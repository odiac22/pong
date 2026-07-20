import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const FIXTURE_PATH = path.join(ROOT, 'scripts', 'local2-regression-cases.json');
const LOCAL_AI = String(process.env.PONG_BENCH_LOCAL_AI || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CHROME = process.env.PONG_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CASE_TIMEOUT_MS = Math.max(30_000, Number(process.env.PONG_BENCH_CASE_TIMEOUT_MS || 180_000));
const APP_READY_TIMEOUT_MS = Math.max(10_000, Number(process.env.PONG_BENCH_APP_READY_TIMEOUT_MS || 30_000));
const BENCHMARK_PAGES = [1, 2, 3];
const PROFILE_PREFIX = 'pong-local2-regression-';
const MEDIA_URL_PATTERNS = [
  '*.mp4*', '*.m3u8*', '*.mpd*', '*.webm*', '*.mov*', '*.m4v*',
  '*.ts*', '*.mp3*', '*.m4a*', '*.aac*', '*.wav*', '*.ogg*', '*.flac*'
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function timestamp() {
  return new Date().toISOString();
}

function safeError(error) {
  return String(error?.stack || error?.message || error || 'unknown error')
    .replace(/https?:\/\/[^\s)\]}]+/gi, '[url]')
    .slice(0, 1200);
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.eventErrors = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) || []) {
          try {
            Promise.resolve(listener(message.params || {})).catch(error => {
              this.eventErrors.push(safeError(error));
            });
          } catch (error) {
            this.eventErrors.push(safeError(error));
          }
        }
        return;
      }
      if (!this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result || {});
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    // Omitting contextId deliberately evaluates in the page's default main
    // world, where index.html's production lexical bindings are available.
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: false,
      userGesture: false
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(detail || 'browser evaluation failed');
    }
    return response.result?.value;
  }

  close() {
    for (const { reject } of this.pending.values()) reject(new Error('CDP session closed'));
    this.pending.clear();
    try { this.socket?.close(); } catch (_) {}
  }
}

