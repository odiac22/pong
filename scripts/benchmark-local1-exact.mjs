import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const LOCAL_AI = process.env.PONG_BENCH_LOCAL_AI || 'http://127.0.0.1:8787';
const TARGET_ARTISTS = Math.max(1, Number(process.env.PONG_BENCH_ARTISTS || 8));
const PLAYABLE_PER_ARTIST = Math.max(1, Number(process.env.PONG_BENCH_PLAYABLE || 10));
const PLAYBACK_PROOFS_PER_ARTIST = Math.max(1, Number(process.env.PONG_BENCH_PLAYBACK_PROOFS || 10));
const DEADLINE_MS = Math.max(10_000, Number(process.env.PONG_BENCH_DEADLINE_MS || 100_000));
const TRIALS = Math.max(1, Number(process.env.PONG_BENCH_TRIALS || 2));
const CHROME = process.env.PONG_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function waitForWarmReservoir() {
  return waitFor(async () => {
    const health = await fetch(`${LOCAL_AI}/health`).then(response => response.json());
    if (!health?.ok || !health?.personal_preference?.ready || !health?.gateway?.ready) return null;
    if (!health?.ready) return null;
    const reservoir = health.random40_reservoir || {};
    const required = Math.max(TARGET_ARTISTS, Number(reservoir.local1_ready_min || 0));
    return reservoir.local1_ready === true &&
      Number(reservoir.local1_accepted_candidates || 0) >= required &&
      Number(reservoir.local1_distinct_listing_pages || 0) >= 2
      ? reservoir
      : null;
  }, 900_000, `production-ready accepted Local1 RAM reservoir`, 2_000);
}

async function resetBenchmarkWorkload() {
  // Abort only in-flight work. Keep accepted-candidate leases consumed so a
  // later trial must exercise a fresh set of artists from the RAM reservoir.
  await fetch(`${LOCAL_AI}/workload/reset`, { method: 'POST' }).catch(() => null);
  await waitFor(async () => {
    const health = await fetch(`${LOCAL_AI}/health`).then(response => response.json());
    return Number(health?.classify?.active || 0) === 0 &&
      Number(health?.ollama_queue?.active || 0) === 0 &&
      Number(health?.ollama_queue?.queued || 0) === 0 &&
      Number(health?.personal_preference?.active_classify || 0) === 0;
  }, 45_000, 'benchmark workload drain', 500).catch(() => null);
}

function compactState(state) {
  if (!state) return null;
  const audits = Array.isArray(state.verdictAudit) ? state.verdictAudit : [];
  const reasonCounts = {};
  for (const audit of audits) {
    const reason = String(audit?.reason || 'no reason').slice(0, 90);
    const key = `${audit?.decision || 'unknown'}: ${reason}`;
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }
  return {
    ...state,
    verdictAudit: undefined,
    verdicts: {
      total: audits.length,
      accepted: audits.filter(item => item?.decision === 'accept').length,
      rejected: audits.filter(item => item?.decision === 'reject').length,
      qwenReviews: audits.filter(item => /qwen/i.test(String(item?.reason || ''))).length,
      reasons: Object.fromEntries(Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    },
  };
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result || {});
    });
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'browser evaluation failed');
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch (_) {}
  }
}

async function startStaticServer() {
  const html = await readFile(INDEX_PATH);
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/index.html')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

async function startChrome() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pong-local1-bench-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=MediaRouter,Translate',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const port = await waitFor(async () => {
    const raw = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(raw.split(/\r?\n/)[0]) || 0;
  }, 15_000, 'Chrome DevTools');
  return { child, profile, port };
}

async function stopChromeTree(child) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(resolve, 5_000);
    killer.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function openPage(chromePort, url) {
  const target = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  }).then(response => response.json());
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await Promise.all([session.send('Runtime.enable'), session.send('Page.enable')]);
  return { target, session };
}

