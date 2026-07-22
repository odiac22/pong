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
const VIDEO_COUNT = Math.max(1, Math.min(6, Number(process.env.PONG_MEDIA_BENCH_VIDEOS || 3)));
const PLAY_MS = Math.max(4_000, Number(process.env.PONG_MEDIA_BENCH_PLAY_MS || 10_000));
const DISCOVERY_TIMEOUT_MS = Math.max(60_000, Number(process.env.PONG_MEDIA_BENCH_DISCOVERY_MS || 600_000));
const PRODUCTION_FLOW = process.env.PONG_MEDIA_BENCH_PRODUCTION === '1';
const METHOD_ORDER = String(process.env.PONG_MEDIA_BENCH_METHODS || 'direct,proxy,growing,hybrid,complete')
  .split(',').map(value => value.trim().toLowerCase())
  .filter(value => ['direct', 'proxy', 'growing', 'hybrid', 'complete'].includes(value));

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
  return { target, session };
}

async function trustedClick(session, selector) {
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
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function dismissPongSplash(session) {
  for (let index = 0; index < 3; index++) {
    await trustedClick(session, '#pong-hotspot');
    await delay(80);
  }
  await waitFor(
    () => session.evaluate(`document.querySelector('#pong-overlay')?.classList.contains('hidden') === true`),
    3_000,
    'Pong splash dismissal'
  );
}

async function resetCache() {
  await fetch(`${LOCAL_AI}/video-cache/reset`, { method: 'POST' }).catch(() => null);
  await delay(750);
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

async function cacheStatus() {
  return fetch(`${LOCAL_AI}/video-cache/status?t=${Date.now()}`).then(response => response.json());
}

function recordForUrl(payload, url) {
  return (payload?.records || []).find(record => (record.urls || []).includes(url)) || null;
}

async function waitForReady(url, timeoutMs = 120_000) {
  const startedAt = Date.now();
  const record = await waitFor(async () => {
    const status = await cacheStatus();
    return recordForUrl(status, url)?.ready ? recordForUrl(status, url) : null;
  }, timeoutMs, 'complete local video cache', 150);
  return { record, waitMs: Date.now() - startedAt };
}

function proxyUrl(url) {
  return `${LOCAL_AI}/proxy?url=${encodeURIComponent(url)}`;
}

const probeExpression = (url, playMs) => `(async () => {
  const url = ${JSON.stringify(url)};
  const playMs = ${Number(playMs)};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const video = document.createElement('video');
  video.style.cssText = 'position:fixed;left:-10000px;bottom:0;display:block;width:2px;height:2px;opacity:0.001;pointer-events:none';
  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  const startedAt = performance.now();
  let firstPlayingAt = 0;
  let firstFrameAt = 0;
  let canplayAt = 0;
  let stallStartedAt = 0;
  let stallCount = 0;
  let stallMs = 0;
  let longestStallMs = 0;
  let error = '';
  const closeStall = () => {
    if (!stallStartedAt) return;
    const elapsed = performance.now() - stallStartedAt;
    stallMs += elapsed;
    longestStallMs = Math.max(longestStallMs, elapsed);
    stallStartedAt = 0;
  };
  video.addEventListener('canplay', () => { if (!canplayAt) canplayAt = performance.now(); });
  video.addEventListener('playing', () => {
    if (!firstPlayingAt) firstPlayingAt = performance.now();
    closeStall();
  });
  video.addEventListener('waiting', () => {
    if (firstPlayingAt && !stallStartedAt) {
      stallCount++;
      stallStartedAt = performance.now();
    }
  });
  video.addEventListener('stalled', () => {
    if (firstPlayingAt && !stallStartedAt) {
      stallCount++;
      stallStartedAt = performance.now();
    }
  });
  video.addEventListener('error', () => {
    error = 'media error ' + Number(video.error?.code || 0) + ': ' + String(video.error?.message || '');
  });
  document.body.appendChild(video);
  let framePromise = Promise.resolve();
  if (typeof video.requestVideoFrameCallback === 'function') {
    framePromise = new Promise(resolve => {
      const timer = setTimeout(resolve, 20_000);
      video.requestVideoFrameCallback(() => {
        firstFrameAt = performance.now();
        clearTimeout(timer);
        resolve();
      });
    });
  }
  video.src = url;
  video.load();
  const playIntentAt = performance.now();
  let startMediaTime = 0;
  let endMediaTime = 0;
  try {
    await Promise.race([
      Promise.resolve(video.play()),
      sleep(20_000).then(() => { throw new Error('play timeout'); })
    ]);
    await Promise.race([
      framePromise,
      sleep(20_000).then(() => { throw new Error('first-frame timeout'); })
    ]);
    if (!firstFrameAt && firstPlayingAt) firstFrameAt = firstPlayingAt;
    startMediaTime = Number(video.currentTime || 0);
    await sleep(playMs);
    endMediaTime = Number(video.currentTime || 0);
  } catch (caught) {
    error = error || String(caught?.message || caught);
    endMediaTime = Number(video.currentTime || 0);
  }
  closeStall();
  const quality = typeof video.getVideoPlaybackQuality === 'function'
    ? video.getVideoPlaybackQuality()
    : {};
  const bufferedAhead = (() => {
    try {
      for (let index = 0; index < video.buffered.length; index++) {
        if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
          return video.buffered.end(index) - video.currentTime;
        }
      }
    } catch (_) {}
    return 0;
  })();
  const result = {
    source: url,
    success: !error && firstFrameAt > 0 && (
      endMediaTime > startMediaTime + 0.15 ||
      (video.ended && Number(quality.totalVideoFrames || 0) > 0)
    ),
    canplayMs: canplayAt ? canplayAt - startedAt : null,
    firstPlayingMs: firstPlayingAt ? firstPlayingAt - playIntentAt : null,
    firstFrameMs: firstFrameAt ? firstFrameAt - playIntentAt : null,
    stallCount,
    stallMs,
    longestStallMs,
    mediaAdvancedSeconds: Math.max(0, endMediaTime - startMediaTime),
    wallSeconds: playMs / 1000,
    bufferedAheadSeconds: Math.max(0, bufferedAhead),
    droppedFrames: Number(quality.droppedVideoFrames || 0),
    totalFrames: Number(quality.totalVideoFrames || 0),
    endedNormally: Boolean(video.ended),
    readyState: Number(video.readyState || 0),
    networkState: Number(video.networkState || 0),
    error
  };
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  } catch (_) {}
  return result;
})()`;

const installActivePlayerProbeExpression = playMs => `(() => {
  const wrapper = document.querySelector('.video-wrapper.deck-active');
  const video = wrapper?.querySelector('video');
  if (!wrapper || !video) throw new Error('Pong active player was not found');
  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  const installedAt = performance.now();
  const originalUrl = String(wrapper.dataset.originalVideoUrl || '');
  let firstPlayingAt = 0;
  let firstFrameAt = 0;
  let stallStartedAt = 0;
  let stallCount = 0;
  let stallMs = 0;
  let longestStallMs = 0;
  let startMediaTime = Number(video.currentTime || 0);
  let finishTimer = 0;
  let watchdog = 0;
  let frameRequest = 0;
  let settled = false;
  window.__pongActiveProbeTapAt = installedAt;
  window.__pongActivePlayerProbePromise = new Promise(resolve => {
    const closeStall = () => {
      if (!stallStartedAt) return;
      const elapsed = performance.now() - stallStartedAt;
      stallMs += elapsed;
      longestStallMs = Math.max(longestStallMs, elapsed);
      stallStartedAt = 0;
    };
    const cleanup = () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      video.removeEventListener('error', onError);
      video.removeEventListener('ended', finish);
      clearTimeout(finishTimer);
      clearTimeout(watchdog);
      if (frameRequest && typeof video.cancelVideoFrameCallback === 'function') {
        try { video.cancelVideoFrameCallback(frameRequest); } catch (_) {}
      }
    };
    function finish() {
      if (settled) return;
      settled = true;
      closeStall();
      cleanup();
      const quality = typeof video.getVideoPlaybackQuality === 'function'
        ? video.getVideoPlaybackQuality()
        : {};
      const tapAt = Number(window.__pongActiveProbeTapAt || installedAt);
      const endMediaTime = Number(video.currentTime || 0);
      const endedNormally = Boolean(video.ended);
      const mediaAdvancedSeconds = Math.max(0, endMediaTime - startMediaTime);
      const result = {
        source: String(video.currentSrc || video.src || ''),
        originalUrl,
        success: firstPlayingAt > 0 && (
          mediaAdvancedSeconds > 0.15 ||
          (endedNormally && Number(quality.totalVideoFrames || 0) > 0)
        ),
        firstPlayingMs: firstPlayingAt ? firstPlayingAt - tapAt : null,
        firstFrameMs: firstFrameAt ? firstFrameAt - tapAt : (firstPlayingAt ? firstPlayingAt - tapAt : null),
        stallCount,
        stallMs,
        longestStallMs,
        mediaAdvancedSeconds,
        wallSeconds: ${Number(playMs)} / 1000,
        droppedFrames: Number(quality.droppedVideoFrames || 0),
        totalFrames: Number(quality.totalVideoFrames || 0),
        endedNormally,
        readyState: Number(video.readyState || 0),
        networkState: Number(video.networkState || 0),
        error: String(video.error?.message || '')
      };
      try { video.pause(); } catch (_) {}
      resolve(result);
    }
    function onPlaying() {
      closeStall();
      if (firstPlayingAt) return;
      firstPlayingAt = performance.now();
      startMediaTime = Number(video.currentTime || 0);
      finishTimer = setTimeout(finish, ${Number(playMs)});
    }
    function onWaiting() {
      if (!firstPlayingAt || stallStartedAt) return;
      stallCount++;
      stallStartedAt = performance.now();
    }
    function onError() { finish(); }
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onWaiting);
    video.addEventListener('error', onError);
    video.addEventListener('ended', finish);
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameRequest = video.requestVideoFrameCallback(() => { firstFrameAt = performance.now(); });
    }
    if (!video.paused && !video.ended) onPlaying();
    watchdog = setTimeout(finish, ${Number(playMs)} + 20_000);
  });
  return {
    originalUrl,
    source: String(video.currentSrc || video.src || ''),
    needsPlayClick: Boolean(video.paused || video.ended)
  };
})()`;

async function probeActualPongPlayer(session, playMs) {
  const installed = await session.evaluate(installActivePlayerProbeExpression(playMs));
  if (installed?.needsPlayClick) {
    const stillPaused = await session.evaluate(`Boolean(document.querySelector('.video-wrapper.deck-active video')?.paused)`);
    if (stillPaused) {
      await session.evaluate(`window.__pongActiveProbeTapAt = performance.now(); true`);
      await trustedClick(session, '.video-wrapper.deck-active .tap-area');
    }
  }
  const result = await session.evaluate(`window.__pongActivePlayerProbePromise`);
  const activeSource = String(result?.source || installed?.source || '');
  const routeKind = activeSource.includes('/video-cache/stream?')
    ? 'growing-cache'
    : activeSource.includes('/video-cache/media/')
      ? 'complete-cache'
      : activeSource.includes('/proxy?') ? 'proxy' : 'direct';
  return { routeKind, ...result };
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

async function runMethod(session, method, videos) {
  await resetCache();
  const allUrls = videos.map(video => video.url);
  let initialWarm = null;
  if (method === 'growing' || method === 'complete') {
    initialWarm = await warmCache(allUrls, allUrls[0], allUrls);
  } else if (method === 'hybrid') {
    initialWarm = await warmCache(allUrls.slice(1), '', allUrls.slice(1));
  }

  const probes = [];
  for (let index = 0; index < videos.length; index++) {
    const item = videos[index];
    let route = item.url;
    let cacheWaitMs = 0;
    let routeKind = 'direct';
    if (method === 'proxy') {
      route = proxyUrl(item.url);
      routeKind = 'proxy';
    } else if (method === 'growing') {
      const latest = index === 0 ? initialWarm : await cacheStatus();
      const record = recordForUrl(latest, item.url);
      route = record?.playbackUrl || item.url;
      routeKind = record?.playbackUrl ? 'growing-cache' : 'direct-fallback';
    } else if (method === 'complete') {
      const ready = await waitForReady(item.url);
      route = ready.record.playbackUrl;
      cacheWaitMs = ready.waitMs;
      routeKind = 'complete-cache';
    } else if (method === 'hybrid') {
      const latest = await cacheStatus();
      const cached = recordForUrl(latest, item.url);
      if (cached?.ready && cached.playbackUrl) {
        route = cached.playbackUrl;
        routeKind = 'complete-cache';
      }
      const remaining = allUrls.filter(url => url !== item.url);
      await warmCache(remaining, '', remaining).catch(() => null);
    }
    const networkStart = Date.now();
    const result = await session.evaluate(probeExpression(route, PLAY_MS));
    probes.push({
      artist: item.artist,
      originalUrl: item.url,
      routeKind,
      cacheWaitMs,
      networkStart,
      ...result,
    });
    await delay(250);
  }
  const finalCache = await cacheStatus().catch(() => null);
  return {
    method,
    probes,
    summary: {
      success: probes.filter(probe => probe.success).length,
      total: probes.length,
      firstFrameMs: summarize(probes.map(probe => probe.firstFrameMs)),
      stallMs: summarize(probes.map(probe => probe.stallMs)),
      longestStallMs: Math.max(0, ...probes.map(probe => Number(probe.longestStallMs || 0))),
      totalStalls: probes.reduce((sum, probe) => sum + Number(probe.stallCount || 0), 0),
      mediaAdvancedSeconds: Number(probes.reduce((sum, probe) => sum + Number(probe.mediaAdvancedSeconds || 0), 0).toFixed(2)),
      cacheWaitMs: summarize(probes.map(probe => probe.cacheWaitMs)),
      cache: finalCache?.cache || null,
    },
  };
}

async function acquireLocal2Manifest(session) {
  await waitFor(() => session.evaluate(`document.readyState === 'complete' && typeof startRandom40 === 'function'`), 20_000, 'Pong page');
  await session.evaluate(`
    ['pong_session_v1','pong_random40_model_reject_cache_v1','pong_random40_stage_timing_v2','pong_random40_model_accuracy_v2']
      .forEach(key => localStorage.removeItem(key));
    localStorage.setItem('pong_random40_local_endpoint_v1', ${JSON.stringify(LOCAL_AI)});
    localStorage.setItem('pong_player_audio_pref_v2', 'muted');
    location.reload();
    true
  `);
  await waitFor(() => session.evaluate(`document.readyState === 'complete' && typeof startRandom40 === 'function'`), 20_000, 'Pong reload');
  await dismissPongSplash(session);
  await session.evaluate(`(() => {
    window.__pongMediaBenchClick = null;
    document.querySelector('#random-40-local2').addEventListener('click', event => {
      window.__pongMediaBenchClick = { trusted: event.isTrusted, at: Date.now() };
    }, { capture: true, once: true });
    return true;
  })()`);
  await trustedClick(session, '#random-40-local2');
  const state = await waitFor(async () => {
    const raw = await session.evaluate(`document.querySelector('#random40-benchmark-state')?.textContent || ''`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.done ? parsed : null;
  }, DISCOVERY_TIMEOUT_MS, 'trusted Local2 three-page run', 500);
  const manifest = await session.evaluate(`(() => {
    const groups = (pasteEvents || []).map((event, index) => {
      if (!isRandom40PasteEvent(event)) return null;
      const bounds = getPasteEventVideoBounds(event);
      if (!bounds) return null;
      return {
        artist: event.artistDisplayName || event.artistKey || event.artistUrl,
        artistUrl: event.artistUrl || '',
        sourcePage: Number(event.sourcePage || 0),
        urls: [...new Set(allVideoUrls.slice(bounds.start, bounds.end).filter(Boolean))]
      };
    }).filter(group => group && group.urls.length >= 15);
    return {
      click: window.__pongMediaBenchClick,
      groups,
      state: random40State ? {
        accepted: Number(random40State.accepted || 0),
        videos: Number(random40State.videos || 0),
        pages: Number(random40State.pages || 0),
        stageTimings: random40State.stageTimings || {},
        verdictAudit: random40State.verdictAudit || []
      } : null
    };
  })()`);
  if (!manifest?.click?.trusted) throw new Error('Local2 was not started by a trusted real button click');
  if (!manifest.groups?.length) throw new Error('Local2 accepted no 15-video artist on the selected pages');
  return { benchmarkState: state, ...manifest };
}

async function main() {
  const health = await fetch(`${LOCAL_AI}/health`).then(response => response.json());
  if (!health?.ok || !health?.ready) throw new Error('Pong Local AI core is not ready');
  const staticServer = await startStaticServer();
  const chrome = await startChrome();
  let target = null;
  let session = null;
  try {
    if (PRODUCTION_FLOW) await resetCache();
    const noMediaFlag = PRODUCTION_FLOW ? '' : 'pongNoMedia=1&';
    const opened = await openPage(chrome.port, `${staticServer.url}?${noMediaFlag}pongLiveScan=1&pongPages=${PAGES.join(',')}&t=${Date.now()}`);
    target = opened.target;
    session = opened.session;
    const acquiredAt = Date.now();
    const manifest = await acquireLocal2Manifest(session);
    const discoveryMs = Date.now() - acquiredAt;
    const selected = [];
    if (PRODUCTION_FLOW) {
      for (const group of manifest.groups.slice(0, VIDEO_COUNT)) {
        const url = group.urls[0];
        if (url) selected.push({ artist: group.artist, artistUrl: group.artistUrl, sourcePage: group.sourcePage, url });
      }
    } else {
      let offset = 0;
      while (selected.length < VIDEO_COUNT && manifest.groups.some(group => offset < group.urls.length)) {
        for (const group of manifest.groups) {
          if (selected.length >= VIDEO_COUNT) break;
          const url = group.urls[offset];
          if (url) selected.push({ artist: group.artist, artistUrl: group.artistUrl, sourcePage: group.sourcePage, url });
        }
        offset++;
      }
    }
    const results = [];
    let production = null;
    if (PRODUCTION_FLOW) {
      const exactUrls = [...new Set(manifest.groups.flatMap(group => group.urls))];
      const deferredActiveUrl = await session.evaluate(`(() => {
        const wrapper = document.querySelector('.video-wrapper.deck-active');
        const originalUrl = String(wrapper?.dataset?.originalVideoUrl || '');
        const video = wrapper?.querySelector('video');
        const playbackUrl = String(video?.currentSrc || video?.src || '');
        return originalUrl && !random40IsPcFileCachePlaybackUrl(playbackUrl) ? originalUrl : '';
      })()`);
      const expectedCacheUrls = exactUrls.filter(url => url !== deferredActiveUrl);
      const cacheBeforePlayback = await waitFor(async () => {
        const status = await cacheStatus();
        const registeredUrls = new Set((status?.records || []).flatMap(record => record?.urls || []));
        return expectedCacheUrls.every(url => registeredUrls.has(url)) ? status : null;
      }, 15_000, 'exact full video-cache manifest registration', 150);
      const probes = [];
      for (let index = 0; index < selected.length; index++) {
        if (index > 0) {
          const priorPasteIndex = await session.evaluate(`Number(currentPasteIndex)`);
          await trustedClick(session, '#paste-nav-button');
          await waitFor(() => session.evaluate(`
            Number(currentPasteIndex) !== ${Number(priorPasteIndex)} &&
            Boolean(document.querySelector('.video-wrapper.deck-active .tap-area'))
          `), 8_000, 'Pong paperclip navigation');
        }
        const probe = await probeActualPongPlayer(session, PLAY_MS);
        const group = manifest.groups.find(candidate => candidate.urls.includes(probe.originalUrl));
        probes.push({ artist: group?.artist || '', ...probe });
      }
      const cacheAfterPlayback = await cacheStatus();
      production = {
        manifestVideos: exactUrls.length,
        deferredActiveUrl,
        expectedBackgroundRecords: expectedCacheUrls.length,
        registeredBackgroundRecords: Number(cacheBeforePlayback?.cache?.records || 0),
        fullManifestRegistered: true,
        cacheBeforePlayback: cacheBeforePlayback?.cache || null,
        cacheAfterPlayback: cacheAfterPlayback?.cache || null,
        probes,
        summary: {
          success: probes.filter(probe => probe.success).length,
          total: probes.length,
          firstFrameMs: summarize(probes.map(probe => probe.firstFrameMs)),
          stallMs: summarize(probes.map(probe => probe.stallMs)),
          longestStallMs: Math.max(0, ...probes.map(probe => Number(probe.longestStallMs || 0))),
          totalStalls: probes.reduce((sum, probe) => sum + Number(probe.stallCount || 0), 0),
          routes: probes.reduce((counts, probe) => {
            counts[probe.routeKind] = Number(counts[probe.routeKind] || 0) + 1;
            return counts;
          }, {}),
        }
      };
      if (probes.some(probe => !probe.success || Number(probe.stallCount || 0) > 0)) {
        process.exitCode = 1;
      }
      console.error(JSON.stringify({ production: production.summary }));
    } else {
      for (const method of METHOD_ORDER) {
        const result = await runMethod(session, method, selected);
        results.push(result);
        console.error(JSON.stringify({ method, summary: result.summary }));
      }
    }
    const report = {
      schema: 'pong-local2-video-loading-benchmark-v1',
      generatedAt: new Date().toISOString(),
      safety: {
        headless: true,
        chromeMuteAudio: true,
        chromeDisableAudioOutput: true,
        mediaElementsHidden: true,
        desktopWindowsShown: false,
      },
      exactFlow: 'trusted Local2 button, deterministic three-page live scan, one frozen accepted manifest',
      productionFlow: PRODUCTION_FLOW,
      pages: PAGES,
      discoveryMs,
      discovery: {
        accepted: manifest.state?.accepted,
        videos: manifest.state?.videos,
        pages: manifest.state?.pages,
        stageTimings: manifest.state?.stageTimings,
        artists: manifest.groups.map(group => ({
          artist: group.artist,
          artistUrl: group.artistUrl,
          sourcePage: group.sourcePage,
          videos: group.urls.length,
        })),
      },
      selected: selected.map(item => ({ artist: item.artist, sourcePage: item.sourcePage, url: item.url })),
      playWindowMs: PLAY_MS,
      production,
      results,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    session?.close();
    if (target?.id) await fetch(`http://127.0.0.1:${chrome.port}/json/close/${target.id}`).catch(() => {});
    await stopChromeTree(chrome.child);
    // Stop every page request before wiping so a late authoritative warm call
    // cannot recreate files after benchmark cleanup.
    await resetCache().catch(() => {});
    staticServer.server.closeAllConnections?.();
    await new Promise(resolve => staticServer.server.close(resolve));
    await delay(500);
    await removeChromeProfile(chrome.profile);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