async function startStaticServer() {
  const html = await readFile(INDEX_PATH);
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache'
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/index.html`
  };
}

async function closeStaticServer(server) {
  const instance = server?.server || server;
  if (!instance) return;
  instance.closeAllConnections?.();
  await new Promise(resolve => instance.close(resolve));
}

async function startChrome() {
  const profile = await mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
  let spawnError = null;
  const child = spawn(CHROME, [
    '--headless=new',
    '--mute-audio',
    '--disable-audio-output',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--incognito',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-application-cache',
    '--disable-features=MediaRouter,Translate',
    '--disk-cache-size=1',
    '--media-cache-size=1',
    '--autoplay-policy=document-user-activation-required',
    '--window-size=1280,900',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  child.once('error', error => { spawnError = error; });
  try {
    const port = await waitFor(async () => {
      if (spawnError) throw spawnError;
      const raw = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
      return Number(raw.split(/\r?\n/)[0]) || 0;
    }, 15_000, 'Chrome DevTools');
    return { child, profile, port };
  } catch (error) {
    await stopChromeTree(child);
    await removeTempProfile(profile);
    throw error;
  }
}

async function stopChromeTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      delay(5_000)
    ]);
    return;
  }
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true
  });
  await Promise.race([
    new Promise(resolve => killer.once('close', resolve)),
    delay(5_000)
  ]);
}

async function removeTempProfile(profile) {
  const resolved = path.resolve(profile || '');
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  const insideTemp = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!insideTemp || !path.basename(resolved).startsWith(PROFILE_PREFIX)) {
    throw new Error(`Refusing to remove unexpected Chrome profile path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

const MEDIA_GUARD_SOURCE = `(() => {
  const audit = {
    schema: 'pong-no-media-audit-v1',
    createdAudio: 0,
    createdVideo: 0,
    audioConstructorCalls: 0,
    playCalls: 0,
    loadCalls: 0,
    playEvents: 0,
    playingEvents: 0
  };
  Object.defineProperty(window, '__pongMediaAudit', {
    value: audit,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const seen = new WeakSet();
  const recordElement = element => {
    if (!element || seen.has(element)) return;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag !== 'audio' && tag !== 'video') return;
    seen.add(element);
    if (tag === 'audio') audit.createdAudio++;
    else audit.createdVideo++;
    try { element.removeAttribute('autoplay'); } catch (_) {}
    try { element.autoplay = false; } catch (_) {}
    try { element.muted = true; } catch (_) {}
  };

  const nativeCreateElement = Document.prototype.createElement;
  Object.defineProperty(Document.prototype, 'createElement', {
    configurable: true,
    writable: true,
    value: function(name, options) {
      const element = nativeCreateElement.call(this, name, options);
      recordElement(element);
      return element;
    }
  });

  if (typeof HTMLMediaElement !== 'undefined') {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: function() {
        recordElement(this);
        audit.playCalls++;
        return Promise.reject(new DOMException('Regression benchmark blocks playback', 'NotAllowedError'));
      }
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'load', {
      configurable: true,
      writable: true,
      value: function() {
        recordElement(this);
        audit.loadCalls++;
      }
    });
  }

  if (typeof window.Audio === 'function') {
    const NativeAudio = window.Audio;
    const BlockedAudio = function(...args) {
      audit.audioConstructorCalls++;
      const element = new NativeAudio(...args);
      recordElement(element);
      return element;
    };
    BlockedAudio.prototype = NativeAudio.prototype;
    Object.setPrototypeOf(BlockedAudio, NativeAudio);
    Object.defineProperty(window, 'Audio', {
      configurable: true,
      writable: true,
      value: BlockedAudio
    });
  }

  document.addEventListener('play', event => {
    audit.playEvents++;
    recordElement(event.target);
    try { event.target.pause(); } catch (_) {}
  }, true);
  document.addEventListener('playing', event => {
    audit.playingEvents++;
    recordElement(event.target);
    try { event.target.pause(); } catch (_) {}
  }, true);

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes || []) {
        if (node?.nodeType !== 1) continue;
        recordElement(node);
        node.querySelectorAll?.('audio,video').forEach(recordElement);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });
})();`;

async function openGuardedPage(chromePort, url) {
  const target = await fetch(
    `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' }
  ).then(response => response.json());
  const session = new CdpSession(target.webSocketDebuggerUrl);
  const networkAudit = {
    browserMediaRequests: 0,
    browserImageRequests: 0,
    blockedMediaRequests: 0,
    blockedImageRequests: 0,
    interceptionErrors: []
  };
  await session.connect();
  try {
    await Promise.all([
      session.send('Runtime.enable'),
      session.send('Page.enable'),
      session.send('Network.enable'),
      session.send('DOM.enable')
    ]);
    session.on('Network.requestWillBeSent', params => {
      if (params.type === 'Media') networkAudit.browserMediaRequests++;
      if (params.type === 'Image') networkAudit.browserImageRequests++;
    });
    session.on('Fetch.requestPaused', async params => {
      if (params.resourceType === 'Media') networkAudit.blockedMediaRequests++;
      if (params.resourceType === 'Image') networkAudit.blockedImageRequests++;
      try {
        await session.send('Fetch.failRequest', {
          requestId: params.requestId,
          errorReason: 'BlockedByClient'
        });
      } catch (error) {
        networkAudit.interceptionErrors.push(safeError(error));
      }
    });
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await session.send('Network.setBlockedURLs', { urls: MEDIA_URL_PATTERNS });
    await session.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' }
      ]
    });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: MEDIA_GUARD_SOURCE });
    await session.send('Page.navigate', { url });
    return { target, session, networkAudit };
  } catch (error) {
    session.close();
    await fetch(`http://127.0.0.1:${chromePort}/json/close/${target.id}`).catch(() => {});
    throw error;
  }
}

async function initializeProductionMainWorld(session) {
  await waitFor(
    () => session.evaluate(`document.readyState === 'complete' &&
      typeof random40FetchDoc === 'function' &&
      typeof random40CollectVideoPostLinks === 'function' &&
      typeof random40SelectRepresentativeCandidateImages === 'function' &&
      typeof random40ClassifyArtistLocal === 'function' &&
      typeof random40IsAcceptedDecision === 'function'`),
    APP_READY_TIMEOUT_MS,
    'Pong production functions'
  );

  return session.evaluate(`(async () => {
    const configuredEndpoint = random40NormalizeLocalEndpoint(${JSON.stringify(LOCAL_AI)});
    localStorage.setItem(RANDOM40_LOCAL_ENDPOINT_KEY, configuredEndpoint);
    await random40PingLocalEndpoint(configuredEndpoint, 8000);
    const endpoint = configuredEndpoint;
    random40GatewayEndpoint = endpoint;
    random40State = {
      mode: 'local2',
      localEndpoint: endpoint,
      startedAt: Date.now(),
      firstVideoRecordedAt: 0,
      accepted: 0,
      videos: 0,
      pages: 0,
      api: 0,
      skippedLowVideo: 0,
      thumbnailSkips: 0,
      cachedSkips: 0,
      stageTimings: {},
      verdictAudit: [],
      reservoirDropAudit: [],
      cardsStarted: false,
      playbackProtectionRequested: false,
      playbackProtectionPending: false,
      playbackProtectionPromise: null,
      playbackProtectionStartedAt: 0,
      playbackCohortSealed: false,
      playbackCohortSealedAt: 0,
      backgroundFillSequence: 0,
      stop: false,
      done: false,
      abortController: new AbortController(),
      seenPages: new Set(),
      seenArtists: new Set(),
      rejectedArtistUrls: new Set(),
      benchmarkPages: [1, 2, 3],
      benchmarkPageIndex: 0
    };
    await random40LoadPcLearningMemory(endpoint).catch(() => false);
    const posterDoc = new DOMParser().parseFromString(
      '<div class="post"><img><a class="view-post" href="/p/poster-video">2 minute video</a></div>',
      'text/html'
    );
    const posterAwareExtractor =
      random40ExtractVideoPostLinks(posterDoc, 'https://coomerfans.com/').length === 0 &&
      random40ExtractLocal2VideoPostLinks(posterDoc, 'https://coomerfans.com/').length === 1;
    return {
      endpointReady: true,
      mode: random40State.mode,
      noMedia: RANDOM40_BENCHMARK_NO_MEDIA === true,
      liveScan: RANDOM40_BENCHMARK_LIVE_SCAN === true,
      pages: [...RANDOM40_BENCHMARK_PAGES],
      posterAwareExtractor,
      minVideos: RANDOM40_MIN_VIDEOS_PER_ARTIST,
      reviewImages: random40ReviewImageLimit('local2'),
      requiredImages: random40RequiredReviewImages('local2')
    };
  })()`);
}

async function runRegressionCaseInMainWorld(fixture, timeoutMs) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let classificationInvoked = false;

  const reasonCategory = (actualDecision, verifiedVideoCount, textHard, visualDecision) => {
    if (actualDecision === 'accept') return 'accepted';
    const textReason = String(textHard?.reason || '').toLowerCase();
    const code = String(visualDecision?.reason_code || visualDecision?.code || '').toLowerCase();
    const visualReason = String(visualDecision?.reason || '').toLowerCase();
    const checks = visualDecision?.checks || {};
    const anatomy = random40AnatomyAssessment(visualDecision);
    if (
      /\b(?:trans|transgender|male|attached (?:male )?anatomy|penis)\b/.test(textReason) ||
      /(?:confirmed creator profile|name token:\s*ts)/.test(textReason) ||
      ['visible_attached_anatomy', 'male_presenting_content', 'attached_male_anatomy'].includes(code) ||
      checks.male_present === true || checks.male_only === true ||
      anatomy.attached_male_anatomy === true ||
      /\b(?:trans|male-presenting|attached (?:male )?anatomy|penis)\b/.test(visualReason)
    ) return 'explicit_text_or_visible_attached_anatomy';
    if (
      /\b(?:bbw|body|midsection|larger)\b/.test(textReason) ||
      ['body_shape_mismatch', 'body_preference_mismatch'].includes(code) ||
      checks.body_preference_conflict === true || checks.body_preference_mismatch === true ||
      visualDecision?.body_consensus?.veto === true ||
      /\b(?:body shape|body preference|midsection)\b/.test(visualReason)
    ) return 'body_shape_mismatch';
    if (verifiedVideoCount < RANDOM40_MIN_VIDEOS_PER_ARTIST) return 'insufficient_verified_videos';
    return code || 'other_reject';
  };

  try {
    const artist = random40ArtistInfo(fixture.artistUrl, null);
    const firstDoc = await random40FetchDoc(artist.artistUrl, {
      timeoutMs: 22_000,
      signal: controller.signal,
      priority: 0
    });
    const firstPageText = String(firstDoc.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 60_000);
    const firstLinks = random40ExtractVideoPostLinks(firstDoc, artist.artistUrl);
    const supplementalPostLinks = random40ExtractLocal2VideoPostLinks(firstDoc, artist.artistUrl);
    const firstPostImages = random40ExtractScraperPostImages(firstDoc, artist.artistUrl, artist);
    const seed = {
      firstDoc,
      links: firstLinks,
      supplementalPostLinks,
      // The collection gate normally short-circuits explicit text rejects.
      // A neutral collection identity lets this regression prove the 15-media
      // contract first; the real identity and text are restored before the
      // production Local2 classifier and final hard-filter decision.
      pageText: '',
      postImageEntries: firstPostImages,
      verifiedEntries: [],
      checkedPostLinks: [],
      scannedThroughPage: 1,
      nextPage: 2,
      scanComplete: !firstDoc.querySelector('a[href*="?page="], a[href*="&page="]')
    };
    const collectionArtist = {
      ...artist,
      artistName: 'regression-candidate',
      artistDisplayName: 'regression-candidate',
      pageText: ''
    };
    const explicitFirstPageHard = fixture.expectedDecision === 'reject'
      ? random40HardFilter({ ...artist, pageText: firstPageText }, 'local2')
      : null;
    const collected = explicitFirstPageHard
      ? { ...seed, pageText: firstPageText }
      : await random40CollectVideoPostLinks(collectionArtist, {
          stopAt: Infinity,
          // Known regression profiles are allowed to exhaust the same full
          // artist-page ceiling as production. A shallow precheck can undercount
          // older profiles and turn an image-filter regression into a source test.
          maxPages: Math.max(RANDOM40_PRECHECK_MAX_ARTIST_PAGES, 100),
          ignoreStop: true,
          verifyVideosAt: RANDOM40_MIN_VIDEOS_PER_ARTIST,
          minPostImagesForReview: RANDOM40_MIN_POST_IMAGES_FOR_REVIEW,
          seed,
          signal: controller.signal,
          sourcePriority: 0,
          mode: 'local2',
          useSupplementalPostLinks: true
        });

    const verifiedEntries = random40DeduplicateVideoEntries(
      (collected.verifiedEntries || []).filter(entry => entry?.playbackProbeVerified === true)
    );
    const verifiedVideoCount = verifiedEntries.length;
    const workingArtist = {
      ...artist,
      pageText: `${firstPageText} ${collected.pageText || ''}`.replace(/\s+/g, ' ').trim()
    };
    const spamDebugText = String(`${workingArtist.artistName || ''} ${workingArtist.pageText || ''} ${workingArtist.artistUrl || ''}`);
    const spamDebugNormalized = spamDebugText.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, ' ').replace(/\s+/g, ' ');
    const spamDebugOtherHandles = [...spamDebugText.matchAll(/(^|[\s([{:;,])@([a-z0-9_.-]{3,})/gi)]
      .map(match => String(match[2] || '').toLowerCase())
      .filter(handle => handle && handle !== String(artist.artistName || '').toLowerCase());
    const spamDiagnostics = {
      textLength: spamDebugText.length,
      adTagCount: (spamDebugNormalized.match(/#\s*(?:ad|ads|advertisement|advertising|adverting|promo|promotion)\b/g) || []).length,
      vipPhraseCount: (spamDebugNormalized.match(/\b(?:free\s+vip\s+page|vip\s+page|free\s+page|free\s+trial|free\s+subscribe)\b/g) || []).length,
      promoPhraseCount: (spamDebugNormalized.match(/\b(?:write\s+to\s+her|text\s+her|dm\s+me|message\s+me|free\s+gift|online\s+now|subscribe\s+to\s+her|join\s+her|check\s+her|new\s+page|main\s+page)\b/g) || []).length,
      otherHandleMentions: spamDebugOtherHandles.length,
      uniqueOtherHandles: new Set(spamDebugOtherHandles).size,
      emojiCount: random40EmojiCount(spamDebugText)
    };
    const textHard = random40HardFilter(workingArtist, 'local2');
    const profileImage = random40NormalizeUrl(
      collected.profileImageUrl || random40FindProfileImageFromDoc(firstDoc, artist, artist.artistUrl),
      artist.artistUrl
    );
    workingArtist.imageUrl = profileImage;
    const fallbackImages = [
      profileImage,
      ...random40ExtractReviewImages(firstDoc, artist.artistUrl, artist.imageUrl),
      ...(collected.postImageEntries || []).map(entry => entry?.imageUrl)
    ].filter(Boolean);
    const selectedImages = await random40SelectRepresentativeCandidateImages({
      profileImage,
      postImageEntries: collected.postImageEntries || [],
      fallbackImageUrls: fallbackImages,
      maxImages: random40ReviewImageLimit('local2'),
      resolvePostImages: false,
      deterministic: true
    });

    classificationInvoked = true;
    const visualDecision = await random40ClassifyArtistLocal(
      workingArtist,
      random40State.localEndpoint,
      selectedImages,
      {
        visionModel: random40LocalVisionModel('local2'),
        mode: 'local2',
        signal: controller.signal,
        deferQwenReview: false,
        maxImages: random40ReviewImageLimit('local2')
      }
    );
    random40State.api++;

    const browserAccepted = random40IsAcceptedDecision(visualDecision);
    const actualDecision =
      verifiedVideoCount >= RANDOM40_MIN_VIDEOS_PER_ARTIST &&
      !textHard &&
      browserAccepted
        ? 'accept'
        : 'reject';
    const actualReason = reasonCategory(actualDecision, verifiedVideoCount, textHard, visualDecision);
    const checks = visualDecision?.checks || {};
    const anatomy = random40AnatomyAssessment(visualDecision);
    const screenedImages = Array.isArray(visualDecision?.image_grades)
      ? visualDecision.image_grades.length
      : 0;
    const clearBodyImages = random40ClearBodyEvidenceCount(visualDecision);
    const acceptedHardSafe =
      visualDecision?.hard_verified === true &&
      visualDecision?.requires_qwen_review !== true &&
      checks.photograph === true &&
      checks.female_presenting_adult === true &&
      checks.male_present === false && checks.male_only === false &&
      checks.feet_dominant === false &&
      checks.logo_or_placeholder !== true &&
      checks.body_preference_conflict !== true &&
      checks.appears_over_50 !== true && checks.appears_over_60 !== true &&
      anatomy.attached_male_anatomy !== true && anatomy.ambiguous !== true &&
      screenedImages >= random40RequiredReviewImages('local2') &&
      clearBodyImages >= 2;
    const acceptableReasons = Array.isArray(fixture.acceptableReasons)
      ? fixture.acceptableReasons.map(value => String(value || ''))
      : [String(fixture.expectedReason || '')];
    const expectedMatches =
      actualDecision === fixture.expectedDecision &&
      acceptableReasons.includes(actualReason);
    const mediaContractPass = actualDecision === 'accept'
      ? verifiedVideoCount >= RANDOM40_MIN_VIDEOS_PER_ARTIST
      : true;
    const pass =
      expectedMatches &&
      mediaContractPass &&
      selectedImages.length >= random40RequiredReviewImages('local2') &&
      classificationInvoked &&
      (actualDecision !== 'accept' || acceptedHardSafe);
    const finishedAtMs = Date.now();

    return {
      name: fixture.name,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      elapsedMs: finishedAtMs - startedAtMs,
      expected: {
        decision: fixture.expectedDecision,
        reason: fixture.expectedReason
      },
      actual: {
        decision: actualDecision,
        reason: actualReason
      },
      verifiedVideoCount,
      requiredVerifiedVideos: RANDOM40_MIN_VIDEOS_PER_ARTIST,
      selectedImageCount: selectedImages.length,
      requiredImageCount: random40RequiredReviewImages('local2'),
      classificationInvoked,
      hardSafeChecks: {
        browserAccepted,
        acceptedHardSafe,
        textHardReject: Boolean(textHard),
        textHardReason: String(textHard?.reason || ''),
        hardVerified: visualDecision?.hard_verified === true,
        requiresQwenReview: visualDecision?.requires_qwen_review === true,
        photograph: checks.photograph ?? null,
        femalePresentingAdult: checks.female_presenting_adult ?? null,
        malePresent: checks.male_present ?? null,
        maleOnly: checks.male_only ?? null,
        feetDominant: checks.feet_dominant ?? null,
        logoOrPlaceholder: checks.logo_or_placeholder ?? null,
        bodyPreferenceConflict: checks.body_preference_conflict ?? null,
        appearsOver50: checks.appears_over_50 ?? null,
        appearsOver60: checks.appears_over_60 ?? null,
        attachedMaleAnatomy: anatomy.attached_male_anatomy ?? null,
        anatomyAmbiguous: anatomy.ambiguous ?? null,
        screenedImages,
        clearBodyImages
      },
      model: {
        source: String(visualDecision?.vision_source || visualDecision?.source || ''),
        schema: String(visualDecision?.local2_schema || ''),
        reasonCode: String(visualDecision?.reason_code || ''),
        confidence: Number(visualDecision?.confidence || 0)
      },
      spamDiagnostics,
      pass
    };
  } catch (error) {
    const finishedAtMs = Date.now();
    return {
      name: fixture.name,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      elapsedMs: finishedAtMs - startedAtMs,
      expected: {
        decision: fixture.expectedDecision,
        reason: fixture.expectedReason
      },
      actual: {
        decision: 'error',
        reason: error?.name === 'AbortError' ? 'case_timeout_or_abort' : 'case_error'
      },
      verifiedVideoCount: 0,
      requiredVerifiedVideos: RANDOM40_MIN_VIDEOS_PER_ARTIST,
      selectedImageCount: 0,
      requiredImageCount: random40RequiredReviewImages('local2'),
      classificationInvoked,
      hardSafeChecks: null,
      model: null,
      error: String(error?.message || error || 'unknown error').replace(/https?:\/\/[^\s)\]}]+/gi, '[url]').slice(0, 500),
      pass: false
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function collectNoMediaAudit(session, networkAudit) {
  // Give any queued DOM/network activity one turn to surface before auditing.
  await delay(100);
  const pageAudit = await session.evaluate(`(() => ({
    domAudioElements: document.querySelectorAll('audio').length,
    domVideoElements: document.querySelectorAll('video').length,
    guard: window.__pongMediaAudit || null
  }))()`);
  const guard = pageAudit?.guard || {};
  const noMediaPass =
    Number(pageAudit?.domAudioElements || 0) === 0 &&
    Number(pageAudit?.domVideoElements || 0) === 0 &&
    Number(guard.createdAudio || 0) === 0 &&
    Number(guard.createdVideo || 0) === 0 &&
    Number(guard.audioConstructorCalls || 0) === 0 &&
    Number(guard.playCalls || 0) === 0 &&
    Number(guard.loadCalls || 0) === 0 &&
    Number(guard.playEvents || 0) === 0 &&
    Number(guard.playingEvents || 0) === 0 &&
    Number(networkAudit.browserMediaRequests || 0) === 0 &&
    networkAudit.interceptionErrors.length === 0 &&
    session.eventErrors.length === 0;
  return {
    ...pageAudit,
    network: {
      browserMediaRequests: networkAudit.browserMediaRequests,
      browserImageRequests: networkAudit.browserImageRequests,
      blockedMediaRequests: networkAudit.blockedMediaRequests,
      blockedImageRequests: networkAudit.blockedImageRequests,
      interceptionErrorCount: networkAudit.interceptionErrors.length,
      cdpEventErrorCount: session.eventErrors.length
    },
    policy: {
      headless: true,
      audioMutedAtProcessStart: true,
      browserMediaRequestsBlockedBeforeNavigation: true,
      browserImageRequestsBlockedBeforeNavigation: true,
      networkCacheDisabledBeforeNavigation: true,
      screenshotsTaken: false,
      mediaFilesWrittenByBenchmark: false,
      imageFilesWrittenByBenchmark: false,
      sourceAndModelImagesAreRamOnly: true
    },
    pass: noMediaPass
  };
}

async function fetchHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${LOCAL_AI}/health?t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Local AI health HTTP ${response.status}`);
    const health = await response.json();
    if (!health?.ok || health?.ready === false) throw new Error('Pong Local AI is not ready');
    return health;
  } finally {
    clearTimeout(timer);
  }
}

async function loadFixtures() {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  if (fixture?.schema !== 'pong-local2-regression-v1') {
    throw new Error(`Unexpected fixture schema: ${fixture?.schema || 'missing'}`);
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== 4) {
    throw new Error('Local2 regression fixture must contain exactly four cases');
  }
  for (const item of fixture.cases) {
    if (!item?.name || !item?.artistUrl || !item?.expectedDecision || !item?.expectedReason) {
      throw new Error('Local2 regression fixture contains an incomplete case');
    }
  }
  return fixture;
}

async function main() {
  const benchmarkStartedMs = Date.now();
  const benchmarkStartedAt = timestamp();
  const fixture = await loadFixtures();
  await fetchHealth();

  let staticServer = null;
  let chrome = null;
  let target = null;
  let session = null;
  let networkAudit = null;
  const cases = [];
  let noMediaAudit = null;

  try {
    staticServer = await startStaticServer();
    chrome = await startChrome();
    const query = new URLSearchParams({
      pongNoMedia: '1',
      pongLiveScan: '1',
      pongPages: BENCHMARK_PAGES.join(','),
      mode: 'local2',
      local2Regression: '1',
      t: String(Date.now())
    });
    const guarded = await openGuardedPage(chrome.port, `${staticServer.url}?${query}`);
    ({ target, session, networkAudit } = guarded);
    const initialized = await initializeProductionMainWorld(session);
    if (
      initialized?.noMedia !== true ||
      initialized?.liveScan !== true ||
      initialized?.posterAwareExtractor !== true ||
      initialized?.pages?.join(',') !== BENCHMARK_PAGES.join(',')
    ) {
      throw new Error(`Invalid benchmark flags: ${JSON.stringify(initialized)}`);
    }

    for (const item of fixture.cases) {
      console.error(`[${timestamp()}] Local2 regression starting: ${item.name}`);
      const expression = `(${runRegressionCaseInMainWorld.toString()})(` +
        `${JSON.stringify(item)}, ${JSON.stringify(CASE_TIMEOUT_MS)})`;
      const result = await session.evaluate(expression);
      cases.push(result);
      console.error(`[${timestamp()}] Local2 regression finished: ${item.name} - ${result.pass ? 'PASS' : 'FAIL'} (${result.elapsedMs} ms)`);
    }
    noMediaAudit = await collectNoMediaAudit(session, networkAudit);
  } finally {
    if (session) session.close();
    if (target && chrome?.port) {
      await fetch(`http://127.0.0.1:${chrome.port}/json/close/${target.id}`).catch(() => {});
    }
    if (chrome) {
      await stopChromeTree(chrome.child);
      await delay(250);
      await removeTempProfile(chrome.profile);
    }
    await closeStaticServer(staticServer);
  }

  const benchmarkFinishedMs = Date.now();
  const passed =
    cases.length === fixture.cases.length &&
    cases.every(result => result?.pass === true) &&
    noMediaAudit?.pass === true;
  const result = {
    schema: 'pong-local2-live-regression-benchmark-v1',
    benchmark: 'production browser collection, 15-real-video verification, and Local2 classification',
    startedAt: benchmarkStartedAt,
    finishedAt: new Date(benchmarkFinishedMs).toISOString(),
    elapsedMs: benchmarkFinishedMs - benchmarkStartedMs,
    caseTimeoutMs: CASE_TIMEOUT_MS,
    benchmarkFlags: {
      pongNoMedia: true,
      pongLiveScan: true,
      pongPages: BENCHMARK_PAGES,
      posterAwareExtractor: true
    },
    expectedCaseCount: fixture.cases.length,
    cases,
    noMediaAudit,
    passed
  };
  console.log(JSON.stringify(result, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({
    schema: 'pong-local2-live-regression-benchmark-v1',
    finishedAt: timestamp(),
    passed: false,
    fatalError: safeError(error)
  }, null, 2));
  process.exitCode = 1;
});
