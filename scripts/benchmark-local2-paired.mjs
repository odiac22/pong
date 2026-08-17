import { randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = process.env.PONG_PAIR_APP || 'http://127.0.0.1:8787/pong';
const API = process.env.PONG_PAIR_API || 'http://127.0.0.1:8787';
const CHROME = process.env.PONG_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TRIALS = Math.max(1, Math.min(3, Number(process.env.PONG_PAIR_TRIALS || 3)));
const DEADLINE_MS = Math.max(60_000, Number(process.env.PONG_PAIR_DEADLINE_MS || 360_000));
const PLAY_TIMEOUT_MS = Math.max(5_000, Number(process.env.PONG_PAIR_PLAY_TIMEOUT_MS || 20_000));
const ARTIST_COUNT = Math.max(1, Math.min(5, Number(process.env.PONG_PAIR_ARTISTS || 3)));
const VIDEOS_PER_ARTIST = Math.max(1, Math.min(5, Number(process.env.PONG_PAIR_VIDEOS || 3)));
const PLAY_PROOF_SECONDS = Math.max(0.5, Math.min(10, Number(process.env.PONG_PAIR_PLAY_SECONDS || 3)));
const ONLY_MODE = ['local2', 'local22'].includes(String(process.env.PONG_PAIR_ONLY_MODE || '').toLowerCase())
  ? String(process.env.PONG_PAIR_ONLY_MODE).toLowerCase()
  : '';
const FIXED_PAGES = String(process.env.PONG_PAIR_PAGES || '')
  .split(',')
  .map(Number)
  .filter(page => Number.isInteger(page) && page >= 1 && page <= 3500);
const REPORT_PATH = process.env.PONG_PAIR_REPORT ||
  path.join(ROOT, '.pong-local-ai', 'local2-paired-benchmark-latest.json');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function acceptedUrlPassesDeterministicHardText(urlValue) {
  let artistName = '';
  try {
    const parts = new URL(String(urlValue || '')).pathname
      .split('/')
      .filter(Boolean);
    artistName = decodeURIComponent(parts.at(-1) || '');
  } catch (_) {
    artistName = String(urlValue || '');
  }
  const tokens = artistName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  return !tokens.some(token =>
    token === 'ts' ||
    token.includes('bbw') ||
    token.includes('sissy') ||
    /tsg$/.test(token) ||
    /^trans(?:gender|sexual|sensual|girl|woman|female|latina|babe|beauty|queen|princess|doll|model|xxx|onlyfans|free)/.test(token) ||
    /(?:girl|lady|babe|barbie|nasty|queen|princess|doll|goddess|mistress|blonde|brunette|latina|asian|ebony|sissy|model|xxx)ts$/.test(token) ||
    ['boy', 'boi', 'male', 'man', 'guy', 'dude'].includes(token) ||
    /(?:were|the|only|all)(?:guys?|dudes?|males?)$/.test(token) ||
    /(?:cock|dick|dicc|penis)(?:$|lover|girl|boy|xxx|free|vip)/.test(token)
  );
}

async function emitReport(report) {
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

async function waitFor(fn, timeout, label, interval = 100) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.consoleAPICalled') {
        const values = (message.params?.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ');
        if (values.includes('[Pong pair]')) console.log(values);
        return;
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
      else pending.resolve(message.result || {});
    });
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP closed while waiting for ${pending.method}`));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, awaitPromise = true) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'evaluation failed');
    }
    return response.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch (_) {}
  }
}

async function startChrome() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pong-local2-pair-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--mute-audio',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=MediaRouter,Translate',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const port = await waitFor(async () => {
    const raw = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(raw.split(/\r?\n/)[0]) || 0;
  }, 15_000, 'Chrome');
  return { child, profile, port };
}

async function stopChrome(chrome) {
  if (chrome?.child?.pid) {
    const killer = spawn('taskkill', ['/pid', String(chrome.child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    await Promise.race([new Promise(resolve => killer.once('close', resolve)), delay(5000)]);
  }
  if (chrome?.profile) await rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
}

async function openSession(chrome, url) {
  const target = await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT'
  }).then(response => response.json());
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Page.enable'),
    cdp.send('Network.enable'),
    cdp.send('DOM.enable')
  ]);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.navigate', { url });
  await waitFor(
    () => cdp.eval(`location.pathname.startsWith('/pong') && document.readyState === 'complete' && Boolean(document.querySelector('#pong-hotspot'))`, false),
    20_000,
    'Pong document'
  );
  return { cdp, target };
}

async function trustedClick(cdp, selector) {
  const box = await cdp.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      width: rect.width,
      height: rect.height,
      hitId: hit?.id || '',
      hitTag: hit?.tagName || ''
    };
  })()`, false);
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${selector} has no clickable box`);
  if (box.hitId !== selector.replace(/^#/, '')) {
    throw new Error(`${selector} is covered by ${box.hitTag || 'unknown'}#${box.hitId || ''}`);
  }
  const { x, y } = box;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function trustedSwipeUp(cdp) {
  const points = await cdp.eval(`(() => {
    const wrapper = document.querySelector('.video-wrapper.deck-active');
    if (!wrapper) return null;
    const rect = wrapper.getBoundingClientRect();
    const x = rect.left + rect.width * 0.5;
    return {
      x,
      startY: rect.top + rect.height * 0.72,
      endY: rect.top + rect.height * 0.28,
      width: rect.width,
      height: rect.height,
      index: Number(wrapper.dataset.index || -1)
    };
  })()`, false);
  if (!points || points.width <= 0 || points.height <= 0) {
    throw new Error('active video has no swipeable box');
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: points.x, y: points.startY, radiusX: 2, radiusY: 2, force: 1, id: 1 }]
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: points.x, y: points.endY, radiusX: 2, radiusY: 2, force: 1, id: 1 }]
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(
    () => cdp.eval(`deckCurrentIndex !== ${Number(points.index)}`),
    3_000,
    'trusted upward swipe'
  );
}

