import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.PONG_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PONG = process.env.PONG_TEST_URL || 'http://127.0.0.1:8788/pong';
const BASE = new URL(PONG).origin;
const DIRECT = 'https://v20.erome.com/8726/pTrYBqm9/jrNsRhqI_720p.mp4';
const SOURCE = (
  process.env.PONG_SWEEP_SOURCE ||
  process.env.PONG_TEST_SOURCE ||
  `https://pong-erome-proxy.arianslade-pong.workers.dev/erome.mp4?u=${encodeURIComponent(DIRECT)}`
);
const ATTACH_WHEN = String(process.env.PONG_SWEEP_ATTACH_WHEN || 'early').trim().toLowerCase();
const PLAY_KICK = process.env.PONG_SWEEP_PLAY_KICK === '1';
const READY_TIMEOUT_MS = readPositiveNumber('PONG_SWEEP_TIMEOUT_MS', 30_000);
const STABILITY_MS = readPositiveNumber('PONG_SWEEP_STABILITY_MS', 750);
const DEFAULT_LEADS = [0.40, 0.50, 0.65, 0.80, 1.00];
const LEADS = parseLeadValues(process.env.PONG_SWEEP_LEADS);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function readPositiveNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function parseLeadValues(raw) {
  if (!raw?.trim()) return [...DEFAULT_LEADS];
  const values = raw
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(value => Number(value));
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0.25 || value > 5)) {
    throw new Error('PONG_SWEEP_LEADS must contain values from 0.25 through 5 seconds');
  }
  return values;
}

function streamSessionId(value) {
  try {
    return /\/pong-swap\/sessions\/([^/]+)\/stream(?:[?#]|$)/.exec(new URL(value).href)?.[1] || '';
  } catch (_) {
    return '';
  }
}

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
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
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) {
          listener(message.params || {});
        }
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    try {
      this.socket?.close();
    } catch (_) {}
  }
}

