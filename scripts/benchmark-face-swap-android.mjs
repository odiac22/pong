import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const SWAP_ROOT = path.join(ROOT, 'Pong Swap');
const LOG_ROOT = path.join(SWAP_ROOT, 'logs', 'optimization-20260916');
const API_BASE = process.env.PONG_BENCH_API_BASE || 'http://127.0.0.1:8787';
const PAGE_BASE = process.env.PONG_BENCH_PAGE || 'http://10.0.2.2:8787/pong';
const CDP_PORT = Number(process.env.PONG_BENCH_CDP_PORT || 9225);
const LABEL = process.env.PONG_BENCH_LABEL || 'optimized-android-test1';
const FACE_NAME = process.env.PONG_BENCH_FACE || 'Test 1';
const STRICTNESS = Math.max(0, Math.min(100, Number(process.env.PONG_BENCH_STRICTNESS ?? 0)));
const ALBUMS = [
  {
    id: 'xqFSNpbT', url: 'https://www.erome.com/a/xqFSNpbT', expectedVideos: 3,
    files: ['Guker5iQ_720p.mp4', 'kFAjQTIm_720p.mp4', 'qxTu9JAz_720p.mp4'],
  },
  {
    id: 'wa48QuqZ', url: 'https://www.erome.com/a/wa48QuqZ', expectedVideos: 18,
    files: [
      '5w5ExyNX_720p.mp4', 'p8zdQH8w_720p.mp4', 'R66k0Iie_720p.mp4',
      'QyAE4aWv_720p.mp4', 'z3o6vyFJ_720p.mp4', '4xF1dlUc_720p.mp4',
      'skNNqeux_720p.mp4', 'IkB98SV2_720p.mp4', 'XJ3lsAXt_720p.mp4',
      'l6m1lABc_720p.mp4', 'IW7qjrR2_720p.mp4', 'YZWp1yEE_720p.mp4',
      'HvPyX8Hs_720p.mp4', 'KRDWQ8WO_720p.mp4', 'lMJixmoo_720p.mp4',
      '2szQ6k4J_720p.mp4', 'KSHN0BCm_720p.mp4', 'HFbdM1mj_720p.mp4',
    ],
  },
  {
    id: 'pTrYBqm9', url: 'https://www.erome.com/a/pTrYBqm9', expectedVideos: 2,
    files: ['l97VtByj_720p.mp4', 'jrNsRhqI_720p.mp4'],
  },
];
const EXPECTED_TOTAL = ALBUMS.reduce((sum, album) => sum + album.expectedVideos, 0);
const RUN_VIDEO_LIMIT = Math.max(
  1,
  Math.min(EXPECTED_TOTAL, Number(process.env.PONG_BENCH_VIDEO_LIMIT || EXPECTED_TOTAL)),
);
const LONG_WATCH_ORDINALS = new Set(
  String(process.env.PONG_BENCH_LONG_WATCH_ORDINALS || '0,10,20')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value >= 0 && value < EXPECTED_TOTAL),
);
const SEEK_PLAN = new Map([
  [4, { direction: 'forward', deltaSeconds: 6 }],
  // This one happens after the ten-second watch so the gesture genuinely
  // moves backward instead of seeking to an arbitrary point in a long clip.
  [10, { direction: 'backward', deltaSeconds: -5, afterWatch: true }],
  [19, { direction: 'forward', deltaSeconds: 8 }],
]);
const PAPERCLIP_AFTER = new Set([2, 20]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function stats(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { count: 0, minMs: null, medianMs: null, p90Ms: null, maxMs: null };
  return {
    count: finite.length,
    minMs: Number(Math.min(...finite).toFixed(1)),
    medianMs: Number(percentile(finite, 0.5).toFixed(1)),
    p90Ms: Number(percentile(finite, 0.9).toFixed(1)),
    maxMs: Number(Math.max(...finite).toFixed(1)),
  };
}

async function waitFor(fn, timeoutMs, label, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(label + ' timed out' + (lastError ? ': ' + lastError.message : ''));
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
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP ' + method + ' timed out after 15 seconds'));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, userGesture = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body && (body.detail || body.error)) || ('HTTP ' + response.status));
  return body;
}

async function cleanupTestSessions() {
  const listing = await fetchJson(API_BASE + '/pong-swap/sessions').catch(() => ({ sessions: [] }));
  const sessions = Array.isArray(listing.sessions) ? listing.sessions : [];
  await Promise.allSettled(
    sessions
      .filter(session => session?.channel === 'test')
      .map(session => fetchJson(
        API_BASE + '/pong-swap/sessions/' + encodeURIComponent(session.id),
        { method: 'DELETE' },
      )),
  );
}

function browserSetup() {
  window.PongFaceSwapChannelOverride = 'test';
  window.autoplayEnabled = false;
  // This benchmark is intentionally silent. Override any persisted speaker
  // preference before the first video or swap reader is created so Android
  // never opens the original-audio companion while timing video startup.
  window.pongUserWantsAudio = false;
  try { localStorage.setItem('pong_player_audio_pref_v2', 'muted'); } catch (_) {}
  window.__pongBenchmarkPlayEvents = [];
  window.__pongBenchmarkFetchEvents = [];
  window.__pongBenchmarkDeckEvents = [];
  window.__pongBenchmarkLastTouchStartAt = 0;
  if (!window.__pongBenchmarkTouchClockInstalled) {
    window.__pongBenchmarkTouchClockInstalled = true;
    document.addEventListener('touchstart', () => {
      window.__pongBenchmarkLastTouchStartAt = Date.now();
    }, { capture: true, passive: true });
  }
  if (!window.__pongBenchmarkNativeFetch) {
    window.__pongBenchmarkNativeFetch = window.fetch.bind(window);
    window.fetch = async function(input, init = {}) {
      const url = String(input?.url || input || '');
      const tracked = /\/pong-swap\/sessions\/[^/?]+\/activate(?:\?|$)/.test(url);
      const event = tracked ? {
        kind: 'activate', url, method: String(init?.method || input?.method || 'GET'),
        startedAt: Date.now(), completedAt: 0, status: 0, error: ''
      } : null;
      if (event) window.__pongBenchmarkFetchEvents.push(event);
      try {
        const response = await window.__pongBenchmarkNativeFetch(input, init);
        if (event) {
          event.completedAt = Date.now();
          event.status = Number(response.status || 0);
        }
        return response;
      } catch (error) {
        if (event) {
          event.completedAt = Date.now();
          event.error = String(error?.message || error || '');
        }
        throw error;
      }
    };
  }
  if (typeof stopBrowserWorkloadForRefresh === 'function') stopBrowserWorkloadForRefresh();
  try {
    localStorage.removeItem('pong_face_swap_enabled_v1');
    localStorage.removeItem('pong_face_swap_face_id_v1');
    sessionStorage.removeItem('pong_face_swap_faces_cache_v1');
    sessionStorage.setItem('pong_skip_played_enabled_v1', '0');
  } catch (_) {}
  // A cache-busted navigation can still restore the last deck from Pong's
  // session snapshot.  Clear both the model and rendered deck so an old
  // 23-video import can never satisfy this run's readiness gate.
  document.querySelectorAll('video,audio').forEach(media => {
    try { media.pause(); } catch (_) {}
  });
  if (typeof resetPasteEvents === 'function') resetPasteEvents();
  allVideoUrls = [];
  allVideoMetadata = [];
  videoUrls = [];
  videoMetadata = [];
  pasteEvents = [];
  currentVideoIndex = 0;
  currentPasteIndex = -1;
  activePlaybackRange = null;
  activeEromeScrapeTargets = [];
  activeEromeScrapeProgress = null;
  window.PongEromeResumeState = null;
  pongSkipPlayedEnabled = false;
  if (typeof replacePongVideoContainerHtml === 'function') {
    replacePongVideoContainerHtml('<div class="loading-message">Benchmark deck cleared.</div>');
  }
  if (typeof updatePasteNavigationButton === 'function') updatePasteNavigationButton();
  if (typeof updatePongSkipPlayedButton === 'function') updatePongSkipPlayedButton();
  if (typeof setPongFaceSwapPersistentEnabled === 'function') setPongFaceSwapPersistentEnabled(false);
  if (typeof clearDeckReadyPromotion === 'function') clearDeckReadyPromotion();
  window.deckAutoPromotionLockedUntil = Date.now() + 60 * 60 * 1000;
  const intro = document.getElementById('pong-overlay');
  if (intro) intro.style.display = 'none';
  document.querySelectorAll('video,audio').forEach(media => {
    media.muted = true;
    media.volume = 0;
  });
  if (!window.__pongBenchmarkNativePlay) {
    window.__pongBenchmarkNativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {
      this.muted = true;
      this.volume = 0;
      const wrapper = this.closest?.('.video-wrapper');
      const event = {
        kind: 'requested', at: Date.now(),
        index: typeof getVideoGlobalIndexForLocalIndex === 'function'
          ? getVideoGlobalIndexForLocalIndex(Number(wrapper?.dataset?.index ?? -1))
          : Number(wrapper?.dataset?.index ?? -1),
        sessionId: String(wrapper?.dataset?.pongFaceSwapSessionId || ''),
        source: String(this.currentSrc || this.src || ''), readyState: Number(this.readyState || 0),
        tagName: String(this.tagName || ''),
        className: String(this.className || ''),
        held: this.dataset?.pongFaceSwapHeld === 'true',
        connected: Boolean(this.isConnected),
        stack: String(new Error('play caller').stack || '').split('\n').slice(1, 8).join('\n'),
      };
      window.__pongBenchmarkPlayEvents.push(event);
      const result = window.__pongBenchmarkNativePlay.apply(this, args);
      Promise.resolve(result).then(
        () => window.__pongBenchmarkPlayEvents.push({ ...event, kind: 'resolved', at: Date.now() }),
        error => window.__pongBenchmarkPlayEvents.push({ ...event, kind: 'rejected', at: Date.now(), error: String(error?.message || error || '') }),
      );
      return result;
    };
  }
  if (!window.__pongBenchmarkMuteObserver) {
    window.__pongBenchmarkMuteObserver = new MutationObserver(() => {
      document.querySelectorAll('video,audio').forEach(media => {
        media.muted = true;
        media.volume = 0;
      });
    });
    window.__pongBenchmarkMuteObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.__pongBenchmarkDeckObserver?.disconnect?.();
  let lastDeckSignature = '';
  const captureDeckState = () => {
    const wrapper = document.querySelector('.video-wrapper.deck-active');
    if (!wrapper) return;
    const localIndex = Number(wrapper.dataset.index ?? -1);
    const globalIndex = typeof getVideoGlobalIndexForLocalIndex === 'function'
      ? getVideoGlobalIndexForLocalIndex(localIndex)
      : localIndex;
    const entry = [...pongFaceSwapState.prefetches.values()].find(candidate => candidate?.wrapper === wrapper) || null;
    const signature = [globalIndex, wrapper.dataset.pongFaceSwapPreloadSessionId || '', wrapper.dataset.pongFaceSwapPreloadReady || '', wrapper.dataset.pongFaceSwapActive || '', wrapper.dataset.pongFaceSwapBusy || ''].join('|');
    if (signature === lastDeckSignature) return;
    lastDeckSignature = signature;
    window.__pongBenchmarkDeckEvents.push({
      at: Date.now(), globalIndex,
      sessionId: String(wrapper.dataset.pongFaceSwapSessionId || ''),
      preloadSessionId: String(wrapper.dataset.pongFaceSwapPreloadSessionId || ''),
      preloadReady: wrapper.dataset.pongFaceSwapPreloadReady === 'true',
      active: wrapper.dataset.pongFaceSwapActive === 'true',
      busy: wrapper.dataset.pongFaceSwapBusy === 'true',
      entry: entry ? {
        sessionId: String(entry.sessionId || ''), ready: Boolean(entry.ready),
        browserReady: Boolean(entry.browserReady), attached: Boolean(entry.attached),
        browserReadyAt: Number(entry.browserReadyAt || 0), createdAt: Number(entry.createdAt || 0)
      } : null
    });
  };
  window.__pongBenchmarkDeckObserver = new MutationObserver(captureDeckState);
  window.__pongBenchmarkDeckObserver.observe(document.documentElement, {
    attributes: true, childList: true, subtree: true,
    attributeFilter: ['class', 'data-pong-face-swap-preload-session-id', 'data-pong-face-swap-preload-ready', 'data-pong-face-swap-active', 'data-pong-face-swap-busy']
  });
  window.__pongBenchmarkTransitions = Object.create(null);
  window.__pongBenchmarkArmTransition = function(token, expectedIndex, priorSessionId) {
    const state = {
      token,
      expectedIndex: Number(expectedIndex),
      priorSessionId: String(priorSessionId || ''),
      result: null,
      frameCallbackPending: false,
      qualifiedStreamKey: '',
      qualifiedMediaTime: null,
      interval: null,
      observer: null,
    };
    const cleanup = () => {
      if (state.interval) clearInterval(state.interval);
      state.observer?.disconnect?.();
      ['loadeddata', 'canplay', 'playing', 'timeupdate'].forEach(kind => {
        document.removeEventListener(kind, state.check, true);
      });
    };
    const finish = (callbackNow, wrapper, video) => {
      if (state.result) return true;
      const sessionId = String(wrapper?.dataset?.pongFaceSwapSessionId || '');
      const currentSrc = String(video?.currentSrc || video?.src || '');
      const localIndex = Number(wrapper?.dataset?.index ?? -1);
      const index = typeof getVideoGlobalIndexForLocalIndex === 'function'
        ? getVideoGlobalIndexForLocalIndex(localIndex)
        : localIndex;
      if (
        index !== state.expectedIndex ||
        !sessionId ||
        (state.priorSessionId && sessionId === state.priorSessionId) ||
        wrapper?.dataset?.pongFaceSwapActive !== 'true' ||
        !currentSrc.includes('/pong-swap/sessions/') ||
        Number(video?.readyState || 0) < 2
      ) return false;
      video.muted = true;
      video.volume = 0;
      state.result = {
        frameEpochMs: performance.timeOrigin + Number(callbackNow || performance.now()),
        sessionId,
        globalIndex: index,
        currentSrc,
        currentTime: Number(video.currentTime || 0),
        absoluteTime: typeof pongFaceSwapAbsoluteTime === 'function'
          ? Number(pongFaceSwapAbsoluteTime(wrapper, video) || 0)
          : Number(video.currentTime || 0),
        duration: typeof pongFaceSwapFullDuration === 'function'
          ? Number(pongFaceSwapFullDuration(wrapper, video) || 0)
          : Number(video.duration || 0),
        readyState: Number(video.readyState || 0),
        videoWidth: Number(video.videoWidth || 0),
        videoHeight: Number(video.videoHeight || 0),
        prefetched: wrapper.dataset.pongFaceSwapPrefetched === 'true',
        preopened: wrapper.dataset.pongFaceSwapPreopened === 'true',
      };
      cleanup();
      return true;
    };
    state.check = () => {
      if (state.result) return state.result;
      const wrapper = typeof pongFaceSwapCurrentWrapper === 'function'
        ? pongFaceSwapCurrentWrapper()
        : document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector?.('video');
      if (!wrapper || !video) return null;
      const sessionId = String(wrapper.dataset.pongFaceSwapSessionId || '');
      const currentSrc = String(video.currentSrc || video.src || '');
      const localIndex = Number(wrapper.dataset.index ?? -1);
      const globalIndex = typeof getVideoGlobalIndexForLocalIndex === 'function'
        ? getVideoGlobalIndexForLocalIndex(localIndex)
        : localIndex;
      if (
        globalIndex !== state.expectedIndex ||
        !sessionId ||
        (state.priorSessionId && sessionId === state.priorSessionId) ||
        wrapper.dataset.pongFaceSwapActive !== 'true' ||
        !currentSrc.includes('/pong-swap/sessions/') ||
        Number(video.readyState || 0) < 2
      ) return null;
      // Some Android System WebView builds expose rVFC but never invoke one
      // callback after a Paperclip rebuild. Do not turn that API defect into a
      // false app failure: advancing decoded media time proves that multiple
      // real frames from this exact replacement stream were presented. Keep
      // rVFC as the fastest signal and use >=50 ms of progress as the stricter
      // fallback.
      const qualifiedStreamKey = sessionId + '|' + currentSrc;
      const mediaTime = Number(video.currentTime || 0);
      if (state.qualifiedStreamKey !== qualifiedStreamKey) {
        state.qualifiedStreamKey = qualifiedStreamKey;
        state.qualifiedMediaTime = mediaTime;
        state.frameCallbackPending = false;
      } else if (
        !video.paused &&
        Number.isFinite(mediaTime) &&
        Number.isFinite(state.qualifiedMediaTime) &&
        mediaTime - state.qualifiedMediaTime >= 0.05
      ) {
        finish(performance.now(), wrapper, video);
        return state.result;
      }
      if (typeof video.requestVideoFrameCallback === 'function' && !state.frameCallbackPending) {
        state.frameCallbackPending = true;
        video.requestVideoFrameCallback(now => {
          state.frameCallbackPending = false;
          finish(now, wrapper, video);
        });
      } else if (typeof video.requestVideoFrameCallback !== 'function') {
        finish(performance.now(), wrapper, video);
      }
      return state.result;
    };
    state.interval = setInterval(state.check, 50);
    state.observer = new MutationObserver(state.check);
    state.observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    ['loadeddata', 'canplay', 'playing', 'timeupdate'].forEach(kind => {
      document.addEventListener(kind, state.check, true);
    });
    window.__pongBenchmarkTransitions[token] = state;
    state.check();
    return true;
  };
  window.__pongBenchmarkCheckTransition = function(token) {
    const state = window.__pongBenchmarkTransitions?.[token];
    if (!state) return null;
    state.check();
    return state.result;
  };
  return true;
}

async function pageSnapshot(cdp) {
  return cdp.eval('(() => {' +
    'const wrapper = typeof pongFaceSwapCurrentWrapper === "function" ? pongFaceSwapCurrentWrapper() : document.querySelector(".video-wrapper.deck-active");' +
    'const video = wrapper?.querySelector?.("video");' +
    'if (!wrapper || !video) return null;' +
    'const localIndex=Number(wrapper.dataset.index??-1);' +
    'const globalIndex=typeof getVideoGlobalIndexForLocalIndex==="function"?getVideoGlobalIndexForLocalIndex(localIndex):localIndex;' +
    'document.querySelectorAll("video,audio").forEach(media => { media.muted = true; media.volume = 0; });' +
    'return {' +
      'epochMs: Date.now(),' +
      'sessionId: String(wrapper.dataset.pongFaceSwapSessionId || ""),' +
      'globalIndex,' +
      'sourceUrl: String(video.__pongSwapOriginal?.source || allVideoUrls?.[globalIndex] || ""),' +
      'currentMediaUrl: String(video.currentSrc || video.src || ""),' +
      'currentTime: Number(video.currentTime || 0),' +
      'absoluteTime: typeof pongFaceSwapAbsoluteTime === "function" ? Number(pongFaceSwapAbsoluteTime(wrapper, video) || 0) : Number(video.currentTime || 0),' +
      'duration: typeof pongFaceSwapFullDuration === "function" ? Number(pongFaceSwapFullDuration(wrapper, video) || 0) : Number(video.duration || 0),' +
      'readyState: Number(video.readyState || 0),' +
      'paused: Boolean(video.paused),' +
      'ended: Boolean(video.ended),' +
      'seeking: Boolean(video.seeking),' +
      'playbackRate: Number(video.playbackRate || 0),' +
      'muted: Boolean(video.muted),' +
      'volume: Number(video.volume || 0),' +
      'videoWidth: Number(video.videoWidth || 0),' +
      'videoHeight: Number(video.videoHeight || 0),' +
      'bufferedRanges: (()=>{const ranges=[];try{for(let i=0;i<video.buffered.length;i++){ranges.push({start:Number(video.buffered.start(i)||0),end:Number(video.buffered.end(i)||0)});}}catch(_){}return ranges;})(),' +
      'audioViolations: [...document.querySelectorAll("video,audio")].filter(media => !media.muted || Number(media.volume || 0) > 0).length' +
    '};' +
  '})()');
}

async function ensureActivePlaying(cdp) {
  return cdp.eval('(() => {' +
    'const wrapper = pongFaceSwapCurrentWrapper();' +
    'const video = wrapper?.querySelector?.("video");' +
    'if (!wrapper || !video) throw new Error("active video missing");' +
    'const localIndex=Number(wrapper.dataset.index??-1);' +
    'const globalIndex=typeof getVideoGlobalIndexForLocalIndex==="function"?getVideoGlobalIndexForLocalIndex(localIndex):localIndex;' +
    'video.muted = true; video.defaultMuted = true; video.volume = 0; video.loop = false; wrapper.dataset.playIntent = "true";' +
    'if(video.paused&&typeof playVideoCleanly==="function"){try{void playVideoCleanly(video);}catch(_){}}' +
    'return {index:globalIndex,readyState:Number(video.readyState || 0),paused:Boolean(video.paused)};' +
  '})()');
}

async function captureFrame(cdp, outputRoot, ordinal, albumId, sampleNumber) {
  // A growing fragmented MP4 can briefly fall back to HAVE_METADATA while
  // WebView appends the next fragment. Sampling must wait for the next decoded
  // frame instead of misclassifying that transient state as a broken video;
  // the independent media-advance gate still fails genuine playback stalls.
  const capture = await waitFor(
    () => cdp.eval('(() => {' +
      'const wrapper = pongFaceSwapCurrentWrapper();' +
      'const video = wrapper?.querySelector?.("video");' +
      'if (!wrapper || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;' +
      'const localIndex=Number(wrapper.dataset.index??-1);' +
      'const globalIndex=typeof getVideoGlobalIndexForLocalIndex==="function"?getVideoGlobalIndexForLocalIndex(localIndex):localIndex;' +
      'if(globalIndex!==' + Number(ordinal) + ')return null;' +
      'const width = Math.min(540, Number(video.videoWidth));' +
      'const height = Math.max(1, Math.round(width * Number(video.videoHeight) / Number(video.videoWidth)));' +
      'const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;' +
      'const context = canvas.getContext("2d", { alpha:false }); context.drawImage(video, 0, 0, width, height);' +
      'return {' +
        'dataUrl:canvas.toDataURL("image/jpeg",0.92),' +
        'width,height,videoWidth:Number(video.videoWidth),videoHeight:Number(video.videoHeight),' +
        'currentTime:Number(video.currentTime || 0),' +
        'absoluteTime:Number(pongFaceSwapAbsoluteTime(wrapper,video) || 0),' +
        'duration:Number(pongFaceSwapFullDuration(wrapper,video) || 0),' +
        'sourceUrl:String(video.__pongSwapOriginal?.source || allVideoUrls?.[globalIndex] || ""),' +
        'sessionId:String(wrapper.dataset.pongFaceSwapSessionId || ""),' +
        'globalIndex' +
      '};' +
    '})()'),
    5_000,
    'decoded Android capture frame at ordinal ' + ordinal,
    50,
  );
  const fileName = String(ordinal).padStart(2, '0') + '-' + albumId + '-' + sampleNumber + '.jpg';
  const filePath = path.join(outputRoot, 'captures', fileName);
  await writeFile(filePath, Buffer.from(capture.dataUrl.split(',')[1], 'base64'));
  delete capture.dataUrl;
  return { ordinal, albumId, sampleNumber, ...capture, file: filePath };
}

async function watchVideo(cdp, seconds, capturePlan, outputRoot, ordinal, albumId) {
  await ensureActivePlaying(cdp);
  const before = await pageSnapshot(cdp);
  if (!before) throw new Error('active video disappeared before watch ' + ordinal);
  const startedAt = Date.now();
  const samples = [];
  const captures = [];
  const pendingCaptures = capturePlan.slice();
  while (Date.now() - startedAt < seconds * 1000) {
    await delay(250);
    const sample = await pageSnapshot(cdp);
    if (!sample) throw new Error('active video disappeared during watch ' + ordinal);
    sample.elapsedMs = Date.now() - startedAt;
    samples.push(sample);
    while (pendingCaptures.length && sample.elapsedMs >= pendingCaptures[0] * 1000) {
      const sampleNumber = capturePlan.length - pendingCaptures.length;
      pendingCaptures.shift();
      captures.push(await captureFrame(cdp, outputRoot, ordinal, albumId, sampleNumber));
    }
  }
  const after = await pageSnapshot(cdp);
  while (pendingCaptures.length) {
    const sampleNumber = capturePlan.length - pendingCaptures.length;
    pendingCaptures.shift();
    captures.push(await captureFrame(cdp, outputRoot, ordinal, albumId, sampleNumber));
  }
  const discontinuities = [];
  let previousAbsolute = Number(before.absoluteTime || 0);
  for (const sample of samples) {
    if (sample.sessionId !== before.sessionId) discontinuities.push({ kind: 'session-changed', sample });
    if (sample.globalIndex !== before.globalIndex) discontinuities.push({ kind: 'index-changed', sample });
    if (sample.sourceUrl !== before.sourceUrl) discontinuities.push({ kind: 'source-changed', sample });
    if (Number(sample.absoluteTime || 0) + 0.35 < previousAbsolute) {
      discontinuities.push({ kind: 'timeline-regressed', previousAbsolute, sample });
    }
    previousAbsolute = Number(sample.absoluteTime || 0);
  }
  return {
    watch: {
      requestedWallSeconds: seconds,
      actualWallSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      mediaSecondsAdvanced: Number((Number(after.absoluteTime || 0) - Number(before.absoluteTime || 0)).toFixed(3)),
      beforeAbsoluteTime: before.absoluteTime,
      afterAbsoluteTime: after.absoluteTime,
      sameSession: after.sessionId === before.sessionId,
      sameGlobalIndex: after.globalIndex === before.globalIndex,
      sameSourceUrl: after.sourceUrl === before.sourceUrl,
      discontinuities,
      samples,
      silenceViolations: samples.reduce((sum, sample) => sum + Number(sample.audioViolations || 0), 0),
    },
    captures,
  };
}

async function engineSnapshot(sessionId, actionAtEpochMs) {
  const payload = await fetchJson(API_BASE + '/pong-swap/sessions/' + encodeURIComponent(sessionId));
  const session = payload.session || {};
  const createdAtEpochMs = Number(session.createdAt || 0) * 1000;
  const startedAtEpochMs = Number(session.startedAt || 0) * 1000;
  const firstByteAtEpochMs = Number(session.firstByteAt || 0) * 1000;
  const playableAtEpochMs = Number(session.playableAt || 0) * 1000;
  return {
    createdAtEpochMs,
    startedAtEpochMs,
    firstByteAtEpochMs,
    playableAtEpochMs,
    frames: Number(session.frames || 0),
    inferenceFrames: Number(session.inferenceFrames || 0),
    temporalReuseFrames: Number(session.temporalReuseFrames || 0),
    bytesWritten: Number(session.bytesWritten || 0),
    transportPaddingBytes: Number(session.transportPaddingBytes || 0),
    completeFragments: Number(session.completeFragments || 0),
    muxedMediaSeconds: Number(session.muxedMediaSeconds || 0),
    streamRequests: Number(session.streamRequests || 0),
    subscribers: Number(session.subscribers || 0),
    playbackPositionSeconds: Number(session.playbackPositionSeconds || 0),
    playbackPaused: Boolean(session.playbackPaused),
    timingTotals: session.timingTotals || {},
    temporalReuseRejections: session.temporalReuseRejections || {},
    state: session.state || '',
    prepared: Boolean(session.prepared),
    fps: Number(session.fps || 0),
    width: Number(session.width || 0),
    height: Number(session.height || 0),
    firstByteRelativeToActionMs: firstByteAtEpochMs > 0
      ? Number((firstByteAtEpochMs - actionAtEpochMs).toFixed(1))
      : null,
    playableRelativeToActionMs: playableAtEpochMs > 0
      ? Number((playableAtEpochMs - actionAtEpochMs).toFixed(1))
      : null,
  };
}

async function dispatchTouch(cdp, type, x, y) {
  const startedAt = Date.now();
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' || type === 'touchCancel'
      ? []
      : [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }],
    modifiers: 0,
  });
  return { type, startedAt, completedAt: Date.now(), elapsedMs: Date.now() - startedAt };
}

