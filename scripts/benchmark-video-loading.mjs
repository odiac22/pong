import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const LOCAL_AI = String(process.env.PONG_BENCH_LOCAL_AI || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CHROME = process.env.PONG_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGES = [...new Set(String(process.env.PONG_BENCH_PAGES || '1095,2498,2431')
  .split(',').map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 3500))];
const TARGET_VIDEO_COUNT = 10;
const ATTEMPT_POOL_SIZE = 15;
const DISCOVERY_TIMEOUT_MS = Math.max(60_000, Number(process.env.PONG_MEDIA_BENCH_DISCOVERY_MS || 600_000));
const FIRST_FRAME_TIMEOUT_MS = Math.max(15_000, Number(process.env.PONG_MEDIA_BENCH_FIRST_FRAME_MS || 45_000));
const MAX_VIDEO_WALL_MS = Math.max(120_000, Number(process.env.PONG_MEDIA_BENCH_MAX_VIDEO_MS || 1_200_000));
const COMPLETE_CACHE_TIMEOUT_MS = Math.max(120_000, Number(process.env.PONG_MEDIA_BENCH_CACHE_READY_MS || 900_000));
const requestedMethods = [...new Set(String(process.env.PONG_MEDIA_BENCH_METHODS || 'direct,proxy,growing,hybrid,complete')
  .split(',').map(value => value.trim().toLowerCase())
  .filter(value => ['direct', 'proxy', 'growing', 'hybrid', 'complete'].includes(value)))];
// Current production must run first. It is the only method that intentionally
// retains the live Local2 discovery workload and its real background warming.
const METHOD_ORDER = requestedMethods.includes('hybrid')
  ? ['hybrid', ...requestedMethods.filter(method => method !== 'hybrid')]
  : requestedMethods;

if (PAGES.length !== 3) throw new Error('PONG_BENCH_PAGES must contain exactly three distinct pages');
if (!METHOD_ORDER.length) throw new Error('PONG_MEDIA_BENCH_METHODS did not contain a supported method');

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

class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
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
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
      else pending.resolve(message.result || {});
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
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(description || 'browser evaluation failed');
    }
    return response.result?.value;
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
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pong-media-bench-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--mute-audio',
    '--disable-audio-output',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=MediaRouter,Translate',
    '--disk-cache-size=1',
    '--media-cache-size=1',
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
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await Promise.race([new Promise(resolve => killer.once('close', resolve)), delay(5_000)]);
}

async function removeChromeProfile(profile) {
  const resolvedProfile = path.resolve(profile);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (path.dirname(resolvedProfile) !== resolvedTemp || !path.basename(resolvedProfile).startsWith('pong-media-bench-')) {
    throw new Error(`refusing to remove unexpected benchmark profile: ${resolvedProfile}`);
  }
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(resolvedProfile, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

async function openPage(chromePort, url) {
  const target = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  }).then(response => response.json());
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await Promise.all([
    session.send('Runtime.enable'),
    session.send('Page.enable'),
    session.send('DOM.enable'),
    session.send('Network.enable'),
  ]);
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  const browserVersion = await session.send('Browser.getVersion').catch(() => ({}));
  const chromeFullVersion = String(browserVersion.product || '').split('/')[1] || '140.0.0.0';
  const chromeMajorVersion = chromeFullVersion.split('.')[0] || '140';
  const androidUserAgent = [
    'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241105.007)',
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    `Chrome/${chromeFullVersion} Mobile Safari/537.36`,
  ].join(' ');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    screenWidth: 412,
    screenHeight: 915,
    positionX: 0,
    positionY: 0,
    dontSetVisibleSize: false,
  });
  await session.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  });
  await session.send('Network.setUserAgentOverride', {
    userAgent: androidUserAgent,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'Android',
    userAgentMetadata: {
      brands: [
        { brand: 'Not_A Brand', version: '99' },
        { brand: 'Chromium', version: chromeMajorVersion },
        { brand: 'Google Chrome', version: chromeMajorVersion },
      ],
      fullVersionList: [
        { brand: 'Not_A Brand', version: '99.0.0.0' },
        { brand: 'Chromium', version: chromeFullVersion },
        { brand: 'Google Chrome', version: chromeFullVersion },
      ],
      platform: 'Android',
      platformVersion: '15.0.0',
      architecture: '',
      model: 'Pixel 8',
      mobile: true,
      bitness: '',
      wow64: false,
    },
  });
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
      if (OriginalAudioContext) {
        class MutedAudioContext extends OriginalAudioContext {
          constructor(...args) {
            super(...args);
            try { this.suspend(); } catch (_) {}
          }
        }
        if (window.AudioContext) window.AudioContext = MutedAudioContext;
        if (window.webkitAudioContext) window.webkitAudioContext = MutedAudioContext;
      }
      Object.defineProperty(window, '__pongMediaBenchmarkHeadless', { value: true });
    })();`,
  });
  return {
    target,
    session,
    emulation: {
      kind: 'Android-like Chrome on PC',
      physicalPhone: false,
      userAgent: androidUserAgent,
      viewportCssPixels: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      touchPoints: 5,
    },
  };
}

async function trustedTouchTap(session, selector) {
  const documentNode = await session.send('DOM.getDocument', { depth: 1 });
  const buttonNode = await session.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!buttonNode.nodeId) throw new Error(`button ${selector} was not found`);
  await session.send('DOM.scrollIntoViewIfNeeded', { nodeId: buttonNode.nodeId });
  const model = await session.send('DOM.getBoxModel', { nodeId: buttonNode.nodeId });
  const points = model.model?.border || model.model?.content;
  if (!Array.isArray(points) || points.length < 8) throw new Error(`button ${selector} has no box model`);
  const x = (points[0] + points[2] + points[4] + points[6]) / 4;
  const y = (points[1] + points[3] + points[5] + points[7]) / 4;
  const touch = [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch });
  await delay(35);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function trustedSwipeUp(session, selector = '.video-wrapper.deck-active .tap-area') {
  const documentNode = await session.send('DOM.getDocument', { depth: 1 });
  const node = await session.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!node.nodeId) throw new Error(`swipe target ${selector} was not found`);
  await session.send('DOM.scrollIntoViewIfNeeded', { nodeId: node.nodeId });
  const model = await session.send('DOM.getBoxModel', { nodeId: node.nodeId });
  const points = model.model?.border || model.model?.content;
  if (!Array.isArray(points) || points.length < 8) throw new Error(`swipe target ${selector} has no box model`);
  const x = (points[0] + points[2] + points[4] + points[6]) / 4;
  const top = Math.min(points[1], points[3], points[5], points[7]);
  const bottom = Math.max(points[1], points[3], points[5], points[7]);
  const startY = Math.max(top + 100, bottom - 180);
  const endY = Math.min(bottom - 100, top + 180);
  const touch = y => [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(startY) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch((startY + endY) / 2) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(endY) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function dismissPongSplash(session) {
  for (let index = 0; index < 3; index++) {
    await trustedTouchTap(session, '#pong-hotspot');
    await delay(80);
  }
  await waitFor(
    () => session.evaluate(`document.querySelector('#pong-overlay')?.classList.contains('hidden') === true`),
    3_000,
    'Pong splash dismissal'
  );
}

async function cacheStatus() {
  const response = await fetch(`${LOCAL_AI}/video-cache/status?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`video cache status failed: HTTP ${response.status}`);
  return response.json();
}

