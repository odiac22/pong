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

async function proveActiveVideo(cdp, timeoutMs = PLAY_TIMEOUT_MS) {
  return cdp.eval(`(async () => {
    const timeoutMs = ${Number(timeoutMs)};
    const deadline = Date.now() + timeoutMs;
    let buffering = 0;
    let lastTime = -1;
    while (Date.now() < deadline) {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      if (!video) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      video.muted = true;
      video.volume = 0;
      const start = Number(video.currentTime || 0);
      const onWaiting = () => buffering++;
      video.addEventListener('waiting', onWaiting);
      video.addEventListener('stalled', onWaiting);
      try {
        await Promise.race([
          video.play(),
          new Promise(resolve => setTimeout(resolve, 1200))
        ]);
      } catch (_) {}
      const proofDeadline = Math.min(deadline, Date.now() + 5000);
      while (Date.now() < proofDeadline) {
        const now = Number(video.currentTime || 0);
        if (now - start >= 0.15 || (lastTime >= 0 && now - lastTime >= 0.15)) {
          video.pause();
          video.removeEventListener('waiting', onWaiting);
          video.removeEventListener('stalled', onWaiting);
          return {
            ok: true,
            url: String(wrapper.dataset.originalVideoUrl || video.currentSrc || video.src || ''),
            buffering,
            readyState: Number(video.readyState || 0)
          };
        }
        lastTime = now;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      try { video.pause(); } catch (_) {}
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
      playbackFastStart: wrapper
        ? allVideoMetadata[Number(wrapper.dataset.index || -1)]?.playbackFastStart === true
        : false
    };
  })()`);
}

async function proveFiveByFive(cdp, startedAt) {
  const eventIndexes = await cdp.eval(`pasteEvents
    .map((event, index) => ({ event, index }))
    .filter(item => item.event?.source === 'random40')
    .slice(0, 5)
    .map(item => item.index)`);
  if (!Array.isArray(eventIndexes) || eventIndexes.length < 5) {
    return { ok: false, reason: 'fewer than five artist bundles', artists: [] };
  }
  const artists = [];
  const provenUrls = new Set();
  for (const eventIndex of eventIndexes) {
    await cdp.eval(`displayPasteEventAtIndex(${eventIndex}, { recordHistory: false }); true`);
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('.video-wrapper').length >= 5`),
      20_000,
      `artist ${eventIndex} cards`
    );
    const artist = { eventIndex, videos: [], completedMs: 0 };
    for (let offset = 0; offset < 5; offset++) {
      await cdp.eval(`setDeckActiveIndex(${offset}, 'none', { pushHistory: false }); true`);
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
  let fiveArtistsMs = 0;
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
    while (Date.now() < deadline && (!fiveArtistsMs || !firstPlayableMs)) {
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
      if (state?.accepted >= 5 && !fiveArtistsMs) {
        fiveArtistsMs = Date.now() - startedAt;
        console.log(JSON.stringify({
          status: 'milestone',
          trial: trialIndex,
          page,
          mode,
          metric: 'fiveArtistsMs',
          value: fiveArtistsMs
        }));
      }
      if (state?.accepted >= 1 && !firstPlayableMs) {
        firstProof = await proveActiveVideo(cdp, Math.min(PLAY_TIMEOUT_MS, 3500));
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
      if (state?.done && Number(state.accepted || 0) < 5) break;
      await delay(200);
    }
    const fiveByFive = fiveArtistsMs
      ? await proveFiveByFive(cdp, startedAt)
      : { ok: false, reason: 'five accepted artists not reached', artists: [] };
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
      fiveArtistsMs,
      fiveByFiveMs: fiveByFive.completedMs || 0,
      fiveByFive,
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
    await fetch(`${API}/${mode === 'local2' ? 'local2-fast' : 'local2'}/stop`, { method: 'POST' }).catch(() => {});
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
    const metrics = ['firstArtistMs', 'firstPlayableMs', 'fiveArtistsMs', 'fiveByFiveMs'];
    const wins = Object.fromEntries(metrics.map(metric => [
      metric,
      Number(local2?.[metric] || Infinity) < Number(local22?.[metric] || Infinity)
    ]));
    const overlap = local2?.acceptedUrls?.filter(url => local22?.acceptedUrls?.includes(url)) || [];
    return {
      trial,
      page,
      wins,
      allTimingWins: Object.values(wins).every(Boolean),
      local2Accepted: local2?.accepted || 0,
      local22Accepted: local22?.accepted || 0,
      overlap,
      local2,
      local22
    };
  });
  const passed = comparisons.every(comparison =>
    comparison.allTimingWins &&
    comparison.local2?.hardSafe &&
    comparison.local2?.fiveByFive?.ok
  );
  await emitReport({
    benchmark: 'actual Pong Local 2 versus Local 2.2 paired one-page hidden muted playback',
    timestamp: new Date().toISOString(),
    pages,
    passed,
    comparisons
  });
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