async function resetWorkload() {
  await fetch(`${API}/workload/reset?resetMedia=1`, { method: 'POST' }).catch(() => {});
  await waitFor(async () => {
    const health = await fetch(`${API}/health?t=${Date.now()}`).then(response => response.json());
    return health?.ready && Number(health?.classify?.active || 0) === 0;
  }, 60_000, 'idle local server', 250);
}

async function benchmarkState(cdp) {
  const raw = await cdp.eval(`document.querySelector('#random40-benchmark-state')?.textContent || ''`, false);
  return raw ? JSON.parse(raw) : null;
}

async function proveActiveVideo(cdp, timeoutMs = PLAY_TIMEOUT_MS, targetSeconds = PLAY_PROOF_SECONDS) {
  return cdp.eval(`(async () => {
    const timeoutMs = ${Number(timeoutMs)};
    const targetSeconds = ${Number(targetSeconds)};
    const deadline = Date.now() + timeoutMs;
    let buffering = 0;
    let proofStartTime = null;
    let requiredTotalAdvance = targetSeconds;
    while (Date.now() < deadline) {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      if (!video) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      video.muted = true;
      video.volume = 0;
      wrapper.dataset.playIntent = 'true';
      if (proofStartTime === null) {
        try { video.pause(); } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      if (proofStartTime === null && (
        video.ended ||
        (Number.isFinite(video.duration) && Number(video.duration || 0) - Number(video.currentTime || 0) < 0.35)
      )) {
        try { video.currentTime = 0; } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      if (proofStartTime === null) {
        proofStartTime = Number(video.currentTime || 0);
        if (Number.isFinite(video.duration)) {
          requiredTotalAdvance = Math.min(
            targetSeconds,
            Math.max(0.15, Number(video.duration || 0) - proofStartTime - 0.20)
          );
        }
      }
      const start = Number(video.currentTime || 0);
      let attemptBuffering = 0;
      let firstAdvanceAt = 0;
      let lastAdvanceAt = Date.now();
      let lastObservedTime = start;
      let bufferingEpisode = false;
      const attemptStartedAt = Date.now();
      try {
        await Promise.race([
          video.play(),
          new Promise(resolve => setTimeout(resolve, 1200))
        ]);
      } catch (_) {}
      const proofDeadline = Math.min(deadline, Date.now() + 5000);
      while (Date.now() < proofDeadline) {
        const now = Number(video.currentTime || 0);
        const observedAt = Date.now();
        if (now > lastObservedTime + 0.01) {
          if (!firstAdvanceAt) firstAdvanceAt = observedAt;
          lastAdvanceAt = observedAt;
          lastObservedTime = now;
          bufferingEpisode = false;
        } else if (
          firstAdvanceAt &&
          !video.paused &&
          !video.ended &&
          observedAt - lastAdvanceAt >= 450 &&
          !bufferingEpisode
        ) {
          buffering++;
          attemptBuffering++;
          bufferingEpisode = true;
        }
        const totalAdvance = Math.max(0, now - proofStartTime);
        if (totalAdvance >= requiredTotalAdvance - 0.03 || (video.ended && totalAdvance >= 0.15)) {
          video.pause();
          return {
            ok: true,
            url: String(wrapper.dataset.originalVideoUrl || video.currentSrc || video.src || ''),
            buffering,
            attemptBuffering,
            readyState: Number(video.readyState || 0),
            startupMs: firstAdvanceAt ? firstAdvanceAt - attemptStartedAt : Date.now() - attemptStartedAt,
            playedSeconds: totalAdvance,
            wallMs: Date.now() - attemptStartedAt
          };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Keep continuous user play intent between observation windows. Pausing
      // here used to cancel Pong's stall watchdog just before it could rotate
      // to the PC-cache/gateway hedge, producing a benchmark-only deadlock.
      try {
        random40WarmServerVideoCacheForActiveWrapper(wrapper, { urgent: true });
        restoreDeckVideoNetwork(wrapper, video, { force: true });
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const wrapper = document.querySelector('.video-wrapper.deck-active');
    const video = wrapper?.querySelector('video');
    return {
      ok: false,
      buffering,
      readyState: Number(video?.readyState || 0),
      networkState: Number(video?.networkState || 0),
      mediaError: Number(video?.error?.code || 0),
      mediaErrorMessage: String(video?.error?.message || ''),
      url: String(wrapper?.dataset?.originalVideoUrl || video?.currentSrc || video?.src || ''),
      currentSrc: String(video?.currentSrc || ''),
      currentTime: Number(video?.currentTime || 0),
      duration: Number(video?.duration || 0),
      ended: video?.ended === true,
      playbackFastStart: wrapper
        ? allVideoMetadata[Number(wrapper.dataset.index || -1)]?.playbackFastStart === true
        : false
    };
  })()`);
}