async function requiredJsonRequest(pathname, {
  method = 'GET',
  label = pathname,
  validate = payload => payload?.ok === true,
} = {}) {
  const response = await fetch(`${LOCAL_AI}${pathname}`, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}${raw ? ` ${raw.slice(0, 240)}` : ''}`);
  if (!validate(payload)) throw new Error(`${label} returned an unverified response: ${raw.slice(0, 240)}`);
  return payload;
}

function recordForUrl(payload, url) {
  return (payload?.records || []).find(record => (record.urls || []).includes(url)) || null;
}

function compactCacheSnapshot(payload, url = '') {
  const record = url ? recordForUrl(payload, url) : null;
  const cache = payload?.cache || {};
  return {
    capturedAt: new Date().toISOString(),
    record: record ? {
      id: record.id || '',
      status: record.status || '',
      ready: record.ready === true,
      playable: record.playable === true,
      bytes: Number(record.bytes || 0),
      availableBytes: Number(record.availableBytes || 0),
      totalBytes: Number(record.totalBytes || 0),
      contentType: String(record.contentType || ''),
      playbackUrl: String(record.playbackUrl || ''),
    } : null,
    cache: {
      ready: Number(cache.ready || 0),
      downloading: Number(cache.downloading || 0),
      queued: Number(cache.queued || 0),
      errors: Number(cache.errors || 0),
      records: Number(cache.records || 0),
      bytes: Number(cache.bytes || 0),
      partialBytes: Number(cache.partial_bytes || 0),
      activeReaders: Number(cache.active_readers || 0),
    },
  };
}

async function cacheSnapshotsForUrls(urls) {
  const status = await cacheStatus();
  return Object.fromEntries(urls.map(url => [url, compactCacheSnapshot(status, url)]));
}

async function resetCache({ verify = true } = {}) {
  const response = await fetch(`${LOCAL_AI}/video-cache/reset`, { method: 'POST' });
  if (!response.ok) throw new Error(`video cache reset failed: HTTP ${response.status}`);
  if (!verify) {
    await delay(100);
    return;
  }
  await waitFor(async () => {
    const status = await cacheStatus();
    return Number(status?.cache?.records || 0) === 0 ? status : null;
  }, 15_000, 'empty local video cache after reset', 100);
}

async function detachPageMediaBeforeCacheReset(session) {
  await session.evaluate(`(() => {
    try { stopVisibleBatchAutoRetry(); } catch (_) {}
    try { transferForegroundVideoPriority(null); } catch (_) {}
    try { clearTimeout(random40PreloadTimer); } catch (_) {}
    try { clearTimeout(random40PreloadPumpTimer); } catch (_) {}
    try { cleanupRandom40PreloadPool(new Set()); } catch (_) {}
    document.querySelectorAll('video').forEach(video => {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (_) {}
    });
    return true;
  })()`);
  // Let cancellation reach the Node readers before resetting their records.
  await delay(150);
}

async function warmCache(urls, activeUrl = '', currentUrls = []) {
  const response = await fetch(`${LOCAL_AI}/video-cache/warm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeUrl, currentUrls, urls }),
  });
  if (!response.ok) throw new Error(`video cache warm failed: HTTP ${response.status}`);
  return response.json();
}

async function waitForAllReady(urls, timeoutMs = COMPLETE_CACHE_TIMEOUT_MS) {
  const startedAt = Date.now();
  const status = await waitFor(async () => {
    const latest = await cacheStatus();
    return urls.every(url => recordForUrl(latest, url)?.ready === true) ? latest : null;
  }, timeoutMs, `${urls.length} complete local video-cache files`, 250);
  return { status, waitMs: Date.now() - startedAt };
}

function proxyUrl(url) {
  return `${LOCAL_AI}/proxy?url=${encodeURIComponent(url)}`;
}

function growingUrl(url) {
  return `${LOCAL_AI}/video-cache/stream?url=${encodeURIComponent(url)}`;
}

function routeKind(url) {
  const value = String(url || '');
  if (value.includes('/video-cache/stream?')) return 'growing-cache';
  if (value.includes('/video-cache/media/')) return 'complete-cache';
  if (value.includes('/proxy?')) return 'proxy';
  return value ? 'direct' : 'none';
}

function summarize(values) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const percentile = ratio => numbers[Math.min(numbers.length - 1, Math.floor((numbers.length - 1) * ratio))];
  return {
    min: Number(numbers[0].toFixed(1)),
    median: Number(percentile(0.5).toFixed(1)),
    p95: Number(percentile(0.95).toFixed(1)),
    max: Number(numbers.at(-1).toFixed(1)),
    mean: Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(1)),
  };
}

function createNetworkRecorder(session) {
  const requests = new Map();
  const events = [];
  const remember = (kind, params, request = {}) => {
    events.push({
      at: new Date().toISOString(),
      kind,
      requestId: String(params.requestId || ''),
      url: String(request.url || ''),
      type: String(request.type || params.type || ''),
      status: Number(params.response?.status || request.status || 0),
      mimeType: String(params.response?.mimeType || request.mimeType || ''),
      errorText: String(params.errorText || ''),
      canceled: params.canceled === true,
      encodedDataLength: Number(params.encodedDataLength || 0),
    });
  };
  session.on('Network.requestWillBeSent', params => {
    requests.set(params.requestId, {
      url: params.request?.url || '',
      type: params.type || '',
      status: 0,
      mimeType: '',
    });
  });
  session.on('Network.responseReceived', params => {
    const request = requests.get(params.requestId) || {};
    request.url = params.response?.url || request.url || '';
    request.type = params.type || request.type || '';
    request.status = Number(params.response?.status || 0);
    request.mimeType = params.response?.mimeType || '';
    requests.set(params.requestId, request);
    if (request.type === 'Media' || /\/video-cache\/|\/proxy\?|\.(?:mp4|m4v|webm)(?:\?|$)/i.test(request.url)) {
      remember('response', params, request);
    }
  });
  session.on('Network.loadingFailed', params => {
    const request = requests.get(params.requestId) || {};
    if (request.type === 'Media' || /\/video-cache\/|\/proxy\?|\.(?:mp4|m4v|webm)(?:\?|$)/i.test(request.url || '')) {
      remember('failed', params, request);
    }
  });
  session.on('Network.loadingFinished', params => {
    const request = requests.get(params.requestId) || {};
    if (request.type === 'Media' || /\/video-cache\/|\/proxy\?|\.(?:mp4|m4v|webm)(?:\?|$)/i.test(request.url || '')) {
      remember('finished', params, request);
    }
  });
  return {
    mark: () => events.length,
    relatedSince(mark, originalUrl, routeHistory = []) {
      const aliases = new Set([originalUrl, ...routeHistory.map(item => item.url)].filter(Boolean));
      return events.slice(mark).filter(event => {
        if (aliases.has(event.url)) return true;
        try {
          const decoded = decodeURIComponent(event.url);
          return decoded.includes(originalUrl) || [...aliases].some(alias => alias && decoded.includes(alias));
        } catch (_) {
          return event.url.includes(originalUrl);
        }
      });
    },
  };
}

