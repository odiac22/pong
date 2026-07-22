import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const LOCAL_AI = String(process.env.PONG_BENCH_LOCAL_AI || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CHROME = process.env.PONG_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIXTURE_INPUT_PATH = String(process.env.PONG_MEDIA_BENCH_FIXTURE_IN || '').trim();
const FIXTURE_OUTPUT_PATH = String(process.env.PONG_MEDIA_BENCH_FIXTURE_OUT || '').trim();
const FIXTURE_FIRST_VIDEO_INDEX_RAW = String(process.env.PONG_MEDIA_BENCH_FIRST_VIDEO_INDEX || '').trim();
const FIXTURE_MODE = Boolean(FIXTURE_INPUT_PATH);
const PAGES = [...new Set(String(process.env.PONG_BENCH_PAGES || '1095,2498,2431')
  .split(',').map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 3500))];
const TARGET_VIDEO_COUNT = 10;
const FIXTURE_FIRST_VIDEO_INDEX = FIXTURE_FIRST_VIDEO_INDEX_RAW ? Number(FIXTURE_FIRST_VIDEO_INDEX_RAW) : 0;
const ATTEMPT_POOL_SIZE = FIXTURE_MODE ? TARGET_VIDEO_COUNT : 15;
const DISCOVERY_TIMEOUT_MS = Math.max(60_000, Number(process.env.PONG_MEDIA_BENCH_DISCOVERY_MS || 600_000));
const FIRST_FRAME_TIMEOUT_MS = Math.max(15_000, Number(process.env.PONG_MEDIA_BENCH_FIRST_FRAME_MS || 45_000));
const MAX_VIDEO_WALL_MS = Math.max(120_000, Number(process.env.PONG_MEDIA_BENCH_MAX_VIDEO_MS || 1_200_000));
const COMPLETE_CACHE_TIMEOUT_MS = Math.max(120_000, Number(process.env.PONG_MEDIA_BENCH_CACHE_READY_MS || 900_000));
const requestedMethods = [...new Set(String(process.env.PONG_MEDIA_BENCH_METHODS || 'direct,proxy,growing,hybrid,complete')
  .split(',').map(value => value.trim().toLowerCase())
  .filter(value => ['direct', 'proxy', 'growing', 'hybrid', 'complete'].includes(value)))];
// Current production must run first. It is the only method that intentionally
// retains the live Local2 discovery workload and its real background warming.
const METHOD_ORDER = FIXTURE_MODE
  ? ['hybrid']
  : requestedMethods.includes('hybrid')
    ? ['hybrid', ...requestedMethods.filter(method => method !== 'hybrid')]
    : requestedMethods;

if (!FIXTURE_MODE && PAGES.length !== 3) throw new Error('PONG_BENCH_PAGES must contain exactly three distinct pages');
if (!METHOD_ORDER.length) throw new Error('PONG_MEDIA_BENCH_METHODS did not contain a supported method');
if (FIXTURE_FIRST_VIDEO_INDEX_RAW && (!FIXTURE_MODE || !Number.isInteger(FIXTURE_FIRST_VIDEO_INDEX)
  || FIXTURE_FIRST_VIDEO_INDEX < 1 || FIXTURE_FIRST_VIDEO_INDEX > TARGET_VIDEO_COUNT)) {
  throw new Error(`PONG_MEDIA_BENCH_FIRST_VIDEO_INDEX requires fixture mode and an integer from 1 to ${TARGET_VIDEO_COUNT}`);
}

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
  for (let step = 1; step <= 5; step++) {
    await delay(18);
    const y = startY + ((endY - startY) * step / 5);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(y) });
  }
  await delay(18);
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

function resolveBenchmarkFile(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
}

function benchmarkFixtureHash(videos) {
  return createHash('sha256')
    .update(videos.map(item => String(item?.url || '')).join('\n'))
    .digest('hex');
}