async function performTap(cdp, x, y) {
  await dispatchTouch(cdp, 'touchStart', x, y);
  await delay(55);
  await dispatchTouch(cdp, 'touchEnd', x, y);
}

async function dismissAndroidImmersiveTutorial(cdp) {
  const point = await cdp.eval('({x:Math.max(1,innerWidth/2),y:Math.max(1,innerHeight/2)})');
  await performTap(cdp, point.x, point.y);
  await delay(120);
}

async function performVerticalSwipe(cdp) {
  const rect = await cdp.eval('(() => {' +
    'const wrapper = pongFaceSwapCurrentWrapper(); const target = wrapper?.querySelector?.(".tap-area") || wrapper;' +
    'if (!target) return null; const r = target.getBoundingClientRect();' +
    'return {x:r.left+r.width*0.55,startY:r.top+r.height*0.72,endY:r.top+r.height*0.24};' +
  '})()');
  if (!rect) throw new Error('tap area missing for vertical swipe');
  // Send the physical gesture at a fixed cadence. Waiting for each CDP input
  // acknowledgement serializes seven renderer round trips and can add several
  // seconds that a real Android finger never waits between move samples.
  const pendingTouchDispatches = [];
  pendingTouchDispatches.push(dispatchTouch(cdp, 'touchStart', rect.x, rect.startY));
  for (let step = 1; step <= 5; step += 1) {
    const y = rect.startY + (rect.endY - rect.startY) * step / 5;
    await delay(28);
    pendingTouchDispatches.push(dispatchTouch(cdp, 'touchMove', rect.x, y));
  }
  await delay(30);
  pendingTouchDispatches.push(dispatchTouch(cdp, 'touchEnd', rect.x, rect.endY));
  const touchDispatches = await Promise.all(pendingTouchDispatches);
  const actionAtEpochMs = await cdp.eval('Number(window.__pongBenchmarkLastTouchStartAt || 0)');
  return { rect, touchDispatches, actionAtEpochMs };
}

