(() => {
  'use strict';

  const CONFIG_KEY = 'pong_live_observer_config_v1';
  const HEARTBEAT_MS = 1500;
  const MAX_EVENTS = 60;
  const MAX_STRING = 900;
  const params = new URLSearchParams(location.search);
  const requestedInstance = String(params.get('pongInstance') || '').trim();
  const instanceId = requestedInstance === '2' ? 'pong2' : 'pong1';
  const appName = instanceId === 'pong2' ? 'Pong 2' : 'Pong 1';
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const events = [];
  let lastStateSignature = '';
  let lastSentEventSequence = 0;
  let eventSequence = 0;
  let sending = false;
  let sendTimer = null;

  function decodePairing(raw) {
    try {
      const normalized = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      return JSON.parse(decodeURIComponent(escape(atob(padded))));
    } catch (_) {
      return null;
    }
  }

  function readPairingFromHash() {
    const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    const pairing = decodePairing(hash.get('pongObserve'));
    if (!pairing?.endpoint || !pairing?.token) return null;
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({
        endpoint: String(pairing.endpoint),
        token: String(pairing.token)
      }));
      hash.delete('pongObserve');
      history.replaceState(null, '', `${location.pathname}${location.search}${hash.toString() ? `#${hash}` : ''}`);
    } catch (_) {}
    return pairing;
  }

  function loadConfig() {
    const paired = readPairingFromHash();
    if (paired) return paired;
    try {
      const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      if (stored?.endpoint && stored?.token) return stored;
    } catch (_) {}
    return null;
  }

  const config = loadConfig();
  document.documentElement.dataset.pongInstance = instanceId;
  document.title = appName;

  function bounded(value, maximum = MAX_STRING) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum);
  }

  function safeUrl(raw) {
    const input = String(raw || '').trim();
    if (!input) return '';
    try {
      const url = new URL(input, location.href);
      url.username = '';
      url.password = '';
      url.hash = '';
      const retained = new URLSearchParams();
      for (const [key, value] of url.searchParams) {
        if (/^(page|q|sort|service|profile|id)$/i.test(key)) retained.set(key, bounded(value, 120));
      }
      url.search = retained.toString();
      return bounded(url.toString(), 1200);
    } catch (_) {
      return bounded(input.replace(/[?#].*$/, ''), 1200);
    }
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function activeWrapper() {
    return document.querySelector('.video-wrapper.deck-active, .video-wrapper.most-visible, .video-wrapper[data-playable="true"]');
  }

  function currentGlobalIndex(wrapper) {
    const localIndex = number(wrapper?.dataset?.index, -1);
    if (typeof getVideoGlobalIndexForLocalIndex === 'function' && localIndex >= 0) {
      return number(getVideoGlobalIndexForLocalIndex(localIndex), -1);
    }
    return number(globalThis.currentLoadedRangeStart, 0) + localIndex;
  }

  function bufferedRanges(video) {
    const ranges = [];
    try {
      for (let index = 0; index < Math.min(4, video.buffered.length); index++) {
        ranges.push([number(video.buffered.start(index)), number(video.buffered.end(index))]);
      }
    } catch (_) {}
    return ranges;
  }

  function bridgeState() {
    try { return globalThis.PongObserverStateBridge?.() || {}; } catch (_) { return {}; }
  }

  function collectPlayback(source) {
    const wrapper = activeWrapper();
    const video = wrapper?.querySelector('video');
    const globalIndex = currentGlobalIndex(wrapper);
    const localIndex = number(wrapper?.dataset?.index, -1);
    const metadata = Array.isArray(source.allVideoMetadata) && globalIndex >= 0
      ? source.allVideoMetadata[globalIndex] || {}
      : Array.isArray(source.videoMetadata) && localIndex >= 0
        ? source.videoMetadata[localIndex] || {}
        : {};
    const error = video?.error;
    return {
      globalIndex,
      localIndex,
      artist: bounded(
        metadata.artistDisplayName || metadata.artistName || metadata.simpCityCreatorName ||
        wrapper?.querySelector('.artist-label')?.dataset?.artistName ||
        wrapper?.querySelector('.artist-label')?.textContent || ''
      ),
      artistKey: bounded(metadata.artistKey || metadata.simpCityCreatorKey || '', 300),
      source: bounded(metadata.source || ''),
      artistUrl: safeUrl(metadata.artistUrl || metadata.postUrl || ''),
      videoUrl: safeUrl(wrapper?.dataset?.originalVideoUrl || metadata.videoUrl || ''),
      paused: video ? video.paused : true,
      muted: video ? video.muted : true,
      ended: video ? video.ended : false,
      seeking: video ? video.seeking : false,
      currentTime: number(video?.currentTime),
      duration: number(video?.duration),
      readyState: number(video?.readyState),
      networkState: number(video?.networkState),
      buffered: video ? bufferedRanges(video) : [],
      error: error ? { code: number(error.code), message: bounded(error.message) } : null,
      retryCount: number(wrapper?.dataset?.autoRetryCount),
      retryState: bounded(wrapper?.dataset?.autoRetryState || ''),
      unplayable: wrapper?.dataset?.unplayable === 'true',
      networkSuspended: wrapper?.dataset?.networkSuspended === 'true',
      viewed: wrapper?.dataset?.viewed === 'true'
    };
  }

  function collectWorkflow(source) {
    const state = source.random40State || {};
    const recall = source.activeSimpCityRecallContext || {};
    const progress = document.getElementById('random40-progress');
    const loading = document.querySelector('#video-container > .loading-message');
    return {
      mode: bounded(state.mode || (recall.recallChannel ? `recall${recall.recallChannel}` : source.loadedSavedMode || 'idle')),
      playbackProfile: bounded(state.playbackProfile || ''),
      running: Boolean((source.random40State && !state.done && !state.stop) || recall.recallChannel),
      stopped: state.stop === true,
      done: state.done === true,
      accepted: number(state.accepted),
      videos: number(state.videos),
      pages: number(state.pages),
      apiCalls: number(state.api),
      stageTimings: state.stageTimings && typeof state.stageTimings === 'object' ? state.stageTimings : {},
      recallChannel: number(recall.recallChannel),
      recallTargets: Array.isArray(recall.targets) ? recall.targets.slice(0, 3).map(safeUrl) : [],
      progressTitle: bounded(progress?.querySelector('#random40-title')?.textContent || ''),
      progressDetail: bounded(progress?.querySelector('#random40-detail')?.textContent || ''),
      loadingMessage: bounded(loading?.textContent || '')
    };
  }

  function collectQueues(source) {
    return {
      artists: Array.isArray(source.pasteEvents) ? source.pasteEvents.length : 0,
      videos: Array.isArray(source.allVideoUrls) ? source.allVideoUrls.length : 0,
      visibleVideos: Array.isArray(source.videoUrls) ? source.videoUrls.length : 0,
      currentArtistIndex: number(source.currentPasteIndex, -1),
      currentVideoIndex: number(source.currentVideoIndex, -1),
      loadedStart: number(source.currentLoadedRangeStart),
      loadedEnd: number(source.currentLoadedRangeEnd),
      pendingPastes: Array.isArray(source.pendingPastes) ? source.pendingPastes.length : 0,
      postFetchQueued: Array.isArray(source.random40PostFetchQueue) ? source.random40PostFetchQueue.length : 0,
      postFetchActive: number(source.random40PostFetchActive),
      sourceFetchQueued: Array.isArray(source.random40SourceFetchQueue) ? source.random40SourceFetchQueue.length : 0,
      sourceFetchActive: number(source.random40SourceFetchActive),
      preloadActive: number(source.random40PreloadActive)
    };
  }

  function collectUi() {
    const controls = document.querySelector('.controls-overlay');
    const server = document.getElementById('pong-server-toggle');
    return {
      visible: document.visibilityState,
      focused: document.hasFocus(),
      standalone: matchMedia('(display-mode: standalone)').matches,
      controlsVisible: controls ? getComputedStyle(controls).display !== 'none' && !controls.classList.contains('hidden') : false,
      serverState: bounded(server?.dataset?.state || ''),
      serverText: bounded(server?.textContent || ''),
      counter: bounded(document.getElementById('video-counter')?.textContent || ''),
      paperclip: bounded(document.getElementById('paste-nav-button')?.dataset?.count || ''),
      version: bounded(document.querySelector('.version-number')?.textContent || '')
    };
  }

  function recordEvent(type, detail = {}) {
    const event = {
      sequence: ++eventSequence,
      at: new Date().toISOString(),
      type: bounded(type, 80),
      detail
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    scheduleSend(30);
  }

  function stateSignature(state) {
    return JSON.stringify([
      state.playback.artist,
      state.playback.videoUrl,
      state.playback.paused,
      state.playback.readyState,
      state.playback.networkState,
      state.playback.error?.code || 0,
      state.workflow.mode,
      state.workflow.running,
      state.workflow.progressDetail,
      state.queues.artists,
      state.queues.videos,
      state.ui.serverState
    ]);
  }

  function collectState() {
    const source = bridgeState();
    return {
      instanceId,
      appName,
      sessionId,
      sentAt: new Date().toISOString(),
      page: { url: safeUrl(location.href), online: navigator.onLine },
      ui: collectUi(),
      playback: collectPlayback(source),
      workflow: collectWorkflow(source),
      queues: collectQueues(source)
    };
  }

  async function sendNow() {
    if (!config?.endpoint || !config?.token || sending) return;
    sending = true;
    try {
      const state = collectState();
      const signature = stateSignature(state);
      const freshEvents = events.filter(event => event.sequence > lastSentEventSequence);
      const response = await fetch(String(config.endpoint), {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.token}`
        },
        body: JSON.stringify({ state, events: freshEvents })
      });
      if (!response.ok) throw new Error(`observer HTTP ${response.status}`);
      lastStateSignature = signature;
      if (freshEvents.length) lastSentEventSequence = freshEvents[freshEvents.length - 1].sequence;
      document.documentElement.dataset.pongObserver = 'connected';
    } catch (error) {
      document.documentElement.dataset.pongObserver = 'disconnected';
      document.documentElement.dataset.pongObserverError = bounded(error?.message || error, 180);
    } finally {
      sending = false;
    }
  }

  function scheduleSend(delay = HEARTBEAT_MS) {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      sendTimer = null;
      await sendNow();
      scheduleSend(HEARTBEAT_MS);
    }, Math.max(20, number(delay, HEARTBEAT_MS)));
  }

  function installEventCapture() {
    addEventListener('error', event => recordEvent('window-error', {
      message: bounded(event.message),
      source: safeUrl(event.filename),
      line: number(event.lineno),
      column: number(event.colno)
    }));
    addEventListener('unhandledrejection', event => recordEvent('unhandled-rejection', {
      message: bounded(event.reason?.message || event.reason)
    }));
    document.addEventListener('click', event => {
      const control = event.target?.closest?.('button, .control-button, .paste-nav-button, .paste-prev-button, .simpcity-tiktok-button');
      if (!control) return;
      recordEvent('ui-action', {
        id: bounded(control.id || control.className, 180),
        label: bounded(control.getAttribute('aria-label') || control.textContent, 180)
      });
    }, true);
    document.addEventListener('playing', event => {
      const wrapper = event.target?.closest?.('.video-wrapper');
      recordEvent('video-playing', { index: number(wrapper?.dataset?.index, -1) });
    }, true);
    document.addEventListener('waiting', event => {
      const wrapper = event.target?.closest?.('.video-wrapper');
      recordEvent('video-waiting', { index: number(wrapper?.dataset?.index, -1), time: number(event.target?.currentTime) });
    }, true);
    document.addEventListener('error', event => {
      if (event.target?.tagName !== 'VIDEO') return;
      const wrapper = event.target.closest('.video-wrapper');
      recordEvent('video-error', {
        index: number(wrapper?.dataset?.index, -1),
        code: number(event.target.error?.code),
        message: bounded(event.target.error?.message)
      });
    }, true);
    addEventListener('online', () => recordEvent('network-online'));
    addEventListener('offline', () => recordEvent('network-offline'));
    document.addEventListener('visibilitychange', () => recordEvent('visibility', { state: document.visibilityState }));
  }

  globalThis.PongLiveObserver = {
    instanceId,
    appName,
    enabled: Boolean(config?.endpoint && config?.token),
    snapshot: collectState,
    event: recordEvent,
    send: sendNow
  };

  installEventCapture();
  recordEvent('observer-started', { enabled: globalThis.PongLiveObserver.enabled, appName });
  scheduleSend(100);
})();