const snapshotExpression = `(() => {
  const canonicalPhysicalMediaKey = rawUrl => {
    try {
      const parsed = new URL(rawUrl, location.href);
      const pathname = decodeURIComponent(parsed.pathname).replace(/\\/+$/, '').toLowerCase();
      const filename = pathname.split('/').filter(Boolean).at(-1) || '';
      if (/\\/storage\\//.test(pathname) && filename) {
        return 'storage:' + filename.replace(/^[a-f0-9]{6}-/, '');
      }
      const host = parsed.hostname.toLowerCase().replace(/^www\\./, '').replace(/^img\\d+\\./, '');
      return host + ':' + pathname;
    } catch (_) {
      return String(rawUrl || '').split('?')[0].trim().toLowerCase();
    }
  };
  const groups = (pasteEvents || []).map((event, eventIndex) => {
    if (!isRandom40PasteEvent(event)) return null;
    const bounds = getPasteEventVideoBounds(event);
    const key = getPasteEventPaperclipKey(event, eventIndex);
    if (!bounds || !key) return null;
    const artistUrl = random40NormalizeArtistUrl(event.artistUrl || event.postUrl || '');
    const artistKey = String(event.artistKey || event.sourceArtistKey || '').trim();
    let artistIdentity = artistKey ? 'key:' + artistKey.toLowerCase() : '';
    if (!artistIdentity) {
      try {
        artistIdentity = 'path:' + decodeURIComponent(new URL(artistUrl).pathname).replace(/\\/+$/, '').toLowerCase();
      } catch (_) {}
    }
    const evidence = [...(random40State?.verdictAudit || [])].reverse().find(record =>
      random40NormalizeArtistUrl(record?.artistUrl || '') === artistUrl
    ) || null;
    const physicalMedia = new Map();
    for (let globalIndex = bounds.start; globalIndex < bounds.end; globalIndex++) {
      const videoUrl = allVideoUrls[globalIndex];
      const mediaKey = canonicalPhysicalMediaKey(videoUrl);
      if (!videoUrl || !mediaKey || physicalMedia.has(mediaKey)) continue;
      physicalMedia.set(mediaKey, { url: videoUrl, meta: allVideoMetadata[globalIndex] || {} });
    }
    const urls = [...physicalMedia.values()].map(item => item.url);
    const distinctMedia = physicalMedia.size;
    const byteVerifiedMedia = [...physicalMedia.values()].filter(item => item.meta?.mediaByteVerified === true).length;
    const playbackPassed = window.__pongBenchPlaybackPassed instanceof Set
      ? window.__pongBenchPlaybackPassed
      : new Set();
    const playbackErrors = window.__pongBenchPlaybackErrors instanceof Map
      ? window.__pongBenchPlaybackErrors
      : new Map();
    const readyUrls = new Set();
    const advancingPlaybackUrls = new Set();
    const preloadErrors = [];
    const preloadStatus = { queued: 0, loading: 0, ready: 0, error: 0 };
    document.querySelectorAll('.video-wrapper').forEach(wrapper => {
      const localIndex = Number(wrapper.dataset.index || -1);
      const globalIndex = Number(currentLoadedRangeStart || 0) + localIndex;
      if (globalIndex < bounds.start || globalIndex >= bounds.end) return;
      const video = wrapper.querySelector('video');
      if (video && !video.error && video.readyState >= 3 && getVideoBufferedAheadSeconds(video) >= 0.5 && allVideoUrls[globalIndex]) {
        readyUrls.add(allVideoUrls[globalIndex]);
      }
    });
    random40PreloadMap.forEach(record => {
      if (record.bundleKey !== key) return;
      const status = String(record.status || 'queued');
      preloadStatus[status] = (preloadStatus[status] || 0) + 1;
      if (
        (status === 'ready' || status === 'proven') &&
        record.ready === true &&
        record.browserPlayableProof === true &&
        document.body.contains(record.video) &&
        !record.video?.error &&
        (
          status === 'proven' || (
            Number(record.video?.readyState || 0) >= HTMLMediaElement.HAVE_FUTURE_DATA &&
            getVideoBufferedAheadSeconds(record.video) >= 0.5
          )
        )
      ) readyUrls.add(record.url);
      if (record.actualPlaybackProof === true) advancingPlaybackUrls.add(record.url);
      if (status === 'error') {
        preloadErrors.push({
          url: record.url,
          activeUrl: record.video?.currentSrc || record.video?.src || '',
          mediaError: Number(record.video?.error?.code || 0),
          networkState: Number(record.video?.networkState || 0),
          attempts: Number(record.attempts || 0)
        });
      }
    });
    return {
      key,
      artistKey,
      artistUrl,
      artistIdentity,
      name: event.artistDisplayName || event.bundleLabel || event.artistKey || key,
      sourcePage: Number(event.sourcePage || 0),
      urls,
      distinctMedia,
      byteVerifiedMedia,
      decodeReady: readyUrls.size,
      browserPlayable: readyUrls.size,
      playable: urls.filter(url => playbackPassed.has(key + '|' + url) || advancingPlaybackUrls.has(url)).length,
      playbackErrors: urls
        .map(url => ({ url, error: playbackErrors.get(key + '|' + url) || '' }))
        .filter(item => item.error)
        .slice(0, 5),
      playbackProbeVerified: urls.filter(url => {
        const globalIndex = allVideoUrls.indexOf(url, bounds.start);
        return globalIndex >= bounds.start && globalIndex < bounds.end && allVideoMetadata?.[globalIndex]?.playbackProbeVerified === true;
      }).length,
      checked: urls.length,
      total: urls.length,
      preloadStatus,
      preloadErrors,
      evidence
    };
  }).filter(Boolean);
  return {
    state: random40State ? {
      accepted: Number(random40State.accepted || 0),
      videos: Number(random40State.videos || 0),
      pages: Number(random40State.pages || 0),
      api: Number(random40State.api || 0),
      skippedLowVideo: Number(random40State.skippedLowVideo || 0),
      done: Boolean(random40State.done),
      stop: Boolean(random40State.stop),
      stages: random40State.stageTimings || {},
      verdictAudit: random40State.verdictAudit || [],
      reservoirDropAudit: random40State.reservoirDropAudit || []
    } : null,
    groups
  };
})()`;