async function performProgressScrub(cdp, plan) {
  const geometry = await cdp.eval('(() => {' +
    'const wrapper = pongFaceSwapCurrentWrapper(); const bar = wrapper?.querySelector?.(".video-progress-bar"); const video = wrapper?.querySelector?.("video");' +
    'if (!wrapper || !bar || !video) return null; const r = bar.getBoundingClientRect();' +
    'return {left:r.left,width:r.width,y:r.top+r.height/2,from:Number(pongFaceSwapAbsoluteTime(wrapper,video)||0),duration:Number(pongFaceSwapFullDuration(wrapper,video)||0),sessionId:String(wrapper.dataset.pongFaceSwapSessionId||"")};' +
  '})()');
  if (!geometry || geometry.width < 20) throw new Error('progress bar missing for scrub');
  const clampFraction = value => Math.max(0, Math.min(1, Number(value || 0)));
  const startFraction = Number.isFinite(Number(plan.startFraction))
    ? clampFraction(plan.startFraction)
    : (geometry.duration > 0 ? clampFraction(geometry.from / geometry.duration) : 0);
  const requestedSeconds = Number.isFinite(Number(plan.deltaSeconds))
    ? Math.max(0, geometry.duration > 0
      ? Math.min(geometry.duration - 0.05, geometry.from + Number(plan.deltaSeconds))
      : geometry.from + Number(plan.deltaSeconds))
    : Math.max(0, geometry.duration * clampFraction(plan.targetFraction));
  const targetFraction = geometry.duration > 0
    ? clampFraction(requestedSeconds / geometry.duration)
    : clampFraction(plan.targetFraction);
  const startX = geometry.left + geometry.width * startFraction;
  const endX = geometry.left + geometry.width * targetFraction;
  const pendingTouchDispatches = [];
  pendingTouchDispatches.push(dispatchTouch(cdp, 'touchStart', startX, geometry.y));
  for (let step = 1; step <= 6; step += 1) {
    const x = startX + (endX - startX) * step / 6;
    await delay(25);
    pendingTouchDispatches.push(dispatchTouch(cdp, 'touchMove', x, geometry.y));
  }
  await delay(30);
  pendingTouchDispatches.push(dispatchTouch(cdp, 'touchEnd', endX, geometry.y));
  const touchDispatches = await Promise.all(pendingTouchDispatches);
  const actionAtEpochMs = await cdp.eval('Number(window.__pongBenchmarkLastTouchStartAt || 0)');
  return { ...geometry, startFraction, targetFraction, requestedSeconds, touchDispatches, actionAtEpochMs };
}