async function stopTree(child) {
  if (!child?.pid) return;
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('close', resolve);
    killer.once('error', resolve);
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {}
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function publicServerState(payload) {
  const session = payload?.session || payload || {};
  return {
    state: String(session.state || ''),
    error: String(session.error || ''),
    frames: Number(session.frames || 0),
    bytesWritten: Number(session.bytesWritten || 0),
    prepared: Boolean(session.prepared),
    mediaFragmentReady: Boolean(session.mediaFragmentReady),
    subscribers: Number(session.subscribers || 0),
    streamRequests: Number(session.streamRequests || 0),
    fps: Number(session.fps || 0),
    prebufferSeconds: Number(session.prebufferSeconds || 0),
  };
}

const streamRequests = [];
const streamResponses = [];
const streamFailures = [];
const sessionIds = new Set();
const report = {
  ok: false,
  pongUrl: PONG,
  source: SOURCE,
  attachWhen: ATTACH_WHEN,
  playKick: PLAY_KICK,
  timeoutMs: READY_TIMEOUT_MS,
  stabilityMs: STABILITY_MS,
  leads: LEADS,
  results: [],
  passedLeads: [],
};

let chrome;
let profile;
let cdp;

async function sessionStatus(sessionId) {
  return fetchJson(`${BASE}/pong-swap/sessions/${encodeURIComponent(sessionId)}?t=${Date.now()}`);
}

async function waitUntilPrepared(sessionId, outcome) {
  return waitFor(async () => {
    const payload = await sessionStatus(sessionId);
    const status = publicServerState(payload);
    outcome.server = status;
    if (status.error || status.state === 'error') {
      throw new Error(status.error || `session entered ${status.state}`);
    }
    if (!status.prepared) return null;
    outcome.preparedMs = Date.now() - outcome.createdAtEpochMs;
    return payload;
  }, READY_TIMEOUT_MS, `server preparation at ${outcome.leadSeconds.toFixed(2)} seconds`);
}

async function attachMutedVideo(sessionId, streamUrl) {
  const attachUrl = new URL(streamUrl, BASE);
  attachUrl.searchParams.set('attach', '1');
  return cdp.eval(`(() => {
    window.__pongHeldLeadSweep ||= Object.create(null);
    const sessionId = ${JSON.stringify(sessionId)};
    const prior = window.__pongHeldLeadSweep[sessionId]?.video;
    if (prior) prior.remove();

    const video = document.createElement('video');
    video.id = 'pong-held-lead-' + sessionId;
    video.preload = 'auto';
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.playsInline = true;
    video.controls = false;
    video.autoplay = false;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.style.cssText = 'position:fixed;left:-4px;bottom:-4px;width:1px;height:1px;opacity:0;pointer-events:none;';

    const startedAt = performance.now();
    const state = {
      sessionId,
      attachedEpochMs: Date.now(),
      events: { loadedmetadataMs:null, loadeddataMs:null, canplayMs:null, errorMs:null },
      error: null,
      srcAssignments: 0,
      readyState: 0,
      networkState: 0,
      currentSrc: '',
      playError: '',
      video,
    };
    const snapshot = () => {
      state.readyState = video.readyState;
      state.networkState = video.networkState;
      state.currentSrc = video.currentSrc || video.src || '';
    };
    const record = type => {
      const key = type + 'Ms';
      if (state.events[key] == null) state.events[key] = performance.now() - startedAt;
      if (type === 'error') {
        state.error = {
          code: Number(video.error?.code || 0),
          message: String(video.error?.message || ''),
        };
      }
      if ((type === 'loadeddata' || type === 'canplay') && ${PLAY_KICK ? 'true' : 'false'}) video.pause();
      snapshot();
    };
    for (const type of ['loadedmetadata', 'loadeddata', 'canplay', 'error']) {
      video.addEventListener(type, () => record(type));
    }

    document.body.appendChild(video);
    video.src = ${JSON.stringify(attachUrl.href)};
    state.srcAssignments += 1;
    if (${PLAY_KICK ? 'true' : 'false'}) {
      Promise.resolve(video.play()).catch(error => {
        state.playError = String(error?.message || error || 'play failed');
      });
    }
    snapshot();
    window.__pongHeldLeadSweep[sessionId] = state;
    return {
      attachedEpochMs: state.attachedEpochMs,
      connected: video.isConnected,
      muted: video.muted,
      volume: video.volume,
      preload: video.preload,
      srcAssignments: state.srcAssignments,
      assignedSrc: video.src,
    };
  })()`);
}

async function browserState(sessionId) {
  return cdp.eval(`(() => {
    const state = window.__pongHeldLeadSweep?.[${JSON.stringify(sessionId)}];
    if (!state) return null;
    const video = state.video;
    return {
      attachedEpochMs: state.attachedEpochMs,
      events: { ...state.events },
      error: state.error,
      srcAssignments: state.srcAssignments,
      connected: Boolean(video?.isConnected),
      muted: Boolean(video?.muted),
      volume: Number(video?.volume ?? -1),
      preload: String(video?.preload || ''),
      readyState: Number(video?.readyState || state.readyState || 0),
      networkState: Number(video?.networkState ?? state.networkState ?? 0),
      currentSrc: String(video?.currentSrc || video?.src || state.currentSrc || ''),
      paused: Boolean(video?.paused),
      currentTime: Number(video?.currentTime || 0),
      playError: String(state.playError || ''),
    };
  })()`);
}

async function removeBrowserVideo(sessionId) {
  if (!cdp) return;
  await cdp.eval(`(() => {
    const state = window.__pongHeldLeadSweep?.[${JSON.stringify(sessionId)}];
    if (!state) return false;
    const video = state.video;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.remove();
    }
    delete window.__pongHeldLeadSweep[${JSON.stringify(sessionId)}];
    return true;
  })()`).catch(() => null);
}

function networkStateFor(sessionId, attachedEpochMs) {
  const requests = streamRequests.filter(item => item.sessionId === sessionId);
  const responses = streamResponses.filter(item => item.sessionId === sessionId);
  const failures = streamFailures.filter(item => item.sessionId === sessionId);
  const uniqueRequestIds = [...new Set(requests.map(item => item.requestId))];
  return {
    requestCount: uniqueRequestIds.length,
    requests: requests.map(item => ({
      requestId: item.requestId,
      atMs: attachedEpochMs ? item.at - attachedEpochMs : null,
      url: item.url,
      type: item.type,
    })),
    responses: responses.map(item => ({
      requestId: item.requestId,
      atMs: attachedEpochMs ? item.at - attachedEpochMs : null,
      status: item.status,
      mimeType: item.mimeType,
      protocol: item.protocol,
    })),
    loadingFailures: failures.map(item => ({
      requestId: item.requestId,
      atMs: attachedEpochMs ? item.at - attachedEpochMs : null,
      errorText: item.errorText,
      canceled: item.canceled,
      blockedReason: item.blockedReason,
    })),
  };
}

async function sweepLead(leadSeconds, faceId, ordinal) {
  const outcome = {
    leadSeconds,
    attachWhen: ATTACH_WHEN,
    passed: false,
    createdAtEpochMs: Date.now(),
    preparedMs: null,
    attach: null,
    browser: null,
    network: { requestCount: 0, requests: [], responses: [], loadingFailures: [] },
    server: null,
    failureReasons: [],
  };
  let sessionId = '';
  try {
    const created = await fetchJson(`${BASE}/pong-swap/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: `test-held-lead-${process.pid}-${ordinal}`,
        sourceUrl: SOURCE,
        faceId,
        startSeconds: 0,
        prefetch: true,
        prebufferSeconds: leadSeconds,
      }),
    });
    sessionId = String(created?.session?.id || '');
    if (!sessionId) throw new Error('session create response did not include an id');
    sessionIds.add(sessionId);
    outcome.sessionId = sessionId;
    outcome.createdAtEpochMs = Date.now();
    outcome.server = publicServerState(created);

    if (ATTACH_WHEN === 'prepared') {
      await waitUntilPrepared(sessionId, outcome);
    }

    outcome.attach = await attachMutedVideo(sessionId, created.streamUrl);
    if (!outcome.attach.connected || !outcome.attach.muted || outcome.attach.volume !== 0) {
      throw new Error(`muted connected video invariant failed: ${JSON.stringify(outcome.attach)}`);
    }
    if (outcome.attach.srcAssignments !== 1) {
      throw new Error(`expected one src assignment, received ${outcome.attach.srcAssignments}`);
    }

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let readyObserved = false;
    while (Date.now() < deadline) {
      const [browser, statusPayload] = await Promise.all([
        browserState(sessionId),
        sessionStatus(sessionId),
      ]);
      outcome.browser = browser;
      outcome.server = publicServerState(statusPayload);
      if (outcome.preparedMs == null && outcome.server.prepared) {
        outcome.preparedMs = Date.now() - outcome.createdAtEpochMs;
      }
      const readyMs = [browser?.events?.loadeddataMs, browser?.events?.canplayMs]
        .filter(value => Number.isFinite(value));
      if (readyMs.length) {
        readyObserved = true;
        break;
      }
      if (browser?.events?.errorMs != null || outcome.server.error || outcome.server.state === 'error') break;
      await delay(100);
    }

    if (readyObserved) await delay(STABILITY_MS);
    outcome.browser = await browserState(sessionId);
    outcome.server = publicServerState(await sessionStatus(sessionId));
    outcome.network = networkStateFor(sessionId, outcome.attach.attachedEpochMs);

    const readyMs = [outcome.browser?.events?.loadeddataMs, outcome.browser?.events?.canplayMs]
      .filter(value => Number.isFinite(value));
    outcome.readyMs = readyMs.length ? Math.min(...readyMs) : null;
    if (outcome.readyMs == null) outcome.failureReasons.push('no loadeddata or canplay event before timeout');
    if (outcome.browser?.events?.errorMs != null || outcome.browser?.error) {
      outcome.failureReasons.push(`media error: ${JSON.stringify(outcome.browser.error || {})}`);
    }
    if (outcome.network.requestCount !== 1) {
      outcome.failureReasons.push(`held stream opened ${outcome.network.requestCount} requests instead of one`);
    }
    if (outcome.network.loadingFailures.length) {
      outcome.failureReasons.push(`${outcome.network.loadingFailures.length} held stream loading failure(s)`);
    }
    if (!outcome.browser?.muted || outcome.browser?.volume !== 0) {
      outcome.failureReasons.push('video did not remain muted at volume zero');
    }
    if (outcome.browser?.srcAssignments !== 1) {
      outcome.failureReasons.push(`video had ${outcome.browser?.srcAssignments ?? 'unknown'} src assignments`);
    }
    outcome.passed = outcome.failureReasons.length === 0;
  } catch (error) {
    outcome.failureReasons.push(String(error?.message || error));
    if (sessionId) {
      outcome.browser = await browserState(sessionId).catch(() => outcome.browser);
      outcome.server = await sessionStatus(sessionId)
        .then(publicServerState)
        .catch(() => outcome.server);
      outcome.network = networkStateFor(sessionId, outcome.attach?.attachedEpochMs || outcome.browser?.attachedEpochMs);
    }
  } finally {
    if (sessionId) {
      await removeBrowserVideo(sessionId);
      await fetch(`${BASE}/pong-swap/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => null);
      sessionIds.delete(sessionId);
      await delay(100);
    }
  }
  return outcome;
}