const playbackProbeExpression = `(async () => {
  window.__pongBenchPlaybackPassed ||= new Set();
  window.__pongBenchPlaybackAttempts ||= new Map();
  window.__pongBenchPlaybackErrors ||= new Map();
  window.__pongBenchArtistCursor ||= 0;
  window.__pongBenchProbeRounds = Number(window.__pongBenchProbeRounds || 0) + 1;
  const passed = window.__pongBenchPlaybackPassed;
  const attempts = window.__pongBenchPlaybackAttempts;
  const errors = window.__pongBenchPlaybackErrors;
  const work = [];
  (pasteEvents || []).forEach((event, eventIndex) => {
    if (!isRandom40PasteEvent(event)) return;
    const bounds = getPasteEventVideoBounds(event);
    const key = getPasteEventPaperclipKey(event, eventIndex);
    if (!bounds || !key) return;
    const targetKeys = window.__pongBenchTargetBundleKeys;
    if (targetKeys instanceof Set && targetKeys.size && !targetKeys.has(key)) return;
    const urls = [...new Set(allVideoUrls.slice(bounds.start, bounds.end).filter(Boolean))];
    random40PreloadMap.forEach(record => {
      if (record.bundleKey === key && record.actualPlaybackProof === true && urls.includes(record.url)) {
        passed.add(key + '|' + record.url);
      }
    });
    const groupPlayable = urls.filter(url => passed.has(key + '|' + url)).length;
    if (groupPlayable >= ${PLAYBACK_PROOFS_PER_ARTIST}) return;
    const groupWork = [];
    urls.forEach((url, offset) => {
      const passKey = key + '|' + url;
      if (passed.has(passKey)) return;
      const priorAttempts = Number(attempts.get(passKey) || 0);
      const preloadRecord = random40PreloadMap.get(passKey);
      const provenRecord = preloadRecord?.status === 'proven' &&
        preloadRecord?.browserPlayableProof === true;
      const warmRecord = preloadRecord?.status === 'ready' &&
        preloadRecord?.ready === true &&
        preloadRecord?.video &&
        document.body.contains(preloadRecord.video) &&
        !preloadRecord.video.error &&
        Number(preloadRecord.video.readyState || 0) >= HTMLMediaElement.HAVE_FUTURE_DATA
        ? preloadRecord
        : null;
      // A direct preload can become ready after an earlier cold play() timed
      // out. That newly buffered state must override the cold-attempt cap.
      if (priorAttempts >= 2) return;
      if (!warmRecord && !provenRecord && priorAttempts === 0 && window.__pongBenchProbeRounds < 16) return;
      groupWork.push({ url, passKey, priorAttempts, groupPlayable, offset, eventIndex, warmRecord });
    });
    groupWork.sort((a, b) =>
      a.priorAttempts - b.priorAttempts ||
      Number(!a.warmRecord) - Number(!b.warmRecord) ||
      Number(b.warmRecord?.fastStart === true) - Number(a.warmRecord?.fastStart === true) ||
      a.offset - b.offset
    );
    if (groupWork[0]) work.push(groupWork[0]);
  });
  work.sort((a, b) => a.eventIndex - b.eventIndex);
  // Let Pong's production proof lanes finish already-warm clips before this
  // harness creates a foreground player. Continuously foreground-probing one
  // cold URL previously paused the very background queue being measured.
  if (Number(random40PlaybackProofActive || 0) > 0 || (random40PlaybackProofQueue || []).length > 0) {
    return { attempted: 0, passed: passed.size, errors: errors.size };
  }
  // Pong has one foreground player. Probe one clip at a time, round-robin
  // across artists, so the benchmark exercises the same foreground-priority
  // and hidden-preload throttling as a person swiping quickly through Pong.
  // Eight simultaneous play() calls bypassed production's single-player rule
  // and manufactured media-connection starvation on otherwise valid clips.
  const probeConcurrency = Math.min(1, work.length);
  const cursor = work.length ? Number(window.__pongBenchArtistCursor || 0) % work.length : 0;
  const selected = Array.from({ length: probeConcurrency }, (_, index) => work[(cursor + index) % work.length]);
  window.__pongBenchArtistCursor = work.length ? (cursor + probeConcurrency) % work.length : 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  await Promise.all(selected.map(async ({ url, passKey, priorAttempts, warmRecord }, lane) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.dataset.originalVideoUrl = url;
    wrapper.style.cssText = 'position:fixed;z-index:2147483647;left:' + (lane * 18) + 'px;bottom:0;width:16px;height:16px;opacity:0.12;pointer-events:none;overflow:hidden';
    const video = warmRecord?.video || document.createElement('video');
    const originalParent = video.parentElement;
    const originalStyle = video.getAttribute('style');
    const originalClass = video.className;
    const originalPreload = video.preload;
    // Do not use .video-player: Pong correctly pauses sibling deck players,
    // which would make simultaneous URL verification cancel itself.
    video.className = 'pong-benchmark-playback-probe';
    video.style.cssText = 'display:block;width:16px;height:16px';
    video.muted = true;
    video.volume = 0;
    video.playsInline = true;
    video.preload = 'auto';
    wrapper.appendChild(video);
    document.body.appendChild(wrapper);
    const wasPaused = video.paused;
    const previousMuted = video.muted;
    const previousVolume = video.volume;
    try {
      video.__pongBenchProbing = true;
      video.muted = true;
      video.volume = 0;
      const loadUrl = warmRecord
        ? (video.currentSrc || video.src || url)
        : priorAttempts > 0
          ? (random40PcGatewayUrl(url) || url)
          : url;
      // Never throw away a ready direct preload merely because an earlier
      // cold attempt failed; that corrupted the preload record and produced
      // false 0-playable artists in the old benchmark.
      if (!warmRecord || video.error || !video.currentSrc) {
        video.src = loadUrl;
        video.load();
      }
      if (video.networkState === HTMLMediaElement.NETWORK_EMPTY) video.load();
      if (Number.isFinite(video.duration) && video.duration - video.currentTime < 0.8) video.currentTime = 0;
      prepareVideoForPlayback(video);
      const start = Number(video.currentTime || 0);
      await Promise.race([
        Promise.resolve(video.play()),
        delay(800).then(() => { throw new Error('play promise timed out'); })
      ]);
      const deadline = performance.now() + 800;
      while (performance.now() < deadline && !video.error) {
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && Number(video.currentTime || 0) - start >= 0.15) {
          passed.add(passKey);
          errors.delete(passKey);
          break;
        }
        await delay(20);
      }
      if (!passed.has(passKey)) {
        errors.set(passKey, 'no time advancement; ready=' + video.readyState + ', network=' + video.networkState + ', mediaError=' + Number(video.error?.code || 0));
      }
    } catch (error) {
      errors.set(passKey, String(error?.message || error || 'playback failed'));
    } finally {
      if (!passed.has(passKey)) attempts.set(passKey, priorAttempts + 1);
      video.__pongBenchProbing = false;
      if (wasPaused || video.closest('#random40-preload-pool')) video.pause();
      video.muted = previousMuted;
      video.volume = previousVolume;
      try {
        video.pause();
        if (warmRecord && originalParent) {
          video.className = originalClass;
          if (originalStyle == null) video.removeAttribute('style');
          else video.setAttribute('style', originalStyle);
          video.preload = originalPreload;
          originalParent.appendChild(video);
        } else {
          video.removeAttribute('src');
          video.load();
        }
        wrapper.remove();
        transferForegroundVideoPriority(null);
        if (window.currentlyPlayingVideo === video) window.currentlyPlayingVideo = null;
      } catch (_) {}
    }
  }));
  return { attempted: selected.length, passed: passed.size, errors: errors.size };
})()`;