async function acquireFirstLocal2Artist(session) {
  await waitFor(() => session.evaluate(`document.readyState === 'complete' && typeof startRandom40 === 'function'`), 20_000, 'Pong page');
  const priorTimeOrigin = Number(await session.evaluate(`performance.timeOrigin`));
  await session.evaluate(`
    ['pong_session_v1','pong_random40_model_reject_cache_v1','pong_random40_stage_timing_v2','pong_random40_model_accuracy_v2']
      .forEach(key => localStorage.removeItem(key));
    localStorage.setItem('pong_random40_local_endpoint_v1', ${JSON.stringify(LOCAL_AI)});
    localStorage.setItem('pong_player_audio_pref_v2', 'muted');
    setTimeout(() => location.reload(), 0);
    true
  `);
  await waitFor(() => session.evaluate(`
    document.readyState === 'complete' &&
    typeof startRandom40 === 'function' &&
    performance.timeOrigin !== ${Number(priorTimeOrigin)}
  `), 20_000, 'Pong reload');
  await dismissPongSplash(session);
  await session.evaluate(`(() => {
    window.autoplayEnabled = false;
    window.__pongMediaBenchTouch = null;
    window.__pongMediaBenchClick = null;
    document.querySelector('#random-40-local2').addEventListener('touchend', event => {
      window.__pongMediaBenchTouch = {
        trusted: event.isTrusted,
        wallAt: Date.now(),
        performanceAt: performance.now()
      };
    }, { capture: true, once: true });
    document.querySelector('#random-40-local2').addEventListener('click', event => {
      window.__pongMediaBenchClick = {
        trusted: event.isTrusted,
        wallAt: Date.now(),
        performanceAt: performance.now()
      };
    }, { capture: true, once: true });
    return true;
  })()`);
  await trustedTouchTap(session, '#random-40-local2');

  const manifest = await waitFor(() => session.evaluate(`(() => {
    if (!window.__pongMediaBenchTouch?.trusted || !window.__pongMediaBenchClick?.trusted || !Array.isArray(pasteEvents) || !Array.isArray(allVideoUrls)) return null;
    for (let eventIndex = 0; eventIndex < pasteEvents.length; eventIndex++) {
      const event = pasteEvents[eventIndex];
      if (!isRandom40PasteEvent(event)) continue;
      const bounds = getPasteEventVideoBounds(event);
      if (!bounds) continue;
      const seen = new Set();
      const videos = [];
      for (let globalIndex = bounds.start; globalIndex < bounds.end; globalIndex++) {
        const url = String(allVideoUrls[globalIndex] || '');
        if (!url || seen.has(url)) continue;
        seen.add(url);
        videos.push({
          url,
          metadata: { ...(allVideoMetadata[globalIndex] || {}) },
          globalIndex
        });
      }
      if (videos.length < 15) continue;
      const activeWrapper = document.querySelector('.video-wrapper.deck-active');
      const activeVideo = activeWrapper?.querySelector('video');
      if (!activeWrapper || !activeVideo) continue;
      const state = random40State || {};
      return {
        touch: window.__pongMediaBenchTouch,
        click: window.__pongMediaBenchClick,
        eventIndex,
        event: { ...event },
        artist: event.artistDisplayName || event.artistKey || event.artistUrl || '',
        artistUrl: event.artistUrl || '',
        sourcePage: Number(event.sourcePage || 0),
        videos,
        activeOriginalUrl: String(activeWrapper.dataset.originalVideoUrl || ''),
        browserEnvironment: {
          userAgent: navigator.userAgent,
          platform: navigator.userAgentData?.platform || navigator.platform || '',
          mobile: navigator.userAgentData?.mobile === true,
          viewportCssPixels: { width: innerWidth, height: innerHeight },
          deviceScaleFactor: devicePixelRatio,
          maxTouchPoints: Number(navigator.maxTouchPoints || 0),
          visibilityState: document.visibilityState
        },
        state: {
          mode: String(state.mode || ''),
          startedAt: Number(state.startedAt || 0),
          firstVideoRecordedAt: Number(state.firstVideoRecordedAt || 0),
          accepted: Number(state.accepted || 0),
          videos: Number(state.videos || 0),
          pages: Number(state.pages || 0),
          api: Number(state.api || 0),
          stageTimings: state.stageTimings || {},
          verdictAudit: [...(state.verdictAudit || [])]
        },
        observedAt: Date.now()
      };
    }
    return null;
  })()`), DISCOVERY_TIMEOUT_MS, 'first accepted Local2 artist and real Pong card', 100);

  if (!manifest?.touch?.trusted || !manifest?.click?.trusted) {
    throw new Error('Local2 was not started by a trusted CDP touch and its production click activation');
  }
  if (manifest.state?.mode !== 'local2') throw new Error(`trusted button started unexpected mode: ${manifest.state?.mode || 'none'}`);
  const frozen = manifest.videos.slice(0, ATTEMPT_POOL_SIZE);
  if (new Set(frozen.map(item => item.url)).size !== ATTEMPT_POOL_SIZE) {
    throw new Error(`first Local2 artist did not expose ${ATTEMPT_POOL_SIZE} distinct attempt videos`);
  }
  return {
    ...manifest,
    frozen,
    buttonToDiscoveryMs: manifest.state.firstVideoRecordedAt && manifest.state.startedAt
      ? manifest.state.firstVideoRecordedAt - manifest.state.startedAt
      : manifest.observedAt - manifest.touch.wallAt,
    buttonToActiveCardMs: manifest.observedAt - manifest.touch.wallAt,
  };
}

async function quiesceProductionWork(session) {
  await session.evaluate(`(async () => {
    if (random40State) {
      random40State.stop = true;
      try { random40State.abortController?.abort(); } catch (_) {}
      try { await random40ReleasePlaybackProtection(random40State); } catch (_) {}
    }
    try { pongWorkloadAbortControllers.forEach(controller => controller.abort()); } catch (_) {}
    clearTimeout(random40PreloadTimer);
    clearTimeout(random40PreloadPumpTimer);
    clearInterval(random40ServerVideoCachePollTimer);
    clearInterval(random40ServerVideoCacheHeartbeatTimer);
    random40ServerVideoCachePollTimer = null;
    random40ServerVideoCacheHeartbeatTimer = null;
    try { cleanupRandom40PreloadPool(new Set()); } catch (_) {}
    random40PreloadActive = 0;
    document.querySelectorAll('video').forEach(video => {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
    });
    if (!window.__pongBenchmarkOriginalFunctions) {
      window.__pongBenchmarkOriginalFunctions = {
        warmActive: random40WarmServerVideoCacheForActiveWrapper,
        warm: random40WarmServerVideoCache,
        promote: random40PromoteWrapperToServerCache,
        schedule: scheduleRandom40PreloadPool,
        cacheEndpoint: random40ServerVideoCacheEndpoint
      };
    }
    random40WarmServerVideoCacheForActiveWrapper = () => Promise.resolve(null);
    random40WarmServerVideoCache = () => Promise.resolve({ ok: true, benchmarkSuppressed: true });
    random40PromoteWrapperToServerCache = () => false;
    return true;
  })()`);
  await requiredJsonRequest('/local2/stop', {
    method: 'POST',
    label: 'Local2 stop',
    validate: payload => payload?.ok === true && payload?.active === false && payload?.producer?.running === false,
  });
  await requiredJsonRequest('/workload/reset', {
    method: 'POST',
    label: 'workload reset',
    validate: payload => payload?.ok === true && Number.isInteger(Number(payload?.generation)),
  });
  await requiredJsonRequest('/local2/health', {
    label: 'Local2 stopped-state verification',
    validate: payload => payload?.ok === true && payload?.active === false && payload?.producer?.running === false,
  });
  // Let already-delivered browser warm calls settle before the next method's
  // verified cache reset establishes its isolated baseline.
  await delay(500);
}