function albumForOrdinal(ordinal) {
  if (ordinal < 3) return ALBUMS[0];
  if (ordinal < 21) return ALBUMS[1];
  return ALBUMS[2];
}

async function waitTransition(cdp, expectedIndex, priorSessionId, action) {
  const token = 'transition-' + expectedIndex + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  await cdp.eval(
    'window.__pongBenchmarkArmTransition(' +
      JSON.stringify(token) + ',' +
      Number(expectedIndex) + ',' +
      JSON.stringify(priorSessionId || '') + ')',
  );
  await delay(40);
  const actionAtEpochMs = await cdp.eval('Date.now()');
  const actionResult = await action();
  const measuredActionAtEpochMs = Number(actionResult?.actionAtEpochMs || actionAtEpochMs);
  const frame = await waitFor(
    () => cdp.eval('window.__pongBenchmarkCheckTransition(' + JSON.stringify(token) + ')'),
    45_000,
    'processed swap frame for index ' + expectedIndex,
    50,
  );
  const engine = await engineSnapshot(frame.sessionId, measuredActionAtEpochMs);
  return {
    actionAtEpochMs: measuredActionAtEpochMs,
    firstPlayableSwappedFrameEpochMs: frame.frameEpochMs,
    firstPlayableSwappedFrameMs: Number((frame.frameEpochMs - measuredActionAtEpochMs).toFixed(1)),
    firstVisiblyProcessedFaceFrameMs: Number((frame.frameEpochMs - measuredActionAtEpochMs).toFixed(1)),
    timingBasis: 'first rendered Android WebView video frame bound to a real engine-processed swap session',
    sessionId: frame.sessionId,
    prefetched: frame.prefetched,
    preopened: frame.preopened,
    videoDimensions: { width: frame.videoWidth, height: frame.videoHeight },
    engine,
    actionResult,
  };
}

