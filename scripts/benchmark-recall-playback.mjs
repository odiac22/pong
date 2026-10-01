import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOCAL_AI = String(process.env.PONG_RECALL_BENCH_LOCAL_AI || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CHROME = process.env.PONG_RECALL_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LOAD_TIMEOUT_MS = Math.max(30_000, Number(process.env.PONG_RECALL_BENCH_LOAD_TIMEOUT_MS || 180_000));
const SWIPE_INTERVAL_MS = Math.max(1_000, Number(process.env.PONG_RECALL_BENCH_SWIPE_INTERVAL_MS || 5_000));
const PAPERCLIP_AT_MS = Math.max(10_000, Number(process.env.PONG_RECALL_BENCH_PAPERCLIP_AT_MS || 60_000));
const RUN_MS = Math.max(PAPERCLIP_AT_MS + 8_000, Number(process.env.PONG_RECALL_BENCH_DURATION_MS || 70_000));
const START_EXPRESSION = String(process.env.PONG_PLAYBACK_BENCH_START_EXPRESSION || '').trim();
const READY_EXPRESSION = String(process.env.PONG_PLAYBACK_BENCH_READY_EXPRESSION || '').trim();
const BENCHMARK_NAME = String(process.env.PONG_PLAYBACK_BENCH_NAME || 'recall1-playback').trim();

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class BenchError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function waitFor(predicate, timeoutMs, code, intervalMs = 125) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (_) {}
    await delay(intervalMs);
  }
  throw new BenchError(code);
}

class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
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
      if (message.error) pending.reject(new BenchError('cdp-command-failed'));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { userGesture = false } = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture
    });
    if (response.exceptionDetails) throw new BenchError('page-evaluation-failed');
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch (_) {}
  }
}

async function preflight() {
  try {
    const healthResponse = await fetch(`${LOCAL_AI}/health?t=${Date.now()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000)
    });
    if (!healthResponse.ok) return { server: false, recall: false, itemCount: 0 };
    await healthResponse.arrayBuffer();
  } catch (_) {
    return { server: false, recall: false, itemCount: 0 };
  }

  try {
    const response = await fetch(`${LOCAL_AI}/simpcity/recall?channel=1&consume=0&t=${Date.now()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return { server: true, recall: false, itemCount: 0 };
    const payload = await response.json();
    const names = Array.isArray(payload?.recall?.names) ? payload.recall.names.length : 0;
    const albums = Array.isArray(payload?.recall?.albums) ? payload.recall.albums.length : 0;
    const pending = Boolean(payload?.pending?.threadUrl);
    const background = ['starting', 'running'].includes(String(payload?.background?.state || ''));
    return {
      server: true,
      recall: START_EXPRESSION ? true : names + albums > 0 || pending || background,
      itemCount: names + albums
    };
  } catch (_) {
    return { server: true, recall: false, itemCount: 0 };
  }
}

async function startChrome() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pong-recall-playback-bench-'));
  let child = null;
  try {
    child = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--mute-audio',
      '--disable-audio-output',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-features=MediaRouter,Translate',
      '--window-size=412,915',
      'about:blank'
    ], { stdio: 'ignore', windowsHide: true });
    let spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });

    const port = await waitFor(async () => {
      if (spawnFailed) return -1;
      const raw = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
      return Number(raw.split(/\r?\n/)[0]) || 0;
    }, 15_000, 'chrome-start-timeout');
    if (port < 0) throw new BenchError('chrome-launch-failed');
    const target = await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      return targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl) || null;
    }, 10_000, 'chrome-page-timeout');
    return { child, profile, port, target };
  } catch (error) {
    await stopChromeTree(child).catch(() => {});
    await removeChromeProfile(profile).catch(() => {});
    throw error;
  }
}

async function stopChromeTree(child) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
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

async function removeChromeProfile(profile) {
  if (!profile) return;
  const resolved = path.resolve(profile);
  const tempRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(resolved) !== tempRoot ||
    !path.basename(resolved).startsWith('pong-recall-playback-bench-')
  ) throw new BenchError('unsafe-profile-path');
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(resolved, { recursive: true, force: true });
      return;
    } catch (_) {
      await delay(200 * (attempt + 1));
    }
  }
}