async function runTrial(chromePort, appUrl, trialNumber) {
  const { target, session } = await openPage(chromePort, `${appUrl}?trial=${trialNumber}&t=${Date.now()}`);
  let started = 0;
  let acceptedAt = null;
  let warm10At = null;
  let finalSnapshot = null;
  try {
    await waitFor(() => session.evaluate(`typeof startRandom40 === 'function'`), 15_000, 'Pong script');
    await session.evaluate(`
      ['pong_session_v1','pong_random40_model_reject_cache_v1','pong_random40_stage_timing_v2','pong_random40_model_accuracy_v2']
        .forEach(key => localStorage.removeItem(key));
      localStorage.setItem('pong_random40_local_endpoint_v1', ${JSON.stringify(LOCAL_AI)});
      location.reload();
      true
    `);
    await waitFor(() => session.evaluate(`typeof startRandom40 === 'function' && document.readyState === 'complete'`), 20_000, 'Pong reload');
    const contractSmoke = await session.evaluate(`(() => {
      const failures = [];
      const feetText = random40HardFilter({ artistName: 'Example', artistUrl: 'https://coomerfans.com/u/example', pageText: 'new feet caption' });
      if (feetText) failures.push('feet text was hard-rejected');
      const incidentalTrap = random40HardFilter({ artistName: 'Example', artistUrl: 'https://coomerfans.com/u/example', pageText: 'standing beside a trap door' });
      if (incidentalTrap) failures.push('incidental trap text was hard-rejected');
      const explicitTrap = random40HardFilter({ artistName: 'trapgirl', artistUrl: 'https://coomerfans.com/u/trapgirl', pageText: '' });
      if (explicitTrap) failures.push('trap creator name was hard-rejected instead of using explicit trans evidence');
      const innocentTsPrefix = random40HardFilter({ artistName: 'tsunami', artistUrl: 'https://coomerfans.com/u/tsunami', pageText: '' });
      if (innocentTsPrefix) failures.push('innocent ts-prefix creator name was hard-rejected');
      const confirmedTsProfile = random40HardFilter({ artistName: 'tsemmaswan', artistUrl: 'https://coomerfans.com/u/onlyfans/375651/tsemmaswan', pageText: '' });
      if (!confirmedTsProfile) failures.push('confirmed blocked creator profile was not rejected');
      const transText = random40HardFilter({ artistName: 'Example', artistUrl: 'https://coomerfans.com/u/example', pageText: 'trans creator' });
      if (!transText) failures.push('explicit text hard filter was not rejected');
      const transName = random40HardFilter({ artistName: 'translatina69', artistUrl: 'https://coomerfans.com/u/example', pageText: '' });
      if (!transName) failures.push('explicit blocked identity token in artist name was not rejected');
      const explicitMaleSelfText = random40HardFilter({ artistName: 'Example', artistUrl: 'https://coomerfans.com/u/example', pageText: 'playing with my cock today; showing my cock again' });
      if (!explicitMaleSelfText) failures.push('repeated explicit male self-description was not rejected');
      const toyText = random40HardFilter({ artistName: 'Example', artistUrl: 'https://coomerfans.com/u/example', pageText: 'playing with my dildo toy; my boyfriend filmed it' });
      if (toyText) failures.push('toy or boyfriend text was incorrectly treated as male self-description');
      const safeBase = {
        decision: 'accept', confidence: 0.9, hard_verified: false,
        checks: { photograph: true, female_presenting_adult: true, male_present: false, male_only: false, appears_over_50: false, underage_looking: false, age_ambiguous: false, feet_dominant: false, logo_or_placeholder: false },
        anatomy_assessment: { attached_male_anatomy: false, toy_or_dildo: false, ambiguous: false },
        image_grades: [{ decision: 'accept', checks: { visual_preference_match: true } }]
      };
      const narrowAgeReview = {
        decision: 'accept', confidence: 0.98, requires_qwen_review: false,
        checks: { photograph: null, female_presenting_adult: null, male_present: null, male_only: null, appears_over_50: false, underage_looking: false, age_ambiguous: false, feet_dominant: null, logo_or_placeholder: null },
        anatomy_assessment: { attached_male_anatomy: null, toy_or_dildo: null, ambiguous: false }
      };
      if (!random40HardVisionChecksPass(narrowAgeReview, safeBase)) failures.push('narrow Qwen null fields erased Local1 evidence');
      const oneBodyMismatch = [{ checks: { body_preference_mismatch: true } }];
      if (random40BodyMismatchGrade(oneBodyMismatch)) failures.push('one body crop caused an artist veto');
      if (!random40BodyMismatchGrade([...oneBodyMismatch, ...oneBodyMismatch])) failures.push('two body mismatches did not form consensus');
      const clearBodyGrade = {
        decision: 'accept', confidence: 0.9,
        checks: { visual_preference_match: true, body_evidence_clear: true, body_preference_match: true }
      };
      const profileGrade = {
        decision: 'accept', confidence: 0.9,
        checks: { visual_preference_match: true, body_evidence_clear: false, body_preference_match: null }
      };
      const localFourImageDecision = {
        decision: 'accept', confidence: 0.9, hard_verified: true,
        source: 'personal_preference_v3', vision_source: 'personal_preference_v3', variant: 'local',
        checks: { photograph: true, female_presenting_adult: true, male_present: false, male_only: false, appears_over_50: false, underage_looking: false, age_ambiguous: false, feet_dominant: false, logo_or_placeholder: false },
        anatomy_assessment: { attached_male_anatomy: false, toy_or_dildo: false, ambiguous: false },
        evidence: { clear_body_images: 3, preferred_body_images: 3 },
        image_grades: [profileGrade, clearBodyGrade, clearBodyGrade, clearBodyGrade]
      };
      if (!random40IsAcceptedDecision(localFourImageDecision)) failures.push('four-image/three-body Local1 contract did not accept');
      const onlyTwoBodies = {
        ...localFourImageDecision,
        evidence: { clear_body_images: 2, preferred_body_images: 2 },
        image_grades: [profileGrade, profileGrade, clearBodyGrade, clearBodyGrade]
      };
      if (random40IsAcceptedDecision(onlyTwoBodies)) failures.push('Local1 accepted without three independently clear body images');
      const toy = { anatomy_assessment: { attached_male_anatomy: true, toy_or_dildo: true, ambiguous: false } };
      if (random40HasAttachedAnatomyConflict(toy)) failures.push('toy was treated as attached anatomy');
      if (!random40AnatomyNeedsReview(toy)) failures.push('contradictory attached-plus-toy evidence did not request review');
      const qwenResolvedToy = {
        qwen_review_resolved: true, requires_qwen_review: false,
        checks: { attached_male_anatomy: false, toy_or_dildo: true, anatomy_ambiguous: false },
        anatomy_assessment: { attached_male_anatomy: false, toy_or_dildo: true, ambiguous: false },
        image_grades: [{ checks: { attached_male_anatomy: true, toy_or_dildo: true, anatomy_ambiguous: false } }]
      };
      if (random40AnatomyNeedsReview(qwenResolvedToy)) failures.push('resolved Qwen toy evidence remained stuck in review');
      const attached = { anatomy_assessment: { attached_male_anatomy: true, toy_or_dildo: false, ambiguous: false } };
      if (!random40HasAttachedAnatomyConflict(attached)) failures.push('clear attached anatomy was not rejected');
      return { passed: failures.length === 0, failures };
    })()`);
    if (!contractSmoke?.passed) throw new Error(`browser filter contract failed: ${(contractSmoke?.failures || []).join('; ')}`);
    started = Date.now();
    await session.evaluate(`startRandom40('local'); true`);

    while (Date.now() - started <= DEADLINE_MS) {
      finalSnapshot = await session.evaluate(snapshotExpression);
      const measuredGroups = finalSnapshot.groups.slice(0, TARGET_ARTISTS);
      const measuredIdentities = new Set(measuredGroups.map(group => group.artistIdentity).filter(Boolean));
      if (
        !acceptedAt &&
        Number(finalSnapshot.state?.accepted || 0) >= TARGET_ARTISTS &&
        measuredGroups.length >= TARGET_ARTISTS &&
        measuredIdentities.size >= TARGET_ARTISTS
      ) {
        acceptedAt = Date.now();
        const targetBundleKeys = measuredGroups.map(group => group.key);
        await session.evaluate(`window.__pongBenchTargetBundleKeys = new Set(${JSON.stringify(targetBundleKeys)})`);
      }
      if (
        acceptedAt && !warm10At && measuredGroups.length >= TARGET_ARTISTS &&
        measuredGroups.every(group => group.browserPlayable >= PLAYABLE_PER_ARTIST)
      ) warm10At = Date.now();
      // Exercise the real single foreground player continuously as soon as the
      // first-eight cohort exists. The probe itself prefers already-warm clips,
      // so playback proof overlaps background canplay warming instead of leaving
      // an impossible serial 80-clip tail after every artist reaches ten.
      if (acceptedAt) await session.evaluate(playbackProbeExpression);
      const distinctPages = new Set(measuredGroups.map(group => group.sourcePage).filter(Boolean));
      const evidenceContractPasses = measuredGroups.every(group => {
        const evidence = group.evidence || {};
        const checks = evidence.checks || {};
        const anatomy = evidence.anatomyAssessment || {};
        return evidence.decision === 'accept' &&
          Number(evidence.actualVideos || 0) >= 15 &&
          group.distinctMedia >= 15 &&
          group.byteVerifiedMedia >= 15 &&
          evidence.hardVerified === true &&
          evidence.requiresQwenReview !== true &&
          Number(evidence.screenedImages || 0) === 4 &&
          Array.isArray(evidence.candidateImageUrls) && evidence.candidateImageUrls.length === 4 &&
          Number(evidence.clearBodyImages || 0) >= 3 &&
          checks.photograph !== false && checks.female_presenting_adult === true &&
          checks.male_present !== true && checks.male_only !== true &&
          checks.feet_dominant !== true && checks.logo_or_placeholder !== true &&
          checks.appears_over_50 !== true && checks.underage_looking !== true &&
          checks.age_ambiguous !== true &&
          anatomy.attached_male_anatomy !== true && anatomy.ambiguous !== true;
      });
      if (
        acceptedAt &&
        measuredGroups.length >= TARGET_ARTISTS &&
        measuredIdentities.size >= TARGET_ARTISTS &&
        distinctPages.size >= 2 &&
        evidenceContractPasses &&
        measuredGroups.every(group =>
          group.urls.length >= 15 &&
          group.playable >= PLAYBACK_PROOFS_PER_ARTIST
        )
      ) {
        const elapsed = Date.now() - started;
        return {
          trial: trialNumber,
          passed: elapsed <= DEADLINE_MS,
          acceptedMs: acceptedAt - started,
          warm10Ms: warm10At - started,
          playableMs: elapsed,
          artists: measuredGroups.map(group => ({
            artistKey: group.artistKey,
            artistUrl: group.artistUrl,
            name: group.name,
            sourcePage: group.sourcePage,
            videos: group.urls.length,
            distinctMedia: group.distinctMedia,
            byteVerifiedMedia: group.byteVerifiedMedia,
            decodeReady: group.decodeReady,
            browserPlayable: group.browserPlayable,
            playable: group.playable,
            playbackErrors: group.playbackErrors,
            playbackProbeVerified: group.playbackProbeVerified,
            checked: group.checked,
            total: group.total,
            preloadStatus: group.preloadStatus,
            preloadErrors: group.preloadErrors,
            evidence: group.evidence,
          })),
          state: compactState(finalSnapshot.state),
        };
      }
      if (finalSnapshot.state?.done && Number(finalSnapshot.state.accepted || 0) < TARGET_ARTISTS) break;
      await delay(warm10At ? 25 : 250);
    }

    return {
      trial: trialNumber,
      passed: false,
      acceptedMs: acceptedAt ? acceptedAt - started : null,
      warm10Ms: warm10At ? warm10At - started : null,
      playableMs: null,
      artists: (finalSnapshot?.groups || []).slice(0, TARGET_ARTISTS).map((group, index) => ({
        artistKey: group.artistKey,
        artistUrl: group.artistUrl,
        name: group.name,
        sourcePage: group.sourcePage,
        videos: group.urls.length,
        distinctMedia: group.distinctMedia || 0,
        decodeReady: group.decodeReady || 0,
        browserPlayable: group.browserPlayable || 0,
        playable: group.playable || 0,
        playbackErrors: group.playbackErrors || [],
        playbackProbeVerified: group.playbackProbeVerified || 0,
        checked: group.checked || group.urls.length,
        total: group.total || group.urls.length,
        preloadStatus: group.preloadStatus || {},
        preloadErrors: group.preloadErrors || [],
        evidence: group.evidence || null,
      })),
      state: compactState(finalSnapshot?.state),
    };
  } finally {
    await session.evaluate(`if (random40State) { random40State.stop = true; random40State.done = true; } true`).catch(() => {});
    session.close();
    await fetch(`http://127.0.0.1:${chromePort}/json/close/${target.id}`).catch(() => {});
  }
}