async function provePlaybackMatrix(cdp, startedAt) {
  const availableArtists = await cdp.eval(`pasteEvents.filter(event => event?.source === 'random40').length`);
  if (Number(availableArtists || 0) < ARTIST_COUNT) {
    return { ok: false, reason: `fewer than ${ARTIST_COUNT} artist bundles`, artists: [] };
  }
  const artists = [];
  const provenUrls = new Set();
  let priorEventIndex = -1;
  for (let artistOffset = 0; artistOffset < ARTIST_COUNT; artistOffset++) {
    if (artistOffset === 0) {
      await cdp.eval(`(() => {
        syncCurrentPasteIndexFromVisibleVideo();
        if (pasteEvents[currentPasteIndex]?.source === 'random40') return true;
        const first = pasteEvents.findIndex(event => event?.source === 'random40');
        if (first >= 0) displayPasteEventAtIndex(first, { recordHistory: true });
        return first >= 0;
      })()`);
    } else {
      await trustedClick(cdp, '#paste-nav-button');
    }
    await waitFor(
      () => cdp.eval(`currentPasteIndex >= 0 && currentPasteIndex !== ${priorEventIndex} && pasteEvents[currentPasteIndex]?.source === 'random40'`),
      20_000,
      `paperclip artist ${artistOffset + 1}`
    );
    const eventIndex = Number(await cdp.eval('currentPasteIndex'));
    await waitFor(
      () => cdp.eval(`currentPasteIndex === ${eventIndex} && document.querySelectorAll('.video-wrapper').length >= ${VIDEOS_PER_ARTIST}`),
      20_000,
      `artist ${eventIndex} cards`
    );
    priorEventIndex = eventIndex;
    const artist = { eventIndex, videos: [], completedMs: 0 };
    for (let offset = 0; offset < VIDEOS_PER_ARTIST; offset++) {
      if (offset > 0) {
        await trustedSwipeUp(cdp);
        await waitFor(
          () => cdp.eval(`currentPasteIndex === ${eventIndex} && Boolean(document.querySelector('.video-wrapper.deck-active'))`),
          5_000,
          `artist ${eventIndex} swipe ${offset + 1}`
        );
      }
      const proof = await proveActiveVideo(cdp);
      if (!proof?.ok || provenUrls.has(proof.url)) {
        artist.videos.push({ ...proof, duplicate: provenUrls.has(proof?.url) });
        artists.push(artist);
        return { ok: false, reason: `artist ${eventIndex} video ${offset + 1} did not advance`, artists };
      }
      provenUrls.add(proof.url);
      artist.videos.push({ ...proof, elapsedMs: Date.now() - startedAt });
    }
    artist.completedMs = Date.now() - startedAt;
    artists.push(artist);
  }
  return {
    ok: true,
    completedMs: Date.now() - startedAt,
    distinctVideos: provenUrls.size,
    requiredArtists: ARTIST_COUNT,
    requiredVideosPerArtist: VIDEOS_PER_ARTIST,
    targetPlaybackSeconds: PLAY_PROOF_SECONDS,
    buffers: artists.reduce((sum, artist) =>
      sum + artist.videos.reduce((inner, video) => inner + Number(video.buffering || 0), 0), 0),
    artists
  };
}