function browserMonitor() {
  const state = {
    nextId: 1,
    records: new Map(),
    nodes: new Map(),
    activeIds: new Set(),
    playAttempts: 0,
    removedVideos: 0,
    removedActiveVideos: 0,
    unsafeRemovedActiveVideos: 0,
    unsafeRemovalReasons: {
      connected: 0,
      playing: 0,
      audible: 0,
      sourceAttached: 0,
      hlsOwned: 0,
      blobOwned: 0
    },
    removalAudits: new Map(),
    alerts: 0
  };
  const idFor = video => {
    if (!video) return 0;
    if (!video.__pongRecallBenchmarkId) video.__pongRecallBenchmarkId = state.nextId++;
    const id = Number(video.__pongRecallBenchmarkId);
    state.nodes.set(id, video);
    if (!state.records.has(id)) state.records.set(id, {
      ready: false,
      played: false,
      advanced: false,
      error: false,
      waiting: 0,
      stalled: 0,
      maxTime: 0,
      wasActive: false
    });
    return id;
  };
  const hardMute = media => {
    try { media.muted = true; } catch (_) {}
    try { media.volume = 0; } catch (_) {}
  };
  const sample = (video, active = false) => {
    if (!video) return 0;
    hardMute(video);
    const id = idFor(video);
    const record = state.records.get(id);
    const currentTime = Math.max(0, Number(video.currentTime || 0));
    record.maxTime = Math.max(record.maxTime, currentTime);
    record.ready ||= Number(video.readyState || 0) >= 2;
    record.advanced ||= currentTime >= 0.05;
    record.error ||= Boolean(video.error);
    if (active) {
      record.wasActive = true;
      state.activeIds.add(id);
    }
    return id;
  };

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    hardMute(this);
    return nativePlay.apply(this, args);
  };

  for (const type of ['loadeddata', 'canplay', 'playing', 'timeupdate', 'error', 'waiting', 'stalled']) {
    document.addEventListener(type, event => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      const active = Boolean(video.closest?.('.video-wrapper.deck-active'));
      const id = sample(video, active);
      const record = state.records.get(id);
      if (type === 'playing') record.played = true;
      if (type === 'error') record.error = true;
      if (type === 'waiting') record.waiting++;
      if (type === 'stalled') record.stalled++;
    }, true);
  }

  const auditRemovedVideo = video => {
    const id = idFor(video);
    // A subtree removal may be reported once for the wrapper and again for a
    // nested node. Audit each media element exactly once.
    if (state.removalAudits.has(id)) return;
    const record = state.records.get(id);
    const detached = !video.hasAttribute('src') && !video.querySelector?.('source[src]');
    const audit = {
      found: true,
      connected: Boolean(video.isConnected),
      paused: Boolean(video.paused),
      muted: Boolean(video.muted) && Number(video.volume || 0) === 0,
      detached,
      hlsReleased: !video.__pongHls,
      blobReleased: !video.__pongBlobUrl
    };
    const safe = !audit.connected && audit.paused && audit.muted && audit.detached &&
      audit.hlsReleased && audit.blobReleased;
    state.removalAudits.set(id, audit);
    state.removedVideos++;
    if (record.wasActive) {
      state.removedActiveVideos++;
      if (!safe) {
        state.unsafeRemovedActiveVideos++;
        if (audit.connected) state.unsafeRemovalReasons.connected++;
        if (!audit.paused) state.unsafeRemovalReasons.playing++;
        if (!audit.muted) state.unsafeRemovalReasons.audible++;
        if (!audit.detached) state.unsafeRemovalReasons.sourceAttached++;
        if (!audit.hlsReleased) state.unsafeRemovalReasons.hlsOwned++;
        if (!audit.blobReleased) state.unsafeRemovalReasons.blobOwned++;
      }
    }
    hardMute(video);
  };
  const startObserver = () => {
    if (!document.documentElement) return;
    new MutationObserver(mutations => {
      mutations.forEach(mutation => mutation.removedNodes.forEach(node => {
        if (node instanceof HTMLVideoElement) auditRemovedVideo(node);
        node.querySelectorAll?.('video').forEach(auditRemovedVideo);
      }));
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  const activeVideo = () => document.querySelector('.video-wrapper.deck-active video');
  const activeSnapshot = () => {
    const video = activeVideo();
    const wrapper = video?.closest?.('.video-wrapper');
    const id = sample(video, true);
    const record = id ? state.records.get(id) : null;
    let eventCount = 0;
    let currentEventIndex = -1;
    let paperclipReady = false;
    try {
      eventCount = typeof pasteEvents !== 'undefined' && Array.isArray(pasteEvents)
        ? pasteEvents.filter(event => event?.paperclipHidden !== true && Number(event?.count || 0) > 0).length
        : 0;
      currentEventIndex = typeof currentPasteIndex !== 'undefined' ? Number(currentPasteIndex) : -1;
      paperclipReady = typeof canNavigateToNextPasteEvent === 'function' && canNavigateToNextPasteEvent();
    } catch (_) {}
    return {
      activeId: id,
      ready: Boolean(record?.ready),
      played: Boolean(record?.played),
      advanced: Boolean(record?.advanced),
      paused: video ? Boolean(video.paused) : true,
      error: Boolean(record?.error),
      errorCode: Number(video?.error?.code || 0),
      currentHost: (() => { try { return new URL(video?.currentSrc || video?.src || '').hostname; } catch (_) { return ''; } })(),
      originalHost: (() => { try { return new URL(wrapper?.dataset?.canonicalMediaUrl || wrapper?.dataset?.originalVideoUrl || '').hostname; } catch (_) { return ''; } })(),
      eventCount,
      currentEventIndex,
      paperclipReady
    };
  };

  const forceActivePlay = () => {
    const video = activeVideo();
    if (!video) return false;
    sample(video, true);
    hardMute(video);
    state.playAttempts++;
    try {
      const result = typeof window.playVideoCleanly === 'function'
        ? window.playVideoCleanly(video)
        : video.play();
      Promise.resolve(result).catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  };

  const beforeArtistTransition = () => {
    const snapshot = activeSnapshot();
    return { activeId: snapshot.activeId, currentEventIndex: snapshot.currentEventIndex };
  };
  const auditArtistTransition = activeId => {
    const removedAudit = state.removalAudits.get(Number(activeId));
    if (removedAudit) return removedAudit;
    const video = state.nodes.get(Number(activeId));
    if (!video) return { found: false };
    const audit = {
      found: true,
      connected: Boolean(video.isConnected),
      paused: Boolean(video.paused),
      muted: Boolean(video.muted) && Number(video.volume || 0) === 0,
      detached: !video.hasAttribute('src') && !video.querySelector?.('source[src]'),
      hlsReleased: !video.__pongHls,
      blobReleased: !video.__pongBlobUrl
    };
    hardMute(video);
    return audit;
  };
  const summary = () => {
    const activeRecords = [...state.activeIds].map(id => state.records.get(id)).filter(Boolean);
    return {
      uniqueActiveVideos: state.activeIds.size,
      readyActiveVideos: activeRecords.filter(record => record.ready).length,
      playedActiveVideos: activeRecords.filter(record => record.played).length,
      timeAdvancedActiveVideos: activeRecords.filter(record => record.advanced).length,
      erroredActiveVideos: activeRecords.filter(record => record.error).length,
      waitingEvents: activeRecords.reduce((sum, record) => sum + record.waiting, 0),
      stalledEvents: activeRecords.reduce((sum, record) => sum + record.stalled, 0),
      playAttempts: state.playAttempts,
      removedVideos: state.removedVideos,
      removedActiveVideos: state.removedActiveVideos,
      unsafeRemovedActiveVideos: state.unsafeRemovedActiveVideos,
      unsafeRemovalReasons: { ...state.unsafeRemovalReasons },
      interceptedAlerts: state.alerts
    };
  };

  window.alert = () => { state.alerts++; };
  window.__pongRecallPlaybackBenchmark = {
    activeSnapshot,
    forceActivePlay,
    beforeArtistTransition,
    auditArtistTransition,
    summary
  };
  setInterval(() => {
    document.querySelectorAll('video, audio').forEach(hardMute);
    sample(activeVideo(), true);
  }, 100);
}

async function trustedTouchTap(session, selector) {
  const documentNode = await session.send('DOM.getDocument', { depth: 1 });
  const target = await session.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector
  });
  if (!target.nodeId) throw new BenchError('touch-target-missing');
  await session.send('DOM.scrollIntoViewIfNeeded', { nodeId: target.nodeId });
  const model = await session.send('DOM.getBoxModel', { nodeId: target.nodeId });
  const points = model.model?.border || model.model?.content;
  if (!Array.isArray(points) || points.length < 8) throw new BenchError('touch-target-hidden');
  const x = (points[0] + points[2] + points[4] + points[6]) / 4;
  const y = (points[1] + points[3] + points[5] + points[7]) / 4;
  const touch = [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch });
  await delay(40);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function trustedSwipeUp(session) {
  const selector = '.video-wrapper.deck-active .tap-area';
  const documentNode = await session.send('DOM.getDocument', { depth: 1 });
  const target = await session.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector
  });
  if (!target.nodeId) throw new BenchError('swipe-target-missing');
  const model = await session.send('DOM.getBoxModel', { nodeId: target.nodeId });
  const points = model.model?.border || model.model?.content;
  if (!Array.isArray(points) || points.length < 8) throw new BenchError('swipe-target-hidden');
  const x = (points[0] + points[2] + points[4] + points[6]) / 4;
  const top = Math.min(points[1], points[3], points[5], points[7]);
  const bottom = Math.max(points[1], points[3], points[5], points[7]);
  const startY = Math.max(top + 100, bottom - 180);
  const endY = Math.min(bottom - 100, top + 180);
  const touch = y => [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(startY) });
  for (let step = 1; step <= 6; step++) {
    await delay(18);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: touch(startY + ((endY - startY) * step / 6))
    });
  }
  await delay(20);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function dismissSplash(session) {
  const hidden = async () => session.evaluate(
    `document.querySelector('#pong-overlay')?.classList.contains('hidden') === true`
  );
  if (await hidden().catch(() => false)) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    await trustedTouchTap(session, '#pong-hotspot');
    await delay(100);
    if (await hidden().catch(() => false)) return;
  }
  await waitFor(hidden, 3_000, 'splash-dismiss-timeout');
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0;
}

