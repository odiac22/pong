import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOST_BASE = process.env.PONG_SWAP_HOST_BASE || 'http://127.0.0.1:8787';
const DEVICE_BASE = process.env.PONG_SWAP_DEVICE_BASE || 'http://10.0.2.2:8787';
const CDP_PORT = Number(process.env.PONG_ANDROID_CDP_PORT || 9225);
const FACE_ID = process.env.PONG_SWAP_FACE_ID || 'approved-2-6661c9deb08e';
const SOURCE = process.env.PONG_SWAP_SOURCE ||
  'https://pong-erome-proxy.arianslade-pong.workers.dev/erome.mp4?u=https%3A%2F%2Fv40.erome.com%2F8311%2Fwa48QuqZ%2F5w5ExyNX_720p.mp4';
const THRESHOLDS = String(process.env.PONG_SWAP_STARTUP_BYTE_THRESHOLDS ||
  '32768,65536,98304,131072,196608,262144,393216,524288')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0);
const PRODUCE_TIMEOUT_MS = Number(process.env.PONG_SWAP_PRODUCE_TIMEOUT_MS || 90_000);
const BROWSER_TIMEOUT_MS = Number(process.env.PONG_SWAP_BROWSER_TIMEOUT_MS || 12_000);
const OUTPUT = process.env.PONG_SWAP_STARTUP_BUFFER_REPORT ||
  path.resolve('artifacts', `android-swap-startup-buffer-${new Date().toISOString().replaceAll(':', '-')}.json`);

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(payload)}`);
  return payload;
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.socket = null;
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
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) {
        pending.reject(new Error(message.error?.message || message.result.exceptionDetails.text));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, { timeoutMs = BROWSER_TIMEOUT_MS + 5_000 } = {}) {
    const command = this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('CDP evaluation timed out')), timeoutMs).unref();
    });
    const result = await Promise.race([command, timeout]);
    return result?.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function waitForBytes(sessionId, threshold) {
  const deadline = Date.now() + PRODUCE_TIMEOUT_MS;
  let state = null;
  while (Date.now() < deadline) {
    state = (await fetchJson(`${HOST_BASE}/pong-swap/sessions/${sessionId}?t=${Date.now()}`)).session;
    if (Number(state.bytesWritten || 0) >= threshold || state.terminal) return state;
    await delay(100);
  }
  throw new Error(`session ${sessionId} did not reach ${threshold} bytes; last=${state?.bytesWritten || 0}`);
}

async function attachAndProbe(cdp, sessionId) {
  const streamUrl = `${DEVICE_BASE}/pong-swap/sessions/${encodeURIComponent(sessionId)}/stream?startupProbe=1`;
  return cdp.eval(`new Promise(resolve => {
    const id = ${JSON.stringify(`pong-startup-probe-${sessionId}`)};
    document.getElementById(id)?.remove();
    const video = document.createElement('video');
    video.id = id;
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    Object.assign(video.style, {
      position: 'fixed', left: '-10000px', top: '-10000px',
      width: '1px', height: '1px', opacity: '0.001', pointerEvents: 'none'
    });
    const startedAt = performance.now();
    const events = [];
    let settled = false;
    const snapshot = reason => ({
      reason,
      elapsedMs: performance.now() - startedAt,
      events,
      readyState: video.readyState,
      networkState: video.networkState,
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      paused: video.paused,
      muted: video.muted,
      defaultMuted: video.defaultMuted,
      volume: video.volume,
      error: video.error ? { code: video.error.code, message: video.error.message || '' } : null,
    });
    const finish = reason => {
      if (settled) return;
      settled = true;
      resolve(snapshot(reason));
    };
    for (const name of ['loadstart','loadedmetadata','loadeddata','canplay','playing','waiting','stalled','suspend','error']) {
      video.addEventListener(name, () => {
        events.push({ name, atMs: performance.now() - startedAt, readyState: video.readyState, currentTime: video.currentTime });
        if (name === 'error') finish('error');
        if ((name === 'loadeddata' || name === 'canplay' || name === 'playing') && video.readyState >= 2) finish('ready');
      });
    }
    document.body.appendChild(video);
    video.src = ${JSON.stringify(streamUrl)};
    video.load();
    Promise.resolve(video.play()).catch(error => {
      events.push({ name: 'play-rejected', atMs: performance.now() - startedAt, message: String(error?.message || error) });
    });
    setTimeout(() => finish('timeout'), ${BROWSER_TIMEOUT_MS});
  })`);
}

async function removeProbe(cdp, sessionId) {
  return cdp.eval(`(() => {
    const video = document.getElementById(${JSON.stringify(`pong-startup-probe-${sessionId}`)});
    if (!video) return false;
    video.muted = true; video.defaultMuted = true; video.volume = 0;
    try { video.pause(); } catch {}
    video.removeAttribute('src');
    try { video.load(); } catch {}
    video.remove();
    return true;
  })()`);
}

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(response => response.json());
const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
assert(target?.webSocketDebuggerUrl, `No Android WebView CDP page on ${CDP_PORT}`);

const cdp = new Cdp(target.webSocketDebuggerUrl);
const report = {
  generatedAt: new Date().toISOString(),
  source: SOURCE,
  faceId: FACE_ID,
  thresholds: THRESHOLDS,
  userAgent: null,
  results: [],
};
await cdp.connect();
try {
  await cdp.send('Runtime.enable');
  report.userAgent = await cdp.eval('navigator.userAgent');
  await cdp.eval(`(() => {
    window.__pongStartupOriginalPlay = window.__pongStartupOriginalPlay || HTMLMediaElement.prototype.play;
    for (const media of document.querySelectorAll('audio,video')) {
      media.muted = true; media.defaultMuted = true; media.volume = 0;
    }
    return true;
  })()`);

  for (let index = 0; index < THRESHOLDS.length; index += 1) {
    const threshold = THRESHOLDS[index];
    let sessionId = '';
    const result = { threshold, createdAt: new Date().toISOString() };
    try {
      const created = await fetchJson(`${HOST_BASE}/pong-swap/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: `android-startup-buffer-${process.pid}-${index}`,
          sourceUrl: SOURCE,
          faceId: FACE_ID,
          startSeconds: 0,
          prefetch: true,
          prebufferSeconds: 5,
          navigationClass: 'prefetch',
          clientEpoch: `startup-buffer-${process.pid}-${index}`,
        }),
      });
      sessionId = String(created.session?.id || '');
      assert(sessionId, 'create response had no session id');
      result.sessionId = sessionId;
      await fetchJson(`${HOST_BASE}/pong-swap/sessions/${sessionId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientEpoch: `startup-buffer-${process.pid}-${index}`, activationSequence: 1 }),
      });
      const beforeAttach = await waitForBytes(sessionId, threshold);
      result.beforeAttach = {
        bytesWritten: beforeAttach.bytesWritten,
        frames: beforeAttach.frames,
        muxedMediaSeconds: beforeAttach.muxedMediaSeconds,
        compatibilityStatus: beforeAttach.compatibilityStatus,
        inferenceFrames: beforeAttach.inferenceFrames,
        completeFragments: beforeAttach.completeFragments,
      };
      result.browser = await attachAndProbe(cdp, sessionId);
      result.server = (await fetchJson(`${HOST_BASE}/pong-swap/sessions/${sessionId}?t=${Date.now()}`)).session;
      result.passed = result.browser?.reason === 'ready' &&
        result.browser?.readyState >= 2 && result.browser?.muted === true && result.browser?.volume === 0;
    } catch (error) {
      result.error = String(error?.stack || error);
      result.passed = false;
    } finally {
      if (sessionId) {
        await removeProbe(cdp, sessionId).catch(() => null);
        await fetch(`${HOST_BASE}/pong-swap/sessions/${encodeURIComponent(sessionId)}?defer=1`, { method: 'DELETE' }).catch(() => null);
      }
    }
    report.results.push(result);
    console.log(JSON.stringify({
      threshold,
      bytes: result.beforeAttach?.bytesWritten,
      mediaSeconds: result.beforeAttach?.muxedMediaSeconds,
      browser: result.browser,
      passed: result.passed,
      error: result.error,
    }));
    await delay(500);
  }
} finally {
  cdp.close();
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({ output: OUTPUT, passed: report.results.filter(item => item.passed).map(item => item.threshold) }, null, 2));
