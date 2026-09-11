(() => {
  'use strict';

  const CONFIG_KEY = 'pong_live_observer_config_v1';
  const HEARTBEAT_MS = 1500;
  const MAX_EVENTS = 60;
  const MAX_STRING = 900;
  const params = new URLSearchParams(location.search);
  // Sync iframes share storage with the player, but are never player sessions.
  if (window.top !== window || params.get('pongStateBridge') === '1') return;
  const requestedInstance = String(params.get('pongInstance') || '').trim();
  const instanceId = requestedInstance === '2' ? 'pong2' : 'pong1';
  const appName = instanceId === 'pong2' ? 'Pong 2' : 'Pong 1';
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const events = [];
  let nativeClient = null;
  let lastSentEventSequence = 0;
  let eventSequence = 0;
  let sending = false;
  let sendTimer = null;
  let pendingFrame = null;
  let latestFrameMeta = null;

  function decodePairing(raw) {
    try {
      const normalized = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      return JSON.parse(decodeURIComponent(escape(atob(padded))));
    } catch (_) {
      return null;
    }
  }

  function encodePairing(value) {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify({
        endpoint: String(value?.endpoint || ''),
        token: String(value?.token || '')
      }));
      let binary = '';
      bytes.forEach(byte => { binary += String.fromCharCode(byte); });
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (_) {
      return '';
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

  let config = loadConfig();
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
    return document.querySelector('.video-wrapper.deck-active') || document.querySelector('.video-wrapper.most-visible');
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
    const playbackEvent = Array.isArray(source.pasteEvents)
      ? source.pasteEvents.find(event => {
          const start = number(event?.startIndex, -1);
          const count = Math.max(0, number(event?.count));
          return globalIndex >= start && globalIndex < start + count;
        }) || source.pasteEvents[number(source.currentPasteIndex, -1)] || null
      : null;
    const eventStart = number(playbackEvent?.startIndex, -1);
    const eventCount = Math.max(0, number(playbackEvent?.count));
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
      artistVideoCount: eventCount,
      artistVideoPosition: eventStart >= 0 && globalIndex >= eventStart ? globalIndex - eventStart + 1 : 0,
      status: !video ? 'idle' : error ? 'error' : video.ended ? 'ended' : video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing',
      paused: video ? video.paused : null,
      playing: Boolean(video && !video.paused && !video.ended && video.readyState >= 3),
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
    const recallChannel = number(
      recall.recallChannel || source.activeRecallChannel || document.documentElement.dataset.pongRecallChannel
    );
    const progress = document.getElementById('random40-progress');
    const loading = document.querySelector('#video-container > .loading-message');
    return {
      mode: bounded(recallChannel ? `recall${recallChannel}` : state.mode || source.loadedSavedMode || 'idle'),
      playbackProfile: bounded(state.playbackProfile || ''),
      running: Boolean((source.random40State && !state.done && !state.stop) || recallChannel),
      stopped: state.stop === true,
      done: state.done === true,
      accepted: number(state.accepted),
      videos: number(state.videos),
      pages: number(state.pages),
      apiCalls: number(state.api),
      stageTimings: state.stageTimings && typeof state.stageTimings === 'object' ? state.stageTimings : {},
      recallChannel,
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
    const tiktok = document.getElementById('simpcity-tiktok-button');
    const tiktokStyle = tiktok ? getComputedStyle(tiktok) : null;
    const tiktokVisible = Boolean(tiktok && tiktokStyle?.display !== 'none' && tiktokStyle?.visibility !== 'hidden');
    return {
      visible: document.visibilityState,
      focused: document.hasFocus(),
      standalone: matchMedia('(display-mode: standalone)').matches,
      controlsVisible: controls ? getComputedStyle(controls).display !== 'none' && getComputedStyle(controls).opacity !== '0' && !document.body.classList.contains('controls-hidden') && !controls.classList.contains('hidden') : false,
      serverState: bounded(server?.dataset?.state || ''),
      serverText: bounded(server?.textContent || ''),
      counter: bounded(activeWrapper()?.querySelector('.video-counter')?.textContent || document.getElementById('video-counter')?.textContent || ''),
      paperclip: bounded(document.getElementById('paste-nav-button')?.dataset?.count || ''),
      tiktokButton: {
        present: Boolean(tiktok),
        visible: tiktokVisible,
        active: Boolean(tiktok?.classList.contains('active')),
        disabled: Boolean(tiktok?.disabled),
        label: bounded(tiktok?.getAttribute('aria-label') || tiktok?.textContent || '')
      },
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
      state.playback.artistVideoCount,
      state.playback.paused,
      state.playback.readyState,
      state.playback.networkState,
      state.playback.error?.code || 0,
      state.workflow.mode,
      state.workflow.running,
      state.workflow.progressDetail,
      state.queues.artists,
      state.queues.videos,
      state.ui.tiktokButton.visible,
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
      client: nativeClient || { native: false },
      page: { url: safeUrl(location.href), online: navigator.onLine, topFrame: true, bridge: false },
      screenshot: latestFrameMeta,
      ui: collectUi(),
      playback: collectPlayback(source),
      workflow: collectWorkflow(source),
      queues: collectQueues(source)
    };
  }

  async function sendNow() {
    if (!config?.endpoint || !config?.token || sending) return;
    sending = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const state = collectState();
      const freshEvents = events.filter(event => event.sequence > lastSentEventSequence);
      const frame = pendingFrame;
      const response = await fetch(String(config.endpoint), {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.token}`
        },
        body: JSON.stringify({ state, events: freshEvents, frame })
      });
      if (!response.ok) throw new Error(`observer HTTP ${response.status}`);
      if (freshEvents.length) lastSentEventSequence = freshEvents[freshEvents.length - 1].sequence;
      if (pendingFrame === frame) pendingFrame = null;
      document.documentElement.dataset.pongObserver = 'connected';
      delete document.documentElement.dataset.pongObserverError;
    } catch (error) {
      document.documentElement.dataset.pongObserver = 'disconnected';
      document.documentElement.dataset.pongObserverError = bounded(error?.message || error, 180);
    } finally {
      clearTimeout(timeout);
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
    document.addEventListener('visibilitychange', () => {
      recordEvent('visibility', { state: document.visibilityState });
      // Android can suspend WebView timers immediately after it becomes hidden.
      // Start the final snapshot request synchronously instead of waiting for
      // the scheduled heartbeat that may never run in the background.
      void sendNow();
    });
  }

  globalThis.PongLiveObserver = {
    instanceId,
    appName,
    get enabled() { return Boolean(config?.endpoint && config?.token); },
    configure(pairing, client) {
      const next = decodePairing(pairing);
      if (!next?.endpoint || !next?.token || String(client?.instance) !== requestedInstance) return false;
      config = next;
      nativeClient = { native: true, instance: String(client.instance), deviceId: bounded(client.deviceId, 100), version: bounded(client.version, 40) };
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); } catch (_) {}
      recordEvent('native-connected', { version: nativeClient.version });
      void sendNow();
      return true;
    },
    frame(jpegBase64, width, height) {
      const data = String(jpegBase64 || '');
      if (!nativeClient?.native || data.length < 100 || data.length > 190_000 || !/^[A-Za-z0-9+/=]+$/.test(data)) return false;
      latestFrameMeta = { capturedAt: new Date().toISOString(), width: number(width), height: number(height) };
      pendingFrame = { ...latestFrameMeta, jpegBase64: data };
      scheduleSend(25);
      return true;
    },
    snapshot: collectState,
    event: recordEvent,
    send: sendNow,
    decorateUrl(rawUrl) {
      if (!config?.endpoint || !config?.token) return String(rawUrl || '');
      try {
        const target = new URL(String(rawUrl || ''), location.href);
        const hash = new URLSearchParams(String(target.hash || '').replace(/^#/, ''));
        const encoded = encodePairing(config);
        if (encoded) hash.set('pongObserve', encoded);
        target.hash = hash.toString();
        return target.href;
      } catch (_) {
        return String(rawUrl || '');
      }
    }
  };

  installEventCapture();
  recordEvent('observer-started', { enabled: globalThis.PongLiveObserver.enabled, appName });
  scheduleSend(100);
})();