async function runBenchmark(preflightState) {
  let chrome = null;
  let session = null;
  const interactions = {
    swipeAttempts: 0,
    swipeCardChanges: 0,
    swipeUnavailable: 0,
    paperclipAttempted: false,
    paperclipAdvanced: false
  };
  let transitionAudit = null;
  const wallStartedAt = Date.now();

  try {
    chrome = await startChrome();
    session = new CdpSession(chrome.target.webSocketDebuggerUrl);
    await session.connect();
    await Promise.all([
      session.send('Runtime.enable'),
      session.send('Page.enable'),
      session.send('DOM.enable')
    ]);
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${browserMonitor.toString()})()`
    });
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      mobile: true,
      screenWidth: 412,
      screenHeight: 915
    });
    await session.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5
    });
    await session.send('Page.navigate', {
      url: `${LOCAL_AI}/pong?pongInstance=1&recallPlaybackBenchmark=${Date.now()}`
    });
    await waitFor(
      () => session.evaluate(`document.readyState === 'complete' && Boolean(window.__pongRecallPlaybackBenchmark)`),
      30_000,
      'pong-load-timeout'
    );
    if (START_EXPRESSION) {
      await session.evaluate(`(() => { const overlay = document.querySelector('#pong-overlay'); if (overlay) { overlay.classList.add('hidden'); overlay.style.display = 'none'; } return true; })()`);
    } else {
      await dismissSplash(session);
    }
    if (READY_EXPRESSION) {
      await waitFor(
        () => session.evaluate(`Boolean(${READY_EXPRESSION})`),
        15_000,
        'playback-action-not-ready'
      );
    }
    await session.evaluate(`(() => {
      window.__pongPlaybackBenchmarkErrors = [];
      const remember = (...args) => window.__pongPlaybackBenchmarkErrors.push(args.map(value => String(value?.stack || value)).join(' '));
      const nativeError = console.error.bind(console);
      console.error = (...args) => { remember(...args); nativeError(...args); };
      window.addEventListener('error', event => remember(event.error || event.message || 'page-error'));
      window.addEventListener('unhandledrejection', event => remember(event.reason || 'unhandled-rejection'));
      return true;
    })()`);

    const clickStartedAt = Date.now();
    if (START_EXPRESSION) {
      await session.evaluate(`Promise.resolve(${START_EXPRESSION})`, { userGesture: true });
    } else {
      await trustedTouchTap(session, '#simpcity-recall-1');
      await waitFor(
        () => session.evaluate(`document.documentElement.dataset.pongRecallChannel === '1'`),
        5_000,
        'recall-click-not-accepted'
      );
    }
    let first;
    try {
      first = await waitFor(
        () => session.evaluate(`(() => {
          const value = window.__pongRecallPlaybackBenchmark?.activeSnapshot?.();
          return value?.activeId ? value : null;
        })()`),
        LOAD_TIMEOUT_MS,
        'first-recall-video-timeout',
        250
      );
    } catch (error) {
      const diagnostic = await session.evaluate(`(() => ({
        wrappers: document.querySelectorAll('.video-wrapper').length,
        videos: document.querySelectorAll('video').length,
        active: document.querySelectorAll('.video-wrapper.deck-active').length,
        savedMode: String(window.PongLoadedSavedMode || ''),
        cachedArtists: Number(window.PongSavedPlaybackMemoryCache?.artists?.artists?.length || 0),
        cachedVideos: Number(window.PongSavedPlaybackMemoryCache?.videos?.items?.length || 0),
        loadingText: String(document.querySelector('.loading-message')?.textContent || ''),
        errors: (window.__pongPlaybackBenchmarkErrors || []).slice(-5)
      }))()`).catch(() => null);
      process.stderr.write(`${JSON.stringify({ diagnostic })}\n`);
      throw error;
    }
    const firstBundleMs = Date.now() - clickStartedAt;
    await session.evaluate(`window.__pongRecallPlaybackBenchmark.forceActivePlay()`, { userGesture: true });

    const sampleStartedAt = Date.now();
    let lastActiveId = Number(first.activeId || 0);
    let lastSnapshot = first;
    let nextSwipeAt = sampleStartedAt + SWIPE_INTERVAL_MS;
    let paperclipDecisionMade = false;

    while (Date.now() - sampleStartedAt < RUN_MS) {
      const now = Date.now();
      const elapsed = now - sampleStartedAt;
      const snapshot = await session.evaluate(`window.__pongRecallPlaybackBenchmark.activeSnapshot()`);
      lastSnapshot = snapshot || lastSnapshot;
      if (snapshot?.activeId && (snapshot.paused || Number(snapshot.activeId) !== lastActiveId)) {
        await session.evaluate(`window.__pongRecallPlaybackBenchmark.forceActivePlay()`, { userGesture: true });
      }
      if (snapshot?.activeId) lastActiveId = Number(snapshot.activeId);

      if (!paperclipDecisionMade && elapsed >= PAPERCLIP_AT_MS) {
        paperclipDecisionMade = true;
        if (snapshot?.paperclipReady && Number(snapshot.eventCount || 0) > 1) {
          interactions.paperclipAttempted = true;
          const before = await session.evaluate(
            `window.__pongRecallPlaybackBenchmark.beforeArtistTransition()`
          );
          await trustedTouchTap(session, '#paste-nav-button');
          const after = await waitFor(
            async () => {
              const value = await session.evaluate(
                `window.__pongRecallPlaybackBenchmark.activeSnapshot()`
              );
              return value?.activeId && (
                Number(value.currentEventIndex) !== Number(before.currentEventIndex) ||
                Number(value.activeId) !== Number(before.activeId)
              ) ? value : null;
            },
            8_000,
            'paperclip-transition-timeout',
            200
          );
          interactions.paperclipAdvanced = Boolean(after);
          await delay(500);
          transitionAudit = await session.evaluate(
            `window.__pongRecallPlaybackBenchmark.auditArtistTransition(${Number(before.activeId || 0)})`
          );
          await session.evaluate(`window.__pongRecallPlaybackBenchmark.forceActivePlay()`, { userGesture: true });
          while (nextSwipeAt <= Date.now()) nextSwipeAt += SWIPE_INTERVAL_MS;
        }
      } else if (now >= nextSwipeAt) {
        interactions.swipeAttempts++;
        const beforeId = Number(snapshot?.activeId || 0);
        try {
          await trustedSwipeUp(session);
          await delay(450);
          const after = await session.evaluate(`window.__pongRecallPlaybackBenchmark.activeSnapshot()`);
          if (Number(after?.activeId || 0) !== beforeId) interactions.swipeCardChanges++;
          await session.evaluate(`window.__pongRecallPlaybackBenchmark.forceActivePlay()`, { userGesture: true });
        } catch (_) {
          interactions.swipeUnavailable++;
        }
        while (nextSwipeAt <= Date.now()) nextSwipeAt += SWIPE_INTERVAL_MS;
      }
      await delay(200);
    }

    const playback = await session.evaluate(`window.__pongRecallPlaybackBenchmark.summary()`);
    const oldVideoSafe = Boolean(transitionAudit?.found && (
      transitionAudit.connected === false &&
      transitionAudit.paused === true &&
      transitionAudit.muted === true &&
      transitionAudit.detached === true &&
      transitionAudit.hlsReleased === true &&
      transitionAudit.blobReleased === true
    ));
    const checks = {
      firstBundleLoaded: firstBundleMs <= LOAD_TIMEOUT_MS,
      atLeastOneReady: Number(playback.readyActiveVideos || 0) > 0,
      atLeastOnePlayable: Number(playback.playedActiveVideos || 0) > 0 ||
        Number(playback.timeAdvancedActiveVideos || 0) > 0,
      removedActiveVideosSafe: Number(playback.unsafeRemovedActiveVideos || 0) === 0,
      paperclipOldVideoSafe: interactions.paperclipAttempted ? oldVideoSafe : null
    };
    const requiredChecks = Object.values(checks).filter(value => value !== null);
    return {
      benchmark: BENCHMARK_NAME,
      ok: requiredChecks.every(Boolean),
      skipped: false,
      safety: {
        headless: true,
        chromeMuted: true,
        audioOutputDisabled: true,
        pageMediaForcedMuted: true
      },
      availability: {
        server: true,
        recall: true,
        initialRecallItems: preflightState.itemCount
      },
      timing: {
        firstBundleMs,
        sampledMs: Date.now() - sampleStartedAt,
        wallMs: Date.now() - wallStartedAt,
        swipeIntervalMs: SWIPE_INTERVAL_MS,
        paperclipAtMs: PAPERCLIP_AT_MS
      },
      interactions,
      playback: {
        ...playback,
        readyRate: rate(playback.readyActiveVideos, playback.uniqueActiveVideos),
        playableRate: rate(
          Math.max(playback.playedActiveVideos, playback.timeAdvancedActiveVideos),
          playback.uniqueActiveVideos
        )
      },
      lastActive: {
        errorCode: Number(lastSnapshot?.errorCode || 0),
        currentHost: String(lastSnapshot?.currentHost || ''),
        originalHost: String(lastSnapshot?.originalHost || '')
      },
      transition: {
        audited: interactions.paperclipAttempted,
        oldVideoSafe: interactions.paperclipAttempted ? oldVideoSafe : null
      },
      checks
    };
  } finally {
    session?.close();
    await stopChromeTree(chrome?.child).catch(() => {});
    await removeChromeProfile(chrome?.profile).catch(() => {});
  }
}

let report;
try {
  const available = await preflight();
  if (!available.server) {
    report = {
      benchmark: BENCHMARK_NAME,
      ok: false,
      skipped: true,
      reason: 'server-unavailable'
    };
  } else if (!available.recall) {
    report = {
      benchmark: BENCHMARK_NAME,
      ok: false,
      skipped: true,
      reason: 'recall1-unavailable',
      availability: { server: true, recall: false, initialRecallItems: 0 }
    };
  } else {
    report = await runBenchmark(available);
  }
} catch (error) {
  report = {
    benchmark: BENCHMARK_NAME,
    ok: false,
    skipped: false,
    failure: error instanceof BenchError ? error.code : 'unexpected-benchmark-failure'
  };
}

console.log(JSON.stringify(report));
if (!report.ok && !report.skipped) process.exitCode = 1;