async function prepareActualPongCards(session, acquisition, routes, {
  productionWarm = false,
  browserBackgroundPreload = false,
} = {}) {
  const urls = acquisition.frozen.map(item => item.url);
  const metadata = acquisition.frozen.map(item => item.metadata || {});
  const routeEntries = routes ? urls.map((url, index) => [url, routes[index] || url]) : [];
  const prepared = await session.evaluate(`(() => {
    const urls = ${JSON.stringify(urls)};
    const metadata = ${JSON.stringify(metadata)};
    const routeEntries = ${JSON.stringify(routeEntries)};
    if (window.__pongBenchmarkOriginalFunctions) {
      scheduleRandom40PreloadPool = window.__pongBenchmarkOriginalFunctions.schedule;
      random40ServerVideoCacheEndpoint = ${browserBackgroundPreload ? '() => \'\'' : 'window.__pongBenchmarkOriginalFunctions.cacheEndpoint'};
    }
    document.querySelectorAll('video').forEach(video => {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
    });
    stopVisibleBatchAutoRetry();
    transferForegroundVideoPriority(null);
    clearTimeout(random40PreloadTimer);
    clearTimeout(random40PreloadPumpTimer);
    try { cleanupRandom40PreloadPool(new Set()); } catch (_) {}
    random40PreloadActive = 0;
    random40PlaybackUrlOverrides.clear();
    ${productionWarm ? '' : 'random40ServerVideoCacheTracked.clear();'}
    random40ServerVideoCacheManifestSignature = '';
    random40ServerVideoCacheManifestInFlightSignature = '';
    routeEntries.forEach(([originalUrl, playbackUrl]) => random40RememberPlaybackOverride(originalUrl, playbackUrl));
    allVideoUrls = [...urls];
    allVideoMetadata = metadata.map(item => ({ ...item }));
    parsedVideoUrlsCache = [...urls];
    parsedVideoMetadataCache = metadata.map(item => ({ ...item }));
    videoUrls = [];
    videoMetadata = [];
    pendingPastes = [];
    _prevUrlCount = urls.length;
    parseCacheDirty = false;
    pasteEvents = [{
      ...${JSON.stringify(acquisition.event)},
      startIndex: 0,
      count: urls.length,
      loadAll: false,
      ready: true,
      pending: false
    }];
    currentPasteIndex = -1;
    if (viewedVideoKeys?.clear) viewedVideoKeys.clear();
    resetPaperclipQueue();
    window.autoplayEnabled = false;
    window.PongLoadedSavedMode = 'random40';
    setEromeTwentyCardMode(true, { respectRange: true });
    setActivePlaybackRangeForPasteEvent(0, { recordHistory: true });
    window.PongFastNextBatchOnce = true;
    loadNextBatch(0);
    setTimeout(() => {
      try { scheduleRandom40PreloadPool(0); } catch (_) {}
    }, 0);
    return { urls: [...allVideoUrls], event: { ...pasteEvents[0] } };
  })()`);
  if (prepared?.urls?.length !== urls.length) throw new Error('failed to install frozen Pong benchmark cards');
  return waitFor(() => session.evaluate(`(() => {
    const wrapper = document.querySelector('.video-wrapper.deck-active');
    const video = wrapper?.querySelector('video');
    if (!wrapper || !video) return null;
    return {
      originalUrl: String(wrapper.dataset.originalVideoUrl || ''),
      source: String(video.currentSrc || video.src || ''),
      paused: Boolean(video.paused),
      cardCount: document.querySelectorAll('.video-wrapper').length
    };
  })()`), 10_000, 'frozen actual Pong cards', 50);
}