async function main() {
  const health = await fetch(`${LOCAL_AI}/health`).then(response => response.json());
  if (!health?.ok || !health?.ready) throw new Error('Pong Local AI core is not ready');
  const { server, url } = await startStaticServer();
  const chrome = await startChrome();
  const results = [];
  const priorArtistIdentities = new Set();
  try {
    for (let trial = 1; trial <= TRIALS; trial++) {
      // Start the production button immediately after draining in-flight work.
      // Reservoir discovery/refill is part of the measured user wait; do not
      // hide it behind a benchmark-only prewarm barrier.
      await resetBenchmarkWorkload();
      const result = await runTrial(chrome.port, url, trial);
      const identities = result.artists.map(artist => {
        const explicitKey = String(artist.artistKey || '').trim().toLowerCase();
        if (explicitKey) return `key:${explicitKey}`;
        try {
          const parsed = new URL(artist.artistUrl);
          const pathname = decodeURIComponent(parsed.pathname).replace(/\/+$/, '').toLowerCase();
          if (pathname) return `path:${pathname}`;
        } catch (_) {}
        return `name:${String(artist.name || '').trim().toLowerCase()}`;
      }).filter(identity => !identity.endsWith(':'));
      const seenThisTrial = new Set();
      const repeatedThisTrial = new Set();
      identities.forEach(identity => {
        if (seenThisTrial.has(identity)) repeatedThisTrial.add(identity);
        seenThisTrial.add(identity);
      });
      const repeatedIdentities = [...new Set([
        ...repeatedThisTrial,
        ...identities.filter(identity => priorArtistIdentities.has(identity))
      ])];
      identities.forEach(identity => priorArtistIdentities.add(identity));
      result.artistIdentities = identities;
      result.identityRepeats = repeatedIdentities;
      if (
        identities.length !== TARGET_ARTISTS ||
        seenThisTrial.size !== TARGET_ARTISTS ||
        repeatedIdentities.length
      ) result.passed = false;
      results.push(result);
      console.log(JSON.stringify({
        trial: result.trial,
        passed: result.passed,
        acceptedMs: result.acceptedMs,
        warm10Ms: result.warm10Ms,
        playableMs: result.playableMs,
        identityRepeats: result.identityRepeats,
        artists: result.artists.map(artist => ({
          name: artist.name,
          sourcePage: artist.sourcePage,
          videos: artist.videos,
          distinctMedia: artist.distinctMedia,
          byteVerifiedMedia: artist.byteVerifiedMedia,
          decodeReady: artist.decodeReady,
          browserPlayable: artist.browserPlayable,
          playable: artist.playable,
          preloadStatus: artist.preloadStatus,
          playbackErrors: artist.playbackErrors?.slice(0, 2) || [],
          decision: artist.evidence?.decision,
          reason: artist.evidence?.reason,
          screenedImages: artist.evidence?.screenedImages,
          clearBodyImages: artist.evidence?.clearBodyImages,
          actualVideos: artist.evidence?.actualVideos,
        })),
        state: result.state,
      }));
    }
  } finally {
    await resetBenchmarkWorkload().catch(() => {});
    await stopChromeTree(chrome.child);
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await delay(500);
    await rm(chrome.profile, { recursive: true, force: true });
  }

  const passed = results.every(result => result.passed);
  const summary = {
    target: `${TARGET_ARTISTS} distinct artists with 15 byte-verified media and ${PLAYBACK_PROOFS_PER_ARTIST} distinct advancing playback proofs each, ${DEADLINE_MS} ms`,
    reservoirRequirement: 'production-ready, current-revision Local1 accepted minimum',
    passed,
    trials: results.map(result => ({
      trial: result.trial,
      passed: result.passed,
      acceptedMs: result.acceptedMs,
      warm10Ms: result.warm10Ms,
      playableMs: result.playableMs,
      identityRepeats: result.identityRepeats,
      pages: [...new Set(result.artists.map(artist => artist.sourcePage).filter(Boolean))],
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!passed) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