try {
  if (!['early', 'prepared'].includes(ATTACH_WHEN)) {
    throw new Error('PONG_SWEEP_ATTACH_WHEN must be early or prepared');
  }

  profile = await mkdtemp(path.join(os.tmpdir(), 'pong-swap-held-lead-'));
  chrome = spawn(CHROME, [
    '--headless=new',
    '--incognito',
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
    '--window-size=904,2316',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const port = await waitFor(async () => {
    const contents = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(contents.split(/\r?\n/)[0]) || 0;
  }, 15_000, 'Chrome DevTools');
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(PONG)}`, {
    method: 'PUT',
  });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: HTTP ${targetResponse.status}`);
  const target = await targetResponse.json();
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();

  cdp.on('Network.requestWillBeSent', event => {
    const sessionId = streamSessionId(event.request?.url || '');
    if (!sessionId) return;
    streamRequests.push({
      sessionId,
      requestId: event.requestId,
      url: event.request.url,
      at: Date.now(),
      type: event.type || '',
    });
  });
  cdp.on('Network.responseReceived', event => {
    const sessionId = streamSessionId(event.response?.url || '');
    if (!sessionId) return;
    streamResponses.push({
      sessionId,
      requestId: event.requestId,
      status: event.response.status,
      mimeType: event.response.mimeType || '',
      protocol: event.response.protocol || '',
      at: Date.now(),
    });
  });
  cdp.on('Network.loadingFailed', event => {
    const request = streamRequests.find(item => item.requestId === event.requestId);
    if (!request) return;
    streamFailures.push({
      sessionId: request.sessionId,
      requestId: event.requestId,
      errorText: event.errorText || '',
      canceled: Boolean(event.canceled),
      blockedReason: event.blockedReason || '',
      at: Date.now(),
    });
  });

  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Page.enable'),
    cdp.send('Network.enable'),
  ]);
  await waitFor(
    () => cdp.eval(`document.readyState === 'complete' && Boolean(document.body)`),
    20_000,
    'Pong page',
  );
  await cdp.eval(`(() => {
    document.querySelectorAll('video,audio').forEach(media => {
      media.pause();
      media.muted = true;
      media.volume = 0;
    });
    return true;
  })()`);

  const facesPayload = await fetchJson(`${BASE}/pong-swap/faces?t=${Date.now()}`);
  const face = facesPayload?.faces?.[0];
  if (!face?.id) throw new Error('approved test face is missing');
  report.face = { id: face.id, name: face.name || '' };

  for (let index = 0; index < LEADS.length; index += 1) {
    const outcome = await sweepLead(LEADS[index], face.id, index);
    report.results.push(outcome);
  }
  report.passedLeads = report.results.filter(result => result.passed).map(result => result.leadSeconds);
  report.ok = report.passedLeads.length > 0;
} catch (error) {
  report.error = String(error?.stack || error?.message || error);
} finally {
  if (cdp) {
    await cdp.eval(`(() => {
      for (const state of Object.values(window.__pongHeldLeadSweep || {})) {
        const video = state?.video;
        if (!video) continue;
        video.pause();
        video.removeAttribute('src');
        video.remove();
      }
      window.__pongHeldLeadSweep = Object.create(null);
      return true;
    })()`).catch(() => null);
  }
  for (const sessionId of sessionIds) {
    await fetch(`${BASE}/pong-swap/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => null);
  }
  cdp?.close();
  await stopTree(chrome);
  await delay(500);
  if (profile) {
    await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }).catch(() => null);
  }
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passedLeads.length > 0 ? 0 : 1;