function installNaturalEndProbeExpression(maxVideoWallMs, firstFrameTimeoutMs, requestedProbeId) {
  const probeId = String(requestedProbeId || '');
  const selector = `.video-wrapper.deck-active[data-pong-benchmark-probe="${probeId}"] .tap-area[data-pong-benchmark-probe="${probeId}"]`;
  return `(() => {
  try { window.__pongNaturalProbeCancel?.('superseded'); } catch (_) {}
  const wrapper = document.querySelector('.video-wrapper.deck-active');
  const video = wrapper?.querySelector('video');
  const tapArea = wrapper?.querySelector('.tap-area');
  if (!wrapper || !video || !tapArea) throw new Error('Pong active player was not found');
  if (!video.paused || video.ended) throw new Error('Pong benchmark card must be paused and unended before the trusted tap');
  const probeId = ${JSON.stringify(probeId)};
  const selector = ${JSON.stringify(selector)};
  wrapper.dataset.pongBenchmarkProbe = probeId;
  tapArea.dataset.pongBenchmarkProbe = probeId;
  try {
    deckAutoPromotionLockedUntil = Math.max(Number(deckAutoPromotionLockedUntil || 0), Date.now() + 10_000);
    clearDeckReadyPromotion();
  } catch (_) {}
  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  video.loop = false;
  video.playbackRate = 1;
  video.defaultPlaybackRate = 1;

  const installedAt = performance.now();
  const originalUrl = String(wrapper.dataset.originalVideoUrl || '');
  let playIntentAt = 0;
  let firstPlayingAt = 0;
  let firstFrameAt = 0;
  let endedAt = 0;
  let startMediaTime = Number(video.currentTime || 0);
  let firstFrameMetadata = null;
  let waitingEvents = 0;
  let stalledEvents = 0;
  let waitingAfterFirstFrame = 0;
  let stalledAfterFirstFrame = 0;
  let activeRebuffer = null;
  const rebufferEpisodes = [];
  const routeHistory = [];
  const mediaErrors = [];
  let frameRequest = 0;
  let routeTimer = 0;
  let qualityTimer = 0;
  let firstFrameTimer = 0;
  let wallTimer = 0;
  let intentTimer = 0;
  let settled = false;
  let qualityLastTotal = 0;
  let qualityLastDropped = 0;
  let qualityTotalDelta = 0;
  let qualityDroppedDelta = 0;

  const relativeNow = () => playIntentAt ? performance.now() - playIntentAt : performance.now() - installedAt;
  const quality = () => typeof video.getVideoPlaybackQuality === 'function'
    ? video.getVideoPlaybackQuality()
    : {};
  const sampleQuality = () => {
    const current = quality();
    const total = Number(current.totalVideoFrames || 0);
    const dropped = Number(current.droppedVideoFrames || 0);
    qualityTotalDelta += total >= qualityLastTotal ? total - qualityLastTotal : total;
    qualityDroppedDelta += dropped >= qualityLastDropped ? dropped - qualityLastDropped : dropped;
    qualityLastTotal = total;
    qualityLastDropped = dropped;
  };
  const classifyRoute = value => {
    value = String(value || '');
    if (value.includes('/video-cache/stream?')) return 'growing-cache';
    if (value.includes('/video-cache/media/')) return 'complete-cache';
    if (value.includes('/proxy?')) return 'proxy';
    return value ? 'direct' : 'none';
  };
  const noteRoute = event => {
    const url = String(video.currentSrc || video.src || '');
    const prior = routeHistory[routeHistory.length - 1];
    if (prior?.url === url) return;
    routeHistory.push({ event, atMs: Number(relativeNow().toFixed(1)), url, kind: classifyRoute(url) });
  };
  const startRebuffer = trigger => {
    if (!firstFrameAt || activeRebuffer) return;
    activeRebuffer = { trigger, startedAt: performance.now(), startedAtMs: relativeNow() };
  };
  const closeRebuffer = reason => {
    if (!activeRebuffer) return;
    const ended = performance.now();
    rebufferEpisodes.push({
      trigger: activeRebuffer.trigger,
      reason,
      startedAtMs: Number(activeRebuffer.startedAtMs.toFixed(1)),
      endedAtMs: Number((ended - playIntentAt).toFixed(1)),
      durationMs: Number((ended - activeRebuffer.startedAt).toFixed(1))
    });
    activeRebuffer = null;
  };
  const armFirstFrame = () => {
    if (!playIntentAt || firstFrameAt || typeof video.requestVideoFrameCallback !== 'function') return;
    if (frameRequest && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(frameRequest); } catch (_) {}
    }
    frameRequest = video.requestVideoFrameCallback((now, metadata) => {
      if (settled || firstFrameAt) return;
      firstFrameAt = now;
      clearTimeout(firstFrameTimer);
      firstFrameTimer = 0;
      firstFrameMetadata = {
        mediaTime: Number(metadata?.mediaTime || 0),
        presentedFrames: Number(metadata?.presentedFrames || 0),
        expectedDisplayTime: Number(metadata?.expectedDisplayTime || 0)
      };
      sampleQuality();
      if (window.__pongNaturalProbeLive?.probeId === probeId) {
        window.__pongNaturalProbeLive.firstFrameAt = firstFrameAt;
        window.__pongNaturalProbeLive.firstFrameMs = firstFrameAt - playIntentAt;
        window.__pongNaturalProbeLive.source = String(video.currentSrc || video.src || '');
      }
    });
  };

  window.__pongNaturalProbeLive = {
    probeId,
    originalUrl,
    installedAt,
    playIntentAt: 0,
    firstFrameAt: 0,
    firstFrameMs: null,
    source: String(video.currentSrc || video.src || '')
  };

  window.__pongNaturalProbePromise = new Promise(resolve => {
    const cleanup = () => {
      tapArea.removeEventListener('touchend', onIntent, true);
      tapArea.removeEventListener('click', onIntent, true);
      video.removeEventListener('loadstart', onLoadStart);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('durationchange', onMetadata);
      video.removeEventListener('error', onError);
      video.removeEventListener('ended', onEnded);
      clearInterval(routeTimer);
      clearInterval(qualityTimer);
      clearTimeout(firstFrameTimer);
      clearTimeout(wallTimer);
      clearTimeout(intentTimer);
      if (frameRequest && typeof video.cancelVideoFrameCallback === 'function') {
        try { video.cancelVideoFrameCallback(frameRequest); } catch (_) {}
      }
      if (wrapper.dataset.pongBenchmarkProbe === probeId) delete wrapper.dataset.pongBenchmarkProbe;
      if (tapArea.dataset.pongBenchmarkProbe === probeId) delete tapArea.dataset.pongBenchmarkProbe;
      if (window.__pongNaturalProbeLive?.probeId === probeId) window.__pongNaturalProbeCancel = null;
    };
    const finish = termination => {
      if (settled) return;
      settled = true;
      if (termination === 'ended') endedAt = performance.now();
      closeRebuffer(termination);
      noteRoute(termination);
      sampleQuality();
      if (termination !== 'ended') {
        try { video.pause(); } catch (_) {}
      }
      cleanup();
      const duration = Number(video.duration || 0);
      const endMediaTime = Number(video.currentTime || 0);
      const mediaAdvancedSeconds = Math.max(0, endMediaTime - startMediaTime);
      const expectedMediaSeconds = Number.isFinite(duration)
        ? Math.max(0, duration - startMediaTime)
        : 0;
      const completionRatio = expectedMediaSeconds > 0
        ? Math.min(1, mediaAdvancedSeconds / expectedMediaSeconds)
        : 0;
      const totalRebufferMs = rebufferEpisodes.reduce((sum, episode) => sum + episode.durationMs, 0);
      const longestRebufferMs = Math.max(0, ...rebufferEpisodes.map(episode => episode.durationMs));
      const endedNaturally = termination === 'ended' && video.ended === true;
      const success = Boolean(
        endedNaturally &&
        playIntentAt > 0 &&
        firstFrameAt > 0 &&
        Number.isFinite(duration) && duration > 0 &&
        startMediaTime <= 0.25 &&
        completionRatio >= 0.995 &&
        qualityTotalDelta > 0
      );
      resolve({
        probeId,
        originalUrl,
        source: String(video.currentSrc || video.src || ''),
        success,
        termination,
        endedNaturally,
        startMediaTime,
        endMediaTime,
        durationSeconds: Number.isFinite(duration) ? duration : null,
        mediaAdvancedSeconds,
        completionRatio,
        playIntentTrusted: playIntentAt > 0,
        playIntentPerformanceAt: playIntentAt || null,
        firstPlayingMs: firstPlayingAt ? firstPlayingAt - playIntentAt : null,
        firstFrameMs: firstFrameAt ? firstFrameAt - playIntentAt : null,
        firstFrameMetadata,
        wallSeconds: playIntentAt ? (performance.now() - playIntentAt) / 1000 : null,
        waitingEvents,
        stalledEvents,
        waitingAfterFirstFrame,
        stalledAfterFirstFrame,
        rebufferCount: rebufferEpisodes.length,
        totalRebufferMs,
        longestRebufferMs,
        rebufferEpisodes,
        decodedFrames: qualityTotalDelta,
        droppedFrames: qualityDroppedDelta,
        droppedFrameRatio: qualityTotalDelta > 0 ? qualityDroppedDelta / qualityTotalDelta : null,
        routeHistory,
        mediaErrors,
        readyState: Number(video.readyState || 0),
        networkState: Number(video.networkState || 0),
        error: success ? '' : String(video.error?.message || termination)
      });
    };
    function onIntent(event) {
      if (!event.isTrusted || playIntentAt) return;
      const activeWrapper = document.querySelector('.video-wrapper.deck-active');
      if (
        activeWrapper !== wrapper ||
        wrapper.dataset.pongBenchmarkProbe !== probeId ||
        tapArea.dataset.pongBenchmarkProbe !== probeId ||
        String(wrapper.dataset.originalVideoUrl || '') !== originalUrl
      ) {
        finish('card-changed-before-intent');
        return;
      }
      clearTimeout(intentTimer);
      intentTimer = 0;
      playIntentAt = performance.now();
      startMediaTime = Number(video.currentTime || 0);
      const baseline = quality();
      qualityLastTotal = Number(baseline.totalVideoFrames || 0);
      qualityLastDropped = Number(baseline.droppedVideoFrames || 0);
      if (window.__pongNaturalProbeLive?.probeId === probeId) {
        window.__pongNaturalProbeLive.playIntentAt = playIntentAt;
      }
      noteRoute('trusted-play-intent');
      armFirstFrame();
      routeTimer = setInterval(() => noteRoute('poll'), 100);
      qualityTimer = setInterval(sampleQuality, 250);
      firstFrameTimer = setTimeout(() => finish('first-frame-timeout'), ${Number(firstFrameTimeoutMs)});
      wallTimer = setTimeout(() => finish('wall-timeout'), ${Number(maxVideoWallMs)});
      onMetadata();
    }
    function onLoadStart() {
      noteRoute('loadstart');
      if (playIntentAt && !firstFrameAt) setTimeout(armFirstFrame, 0);
    }
    function onPlaying() {
      if (!firstPlayingAt) firstPlayingAt = performance.now();
      closeRebuffer('playing');
      noteRoute('playing');
    }
    function onWaiting() {
      waitingEvents++;
      if (firstFrameAt) {
        waitingAfterFirstFrame++;
        startRebuffer('waiting');
      }
      noteRoute('waiting');
    }
    function onStalled() {
      stalledEvents++;
      if (firstFrameAt) {
        stalledAfterFirstFrame++;
        if (!video.paused && video.readyState < 3) startRebuffer('stalled');
      }
      noteRoute('stalled');
    }
    function onMetadata() {
      const duration = Number(video.duration || 0);
      if (!playIntentAt || !Number.isFinite(duration) || duration <= 0) return;
      const dynamicDeadline = Math.min(
        ${Number(maxVideoWallMs)},
        Math.max(60_000, Math.ceil(Math.max(0, duration - startMediaTime) * 3000 + 30_000))
      );
      clearTimeout(wallTimer);
      const remainingWallMs = Math.max(0, dynamicDeadline - (performance.now() - playIntentAt));
      wallTimer = setTimeout(() => finish('wall-timeout'), remainingWallMs);
    }
    function onError() {
      mediaErrors.push({
        atMs: Number(relativeNow().toFixed(1)),
        code: Number(video.error?.code || 0),
        message: String(video.error?.message || ''),
        source: String(video.currentSrc || video.src || '')
      });
      noteRoute('media-error');
      // Pong may recover by rotating growing-cache -> proxy -> direct. The
      // natural-end contract, rather than the first route error, is terminal.
    }
    function onEnded() { finish('ended'); }

    window.__pongNaturalProbeCancel = reason => finish(String(reason || 'canceled'));
    tapArea.addEventListener('touchend', onIntent, true);
    tapArea.addEventListener('click', onIntent, true);
    video.addEventListener('loadstart', onLoadStart);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onStalled);
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('durationchange', onMetadata);
    video.addEventListener('error', onError);
    video.addEventListener('ended', onEnded);
    intentTimer = setTimeout(() => finish('trusted-intent-timeout'), 5_000);
    noteRoute('installed');
  });

  return {
    probeId,
    selector,
    originalUrl,
    source: String(video.currentSrc || video.src || ''),
    paused: Boolean(video.paused),
    currentTime: Number(video.currentTime || 0),
    duration: Number(video.duration || 0)
  };
})()`;
}