const runStamp = timestamp();
const outputRoot = path.join(LOG_ROOT, LABEL + '-' + runStamp);
const report = {
  schema: 'pong-face-swap-android-benchmark-v1',
  label: LABEL,
  runStartedAt: new Date().toISOString(),
  outputRoot,
  platform: {
    kind: 'Android emulator WebView',
    avd: 'pong_benchmark_api35',
    api: 35,
    device: 'Pixel 5',
    cdpPort: CDP_PORT,
    audio: 'emulator -no-audio plus forced media mute',
  },
  pageUrl: PAGE_BASE,
  apiBase: API_BASE,
  channel: 'test',
  expectedTotalVideos: EXPECTED_TOTAL,
  albums: ALBUMS,
  face: null,
  strictness: {
    benchmark: STRICTNESS,
    original: null,
    restored: false,
  },
  compatibility: {
    enabled: false,
    reason: 'disabled: benchmarking the deployed frontend/backend contract unchanged',
    rewrites: [],
  },
  import: null,
  videos: [],
  seeks: [],
  paperclips: [],
  captures: [],
  dialogs: [],
  fetchEvents: [],
  deckEvents: [],
  initialEngineHealth: null,
  finalEngineHealth: null,
  summary: null,
  error: null,
};

let cdp;
let originalStrictness = null;
try {
  await mkdir(path.join(outputRoot, 'captures'), { recursive: true });
  console.log('[android-benchmark] output ' + outputRoot);
  await cleanupTestSessions();
  report.initialEngineHealth = await fetchJson(API_BASE + '/pong-swap/health');
  if (!report.initialEngineHealth.ready) {
    await fetchJson(API_BASE + '/pong-swap/warm', { method: 'POST' });
    report.initialEngineHealth = await waitFor(
      async () => {
        const health = await fetchJson(API_BASE + '/pong-swap/health');
        return health.ready ? health : null;
      },
      60_000,
      'face-swap warm-up',
      250,
    );
  }
  const initialSettings = await fetchJson(API_BASE + '/pong-swap/settings');
  originalStrictness = Number(initialSettings?.config?.parameters?.DetectScoreSlider);
  report.strictness.original = Number.isFinite(originalStrictness) ? originalStrictness : null;
  if (Number.isFinite(STRICTNESS) && STRICTNESS !== originalStrictness) {
    await fetchJson(API_BASE + '/pong-swap/settings/preview', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameters: { DetectScoreSlider: STRICTNESS } }),
    });
  }

  const targets = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list').then(response => response.json());
  const target = targets.find(item => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('Android WebView CDP target is unavailable');
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  console.log('[android-benchmark] connected to Android WebView');
  cdp.on('Page.javascriptDialogOpening', params => {
    report.dialogs.push({
      at: new Date().toISOString(),
      type: String(params.type || ''),
      message: String(params.message || ''),
      url: String(params.url || ''),
    });
    void cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Page.enable'),
    cdp.send('Network.enable'),
    cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }).catch(() => ({})),
  ]);

  const fresh = runStamp;
  const pageUrl = PAGE_BASE + '?pongPlaybackFresh=1&benchmarkFresh=' + encodeURIComponent(fresh) + '&pongInstance=2&pongNative=1';
  await cdp.send('Page.navigate', { url: pageUrl });
  await waitFor(
    () => cdp.eval('document.readyState === "complete" && typeof loadEromeAsCards === "function" && Boolean(document.getElementById("open-erome"))'),
    30_000,
    'Pong Android page',
  );
  // The native shell normalizes pongInstance and installs its observer hash in
  // a follow-up navigation.  Give that hand-off time to finish so setup and
  // the album launch are not dispatched into the document being replaced.
  await delay(1_500);
  await waitFor(
    () => cdp.eval('document.readyState === "complete" && typeof loadEromeAsCards === "function" && Boolean(document.getElementById("open-erome"))'),
    15_000,
    'settled Pong Android page',
  );
  console.log('[android-benchmark] fresh Pong page loaded');
  await cdp.eval('(' + browserSetup.toString() + ')()');
  // Android shows a one-time immersive-mode teaching overlay above WebView.
  // A genuine touch dismisses it without ADB or affecting benchmark state;
  // the deck is deliberately empty at this point.
  await dismissAndroidImmersiveTutorial(cdp);
  const pageInfo = await cdp.eval('({href:location.href,title:document.title,version:document.querySelector(".version")?.textContent || document.body.innerText.match(/\\b\\d+\\.\\d+\\b/)?.[0] || "",ua:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}})');
  report.platform.page = pageInfo;

  const importStartedAtEpochMs = Date.now();
  await cdp.eval('(() => {' +
    'document.getElementById("erome-url").value=' + JSON.stringify(ALBUMS.map(album => album.url).join('\n')) + ';' +
    // Invoke the same handler directly. Synthetic HTMLElement.click() can be
    // lost when Android finishes the native observer navigation at this exact
    // boundary, while the user path itself simply delegates to this function.
    'void loadEromeAsCards(); return true;' +
  '})()');
  const imported = await waitFor(
    () => cdp.eval('(() => {' +
      'const expected=' + JSON.stringify(ALBUMS.map(album => ({ id: album.id, expectedVideos: album.expectedVideos, files: album.files }))) + ';' +
      'if (!Array.isArray(allVideoUrls) || allVideoUrls.length !== ' + EXPECTED_TOTAL + ') return null;' +
      'if (!Array.isArray(pasteEvents) || pasteEvents.length !== expected.length) return null;' +
      'if(!activeEromeScrapeProgress||activeEromeScrapeProgress.finished!==true)return null;' +
      'const progressTargets=(activeEromeScrapeProgress.targets||[]).map(value=>String(value).toLowerCase());' +
      'if(expected.some(wanted=>!progressTargets.some(value=>value.endsWith("/a/"+wanted.id.toLowerCase()))))return null;' +
      'const events=pasteEvents.map((event,index)=>({index,postUrl:event.postUrl||event.artistUrl||event.sourceUrl||"",artistName:event.artistName||"",startIndex:Number(event.startIndex||0),count:Number(event.count||0),bundleKey:event.bundleKey||""}));' +
      'const ordered=[];for(let index=0;index<expected.length;index+=1){const wanted=expected[index];const wantedPath=("/a/"+wanted.id).toLowerCase();const exactBundle=("erome-bundle:https://www.erome.com"+wantedPath).toLowerCase();' +
        'const event=events.find(candidate=>{let eventPath="";try{eventPath=new URL(candidate.postUrl,location.href).pathname.replace(/\\/+$/," ").trim().toLowerCase();}catch(_){}return eventPath===wantedPath||candidate.bundleKey.toLowerCase()===exactBundle;});' +
        'if(!event||event.count!==wanted.expectedVideos||event.startIndex<0||event.startIndex+event.count>allVideoUrls.length)return null;' +
        'const urls=allVideoUrls.slice(event.startIndex,event.startIndex+event.count);if(urls.length!==event.count||urls.some(url=>!url))return null;' +
        'const metadata=allVideoMetadata.slice(event.startIndex,event.startIndex+event.count);' +
        'const fileName=value=>{const matches=decodeURIComponent(String(value||"")).match(/[^/?&=]+\\.mp4/ig);return matches?.at(-1)||"";};' +
        'const pairs=urls.map((url,pairIndex)=>({url,metadata:metadata[pairIndex],file:fileName(url)}));' +
        'const sorted=wanted.files.map(file=>pairs.find(pair=>pair.file.toLowerCase()===file.toLowerCase()));if(sorted.some(pair=>!pair))return null;' +
        'ordered.push({wanted,event,urls:sorted.map(pair=>pair.url),metadata:sorted.map(pair=>pair.metadata)});}' +
      'if(!window.__pongBenchmarkImportNormalized){' +
        'document.querySelectorAll("video,audio").forEach(media=>{media.pause();media.muted=true;media.volume=0;});' +
        'const normalizedUrls=[],normalizedMetadata=[],normalizedEvents=[];' +
        'ordered.forEach(item=>{const startIndex=normalizedUrls.length;normalizedUrls.push(...item.urls);normalizedMetadata.push(...item.metadata);normalizedEvents.push({...pasteEvents[item.event.index],startIndex,count:item.urls.length});});' +
        'allVideoUrls=normalizedUrls;allVideoMetadata=normalizedMetadata;pasteEvents=normalizedEvents;' +
        'currentBatch=0;currentVideoIndex=0;currentPasteIndex=-1;activePlaybackRange=null;deckCurrentIndex=-1;deckOrder=[];' +
        'setEromeTwentyCardMode(true,{respectRange:true});setActivePlaybackRangeForPasteEvent(0);resetPaperclipQueue();' +
        'window.PongFastNextBatchOnce=true;window.PongSuppressSessionSaveUntil=Date.now()+3600000;loadNextBatch(0);' +
        'window.__pongBenchmarkImportNormalized=true;' +
      '}' +
      'const normalizedEvents=pasteEvents.map((event,index)=>({index,postUrl:event.postUrl||event.artistUrl||event.sourceUrl||"",artistName:event.artistName||"",startIndex:Number(event.startIndex||0),count:Number(event.count||0),bundleKey:event.bundleKey||""}));' +
      'let expectedStart=0;for(let index=0;index<expected.length;index+=1){const wanted=expected[index];const event=normalizedEvents[index];' +
        'let eventPath="";try{eventPath=new URL(event.postUrl,location.href).pathname.replace(/\\/+$/,"").toLowerCase();}catch(_){}' +
        'const wantedPath=("/a/"+wanted.id).toLowerCase();const exactBundle=("erome-bundle:https://www.erome.com"+wantedPath).toLowerCase();' +
        'if((eventPath!==wantedPath&&event.bundleKey.toLowerCase()!==exactBundle)||event.startIndex!==expectedStart||event.count!==wanted.expectedVideos)return null;' +
        'expectedStart+=wanted.expectedVideos;}' +
      'setDeckActiveIndex(0, "none", { force:true });' +
      'document.querySelectorAll(".video-wrapper").forEach(wrapper=>{wrapper.dataset.playIntent="false";});' +
      'document.querySelectorAll("video,audio").forEach(media => { media.pause(); media.loop=false; media.muted=true; media.defaultMuted=true; media.volume=0; });' +
      'return {videoCount:allVideoUrls.length,events:normalizedEvents};' +
    '})()'),
    45_000,
    'three-album 23-video import',
    150,
  );
  report.import = {
    startedAtEpochMs: importStartedAtEpochMs,
    completedAtEpochMs: Date.now(),
    elapsedMs: Date.now() - importStartedAtEpochMs,
    ...imported,
  };
  console.log('[android-benchmark] imported ' + imported.videoCount + ' videos');

  await waitFor(
    () => cdp.eval('(() => {' +
      'const wrapper=pongFaceSwapCurrentWrapper();const video=wrapper?.querySelector?.("video");' +
      'const localIndex=Number(wrapper?.dataset?.index??-1);const globalIndex=typeof getVideoGlobalIndexForLocalIndex==="function"?getVideoGlobalIndexForLocalIndex(localIndex):localIndex;' +
      'if(!wrapper||!video||globalIndex!==0)return null;' +
      'video.muted=true;video.volume=0;wrapper.dataset.playIntent="true";' +
      'const source=allVideoUrls?.[0]||video.currentSrc||video.src||"";' +
      'return source?{index:0,source}:null;' +
    '})()'),
    10_000,
    'first original Android source',
    100,
  );
  console.log('[android-benchmark] first original source is assigned');

  // Match the real interaction being measured: the user chooses a face while
  // the current clip is already playing. Merely setting playIntent leaves a
  // race with initial CDN readiness and can benchmark a deliberately paused
  // card instead of swap startup.
  await waitFor(async () => {
    await ensureActivePlaying(cdp);
    const state = await pageSnapshot(cdp);
    return state && state.globalIndex === 0 && !state.paused && state.readyState >= 2
      ? state
      : null;
  }, 30_000, 'first original Android playback', 100);
  console.log('[android-benchmark] first original is playing silently');

  console.log('[android-benchmark] opening approved-face menu');
  await cdp.eval('document.getElementById("pong-face-swap-button").click()');
  console.log('[android-benchmark] approved-face menu opened');
  const availableFaceChoice = await waitFor(
    () => cdp.eval('(() => {' +
      'const choice=[...document.querySelectorAll("#pong-face-swap-menu .pong-face-swap-menu-choice")].find(button=>button.textContent.trim()===' + JSON.stringify(FACE_NAME) + ');' +
      'const face=pongFaceSwapState.faces.find(item=>item.name===' + JSON.stringify(FACE_NAME) + ');' +
      'if(!choice||!face)return null;choice.scrollIntoView({block:"nearest",inline:"center"});const rect=choice.getBoundingClientRect();' +
      'const tapX=rect.left+rect.width/2,tapY=rect.top+rect.height/2;' +
      'return rect.width>0&&rect.height>0&&tapX>=0&&tapX<=innerWidth&&tapY>=0&&tapY<=innerHeight?{face,tapX,tapY}:null;' +
    '})()'),
    15_000,
    'approved benchmark face menu',
    50,
  );
  console.log('[android-benchmark] ' + FACE_NAME + ' face choice is ready');
  const faceToken = 'face-selection-' + Date.now();
  console.log('[android-benchmark] arming first-frame observer');
  await cdp.eval('window.__pongBenchmarkArmTransition(' + JSON.stringify(faceToken) + ',0,"")');
  console.log('[android-benchmark] first-frame observer armed');
  await delay(40);
  console.log('[android-benchmark] selecting ' + FACE_NAME);
  // Schedule a normal click in a later browser task. Runtime.evaluate returns
  // before the async selection handler starts, while avoiding an artificial
  // pointerdown whose three-second permanent-delete hold can outlive a lost
  // Android test-driver pointerup.
  const faceSelection = { actionAtEpochMs: await cdp.eval('Date.now()') };
  const faceClickQueued = await cdp.eval('(() => {' +
    'const choice=[...document.querySelectorAll("#pong-face-swap-menu .pong-face-swap-menu-choice")].find(button=>button.textContent.trim()===' + JSON.stringify(FACE_NAME) + ');' +
    'if(!choice)return false;setTimeout(()=>{window.__pongBenchmarkFaceClickAt=Date.now();choice.click();},0);return true;' +
  '})()');
  if (!faceClickQueued) throw new Error('approved benchmark face disappeared before selection');
  console.log('[android-benchmark] ' + FACE_NAME + ' selection dispatched');
  faceSelection.face = availableFaceChoice.face;
  report.face = { id: faceSelection.face.id, name: faceSelection.face.name };
  const firstFrame = await waitFor(
    () => cdp.eval('window.__pongBenchmarkCheckTransition(' + JSON.stringify(faceToken) + ')'),
    45_000,
    'first processed face-selection frame',
    50,
  );
  faceSelection.actionAtEpochMs = Number(
    await cdp.eval('Number(window.__pongBenchmarkFaceClickAt || 0)') || faceSelection.actionAtEpochMs
  );
  console.log('[android-benchmark] first swapped frame ' + Math.round(firstFrame.frameEpochMs - faceSelection.actionAtEpochMs) + 'ms');
  const firstEngine = await engineSnapshot(firstFrame.sessionId, faceSelection.actionAtEpochMs);
  const firstTransition = {
    actionAtEpochMs: faceSelection.actionAtEpochMs,
    firstPlayableSwappedFrameEpochMs: firstFrame.frameEpochMs,
    firstPlayableSwappedFrameMs: Number((firstFrame.frameEpochMs - faceSelection.actionAtEpochMs).toFixed(1)),
    firstVisiblyProcessedFaceFrameMs: Number((firstFrame.frameEpochMs - faceSelection.actionAtEpochMs).toFixed(1)),
    timingBasis: 'first rendered Android WebView video frame bound to a real engine-processed swap session',
    sessionId: firstFrame.sessionId,
    prefetched: firstFrame.prefetched,
    preopened: firstFrame.preopened,
    videoDimensions: { width: firstFrame.videoWidth, height: firstFrame.videoHeight },
    engine: firstEngine,
  };

  for (let ordinal = 0; ordinal < RUN_VIDEO_LIMIT; ordinal += 1) {
    const album = albumForOrdinal(ordinal);
    let transition;
    let transitionKind;
    if (ordinal === 0) {
      transition = firstTransition;
      transitionKind = 'face-selection';
    } else if (ordinal === 3 || ordinal === 21) {
      transitionKind = 'paperclip';
      const before = await pageSnapshot(cdp);
      transition = await waitTransition(cdp, ordinal, before?.sessionId || '', async () => {
        const clicked = await cdp.eval('(() => {const button=document.getElementById("paste-nav-button");if(!button||button.disabled)return null;const actionAtEpochMs=Date.now();button.click();return {clicked:true,actionAtEpochMs};})()');
        if (!clicked?.clicked) throw new Error('Paperclip was unavailable before ordinal ' + ordinal);
        return clicked;
      });
      report.paperclips.push({
        afterOrdinal: ordinal - 1,
        fromEventIndex: ordinal === 3 ? 0 : 1,
        toEventIndex: ordinal === 3 ? 1 : 2,
        toGlobalIndex: ordinal,
        ...transition,
      });
    } else {
      transitionKind = 'vertical-swipe';
      const before = await pageSnapshot(cdp);
      transition = await waitTransition(cdp, ordinal, before?.sessionId || '', () => performVerticalSwipe(cdp));
    }

    const state = await cdp.eval('(() => {' +
      'const wrapper=pongFaceSwapCurrentWrapper();const localIndex=Number(wrapper?.dataset?.index??-1);' +
      'const index=typeof getVideoGlobalIndexForLocalIndex==="function"?getVideoGlobalIndexForLocalIndex(localIndex):localIndex;' +
      'return {index,sourceUrl:allVideoUrls[index]||"",metadata:allVideoMetadata[index]||{},eventIndex:typeof findPasteEventIndexForVideoIndex==="function"?findPasteEventIndexForVideoIndex(index):-1};' +
    '})()');
    if (state.index !== ordinal) throw new Error('expected global index ' + ordinal + ' but saw ' + state.index);

    const seekPlan = SEEK_PLAN.get(ordinal);
    const runPlannedSeek = async plan => {
      const prior = await pageSnapshot(cdp);
      const sought = await waitTransition(
        cdp,
        ordinal,
        prior.sessionId,
        () => performProgressScrub(cdp, plan),
      );
      const geometry = sought.actionResult;
      const landed = await pageSnapshot(cdp);
      const exactPreview = await cdp.eval(
        '(() => {const after=' + Number(sought.actionAtEpochMs) + ';' +
        'const events=typeof pongRuntimeDiagnostics==="undefined"?[]:pongRuntimeDiagnostics;' +
        'return [...events].reverse().find(event=>event?.type==="swap.seek-preview-frame"&&Number(event.at||0)>=after)||null;})()',
      );
      report.seeks.push({
        ordinal,
        albumId: album.id,
        globalIndex: ordinal,
        direction: plan.direction,
        fromSeconds: geometry.from,
        requestedSeconds: geometry.requestedSeconds,
        effectiveRequestedSeconds: landed.absoluteTime,
        startFraction: geometry.startFraction,
        targetFraction: geometry.targetFraction,
        landedSeconds: landed.absoluteTime,
        errorSeconds: Math.abs(landed.absoluteTime - geometry.requestedSeconds),
        priorSessionId: prior.sessionId,
        sessionId: sought.sessionId,
        actionAtEpochMs: sought.actionAtEpochMs,
        firstPlayableSwappedFrameEpochMs: sought.firstPlayableSwappedFrameEpochMs,
        firstPlayableSwappedFrameMs: sought.firstPlayableSwappedFrameMs,
        firstVisiblyProcessedFaceFrameMs: sought.firstVisiblyProcessedFaceFrameMs,
        firstExactSeekFrameEpochMs: Number(exactPreview?.at || 0),
        firstExactSeekFrameMs: exactPreview?.at
          ? Number((Number(exactPreview.at) - sought.actionAtEpochMs).toFixed(1))
          : null,
        exactSeekFrameRequestMs: Number.isFinite(Number(exactPreview?.detail?.elapsedMs))
          ? Number(Number(exactPreview.detail.elapsedMs).toFixed(1))
          : null,
        engine: sought.engine,
      });
      transition.finalSessionId = sought.sessionId;
      return sought;
    };

    if (seekPlan && seekPlan.afterWatch !== true) await runPlannedSeek(seekPlan);

    const seconds = LONG_WATCH_ORDINALS.has(ordinal) ? 10 : 2;
    const capturePlan = LONG_WATCH_ORDINALS.has(ordinal) ? [2, 5, 9] : [];
    const watched = await watchVideo(cdp, seconds, capturePlan, outputRoot, ordinal, album.id);
    let engineAfterWatch = null;
    try {
      const finalWatchSessionId = String((await pageSnapshot(cdp))?.sessionId || '');
      if (finalWatchSessionId) engineAfterWatch = await engineSnapshot(finalWatchSessionId, transition.actionAtEpochMs);
    } catch (_) {}
    if (seekPlan?.afterWatch === true) await runPlannedSeek(seekPlan);
    console.log('[android-benchmark] video ' + (ordinal + 1) + '/' + RUN_VIDEO_LIMIT + ' ' + transitionKind + ' ' + Math.round(transition.firstPlayableSwappedFrameMs) + 'ms');
    report.captures.push(...watched.captures);
    report.videos.push({
      ordinal,
      albumId: album.id,
      globalIndex: ordinal,
      eventIndex: state.eventIndex,
      transitionKind,
      sessionId: transition.sessionId,
      faceId: report.face.id,
      prefetched: transition.prefetched,
      preopened: transition.preopened,
      sourceUrl: state.sourceUrl,
      metadata: state.metadata,
      ...transition,
      watch: watched.watch,
      engineAfterWatch,
      finalSessionId: transition.finalSessionId || transition.sessionId,
    });
  }

  report.finalEngineHealth = await fetchJson(API_BASE + '/pong-swap/health');
  const allTransitionMs = report.videos.map(video => video.firstPlayableSwappedFrameMs);
  const warmTransitionMs = report.videos.slice(1).map(video => video.firstPlayableSwappedFrameMs);
  const swipeMs = report.videos.filter(video => video.transitionKind === 'vertical-swipe').map(video => video.firstPlayableSwappedFrameMs);
  const paperclipMs = report.videos.filter(video => video.transitionKind === 'paperclip').map(video => video.firstPlayableSwappedFrameMs);
  const seekMs = report.seeks.map(seek => seek.firstPlayableSwappedFrameMs);
  const seekExactFrameMs = report.seeks
    .map(seek => seek.firstExactSeekFrameMs == null ? Number.NaN : Number(seek.firstExactSeekFrameMs))
    .filter(value => Number.isFinite(value) && value >= 0);
  const discontinuities = report.videos.flatMap(video => video.watch.discontinuities || []);
  const audioViolations = report.videos.reduce((sum, video) => sum + Number(video.watch.silenceViolations || 0), 0);
  const observedAdvance = report.videos.reduce((sum, video) => sum + Number(video.watch.mediaSecondsAdvanced || 0), 0);
  const requestedAdvance = report.videos.reduce((sum, video) => sum + Number(video.watch.requestedWallSeconds || 0), 0);
  const albumCounts = Object.fromEntries(ALBUMS.map(album => [
    album.id,
    report.videos.filter(video => video.albumId === album.id).length,
  ]));
  const coverage = {
    videos: report.videos.length,
    uniqueVideos: new Set(report.videos.map(video => video.sourceUrl)).size,
    albumCounts,
    watches2s: report.videos.filter(video => video.watch.requestedWallSeconds === 2).length,
    watches10s: report.videos.filter(video => video.watch.requestedWallSeconds === 10).length,
    forwardSeeks: report.seeks.filter(seek => seek.direction === 'forward').length,
    backwardSeeks: report.seeks.filter(seek => seek.direction === 'backward').length,
    paperclipPresses: report.paperclips.length,
  };
  report.summary = {
    ok: (
      coverage.videos === EXPECTED_TOTAL &&
      coverage.uniqueVideos === EXPECTED_TOTAL &&
      coverage.watches2s === 20 &&
      coverage.watches10s === 3 &&
      coverage.forwardSeeks === 2 &&
      coverage.backwardSeeks === 1 &&
      coverage.paperclipPresses === 2 &&
      discontinuities.length === 0 &&
      audioViolations === 0 &&
      observedAdvance >= requestedAdvance * 0.8
    ),
    coverage,
    coldFaceSelection: stats([report.videos[0].firstPlayableSwappedFrameMs]),
    allVideoTransitions: stats(allTransitionMs),
    warmVideoTransitions: stats(warmTransitionMs),
    verticalSwipes: stats(swipeMs),
    paperclips: stats(paperclipMs),
    seeks: stats(seekMs),
    exactSeekFrames: stats(seekExactFrameMs),
    playbackGate: {
      ok: discontinuities.length === 0 && audioViolations === 0 && observedAdvance >= requestedAdvance * 0.8,
      checkedVideos: report.videos.length,
      discontinuities: discontinuities.length,
      audioViolations,
    },
    watchMediaAdvanceSeconds: {
      requested: requestedAdvance,
      observed: Number(observedAdvance.toFixed(3)),
    },
    qualityCaptureCount: report.captures.length,
    target: '45-50% or greater median latency reduction with a substantial p90 reduction; exact Android flow, no compatibility shim',
  };
  report.runCompletedAt = new Date().toISOString();
} catch (error) {
  report.error = {
    message: String(error?.message || error),
    stack: String(error?.stack || ''),
  };
  report.runCompletedAt = new Date().toISOString();
} finally {
  try {
    report.preCleanupSessions = (await fetchJson(API_BASE + '/pong-swap/sessions')).sessions || [];
  } catch (_) {
    report.preCleanupSessions = [];
  }
  try {
    report.playEvents = cdp ? await cdp.eval('window.__pongBenchmarkPlayEvents || []') : [];
  } catch (_) {
    report.playEvents = [];
  }
  try {
    report.fetchEvents = cdp ? await cdp.eval('window.__pongBenchmarkFetchEvents || []') : [];
  } catch (_) {
    report.fetchEvents = [];
  }
  try {
    report.deckEvents = cdp ? await cdp.eval('window.__pongBenchmarkDeckEvents || []') : [];
  } catch (_) {
    report.deckEvents = [];
  }
  try {
    report.runtimeDiagnostics = cdp
      ? await cdp.eval('typeof pongRuntimeDiagnostics === "undefined" ? [] : pongRuntimeDiagnostics.slice(-160)')
      : [];
  } catch (_) {
    report.runtimeDiagnostics = [];
  }
  await cleanupTestSessions().catch(() => {});
  if (Number.isFinite(originalStrictness) && originalStrictness !== STRICTNESS) {
    try {
      await fetchJson(API_BASE + '/pong-swap/settings/preview', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: { DetectScoreSlider: originalStrictness } }),
      });
      report.strictness.restored = true;
    } catch (error) {
      report.strictness.restoreError = String(error?.message || error || 'restore failed');
    }
  } else {
    report.strictness.restored = true;
  }
  try {
    report.cleanup = await fetchJson(API_BASE + '/pong-swap/health');
  } catch (_) {
    report.cleanup = null;
  }
  cdp?.close();
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
  const events = [
    ...report.videos.map(video => ({ type: 'video', ...video })),
    ...report.seeks.map(seek => ({ type: 'seek', ...seek })),
    ...report.paperclips.map(paperclip => ({ type: 'paperclip', ...paperclip })),
  ];
  await writeFile(path.join(outputRoot, 'events.ndjson'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
}

console.log(JSON.stringify({
  outputRoot,
  ok: Boolean(report.summary?.ok),
  summary: report.summary,
  error: report.error,
}, null, 2));
if (report.error || !report.summary?.ok) process.exitCode = 1;
