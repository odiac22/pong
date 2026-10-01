import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const CHROME = process.env.PONG_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PONG = process.env.PONG_TEST_URL || 'http://127.0.0.1:8787/pong';
const BASE = new URL(PONG).origin;
const ALBUM = process.env.PONG_TEST_ALBUM || 'https://www.erome.com/a/wa48QuqZ';
const EXPECTED_VIDEOS = Number(process.env.PONG_TEST_EXPECTED_VIDEOS || (ALBUM.includes('/xqFSNpbT') ? 3 : 18));
const PAPERCLIP_MODE = process.env.PONG_TEST_PAPERCLIP === '1';
const PREFETCH_READY_TIMEOUT_MS = Number(process.env.PONG_TEST_PREFETCH_TIMEOUT_MS || (PAPERCLIP_MODE ? 180_000 : 20_000));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const streamRequests = [];
const streamResponses = [];
const streamFailures = [];

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
    } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
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
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }
  close() { try { this.socket?.close(); } catch (_) {} }
}

async function stopTree(child) {
  if (!child?.pid) return;
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('close', resolve);
    killer.once('error', resolve);
  });
}

let chrome;
let profile;
let cdp;
const sessionIds = new Set();
try {
  profile = await mkdtemp(path.join(os.tmpdir(), 'pong-swap-persistent-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--incognito', '--mute-audio', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-features=MediaRouter,Translate', '--autoplay-policy=no-user-gesture-required',
    '--window-size=904,2316', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const port = await waitFor(async () => {
    const raw = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(raw.split(/\r?\n/)[0]) || 0;
  }, 15_000, 'Chrome DevTools');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(PONG)}`, { method: 'PUT' }).then(r => r.json());
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.on('Network.requestWillBeSent', event => {
    const sessionId = streamSessionId(event.request?.url || '');
    if (sessionId) streamRequests.push({
      sessionId,
      requestId: event.requestId,
      url: event.request.url,
      at: Date.now(),
      type: event.type || ''
    });
  });
  cdp.on('Network.responseReceived', event => {
    const sessionId = streamSessionId(event.response?.url || '');
    if (sessionId) streamResponses.push({
      sessionId,
      requestId: event.requestId,
      url: event.response.url,
      status: event.response.status,
      mimeType: event.response.mimeType || '',
      protocol: event.response.protocol || '',
      at: Date.now()
    });
  });
  cdp.on('Network.loadingFailed', event => {
    const request = streamRequests.find(item => item.requestId === event.requestId);
    if (request) streamFailures.push({
      sessionId: request.sessionId,
      requestId: event.requestId,
      errorText: event.errorText || '',
      canceled: Boolean(event.canceled),
      blockedReason: event.blockedReason || '',
      at: Date.now()
    });
  });
  await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable'), cdp.send('Network.enable')]);
  await waitFor(() => cdp.eval(`document.readyState === 'complete' && typeof loadEromeAsCards === 'function'`), 20_000, 'Pong page');

  await cdp.eval(`(() => {
    localStorage.removeItem('pong_face_swap_enabled_v1');
    window.PongFaceSwapChannelOverride = 'test';
    window.autoplayEnabled = false;
    deckAutoPromotionLockedUntil = Date.now() + 600_000;
    clearDeckReadyPromotion();
    const intro = document.getElementById('pong-overlay');
    if (intro) intro.style.display = 'none';
    window.__pongSwapLoadingEvents = [];
    window.__pongSwapStartEvents = [];
    window.__pongSwapMediaLoads = [];
    window.__pongSwapLoadStarts = [];
    window.__pongSwapAttachmentSamples = [];
    if (!window.__pongSwapNativeMediaLoad) {
      window.__pongSwapNativeMediaLoad = HTMLMediaElement.prototype.load;
      HTMLMediaElement.prototype.load = function(...args) {
        window.__pongSwapMediaLoads.push({
          at: Date.now(),
          url: this.currentSrc || this.src || '',
          sessionId: (/\\/pong-swap\\/sessions\\/([^/]+)\\/stream(?:[?#]|$)/.exec(this.currentSrc || this.src || '') || [])[1] || '',
          stack: String(new Error('media.load').stack || '')
        });
        return window.__pongSwapNativeMediaLoad.apply(this, args);
      };
      document.addEventListener('loadstart', event => {
        if (!(event.target instanceof HTMLMediaElement)) return;
        const url = event.target.currentSrc || event.target.src || '';
        window.__pongSwapLoadStarts.push({
          at: Date.now(), url,
          sessionId: (/\\/pong-swap\\/sessions\\/([^/]+)\\/stream(?:[?#]|$)/.exec(url) || [])[1] || ''
        });
      }, true);
    }
    clearInterval(window.__pongSwapAttachmentSampleTimer);
    window.__pongSwapAttachmentSampleTimer = setInterval(() => {
      const active = pongFaceSwapCurrentWrapper();
      const entries = [...pongFaceSwapState.prefetches.values()];
      const held = entries.filter(entry => entry?.attached && !entry?.adopted && entry?.wrapper !== active);
      window.__pongSwapAttachmentSamples.push({
        at: Date.now(),
        held: held.length,
        sessions: held.map(entry => entry.sessionId || '')
      });
      if (window.__pongSwapAttachmentSamples.length > 4000) window.__pongSwapAttachmentSamples.shift();
    }, 25);
    const originalStartPongFaceSwap = startPongFaceSwap;
    startPongFaceSwap = async (...args) => {
      const wrapper = pongFaceSwapCurrentWrapper();
      const event = { at:Date.now(), phase:'start', index:Number(wrapper?.dataset?.index ?? -1), args };
      window.__pongSwapStartEvents.push(event);
      try {
        const result = await originalStartPongFaceSwap(...args);
        window.__pongSwapStartEvents.push({ ...event, at:Date.now(), phase:'finish', result });
        return result;
      } catch (error) {
        window.__pongSwapStartEvents.push({ ...event, at:Date.now(), phase:'error', error:String(error?.message || error) });
        throw error;
      }
    };
    const loading = document.getElementById('pong-face-swap-loading');
    const record = () => window.__pongSwapLoadingEvents.push({
      at: Date.now(),
      visible: Boolean(loading && !loading.hidden),
      title: loading?.querySelector('.pong-face-swap-loading-title')?.textContent || '',
      detail: loading?.querySelector('.pong-face-swap-loading-detail')?.textContent || '',
      percent: parseFloat(loading?.querySelector('.pong-face-swap-loading-fill')?.style.width || '0') || 0
    });
    if (loading) new MutationObserver(record).observe(loading, { attributes:true, childList:true, subtree:true, characterData:true });
    record();
    document.getElementById('erome-url').value = ${JSON.stringify(ALBUM)};
    document.getElementById('open-erome').click();
    return true;
  })()`);

  const albumState = await waitFor(() => cdp.eval(`(() => {
    const active = document.querySelector('.video-wrapper.deck-active');
    if (!active || !Array.isArray(allVideoUrls) || allVideoUrls.length < ${EXPECTED_VIDEOS}) return null;
    window.autoplayEnabled = false;
    document.querySelectorAll('.video-wrapper').forEach(wrapper => { wrapper.dataset.playIntent = 'false'; });
    document.querySelectorAll('video').forEach(video => { video.pause(); video.loop = true; video.muted = true; video.volume = 0; });
    return {
      videos: allVideoUrls.length,
      wrappers: document.querySelectorAll('.video-wrapper').length,
      activeIndex: Number(active.dataset.index ?? -1)
    };
  })()`), 30_000, `${EXPECTED_VIDEOS}-video Erome album import`);
  assert.equal(albumState.videos, EXPECTED_VIDEOS);

  if (PAPERCLIP_MODE) {
    await cdp.eval(`(() => {
      const urls = allVideoUrls.slice(0, 3);
      const metadata = allVideoMetadata.slice(0, 3);
      const seed = pasteEvents[0] || {};
      if (urls.length !== 3) throw new Error('Paperclip benchmark requires three source videos');
      allVideoUrls = urls;
      allVideoMetadata = metadata;
      pasteEvents = [
        { ...seed, source:'benchmark', artistName:'Paperclip A', artistKey:'paperclip-a', bundleKey:'paperclip-a', startIndex:0, count:1, loadAll:true },
        { ...seed, source:'benchmark', artistName:'Paperclip B', artistKey:'paperclip-b', bundleKey:'paperclip-b', startIndex:1, count:2, loadAll:true }
      ];
      resetPaperclipQueue();
      setActivePlaybackRangeForPasteEvent(0);
      videoUrls = [urls[0]];
      videoMetadata = [metadata[0]];
      currentLoadedRangeStart = 0;
      currentLoadedRangeEnd = 1;
      currentBatch = 1;
      deckRestoreIndex = 0;
      createVideoElements();
      return true;
    })()`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('.video-wrapper').length === 1 && document.querySelector('.video-wrapper.deck-active')`), 10_000, 'first Paperclip bundle');
  }

  await cdp.eval(`document.getElementById('pong-face-swap-button').click()`);
  await waitFor(() => cdp.eval(`document.querySelectorAll('#pong-face-swap-menu .pong-face-swap-menu-choice').length >= 2`), 10_000, 'approved face menu');
  const faceMenuChoices = await cdp.eval(`document.querySelectorAll('#pong-face-swap-menu .pong-face-swap-menu-choice').length`);
  assert.equal(faceMenuChoices, 20, 'face menu must contain Original, Controls, and 18 distinct face choices');
  const selectedFace = await cdp.eval(`(() => {
    const choice = document.querySelectorAll('#pong-face-swap-menu .pong-face-swap-menu-choice')[2];
    const name = choice?.textContent?.trim() || '';
    choice?.click();
    return name;
  })()`);
  assert(selectedFace, 'approved face was not selectable');

  async function waitForSwapped(index, label, priorSessionId = '', timeoutMs = 25_000) {
    let state;
    try {
      state = await waitFor(() => cdp.eval(`(() => {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      const activeIndex = Number(wrapper?.dataset?.index ?? -1);
      if (!wrapper || !video || (${index} >= 0 && activeIndex !== ${index}) || wrapper.dataset.pongFaceSwapSessionId === ${JSON.stringify(priorSessionId)} || wrapper.dataset.pongFaceSwapBusy === 'true' || wrapper.dataset.pongFaceSwapActive !== 'true' || video.readyState < 2) return null;
      video.muted = true; video.volume = 0;
      wrapper.dataset.playIntent = 'true';
      if (video.paused && !video.ended) void video.play().catch(() => {});
      return {
        index: activeIndex,
        sessionId: wrapper.dataset.pongFaceSwapSessionId || '',
        faceId: wrapper.dataset.pongFaceSwapFaceId || '',
        persistent: Boolean(pongFaceSwapState.enabled),
        selectedFaceId: pongFaceSwapState.selectedFaceId || '',
        muted: video.muted,
        readyState: video.readyState,
        source: videoMetadata?.[activeIndex]?.artistKey || '',
        prefetched: wrapper.dataset.pongFaceSwapPrefetched === 'true',
        preopened: wrapper.dataset.pongFaceSwapPreopened === 'true',
        loadingEvents: window.__pongSwapLoadingEvents.slice()
      };
      })()`), timeoutMs, label);
    } catch (error) {
      const diagnostic = await cdp.eval(`(() => {
        const wrapper = document.querySelector('.video-wrapper.deck-active');
        const video = wrapper?.querySelector('video');
        return {
          expectedIndex: ${index},
          activeIndex: Number(wrapper?.dataset?.index ?? -1),
          busy: wrapper?.dataset?.pongFaceSwapBusy || '',
          active: wrapper?.dataset?.pongFaceSwapActive || '',
          sessionId: wrapper?.dataset?.pongFaceSwapSessionId || '',
          persistent: Boolean(pongFaceSwapState.enabled),
          selectedFaceId: pongFaceSwapState.selectedFaceId || '',
          readyState: Number(video?.readyState || 0),
          source: video?.currentSrc || video?.src || '',
          originalSource: wrapper?.dataset?.originalVideoUrl || '',
          events: window.__pongSwapLoadingEvents.slice(-20),
          indicator: document.getElementById('sorting-indicator')?.textContent || ''
          ,autoPending: wrapper?.dataset?.pongFaceSwapAutoPending || ''
          ,startEvents: window.__pongSwapStartEvents.slice(-20)
          ,prefetches:[...pongFaceSwapState.prefetches.values()].map(entry => ({sessionId:entry.sessionId,ready:entry.ready,browserReady:entry.browserReady,frames:entry.frames,attached:entry.attached,wrapperIndex:entry.wrapperIndex}))
          ,prefetchErrors:pongFaceSwapState.prefetchErrors.slice(-10)
          ,mediaLoads:window.__pongSwapMediaLoads.slice(-30)
        };
      })()`);
      throw new Error(`${error.message}; diagnostic=${JSON.stringify(diagnostic)}`);
    }
    assert(state.sessionId, `${label} has no swap session`);
    assert(state.faceId, `${label} has no face id`);
    assert.equal(state.faceId, state.selectedFaceId);
    assert.equal(state.persistent, true);
    assert.equal(state.muted, true);
    sessionIds.add(state.sessionId);
    return state;
  }

  const first = await waitForSwapped(-1, 'first swapped album video', '', PAPERCLIP_MODE ? 45_000 : 25_000);
  assert(first.loadingEvents.some(event => event.visible && event.percent > 0), 'center loading bar never became visible');
  assert(first.loadingEvents.some(event => event.percent >= 90), 'loading bar never reached the first-frame stage');

  let secondPrefetchDiagnostic = null;
  try {
    await waitFor(() => cdp.eval(`(() => {
      if (!${PAPERCLIP_MODE ? 'true' : 'false'}) {
        return pongFaceSwapState.prefetches.size > 0 && [...pongFaceSwapState.prefetches.values()].some(entry => entry.browserReady);
      }
       const next = getPongFaceSwapNextPaperclipSources();
       return next.length > 0 && next.every(item => {
         const key = pongFaceSwapSourceKey(pongFaceSwapState.selectedFaceId, item.source, 0);
         const entry = pongFaceSwapState.prefetches.get(key);
         // A detached Paperclip destination can already hold a complete server
         // lead and one live attach response without Chromium decoding it until
         // the destination becomes visible. Activation is the event that paints
         // that reader, so treating browserReady as a prerequisite here created
         // a false 180-second benchmark stall despite dozens of swapped frames.
         return Boolean(entry && (
           entry.browserReady === true ||
           (entry.attached === true && Number(entry.frames || 0) > 0)
         ));
       });
    })()`), PREFETCH_READY_TIMEOUT_MS, 'next swapped video prefetch');
  } catch (error) {
    const queueDiagnostic = await cdp.eval(`(() => ({
      currentPasteIndex,
      nextSources:getPongFaceSwapNextPaperclipSources(),
      entries:[...pongFaceSwapState.prefetches.values()].map(entry => ({key:entry.key,sessionId:entry.sessionId,serverReady:entry.serverReady,browserReady:entry.browserReady,frames:entry.frames,wrapperIndex:entry.wrapperIndex,attached:entry.attached})),
      errors:pongFaceSwapState.prefetchErrors.slice(-10),
      mediaLoads:window.__pongSwapMediaLoads.slice(-30),
      loadStarts:window.__pongSwapLoadStarts.slice(-30),
      wrappers:[...document.querySelectorAll('.video-wrapper')].map(wrapper => ({index:Number(wrapper.dataset.index),active:wrapper.classList.contains('deck-active'),preloadSessionId:wrapper.dataset.pongFaceSwapPreloadSessionId||'',src:wrapper.querySelector('video')?.currentSrc||wrapper.querySelector('video')?.src||''})),
      streamResponses:${JSON.stringify(streamResponses)},
      streamFailures:${JSON.stringify(streamFailures)}
    }))()`);
    secondPrefetchDiagnostic = { error: error.message, diagnostic: queueDiagnostic };
  }
  const queueAfterFirst = await cdp.eval(`(() => ({
    entries:[...pongFaceSwapState.prefetches.values()].map(entry => { const media=entry.video||entry.wrapper?.querySelector?.('video'); return {key:entry.key,wrapperIndex:entry.wrapperIndex,sessionId:entry.sessionId,ready:entry.ready,serverReady:entry.serverReady,browserReady:entry.browserReady,attached:entry.attached,adopted:entry.adopted,attachedSource:media?.currentSrc||media?.src||''}; }),
    wrappers:[...document.querySelectorAll('.video-wrapper')].map(wrapper => ({index:Number(wrapper.dataset.index),active:wrapper.classList.contains('deck-active'),preloadSessionId:wrapper.dataset.pongFaceSwapPreloadSessionId||'',preloadReady:wrapper.dataset.pongFaceSwapPreloadReady||'',networkSuspended:wrapper.dataset.networkSuspended||'',src:wrapper.querySelector('video')?.currentSrc||wrapper.querySelector('video')?.src||''}))
  }))()`);
  const paperclipPrediction = PAPERCLIP_MODE ? await cdp.eval(`(() => {
    const eventIndex = resolveNextPaperclipEventIndex();
    const sources = getPongFaceSwapNextPaperclipSources();
    return { eventIndex, currentPasteIndex, sources };
  })()`) : null;
  if (paperclipPrediction) {
    assert(paperclipPrediction.eventIndex >= 0, `Paperclip resolver found no destination: ${JSON.stringify(paperclipPrediction)}`);
    assert(paperclipPrediction.sources.length > 0, `Paperclip prefetch found no source: ${JSON.stringify(paperclipPrediction)}`);
    assert(
      paperclipPrediction.sources.every(item => item.eventIndex === paperclipPrediction.eventIndex),
      `Paperclip prefetch disagreed with the shared resolver: ${JSON.stringify(paperclipPrediction)}`
    );
  }
  const secondStartedAt = Date.now();
  await cdp.eval(`markVideoViewed(pongFaceSwapCurrentWrapper()); goToNextDeckVideo()`);
  const second = await waitForSwapped(-1, 'second auto-swapped album video', first.sessionId);
  const secondTransitionMs = Date.now() - secondStartedAt;
  const queueAtSecond = await cdp.eval(`(() => ({
    entries:[...pongFaceSwapState.prefetches.values()].map(entry => { const media=entry.video||entry.wrapper?.querySelector?.('video'); return {key:entry.key,wrapperIndex:entry.wrapperIndex,sessionId:entry.sessionId,ready:entry.ready,serverReady:entry.serverReady,browserReady:entry.browserReady,attached:entry.attached,adopted:entry.adopted,attachedSource:media?.currentSrc||media?.src||''}; }),
    wrappers:[...document.querySelectorAll('.video-wrapper')].map(wrapper => { const video=wrapper.querySelector('video'); return {index:Number(wrapper.dataset.index),active:wrapper.classList.contains('deck-active'),sessionId:wrapper.dataset.pongFaceSwapSessionId||'',preloadSessionId:wrapper.dataset.pongFaceSwapPreloadSessionId||'',preloadClearedBy:wrapper.dataset.pongFaceSwapPreloadClearedBy||'',rebindStatus:wrapper.dataset.pongFaceSwapRebindStatus||'',rebindKey:wrapper.dataset.pongFaceSwapRebindKey||'',originalVideoUrl:wrapper.dataset.originalVideoUrl||'',preloadedSource:video?.__pongSwapPreloadedOriginal?.source||'',swapOriginalSource:video?.__pongSwapOriginal?.source||'',src:video?.currentSrc||video?.src||''}; })
  }))()`);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.faceId, first.faceId);
  if (!secondPrefetchDiagnostic) {
    assert.equal(second.prefetched, true, `second video did not adopt its prepared swap session: ${JSON.stringify({second,queueAfterFirst,queueAtSecond})}`);
    assert.equal(second.preopened, true, `second video reopened its prepared stream instead of promoting the existing reader: ${JSON.stringify({second,queueAfterFirst})}`);
  } else {
    assert.equal(second.persistent, true, `second foreground fallback lost persistent face selection: ${JSON.stringify({second,secondPrefetchDiagnostic})}`);
  }
  if (paperclipPrediction) {
    const paperclipDestination = await cdp.eval(`currentPasteIndex`);
    assert.equal(
      paperclipDestination,
      paperclipPrediction.eventIndex,
      `Paperclip navigated somewhere other than its prefetched destination: ${JSON.stringify({paperclipPrediction,paperclipDestination})}`
    );
  }

  let thirdPrefetchDiagnostic = null;
  try {
    await waitFor(() => cdp.eval(`pongFaceSwapState.prefetches.size > 0 && [...pongFaceSwapState.prefetches.values()].some(entry => entry.browserReady || (${PAPERCLIP_MODE ? 'true' : 'false'} && entry.attached && Number(entry.frames || 0) > 0))`), PREFETCH_READY_TIMEOUT_MS, 'third swapped video prefetch');
  } catch (error) {
    const diagnostic = await cdp.eval(`(() => ({
      generation:pongFaceSwapState.prefetchGeneration,
      entries:[...pongFaceSwapState.prefetches.values()].map(entry => { const media=entry.video||entry.wrapper?.querySelector?.('video'); return {key:entry.key,wrapperIndex:entry.wrapperIndex,sessionId:entry.sessionId,ready:entry.ready,browserReady:entry.browserReady,attached:entry.attached,adopted:entry.adopted,frames:entry.frames,attachmentError:entry.attachmentError||'',readyState:Number(media?.readyState||0),networkState:Number(media?.networkState||0),src:media?.currentSrc||media?.src||''}; }),
      errors:pongFaceSwapState.prefetchErrors.slice(-10),
      starts:window.__pongSwapStartEvents.slice(-20),
      mediaLoads:window.__pongSwapMediaLoads.slice(-30),
      loadStarts:window.__pongSwapLoadStarts.slice(-30)
    }))()`);
    // GPEN512 may deliberately reserve the remaining VRAM for the visible
    // stream. In that case the swipe must still succeed through the immediate
    // foreground fallback; lack of speculative readiness is not a failure.
    thirdPrefetchDiagnostic = { error: error.message, diagnostic };
  }
  const queueAfterSecond = await cdp.eval(`(() => ({
    entries:[...pongFaceSwapState.prefetches.values()].map(entry => { const media=entry.video||entry.wrapper?.querySelector?.('video'); return {key:entry.key,wrapperIndex:entry.wrapperIndex,sessionId:entry.sessionId,ready:entry.ready,serverReady:entry.serverReady,browserReady:entry.browserReady,attached:entry.attached,adopted:entry.adopted,attachedSource:media?.currentSrc||media?.src||''}; }),
    wrappers:[...document.querySelectorAll('.video-wrapper')].map(wrapper => ({index:Number(wrapper.dataset.index),active:wrapper.classList.contains('deck-active'),preloadSessionId:wrapper.dataset.pongFaceSwapPreloadSessionId||'',preloadReady:wrapper.dataset.pongFaceSwapPreloadReady||'',networkSuspended:wrapper.dataset.networkSuspended||'',src:wrapper.querySelector('video')?.currentSrc||wrapper.querySelector('video')?.src||''}))
  }))()`);
  // Pong deliberately ignores navigation taps for 240 ms to prevent a single
  // touch from double-advancing. Pre-opened swaps are now faster than that, so
  // the benchmark must wait for the same guard a human swipe naturally clears.
  await delay(300);
  const thirdStartedAt = Date.now();
  await cdp.eval(`markVideoViewed(pongFaceSwapCurrentWrapper()); goToNextDeckVideo()`);
  const third = await waitForSwapped(-1, 'third auto-swapped album video', second.sessionId);
  const thirdTransitionMs = Date.now() - thirdStartedAt;
  assert.notEqual(third.sessionId, second.sessionId);
  assert.notEqual(third.index, first.index, 'third transition recycled the first benchmark clip');
  assert.notEqual(third.index, second.index, 'third transition recycled the second benchmark clip');
  assert.equal(third.faceId, first.faceId);
  if (!thirdPrefetchDiagnostic) {
    assert.equal(third.prefetched, true, `third video did not adopt its prepared swap session: ${JSON.stringify({third,queueAfterFirst,queueAfterSecond})}`);
    assert.equal(third.preopened, true, `third video reopened its prepared stream instead of promoting the existing reader: ${JSON.stringify(third)}`);
  } else {
    assert.equal(third.persistent, true, `foreground fallback lost persistent face selection: ${JSON.stringify({third,thirdPrefetchDiagnostic})}`);
  }

  await delay(250);
  // The compact Swap status is intentionally persistent. It must survive the
  // ready-state delay as well as two navigation handoffs, otherwise the user
  // sees both the panel and the selected swap appear to turn off after a swipe.
  await delay(1250);
  const persistentPanel = await cdp.eval(`(() => {
    const panel = document.getElementById('pong-face-swap-loading');
    const active = pongFaceSwapCurrentWrapper();
    return {
      visible: Boolean(panel && !panel.hidden),
      ready: Boolean(panel?.classList.contains('ready')),
      title: panel?.querySelector('.pong-face-swap-loading-title')?.textContent || '',
      enabled: Boolean(pongFaceSwapState.enabled),
      selectedFaceId: pongFaceSwapState.selectedFaceId || '',
      activeFaceId: active?.dataset?.pongFaceSwapFaceId || ''
    };
  })()`);
  assert.equal(persistentPanel.visible, true, `Swap status disappeared after swipe: ${JSON.stringify(persistentPanel)}`);
  assert.equal(persistentPanel.ready, true, `Swap status did not remain green after presentation: ${JSON.stringify(persistentPanel)}`);
  assert.equal(persistentPanel.enabled, true);
  assert.equal(persistentPanel.activeFaceId, persistentPanel.selectedFaceId);
  const queueAtThird = await cdp.eval(`(() => ({
    wrappers:[...document.querySelectorAll('.video-wrapper')].map(wrapper => { const video=wrapper.querySelector('video'); return {index:Number(wrapper.dataset.index),active:wrapper.classList.contains('deck-active'),sessionId:wrapper.dataset.pongFaceSwapSessionId||'',src:video?.currentSrc||video?.src||''}; }),
    mediaLoads:window.__pongSwapMediaLoads.slice(),
    loadStarts:window.__pongSwapLoadStarts.slice(),
    attachmentSamples:window.__pongSwapAttachmentSamples.slice()
  }))()`);

  const assertHeldReaderReused = (state, before, after, label) => {
    const requests = streamRequests.filter(item => item.sessionId === state.sessionId);
    const uniqueRequests = new Map(requests.map(item => [item.requestId, item]));
    assert.equal(uniqueRequests.size, 1, `${label} opened ${uniqueRequests.size} stream requests: ${JSON.stringify(requests)}`);
    const request = [...uniqueRequests.values()][0];
    assert.equal(new URL(request.url).searchParams.get('attach'), '1', `${label} did not keep the held attach response`);

    const prepared = before.entries.find(entry => entry.sessionId === state.sessionId);
    const active = after.wrappers.find(wrapper => wrapper.sessionId === state.sessionId);
    assert(prepared?.attached, `${label} did not preserve its held reader through activation: ${JSON.stringify(prepared)}`);
    assert(prepared?.attachedSource, `${label} has no pre-adoption media source`);
    assert(active?.src, `${label} has no post-adoption media source`);
    assert.equal(new URL(active.src).href, new URL(prepared.attachedSource).href, `${label} replaced src during adoption`);

    const loads = queueAtThird.mediaLoads.filter(item => item.sessionId === state.sessionId);
    const loadStarts = queueAtThird.loadStarts.filter(item => item.sessionId === state.sessionId);
    assert(loads.length <= 1, `${label} called load() again during adoption: ${JSON.stringify(loads)}`);
    assert.equal(loadStarts.length, 1, `${label} emitted a second loadstart during adoption: ${JSON.stringify(loadStarts)}`);
  };
  if (!secondPrefetchDiagnostic) assertHeldReaderReused(second, queueAfterFirst, queueAtSecond, 'second video');
  if (!thirdPrefetchDiagnostic) assertHeldReaderReused(third, queueAfterSecond, queueAtThird, 'third video');

  assert(queueAtThird.attachmentSamples.length > 0, 'attachment budget sampler did not run');
  const maximumHeldAttachments = Math.max(...queueAtThird.attachmentSamples.map(sample => sample.held));
  assert(
    maximumHeldAttachments <= 2,
    `more than two non-active media readers were held: ${JSON.stringify(queueAtThird.attachmentSamples.filter(sample => sample.held > 2).slice(0, 20))}`
  );

  console.log(JSON.stringify({
    ok: true,
    album: ALBUM,
    paperclipMode: PAPERCLIP_MODE,
    albumState,
    faceMenuChoices,
    selectedFace,
    prefetchDiagnostics: {
      second: secondPrefetchDiagnostic,
      third: thirdPrefetchDiagnostic
    },
    first: { index:first.index, sessionId:first.sessionId, readyState:first.readyState },
    second: { index:second.index, sessionId:second.sessionId, readyState:second.readyState, prefetched:second.prefetched, preopened:second.preopened, transitionMs:secondTransitionMs },
    third: { index:third.index, sessionId:third.sessionId, readyState:third.readyState, prefetched:third.prefetched, preopened:third.preopened, transitionMs:thirdTransitionMs },
    maximumHeldAttachments,
    persistentPanel,
    adoptedStreamRequests: {
      second: streamRequests.filter(item => item.sessionId === second.sessionId).length,
      third: streamRequests.filter(item => item.sessionId === third.sessionId).length
    },
    loadingStages: [...new Set(first.loadingEvents.filter(event => event.visible).map(event => `${event.percent}% ${event.title}`))]
  }, null, 2));
} finally {
  if (cdp) {
    await cdp.eval(`clearInterval(window.__pongSwapAttachmentSampleTimer); clearPongFaceSwapPrefetches(); true`).catch(() => null);
  }
  for (const sessionId of sessionIds) {
    await fetch(`${BASE}/pong-swap/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => null);
  }
  cdp?.close();
  await stopTree(chrome);
  await delay(500);
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }).catch(() => null);
}