async function probeActualPongPlayer(session, networkRecorder) {
  let lastPreIntentError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probeId = `pong-bench-${Date.now()}-${attempt}-${Math.random().toString(36).slice(2, 10)}`;
    let installed = null;
    let resultPromise = null;
    let firstFrameCachePromise = null;
    let probeSettled = false;
    let trustedIntentObserved = false;
    try {
      installed = await session.evaluate(
        installNaturalEndProbeExpression(MAX_VIDEO_WALL_MS, FIRST_FRAME_TIMEOUT_MS, probeId)
      );
      if (!installed?.paused) throw new Error('active Pong card started before the trusted benchmark tap');
      const originalUrl = String(installed.originalUrl || '');
      const cacheBefore = compactCacheSnapshot(await cacheStatus(), originalUrl);
      const identity = await session.evaluate(`(() => {
        const tapArea = document.querySelector(${JSON.stringify(installed.selector)});
        const wrapper = tapArea?.closest('.video-wrapper');
        const video = wrapper?.querySelector('video');
        if (
          !wrapper?.classList.contains('deck-active') ||
          wrapper.dataset.pongBenchmarkProbe !== ${JSON.stringify(probeId)} ||
          tapArea.dataset.pongBenchmarkProbe !== ${JSON.stringify(probeId)} ||
          String(wrapper.dataset.originalVideoUrl || '') !== ${JSON.stringify(originalUrl)} ||
          !video?.paused || video.ended
        ) return null;
        return {
          originalUrl: String(wrapper.dataset.originalVideoUrl || ''),
          source: String(video.currentSrc || video.src || ''),
          paused: Boolean(video.paused)
        };
      })()`);
      if (!identity) throw new Error('active Pong card changed before its trusted touch');

      const networkMark = networkRecorder.mark();
      resultPromise = session.evaluate(`window.__pongNaturalProbePromise`);
      firstFrameCachePromise = (async () => {
        const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS + 1_000;
        while (!probeSettled && Date.now() < deadline) {
          const live = await session.evaluate(`window.__pongNaturalProbeLive || null`).catch(() => null);
          if (live?.probeId === probeId && Number(live?.firstFrameAt || 0) > 0) {
            return compactCacheSnapshot(await cacheStatus(), originalUrl);
          }
          await delay(100);
        }
        return null;
      })();
      await trustedTouchTap(session, installed.selector);
      const trustedIntent = await waitFor(
        () => session.evaluate(`(() => {
          const live = window.__pongNaturalProbeLive;
          return live?.probeId === ${JSON.stringify(probeId)} && Number(live.playIntentAt || 0) > 0
            ? { probeId: live.probeId, playIntentAt: Number(live.playIntentAt) }
            : null;
        })()`),
        1_500,
        `trusted touch intent for ${originalUrl}`,
        40
      ).catch(() => null);
      if (!trustedIntent) throw new Error('trusted touch did not bind to the identified active Pong card');
      trustedIntentObserved = true;

      const result = await resultPromise;
      probeSettled = true;
      const cacheAtFirstFrame = await firstFrameCachePromise;
      if (result?.probeId !== probeId || result?.originalUrl !== originalUrl) {
        throw new Error('natural-end probe result did not match its identified Pong card');
      }
      const cacheAfter = compactCacheSnapshot(await cacheStatus(), originalUrl);
      const networkEvents = networkRecorder.relatedSince(networkMark, originalUrl, result?.routeHistory || []);
      const httpErrors = networkEvents.filter(event => event.kind === 'response' && event.status >= 400);
      const networkFailures = networkEvents.filter(event =>
        event.kind === 'failed' && !(event.canceled && /ERR_ABORTED/i.test(event.errorText))
      );
      return {
        ...result,
        touchBindingAttempts: attempt,
        initialRouteKind: routeKind(installed.source),
        finalRouteKind: routeKind(result?.source),
        cacheBefore,
        cacheAtFirstFrame,
        cacheAfter,
        networkEvents,
        httpErrors,
        networkFailures,
      };
    } catch (error) {
      lastPreIntentError = error;
      await session.evaluate(`window.__pongNaturalProbeCancel?.('trusted-intent-missed'); true`).catch(() => null);
      if (resultPromise) await resultPromise.catch(() => null);
      probeSettled = true;
      if (firstFrameCachePromise) await firstFrameCachePromise.catch(() => null);
      if (trustedIntentObserved) throw error;
      if (attempt < 3) await delay(100);
    }
  }
  throw new Error(`unable to bind a trusted touch to one stable Pong card after three attempts: ${lastPreIntentError?.message || 'unknown error'}`);
}