function benchmarkFixtureFromAcquisition(acquisition) {
  const videos = acquisition.frozen.slice(0, TARGET_VIDEO_COUNT).map(item => ({
    url: String(item.url || ''),
    metadata: { ...(item.metadata || {}) },
  }));
  if (videos.length !== TARGET_VIDEO_COUNT || new Set(videos.map(item => item.url)).size !== TARGET_VIDEO_COUNT) {
    throw new Error(`fixture capture requires ${TARGET_VIDEO_COUNT} distinct ordered media URLs`);
  }
  return {
    schema: 'pong-local2-video-fixture-v1',
    generatedAt: new Date().toISOString(),
    orderedUrlSha256: benchmarkFixtureHash(videos),
    artist: String(acquisition.artist || ''),
    artistUrl: String(acquisition.artistUrl || ''),
    sourcePage: Number(acquisition.sourcePage || 0),
    event: {
      ...(acquisition.event || {}),
      source: 'random40',
      startIndex: 0,
      count: TARGET_VIDEO_COUNT,
      ready: true,
      pending: false,
    },
    videos,
  };
}

async function writeBenchmarkFixture(acquisition) {
  if (!FIXTURE_OUTPUT_PATH) return null;
  const fixture = benchmarkFixtureFromAcquisition(acquisition);
  const filePath = resolveBenchmarkFile(FIXTURE_OUTPUT_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return { filePath, fixture };
}

async function writeLoadedBenchmarkFixture(loadedFixture) {
  if (!FIXTURE_OUTPUT_PATH || !loadedFixture?.fixture) return null;
  const filePath = resolveBenchmarkFile(FIXTURE_OUTPUT_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(loadedFixture.fixture, null, 2)}\n`, 'utf8');
  return { filePath, fixture: loadedFixture.fixture };
}

async function readBenchmarkFixture() {
  const filePath = resolveBenchmarkFile(FIXTURE_INPUT_PATH);
  const bytes = await readFile(filePath);
  const sourceText = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString('utf16le')
    : bytes.toString('utf8').replace(/^\uFEFF/, '');
  const source = JSON.parse(sourceText);
  const fixture = source?.schema === 'pong-local2-video-fixture-v1'
    ? source
    : source?.schema === 'pong-local2-natural-end-video-benchmark-v3' && Array.isArray(source?.acquisition?.frozenVideos)
      ? {
          schema: 'pong-local2-video-fixture-v1',
          generatedAt: new Date().toISOString(),
          artist: String(source.acquisition.artist || ''),
          artistUrl: String(source.acquisition.artistUrl || ''),
          sourcePage: Number(source.acquisition.sourcePage || 0),
          event: {
            source: 'random40',
            artistKey: String(source.acquisition.artistUrl || source.acquisition.artist || 'benchmark-artist'),
            artistName: String(source.acquisition.artist || 'benchmark artist'),
            artistDisplayName: String(source.acquisition.artist || 'benchmark artist'),
            artistUrl: String(source.acquisition.artistUrl || ''),
            sourcePage: Number(source.acquisition.sourcePage || 0)
          },
          videos: source.acquisition.frozenVideos.slice(0, TARGET_VIDEO_COUNT).map(item => ({
            url: String(item?.url || ''),
            metadata: {
              artistDisplayName: String(item?.artist || source.acquisition.artist || ''),
              artistUrl: String(source.acquisition.artistUrl || ''),
              sourcePage: Number(source.acquisition.sourcePage || 0),
              playbackProbeVerified: item?.playbackProbeVerified === true
            }
          }))
        }
      : null;
  if (!fixture) throw new Error(`unsupported Pong media fixture schema: ${source?.schema || 'missing'}`);
  const videos = Array.isArray(fixture.videos) ? fixture.videos.map(item => ({
    url: String(item?.url || '').trim(),
    metadata: { ...(item?.metadata || {}) },
  })) : [];
  if (videos.length !== TARGET_VIDEO_COUNT) {
    throw new Error(`fixture must contain exactly ${TARGET_VIDEO_COUNT} ordered videos`);
  }
  if (new Set(videos.map(item => item.url)).size !== TARGET_VIDEO_COUNT) {
    throw new Error(`fixture must contain ${TARGET_VIDEO_COUNT} distinct media URLs`);
  }
  for (const item of videos) {
    let parsed;
    try { parsed = new URL(item.url); } catch (_) {}
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`fixture contains an invalid media URL: ${item.url.slice(0, 120)}`);
    }
  }
  const originalOrderedUrlSha256 = benchmarkFixtureHash(videos);
  if (fixture.orderedUrlSha256 && fixture.orderedUrlSha256 !== originalOrderedUrlSha256) {
    throw new Error('fixture ordered URL hash does not match its video list');
  }
  const effectiveVideos = FIXTURE_FIRST_VIDEO_INDEX
    ? [videos[FIXTURE_FIRST_VIDEO_INDEX - 1], ...videos.filter((_, index) => index !== FIXTURE_FIRST_VIDEO_INDEX - 1)]
    : videos;
  const effectiveOrderedUrlSha256 = benchmarkFixtureHash(effectiveVideos);
  return {
    filePath,
    originalOrderedUrlSha256,
    firstVideoIndexOverride: FIXTURE_FIRST_VIDEO_INDEX || null,
    fixture: {
      ...fixture,
      orderedUrlSha256: effectiveOrderedUrlSha256,
      videos: effectiveVideos,
      event: {
        ...(fixture.event || {}),
        source: 'random40',
        startIndex: 0,
        count: TARGET_VIDEO_COUNT,
        ready: true,
        pending: false,
      },
    },
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
    window.__pongMediaBenchFirstAcceptance = null;
    const acceptanceObserver = setInterval(() => {
      if (window.__pongMediaBenchFirstAcceptance) {
        clearInterval(acceptanceObserver);
        return;
      }
      const state = typeof random40State === 'object' && random40State ? random40State : null;
      const firstPublishedAt = Number(state?.firstVideoRecordedAt || 0);
      if (!window.__pongMediaBenchTouch?.trusted || state?.mode !== 'local2' || firstPublishedAt <= 0) return;
      const acceptedEvent = Array.isArray(pasteEvents)
        ? pasteEvents.find(event => isRandom40PasteEvent(event))
        : null;
      window.__pongMediaBenchFirstAcceptance = {
        // Production stamps this synchronously when the first accepted artist
        // is published. Reuse that exact timestamp instead of the later poll.
        wallAt: firstPublishedAt,
        performanceAt: firstPublishedAt - performance.timeOrigin,
        accepted: Math.max(1, Number(state.accepted || 0)),
        artist: acceptedEvent?.artistDisplayName || acceptedEvent?.artistKey || acceptedEvent?.artistUrl || '',
        artistUrl: acceptedEvent?.artistUrl || ''
      };
      clearInterval(acceptanceObserver);
    }, 0);
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
    if (!window.__pongMediaBenchTouch?.trusted || !window.__pongMediaBenchClick?.trusted || !window.__pongMediaBenchFirstAcceptance || !Array.isArray(pasteEvents) || !Array.isArray(allVideoUrls)) return null;
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
        firstAcceptance: { ...window.__pongMediaBenchFirstAcceptance },
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
    firstArtistAcceptedAt: Number(manifest.firstAcceptance.wallAt),
    firstArtistAcceptedPerformanceAt: Number(manifest.firstAcceptance.performanceAt),
    buttonToFirstArtistAcceptedMs: Number(manifest.firstAcceptance.wallAt) - Number(manifest.touch.wallAt),
    buttonToDiscoveryMs: manifest.state.firstVideoRecordedAt && manifest.state.startedAt
      ? manifest.state.firstVideoRecordedAt - manifest.state.startedAt
      : manifest.observedAt - manifest.touch.wallAt,
    buttonToActiveCardMs: manifest.observedAt - manifest.touch.wallAt,
  };
}

async function prepareFrozenFixtureAcquisition(session, loadedFixture) {
  const fixture = loadedFixture.fixture;
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
  `), 20_000, 'Pong fixture reload');
  await dismissPongSplash(session);
  const browserEnvironment = await session.evaluate(`(() => {
    // A real Local2 acceptance already has the reachable PC gateway selected.
    // Fixture replay begins at that acceptance boundary, so restore the same
    // runtime state (localStorage alone is not read into this global on load).
    random40GatewayEndpoint = ${JSON.stringify(LOCAL_AI)};
    window.autoplayEnabled = false;
    return {
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform || navigator.platform || '',
      mobile: navigator.userAgentData?.mobile === true,
      viewportCssPixels: { width: innerWidth, height: innerHeight },
      deviceScaleFactor: devicePixelRatio,
      maxTouchPoints: Number(navigator.maxTouchPoints || 0),
      visibilityState: document.visibilityState
    };
  })()`);
  const videos = fixture.videos.map((item, globalIndex) => ({
    url: item.url,
    metadata: { ...(item.metadata || {}) },
    globalIndex,
  }));
  return {
    acquisitionMode: 'frozen-fixture',
    fixturePath: loadedFixture.filePath,
    fixtureHash: fixture.orderedUrlSha256,
    touch: null,
    click: null,
    firstAcceptance: null,
    eventIndex: 0,
    event: { ...fixture.event },
    artist: String(fixture.artist || fixture.event?.artistDisplayName || ''),
    artistUrl: String(fixture.artistUrl || fixture.event?.artistUrl || ''),
    sourcePage: Number(fixture.sourcePage || fixture.event?.sourcePage || 0),
    videos,
    frozen: videos,
    activeOriginalUrl: '',
    browserEnvironment,
    state: {
      mode: 'local2-fixture',
      startedAt: 0,
      firstVideoRecordedAt: 0,
      accepted: 1,
      videos: TARGET_VIDEO_COUNT,
      pages: 0,
      api: 0,
      stageTimings: {},
      verdictAudit: [],
    },
    observedAt: Date.now(),
    firstArtistAcceptedAt: 0,
    firstArtistAcceptedPerformanceAt: 0,
    buttonToFirstArtistAcceptedMs: null,
    buttonToDiscoveryMs: null,
    buttonToActiveCardMs: null,
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
    // Production Random40 publication reaches this path through the Load
    // Videos button, which hides the fixed controls before player gestures.
    // Fixture mode installs the same cards directly, so mirror that side
    // effect without changing any touch or deck-navigation handlers.
    setTimeout(hideControls, 1000);
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
        firstFramePerformanceAt: firstFrameAt || null,
        endedPerformanceAt: endedAt || null,
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

async function runMethod(session, networkRecorder, method, acquisition, { productionLive, fixtureMode = false }) {
  if (fixtureMode) {
    const accepted = await session.evaluate(`({ wallAt: Date.now(), performanceAt: performance.now() })`);
    acquisition.firstAcceptance = {
      wallAt: Number(accepted.wallAt),
      performanceAt: Number(accepted.performanceAt),
      accepted: 1,
      artist: acquisition.artist,
      artistUrl: acquisition.artistUrl,
    };
    acquisition.firstArtistAcceptedAt = Number(accepted.wallAt);
    acquisition.firstArtistAcceptedPerformanceAt = Number(accepted.performanceAt);
    acquisition.observedAt = Number(accepted.wallAt);
    acquisition.state.startedAt = Number(accepted.wallAt);
    acquisition.state.firstVideoRecordedAt = Number(accepted.wallAt);
  }
  const methodStartedAt = productionLive ? acquisition.firstArtistAcceptedAt : Date.now();
  const methodStartedPerformanceAt = productionLive
    ? acquisition.firstArtistAcceptedPerformanceAt
    : Number(await session.evaluate(`performance.now()`));
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
      acceptanceToFirstFrameMs: productionLive && probe.firstFramePerformanceAt != null && Number.isFinite(Number(probe.firstFramePerformanceAt))
        ? Number(probe.firstFramePerformanceAt) - acquisition.firstArtistAcceptedPerformanceAt
        : null,
      acceptanceToEndMs: productionLive && probe.endedPerformanceAt != null && Number.isFinite(Number(probe.endedPerformanceAt))
        ? Number(probe.endedPerformanceAt) - acquisition.firstArtistAcceptedPerformanceAt
        : null,
    });
    const qualifyingNow = new Set(probes
      .filter(item => item.success && item.endedNaturally && item.routeIntegrity)
      .map(item => item.originalUrl)).size;
    if (qualifyingNow >= TARGET_VIDEO_COUNT || seen.size >= frozenUrls.length) break;
    active = await navigateToNextUnseenPongCard(session, seen, frozenSet, probe.originalUrl, method);
  }

  const naturalEnds = probes.filter(probe => probe.success && probe.endedNaturally).length;
  setup.cacheAtMethodEnd = await cacheSnapshotsForUrls(frozenUrls);
  const endingHealth = await fetch(`${LOCAL_AI}/health`, { cache: 'no-store' }).then(response => response.json());
  if (!endingHealth?.ok || !endingHealth?.video_file_cache) {
    throw new Error(`${method} could not capture the ending server transport state`);
  }
  setup.serverVideoCacheAtMethodEnd = endingHealth.video_file_cache;
  const distinctNaturalEnds = new Set(
    probes.filter(probe => probe.success && probe.endedNaturally).map(probe => probe.originalUrl)
  ).size;
  const qualifyingProbes = probes.filter(probe => probe.success && probe.endedNaturally && probe.routeIntegrity);
  const firstFrameProbe = probes.find(probe => (
    probe.firstFramePerformanceAt != null && Number.isFinite(Number(probe.firstFramePerformanceAt))
  ));
  const tenthQualifyingEnd = qualifyingProbes[TARGET_VIDEO_COUNT - 1];
  const naturalMediaDurationMs = Number((qualifyingProbes
    .slice(0, TARGET_VIDEO_COUNT)
    .reduce((sum, probe) => sum + Number(probe.durationSeconds || 0) * 1000, 0)).toFixed(1));
  const acceptanceTo10thEndMs = productionLive && tenthQualifyingEnd
    ? tenthQualifyingEnd.acceptanceToEndMs
    : null;
  const qualifyingNaturalEnds = qualifyingProbes.length;
  const distinctQualifyingNaturalEnds = new Set(qualifyingProbes.map(probe => probe.originalUrl)).size;
  const summary = {
    naturalEnds,
    distinctNaturalEnds,
    qualifyingNaturalEnds,
    distinctQualifyingNaturalEnds,
    total: probes.length,
    timingOrigin: productionLive ? 'first-artist-accepted' : 'isolated-method-start',
    firstArtistAcceptedAt: acquisition.firstArtistAcceptedAt,
    buttonToFirstArtistAcceptedMs: acquisition.buttonToFirstArtistAcceptedMs,
    methodToFirstFrameMs: firstFrameProbe?.methodToFirstFrameMs ?? null,
    acceptanceToFirstFrameMs: productionLive && firstFrameProbe
      ? firstFrameProbe.acceptanceToFirstFrameMs
      : null,
    acceptanceTo10thEndMs,
    naturalMediaDurationMs,
    acceptanceTo10thEndOverheadMs: Number.isFinite(Number(acceptanceTo10thEndMs))
      ? Number((Number(acceptanceTo10thEndMs) - naturalMediaDurationMs).toFixed(1))
      : null,
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
  const loadedFixture = FIXTURE_MODE ? await readBenchmarkFixture() : null;
  const normalizedFixture = loadedFixture ? await writeLoadedBenchmarkFixture(loadedFixture) : null;
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
    const acquisition = loadedFixture
      ? await prepareFrozenFixtureAcquisition(session, loadedFixture)
      : await acquireFirstLocal2Artist(session);
    if (!acquisition.acquisitionMode) acquisition.acquisitionMode = 'live-local2';
    const capturedFixture = !loadedFixture && FIXTURE_OUTPUT_PATH
      ? await writeBenchmarkFixture(acquisition)
      : normalizedFixture;
    const frozenUrls = acquisition.frozen.map(item => item.url);
    let acquisitionCachePromise;
    if (FIXTURE_MODE) {
      // Fixture trials begin from a verified empty PC cache. Capture that state
      // before t0 so status instrumentation cannot delay or contend with the
      // first production warm request.
      await resetCache({ verify: true });
      acquisitionCachePromise = Promise.resolve(await cacheSnapshotsForUrls(frozenUrls));
    } else {
      // Capture discovery cache state immediately without holding the first real
      // Pong tap behind a full status response.
      acquisitionCachePromise = cacheSnapshotsForUrls(frozenUrls).catch(() => null);
    }
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
          fixtureMode: FIXTURE_MODE,
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
            timingOrigin: method === 'hybrid' ? 'first-artist-accepted' : 'isolated-method-start',
            firstArtistAcceptedAt: acquisition.firstArtistAcceptedAt,
            buttonToFirstArtistAcceptedMs: acquisition.buttonToFirstArtistAcceptedMs,
            acceptanceToFirstFrameMs: null,
            acceptanceTo10thEndMs: null,
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
      schema: 'pong-local2-natural-end-video-benchmark-v3',
      generatedAt: new Date().toISOString(),
      benchmarkMode: FIXTURE_MODE ? 'frozen-fixture' : 'live-local2',
      fixture: FIXTURE_MODE ? {
        inputPath: loadedFixture.filePath,
        originalOrderedUrlSha256: loadedFixture.originalOrderedUrlSha256,
        firstVideoIndexOverride: loadedFixture.firstVideoIndexOverride,
        effectiveOrderedUrlSha256: loadedFixture.fixture.orderedUrlSha256,
        orderedUrlSha256: loadedFixture.fixture.orderedUrlSha256,
        orderedVideoCount: loadedFixture.fixture.videos.length,
        exactTenRequired: true,
      } : capturedFixture ? {
        outputPath: capturedFixture.filePath,
        orderedUrlSha256: capturedFixture.fixture.orderedUrlSha256,
        orderedVideoCount: capturedFixture.fixture.videos.length,
        captureRunShouldNotBeUsedForVariantTiming: true,
      } : null,
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
        serverVideoCache: {
          concurrency: Number(health.video_file_cache?.concurrency || 0),
          backgroundConcurrency: Number(health.video_file_cache?.background_concurrency || 0),
          playbackBackgroundConcurrency: Number(health.video_file_cache?.playback_background_concurrency || 0),
          perHostConcurrency: Number(health.video_file_cache?.per_host_concurrency || 0),
        },
        resultScope: 'Android-like Chrome viewport, UA, DPR, and touch input running on this PC; not a physical-phone measurement',
      },
      exactFlow: FIXTURE_MODE
        ? 'verified empty PC cache -> stamp first-artist-accepted timer zero -> install the same 10 ordered fixture cards through production Pong warming/rendering -> 10 trusted card touches and production vertical swipes -> require all 10 distinct natural ends at 1x'
        : 'trusted Local2 CDP touch -> observe first production accepted artist (hybrid timer zero) -> freeze 15-card attempt pool -> up to 15 trusted card touches and production vertical swipes -> require 10 distinct natural ends at 1x',
      pages: FIXTURE_MODE ? [] : PAGES,
      methods: METHOD_ORDER,
      targetNaturalEndsPerMethod: TARGET_VIDEO_COUNT,
      maxAttemptsPerMethod: ATTEMPT_POOL_SIZE,
      acquisition: {
        mode: acquisition.acquisitionMode,
        trustedTouch: acquisition.touch,
        productionClickFromTouch: acquisition.click,
        artist: acquisition.artist,
        artistUrl: acquisition.artistUrl,
        sourcePage: acquisition.sourcePage,
        firstArtistAcceptedAt: acquisition.firstArtistAcceptedAt,
        firstArtistAcceptedAtIso: new Date(acquisition.firstArtistAcceptedAt).toISOString(),
        buttonToFirstArtistAcceptedMs: acquisition.buttonToFirstArtistAcceptedMs,
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