async function runMode(page, mode, trialIndex) {
  await resetWorkload();
  console.log(JSON.stringify({ status: 'setup', trial: trialIndex, page, mode, stage: 'server-reset' }));
  const chrome = await startChrome();
  console.log(JSON.stringify({ status: 'setup', trial: trialIndex, page, mode, stage: 'chrome-started' }));
  const loadedAt = Date.now();
  let startedAt = 0;
  const query = new URLSearchParams({
    pongLiveScan: '1',
    pongPairBench: '1',
    pongPages: String(page),
    pongPlaybackProfile: mode === 'local2' ? 'local2fast' : 'local22',
    pongPlaybackFresh: '1',
    trial: String(trialIndex),
    t: String(loadedAt)
  });
  const session = await openSession(chrome, `${APP}?${query}`);
  console.log(JSON.stringify({ status: 'setup', trial: trialIndex, page, mode, stage: 'pong-loaded' }));
  const { cdp, target } = session;
  const selector = mode === 'local2' ? '#random-40-local2' : '#random-40-local';
  let firstArtistMs = 0;
  let firstPlayableMs = 0;
  let targetArtistsMs = 0;
  let firstProof = null;
  try {
    // The decorative Pong splash is unrelated to either Local mode. Synthetic
    // triple-taps can trigger Pong's separate double-tap gesture and stall the
    // renderer, so remove only this inert overlay before the real button click.
    const preClickState = await cdp.eval(`(() => {
      const overlay = document.querySelector('#pong-overlay');
      if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
      }
      localStorage.setItem('pong_random40_local_endpoint_v1', location.origin);
      window.prompt = (_message, fallback = '') => String(fallback || location.origin);
      window.alert = () => {};
      window.confirm = () => true;
      return {
        pasteEvents: Array.isArray(pasteEvents) ? pasteEvents.length : -1,
        videoUrls: Array.isArray(allVideoUrls) ? allVideoUrls.length : -1,
        random40Active: Boolean(random40State && !random40State.done),
        controlsHidden: document.body.classList.contains('controls-hidden')
      };
    })()`);
    console.log(JSON.stringify({
      status: 'setup',
      trial: trialIndex,
      page,
      mode,
      stage: 'splash-dismissed',
      preClickState
    }));
    startedAt = Date.now();
    await trustedClick(cdp, selector);
    console.log(JSON.stringify({ status: 'setup', trial: trialIndex, page, mode, stage: 'button-clicked' }));
    // Let the click-triggered endpoint/memory/start request finish before the
    // first Runtime read. Timing still starts immediately before the click.
    await delay(3500);
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline && (!targetArtistsMs || !firstPlayableMs)) {
      const state = await benchmarkState(cdp);
      if (state?.accepted >= 1 && !firstArtistMs) {
        firstArtistMs = Date.now() - startedAt;
        console.log(JSON.stringify({
          status: 'milestone',
          trial: trialIndex,
          page,
          mode,
          metric: 'firstArtistMs',
          value: firstArtistMs
        }));
      }
      if (state?.accepted >= ARTIST_COUNT && !targetArtistsMs) {
        targetArtistsMs = Date.now() - startedAt;
        console.log(JSON.stringify({
          status: 'milestone',
          trial: trialIndex,
          page,
          mode,
          metric: 'targetArtistsMs',
          value: targetArtistsMs
        }));
      }
      if (state?.accepted >= 1 && !firstPlayableMs) {
        // First-playable measures startup, not a full matrix proof. The full
        // three-second playback contract is measured below for every card.
        firstProof = await proveActiveVideo(cdp, Math.min(PLAY_TIMEOUT_MS, 8000), 0.35);
        if (firstProof?.ok) {
          firstPlayableMs = Date.now() - startedAt;
          console.log(JSON.stringify({
            status: 'milestone',
            trial: trialIndex,
            page,
            mode,
            metric: 'firstPlayableMs',
            value: firstPlayableMs,
            buffering: Number(firstProof.buffering || 0)
          }));
        }
      }
      if (state?.done && Number(state.accepted || 0) < ARTIST_COUNT) break;
      await delay(200);
    }
    const playbackMatrix = targetArtistsMs
      ? await provePlaybackMatrix(cdp, startedAt)
      : { ok: false, reason: `${ARTIST_COUNT} accepted artists not reached`, artists: [] };
    const finalState = await benchmarkState(cdp) || {};
    const acceptedUrls = (finalState.verdictAudit || [])
      .filter(item => item?.decision === 'accept')
      .map(item => String(item.artistUrl || ''))
      .filter(Boolean);
    await cdp.eval(`if (random40State) { random40State.stop = true; random40State.abortController?.abort(); } true`);
    return {
      trial: trialIndex,
      page,
      mode,
      firstArtistMs,
      firstPlayableMs,
      targetArtistsMs,
      playbackMatrixMs: playbackMatrix.completedMs || 0,
      playbackMatrix,
      accepted: Number(finalState.accepted || 0),
      acceptedUrls,
      hardSafe: (finalState.verdictAudit || [])
        .filter(item => item?.decision === 'accept')
        .every(item =>
          item?.hardVerified === true &&
          acceptedUrlPassesDeterministicHardText(item.artistUrl)
        ),
      firstProof,
      detail: finalState.detail || ''
    };
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${chrome.port}/json/close/${target.id}`).catch(() => {});
    await stopChrome(chrome);
    await fetch(`${API}/${mode === 'local2' ? 'local2-fast' : 'local22-turbo'}/stop`, { method: 'POST' }).catch(() => {});
  }
}

async function main() {
  const health = await fetch(`${API}/health`).then(response => response.json());
  if (!health?.ready) throw new Error('Pong local server is not ready');
  const pages = Array.from({ length: TRIALS }, (_, index) => FIXED_PAGES[index] || randomInt(1, 3501));
  const results = [];
  for (let trial = 0; trial < TRIALS; trial++) {
    const order = ONLY_MODE
      ? [ONLY_MODE]
      : trial % 2 ? ['local2', 'local22'] : ['local22', 'local2'];
    for (const mode of order) {
      console.log(JSON.stringify({ status: 'starting', trial: trial + 1, page: pages[trial], mode }));
      const result = await runMode(pages[trial], mode, trial + 1);
      results.push(result);
      console.log(JSON.stringify({ status: 'finished', ...result }));
    }
  }
  if (ONLY_MODE) {
    await emitReport({
      benchmark: `actual Pong ${ONLY_MODE} calibration`,
      timestamp: new Date().toISOString(),
      pages,
      results
    });
    return;
  }
  const comparisons = pages.map((page, index) => {
    const trial = index + 1;
    const local2 = results.find(result => result.trial === trial && result.mode === 'local2');
    const local22 = results.find(result => result.trial === trial && result.mode === 'local22');
    const observedMetrics = ['firstArtistMs', 'firstPlayableMs', 'targetArtistsMs', 'playbackMatrixMs'];
    const requiredMetrics = ['firstArtistMs', 'firstPlayableMs', 'playbackMatrixMs'];
    const metricValue = (result, metric) => {
      if (metric === 'playbackMatrixMs' && result?.playbackMatrix?.ok !== true) return DEADLINE_MS;
      const value = Number(result?.[metric] || 0);
      return value > 0 ? value : DEADLINE_MS;
    };
    const wins = Object.fromEntries(observedMetrics.map(metric => [
      metric,
      metricValue(local22, metric) < metricValue(local2, metric)
    ]));
    const overlap = local2?.acceptedUrls?.filter(url => local22?.acceptedUrls?.includes(url)) || [];
    const local2Buffers = Number(local2?.playbackMatrix?.buffers ?? Infinity);
    const local22Buffers = Number(local22?.playbackMatrix?.buffers ?? Infinity);
    const bufferingWin = Number.isFinite(local22Buffers) && local22Buffers <= local2Buffers;
    return {
      trial,
      page,
      wins,
      // playbackMatrixMs starts at the button click and therefore already
      // includes waiting for three accepted bundles. targetArtistsMs remains a
      // useful diagnostic, but a card merely existing is not a playback result.
      allTimingWins: requiredMetrics.every(metric => wins[metric] === true),
      bufferingWin,
      local2Buffers,
      local22Buffers,
      local2Accepted: local2?.accepted || 0,
      local22Accepted: local22?.accepted || 0,
      overlap,
      local2,
      local22
    };
  });
  const requiredMetrics = ['firstArtistMs', 'firstPlayableMs', 'playbackMatrixMs'];
  const averages = Object.fromEntries(requiredMetrics.map(metric => {
    const value = result => metric === 'playbackMatrixMs' && result?.playbackMatrix?.ok !== true
      ? DEADLINE_MS
      : Math.max(0, Number(result?.[metric] || 0)) || DEADLINE_MS;
    const local2 = comparisons.reduce((sum, row) => sum + value(row.local2), 0) / comparisons.length;
    const local22 = comparisons.reduce((sum, row) => sum + value(row.local22), 0) / comparisons.length;
    return [metric, {
      local2,
      local22,
      improvementPercent: local2 > 0 ? ((local2 - local22) / local2) * 100 : 0,
      significant: local2 > 0 && local22 <= local2 * 0.90
    }];
  }));
  const significantTimingMargin = Object.values(averages).every(row => row.significant === true);
  const minimumTrialWins = Math.max(1, Math.ceil(comparisons.length * 2 / 3));
  const timingRepeatability = Object.fromEntries(requiredMetrics.map(metric => {
    const wins = comparisons.filter(row => row.wins?.[metric] === true).length;
    return [metric, { wins, trials: comparisons.length, required: minimumTrialWins, passed: wins >= minimumTrialWins }];
  }));
  const repeatableTimingWins = Object.values(timingRepeatability).every(row => row.passed === true);
  const completedBufferPairs = comparisons.filter(row =>
    row.local2?.playbackMatrix?.ok === true && row.local22?.playbackMatrix?.ok === true
  );
  const buffering = {
    comparedTrials: completedBufferPairs.length,
    local2: completedBufferPairs.reduce((sum, row) => sum + Number(row.local2Buffers || 0), 0),
    local22: completedBufferPairs.reduce((sum, row) => sum + Number(row.local22Buffers || 0), 0)
  };
  buffering.passed = completedBufferPairs.length === 0 || buffering.local22 <= buffering.local2;
  const passed = comparisons.every(comparison =>
    comparison.local22?.hardSafe &&
    comparison.local22?.playbackMatrix?.ok
  ) && repeatableTimingWins && significantTimingMargin && buffering.passed;
  await emitReport({
    benchmark: `actual Pong Local 2 versus Local 2.2 paired ${ARTIST_COUNT}x${VIDEOS_PER_ARTIST} hidden muted playback`,
    timestamp: new Date().toISOString(),
    pages,
    contract: {
      artists: ARTIST_COUNT,
      videosPerArtist: VIDEOS_PER_ARTIST,
      playbackSecondsPerVideo: PLAY_PROOF_SECONDS,
      requiredTimingMetrics: requiredMetrics,
      targetArtistsMs: 'diagnostic; full matrix timing already includes artist availability',
      minimumAverageImprovementPercent: 10,
      minimumPerMetricTrialWins: minimumTrialWins,
      buffering: 'total playback freezes across completed paired matrices'
    },
    averages,
    significantTimingMargin,
    timingRepeatability,
    repeatableTimingWins,
    buffering,
    passed,
    comparisons
  });
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