async function prepareMethod(session, method, acquisition, { productionLive }) {
  const urls = acquisition.frozen.map(item => item.url);
  const startedAt = Date.now();
  let routes = null;
  let completeCacheWaitMs = 0;

  if (method !== 'hybrid') {
    await detachPageMediaBeforeCacheReset(session);
    await session.send('Network.clearBrowserCache').catch(() => null);
    await resetCache({ verify: true });
  }

  if (method === 'direct') {
    routes = urls;
  } else if (method === 'proxy') {
    routes = urls.map(proxyUrl);
  } else if (method === 'growing') {
    await warmCache(urls, urls[0], urls);
    routes = urls.map(growingUrl);
  } else if (method === 'complete') {
    await warmCache(urls, urls[0], urls);
    const ready = await waitForAllReady(urls);
    completeCacheWaitMs = ready.waitMs;
    routes = urls.map(url => {
      const record = recordForUrl(ready.status, url);
      if (!record?.playbackUrl) throw new Error(`complete cache route missing for ${url}`);
      return record.playbackUrl;
    });
  } else if (method !== 'hybrid') {
    throw new Error(`unsupported benchmark method ${method}`);
  }

  const initialCard = await prepareActualPongCards(session, acquisition, routes, {
    productionWarm: method === 'hybrid' && productionLive,
    browserBackgroundPreload: method === 'direct' || method === 'proxy',
  });
  return {
    routes,
    initialCard,
    backgroundStrategy: method === 'hybrid'
      ? 'current production PC-cache scheduler'
      : method === 'direct' || method === 'proxy'
        ? 'actual Pong-card browser preload pool'
        : 'PC file-cache background scheduler',
    preparationMs: Date.now() - startedAt,
    completeCacheWaitMs,
    cacheAfterPreparation: null,
  };
}

async function navigateToNextUnseenPongCard(session, seen, frozenSet, priorUrl, method) {
  let previousUrl = String(priorUrl || '');
  for (let step = 0; step < frozenSet.size; step++) {
    await delay(300);
    const alreadyAdvanced = await session.evaluate(`(() => {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      const originalUrl = String(wrapper?.dataset?.originalVideoUrl || '');
      return wrapper && video && originalUrl && originalUrl !== ${JSON.stringify(previousUrl)}
        ? { originalUrl, source: String(video.currentSrc || video.src || ''), paused: Boolean(video.paused) }
        : null;
    })()`);
    if (alreadyAdvanced) {
      if (!frozenSet.has(alreadyAdvanced.originalUrl)) {
        throw new Error(`${method} navigated outside the frozen ${frozenSet.size}-card attempt pool`);
      }
      if (!seen.has(alreadyAdvanced.originalUrl)) return alreadyAdvanced;
      previousUrl = alreadyAdvanced.originalUrl;
    }

    await trustedSwipeUp(session);
    const candidate = await waitFor(() => session.evaluate(`(() => {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      const originalUrl = String(wrapper?.dataset?.originalVideoUrl || '');
      return wrapper && video && originalUrl && originalUrl !== ${JSON.stringify(previousUrl)}
        ? { originalUrl, source: String(video.currentSrc || video.src || ''), paused: Boolean(video.paused) }
        : null;
    })()`), 10_000, `${method} trusted swipe to a distinct Pong card`, 50);
    if (!frozenSet.has(candidate.originalUrl)) {
      throw new Error(`${method} navigated outside the frozen ${frozenSet.size}-card attempt pool`);
    }
    if (!seen.has(candidate.originalUrl)) return candidate;
    previousUrl = candidate.originalUrl;
  }
  throw new Error(`${method} could not reach an unattempted Pong card through production swipe navigation`);
}

async function runMethod(session, networkRecorder, method, acquisition, { productionLive }) {
  const methodStartedAt = Date.now();
  const methodStartedPerformanceAt = Number(await session.evaluate(`performance.now()`));
  const setup = await prepareMethod(session, method, acquisition, { productionLive });
  const frozenUrls = acquisition.frozen.map(item => item.url);
  const frozenSet = new Set(frozenUrls);
  const seen = new Set();
  const probes = [];
  let active = await waitFor(() => session.evaluate(`(() => {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      return wrapper && video ? {
        originalUrl: String(wrapper.dataset.originalVideoUrl || ''),
        source: String(video.currentSrc || video.src || ''),
        paused: Boolean(video.paused)
      } : null;
    })()`), 10_000, 'first active Pong card', 50);

  while (seen.size < frozenUrls.length) {
    const qualifyingSoFar = new Set(probes
      .filter(probe => probe.success && probe.endedNaturally && probe.routeIntegrity)
      .map(probe => probe.originalUrl)).size;
    if (qualifyingSoFar >= TARGET_VIDEO_COUNT) break;
    if (!frozenSet.has(active.originalUrl)) {
      throw new Error(`${method} navigated outside the frozen ${frozenUrls.length}-card attempt pool`);
    }
    if (seen.has(active.originalUrl)) {
      active = await navigateToNextUnseenPongCard(session, seen, frozenSet, active.originalUrl, method);
      continue;
    }

    const probe = await probeActualPongPlayer(session, networkRecorder);
    if (!frozenSet.has(probe.originalUrl)) {
      throw new Error(`${method} probed a card outside the frozen ${frozenUrls.length}-card attempt pool`);
    }
    if (seen.has(probe.originalUrl)) throw new Error(`${method} probed an already attempted Pong card`);
    seen.add(probe.originalUrl);
    const playIntentPerformanceAt = Number(probe.playIntentPerformanceAt || 0);
    const observedRouteKinds = [...new Set((probe.routeHistory || [])
      .map(route => route.kind)
      .filter(kind => kind && kind !== 'none'))];
    const expectedRouteKind = method === 'growing'
      ? 'growing-cache'
      : method === 'complete'
        ? 'complete-cache'
        : method;
    const routeIntegrity = method === 'hybrid' || (
      observedRouteKinds.length > 0 &&
      observedRouteKinds.every(kind => kind === expectedRouteKind)
    );
    probes.push({
      sequence: probes.length + 1,
      artist: acquisition.artist,
      buttonToDiscoveryMs: acquisition.buttonToDiscoveryMs,
      methodToFirstFrameMs: playIntentPerformanceAt && Number.isFinite(probe.firstFrameMs)
        ? playIntentPerformanceAt + Number(probe.firstFrameMs) - methodStartedPerformanceAt
        : null,
      observedRouteKinds,
      expectedRouteKind: method === 'hybrid' ? 'current production with recovery' : expectedRouteKind,
      routeIntegrity,
      methodElapsedAtEndMs: Date.now() - methodStartedAt,
      ...probe,
    });
    const qualifyingNow = new Set(probes
      .filter(item => item.success && item.endedNaturally && item.routeIntegrity)
      .map(item => item.originalUrl)).size;
    if (qualifyingNow >= TARGET_VIDEO_COUNT || seen.size >= frozenUrls.length) break;
    active = await navigateToNextUnseenPongCard(session, seen, frozenSet, probe.originalUrl, method);
  }

  const naturalEnds = probes.filter(probe => probe.success && probe.endedNaturally).length;
  setup.cacheAtMethodEnd = await cacheSnapshotsForUrls(frozenUrls);
  const distinctNaturalEnds = new Set(
    probes.filter(probe => probe.success && probe.endedNaturally).map(probe => probe.originalUrl)
  ).size;
  const qualifyingProbes = probes.filter(probe => probe.success && probe.endedNaturally && probe.routeIntegrity);
  const qualifyingNaturalEnds = qualifyingProbes.length;
  const distinctQualifyingNaturalEnds = new Set(qualifyingProbes.map(probe => probe.originalUrl)).size;
  const summary = {
    naturalEnds,
    distinctNaturalEnds,
    qualifyingNaturalEnds,
    distinctQualifyingNaturalEnds,
    total: probes.length,
    methodToFirstFrameMs: probes[0]?.methodToFirstFrameMs ?? null,
    firstFrameMs: summarize(probes.map(probe => probe.firstFrameMs)),
    completionWallSeconds: summarize(probes.map(probe => probe.wallSeconds)),
    mediaDurationSeconds: summarize(probes.map(probe => probe.durationSeconds)),
    totalWaitingEvents: probes.reduce((sum, probe) => sum + Number(probe.waitingEvents || 0), 0),
    totalStalledEvents: probes.reduce((sum, probe) => sum + Number(probe.stalledEvents || 0), 0),
    totalRebuffers: probes.reduce((sum, probe) => sum + Number(probe.rebufferCount || 0), 0),
    totalRebufferMs: Number(probes.reduce((sum, probe) => sum + Number(probe.totalRebufferMs || 0), 0).toFixed(1)),
    longestRebufferMs: Math.max(0, ...probes.map(probe => Number(probe.longestRebufferMs || 0))),
    decodedFrames: probes.reduce((sum, probe) => sum + Number(probe.decodedFrames || 0), 0),
    droppedFrames: probes.reduce((sum, probe) => sum + Number(probe.droppedFrames || 0), 0),
    routeKinds: probes.reduce((counts, probe) => {
      for (const route of probe.routeHistory || []) counts[route.kind] = Number(counts[route.kind] || 0) + 1;
      return counts;
    }, {}),
    mediaErrors: probes.reduce((sum, probe) => sum + Number(probe.mediaErrors?.length || 0), 0),
    httpErrors: probes.reduce((sum, probe) => sum + Number(probe.httpErrors?.length || 0), 0),
    networkFailures: probes.reduce((sum, probe) => sum + Number(probe.networkFailures?.length || 0), 0),
    routeIntegrity: distinctQualifyingNaturalEnds >= TARGET_VIDEO_COUNT,
    preparationMs: setup.preparationMs,
    completeCacheWaitMs: setup.completeCacheWaitMs,
    methodWallMs: Date.now() - methodStartedAt,
    passed: distinctQualifyingNaturalEnds >= TARGET_VIDEO_COUNT,
  };
  return { method, setup, probes, summary };
}

async function main() {
  const health = await fetch(`${LOCAL_AI}/health`).then(response => response.json());
  if (!health?.ok || !health?.ready) throw new Error('Pong Local AI core is not ready');
  // Cold production begins before Local2 is clicked. Hybrid/current production
  // then keeps every real discovery and background-cache race intact.
  await resetCache({ verify: true });
  const staticServer = await startStaticServer();
  const chrome = await startChrome();
  let target = null;
  let session = null;
  let emulation = null;
  let report = null;
  try {
    const opened = await openPage(
      chrome.port,
      `${staticServer.url}?pongLiveScan=1&pongPages=${PAGES.join(',')}&t=${Date.now()}`
    );
    target = opened.target;
    session = opened.session;
    emulation = opened.emulation;
    const networkRecorder = createNetworkRecorder(session);
    const acquisition = await acquireFirstLocal2Artist(session);
    const frozenUrls = acquisition.frozen.map(item => item.url);
    // Capture discovery cache state immediately without holding the first real
    // Pong tap behind a full status response.
    const acquisitionCachePromise = cacheSnapshotsForUrls(frozenUrls).catch(() => null);
    const results = [];
    let productionQuiesced = false;

    for (const method of METHOD_ORDER) {
      if (method !== 'hybrid' && !productionQuiesced) {
        await quiesceProductionWork(session);
        productionQuiesced = true;
      }
      try {
        const result = await runMethod(session, networkRecorder, method, acquisition, {
          productionLive: method === 'hybrid' && !productionQuiesced,
        });
        results.push(result);
        console.error(JSON.stringify({ method, summary: result.summary }));
      } catch (error) {
        results.push({
          method,
          setup: null,
          probes: [],
          summary: {
            naturalEnds: 0,
            distinctNaturalEnds: 0,
            total: 0,
            passed: false,
            error: String(error?.stack || error),
          },
        });
        console.error(JSON.stringify({ method, error: String(error?.message || error) }));
      }
      if (method === 'hybrid' && !productionQuiesced && METHOD_ORDER.length > 1) {
        await quiesceProductionWork(session);
        productionQuiesced = true;
      }
    }

    const acquisitionCache = await acquisitionCachePromise;
    report = {
      schema: 'pong-local2-natural-end-video-benchmark-v2',
      generatedAt: new Date().toISOString(),
      safety: {
        headless: true,
        chromeMuteAudio: true,
        chromeDisableAudioOutput: true,
        actualPongPlayerRenderedInsideHeadlessChrome: true,
        desktopWindowsShown: false,
      },
      environment: {
        simulation: emulation,
        observedInPage: acquisition.browserEnvironment,
        resultScope: 'Android-like Chrome viewport, UA, DPR, and touch input running on this PC; not a physical-phone measurement',
      },
      exactFlow: 'trusted Local2 CDP touch -> first accepted artist/card -> frozen 15-card attempt pool -> up to 15 trusted card touches and production vertical swipes -> require 10 distinct natural ends at 1x',
      pages: PAGES,
      methods: METHOD_ORDER,
      targetNaturalEndsPerMethod: TARGET_VIDEO_COUNT,
      maxAttemptsPerMethod: ATTEMPT_POOL_SIZE,
      acquisition: {
        trustedTouch: acquisition.touch,
        productionClickFromTouch: acquisition.click,
        artist: acquisition.artist,
        artistUrl: acquisition.artistUrl,
        sourcePage: acquisition.sourcePage,
        buttonToDiscoveryMs: acquisition.buttonToDiscoveryMs,
        buttonToActiveCardMs: acquisition.buttonToActiveCardMs,
        stateAtDiscovery: acquisition.state,
        frozenVideos: acquisition.frozen.map(item => ({
          url: item.url,
          artist: item.metadata?.artistDisplayName || acquisition.artist,
          playbackProbeVerified: item.metadata?.playbackProbeVerified === true,
        })),
        cacheAtDiscovery: acquisitionCache,
      },
      results,
      passed: results.length === METHOD_ORDER.length && results.every(result => result.summary?.passed === true),
    };
    if (!report.passed) process.exitCode = 1;
  } finally {
    let cleanupError = null;
    if (session) await quiesceProductionWork(session).catch(() => {});
    session?.close();
    if (target?.id) await fetch(`http://127.0.0.1:${chrome.port}/json/close/${target.id}`).catch(() => {});
    try {
      await stopChromeTree(chrome.child);
    } catch (error) {
      cleanupError = error;
    }
    // Stop every page request before wiping so a late authoritative warm call
    // cannot recreate files after benchmark cleanup.
    try {
      await resetCache({ verify: true });
    } catch (error) {
      cleanupError = new Error(`verified final video-cache wipe failed: ${error?.message || error}`);
    }
    staticServer.server.closeAllConnections?.();
    await new Promise(resolve => staticServer.server.close(resolve));
    await delay(500);
    await removeChromeProfile(chrome.profile);
    if (cleanupError) throw cleanupError;
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
