import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPlaybackObservation } from './playback-observation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_PORT = Number(process.env.PONG_ANDROID_CDP_PORT || 9225);
const EXPECTED = Math.max(1, Number(process.env.PONG_RECALL_EXPECTED || 1));
const LIMIT = Math.max(1, Number(process.env.PONG_RECALL_LIMIT || EXPECTED));
const PLAY_SECONDS = Math.max(1, Number(process.env.PONG_RECALL_PLAY_SECONDS || 10));
const LABEL = String(process.env.PONG_RECALL_LABEL || 'android-recall');
const requestedSourceMode = String(process.env.PONG_RECALL_SOURCE_MODE || 'pong').toLowerCase();
const SOURCE_MODE = ['pong', 'direct', 'deck'].includes(requestedSourceMode) ? requestedSourceMode : 'pong';
const CHANNEL = Number(process.env.PONG_RECALL_CHANNEL || 1) === 2 ? 2 : 1;
const RELOAD_APP = /^(?:1|true|yes)$/i.test(String(process.env.PONG_ANDROID_RELOAD || ''));
const PAGE_PATTERN = String(process.env.PONG_RECALL_PAGE_PATTERN || '').trim();
const OUTPUT = process.env.PONG_RECALL_OUTPUT
  ? path.resolve(process.env.PONG_RECALL_OUTPUT)
  : path.join(ROOT, 'artifacts', `android-recall-${LABEL.replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase()}.json`);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, { awaitPromise = true, userGesture = true, timeoutMs = 30_000 } = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture,
    }, timeoutMs);
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(detail || 'WebView evaluation failed');
    }
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch (_) {}
  }
}

async function getTarget() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Android CDP target list returned HTTP ${response.status}`);
  const targets = await response.json();
  const pong = targets.find(target => target.type === 'page' && /\/pong(?:[?#]|$)/i.test(String(target.url || '')));
  if (!pong?.webSocketDebuggerUrl) throw new Error(`No Pong Android WebView on CDP port ${CDP_PORT}`);
  return pong;
}

const hardMuteScript = String.raw`(() => {
  window.autoplayEnabled = false;
  // Qualification can replace a previously loaded Recall queue. Accept only
  // the app's local confirmation dialogs so an unattended run cannot stall.
  window.confirm = () => true;
  const mute = media => {
    try { media.muted = true; } catch (_) {}
    try { media.defaultMuted = true; } catch (_) {}
    try { media.volume = 0; } catch (_) {}
  };
  document.querySelectorAll('video,audio').forEach(media => {
    mute(media);
    try { media.pause(); } catch (_) {}
  });
  if (!window.__pongAndroidQualificationNativePlay) {
    window.__pongAndroidQualificationNativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {
      mute(this);
      return window.__pongAndroidQualificationNativePlay.apply(this, args);
    };
  }
  if (!window.__pongAndroidQualificationMuteTimer) {
    window.__pongAndroidQualificationMuteTimer = setInterval(() => {
      document.querySelectorAll('video,audio').forEach(mute);
    }, 100);
  }
  return {
    title: document.title,
    url: location.origin + location.pathname,
    version: document.querySelector('.version-number')?.textContent?.trim() || '',
  };
})()`;

function playbackStartScript(limit, seconds, sourceMode, pagePattern = '') {
  return `(() => {
    const classifyPlaybackObservation = ${classifyPlaybackObservation.toString()};
    if (window.__pongAndroidRecallRun?.state === 'running') {
      throw new Error('An Android Recall qualification is already running');
    }
    const run = window.__pongAndroidRecallRun = {
      state: 'running', startedAt: Date.now(), completedAt: 0,
      requested: ${limit}, playSeconds: ${seconds}, results: [], error: ''
    };
    const allMetadata = Array.isArray(allVideoMetadata) ? allVideoMetadata : [];
    const allPongUrls = Array.isArray(allVideoUrls) ? allVideoUrls : [];
    const pagePattern = ${JSON.stringify(pagePattern)}.toLowerCase();
    const selectedIndices = allPongUrls.map((_url, index) => index).filter(index => {
      if (!pagePattern) return true;
      const item = allMetadata[index] || {};
      return [item.postUrl, item.pageUrl, item.artistUrl, item.canonicalMediaUrl]
        .some(value => String(value || '').toLowerCase().includes(pagePattern));
    }).slice(0, ${limit});
    const metadata = selectedIndices.map(index => allMetadata[index] || {});
    const pongUrls = selectedIndices.map(index => allPongUrls[index]);
    const useDeck = ${JSON.stringify(sourceMode)} === 'deck';
    const urls = ${JSON.stringify(sourceMode)} === 'direct'
      ? pongUrls.map((url, index) => String(metadata[index]?.canonicalMediaUrl || metadata[index]?.originalVideoUrl || url || ''))
      : pongUrls;
    run.available = Array.isArray(allVideoUrls) ? allVideoUrls.length : 0;
    run.urls = urls;
    run.promise = (async () => {
      if (typeof clearDeckReadyPromotion === 'function') clearDeckReadyPromotion();
      if (typeof deckAutoPromotionLockedUntil !== 'undefined') deckAutoPromotionLockedUntil = Date.now() + 60 * 60 * 1000;
      document.querySelectorAll('video,audio').forEach(media => {
        try { media.pause(); } catch (_) {}
        try { media.muted = true; media.defaultMuted = true; media.volume = 0; } catch (_) {}
      });
      for (let index = 0; index < urls.length; index++) {
        const globalIndex = Number(selectedIndices[index]);
        const url = String(urls[index] || '');
        let wrapper = null;
        let ownsMedia = !useDeck;
        let media = null;
        if (useDeck) {
          if (typeof setDeckActiveIndex !== 'function') throw new Error('Pong deck controls are unavailable');
          if (!(globalIndex >= Number(currentLoadedRangeStart || 0) && globalIndex < Number(currentLoadedRangeEnd || 0))) {
            window.PongFastNextBatchOnce = true;
            loadNextBatch(0);
            const batchDeadline = performance.now() + 10000;
            while (performance.now() < batchDeadline) {
              const start = Number(currentLoadedRangeStart || 0);
              const end = Number(currentLoadedRangeEnd || 0);
              const local = globalIndex - start;
              if (globalIndex >= start && globalIndex < end && document.querySelector('.video-wrapper[data-index="' + local + '"]')) break;
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          const localIndex = globalIndex - Number(currentLoadedRangeStart || 0);
          if (!setDeckActiveIndex(localIndex, 'none', {
            pushHistory: false,
            skipPersistentFaceSwap: true,
            skipEromeRecycle: true
          })) {
            throw new Error('Pong deck card ' + globalIndex + ' is unavailable');
          }
          wrapper = typeof getDeckWrapper === 'function'
            ? getDeckWrapper(localIndex)
            : document.querySelector('.video-wrapper[data-index="' + localIndex + '"]');
          media = wrapper?.querySelector('video') || null;
          if (!media) throw new Error('Pong deck video ' + globalIndex + ' is unavailable');
        } else {
          media = document.createElement('video');
        }
        media.muted = true;
        media.defaultMuted = true;
        media.volume = 0;
        media.autoplay = false;
        media.controls = false;
        media.playsInline = true;
        media.defaultPlaybackRate = 1;
        media.playbackRate = 1;
        media.preload = 'auto';
        if (ownsMedia) {
          media.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:black;z-index:2147483647;pointer-events:none';
          document.body.appendChild(media);
        }
        const row = {
          index: globalIndex,
          selectionIndex: index,
          pageUrl: String(metadata[index]?.postUrl || ''),
          sourceUrl: url,
          declaredDuration: Number(metadata[index]?.duration || 0),
          startupMs: null,
          wallMs: null,
          mediaAdvanceSeconds: 0,
          maxProgressGapMs: 0,
          waitingEvents: 0,
          waitingAfterFirstFrame: 0,
          presentedFrames: 0,
          presentedMediaAdvanceSeconds: 0,
          maxPresentedGapMs: 0,
          playbackWallMs: null,
          stalledEvents: 0,
          error: '',
          passed: false,
          muted: true,
          actualPlaybackUrl: '',
          videoWidth: 0,
          videoHeight: 0,
        };
        run.activeIndex = index;
        const startedAt = performance.now();
        let firstProgressAt = 0;
        let lastProgressAt = startedAt;
        let lastTime = 0;
        let startTime = 0;
        let startupTimer = 0;
        let frameCallback = 0;
        let firstPresentedAt = 0;
        let firstPresentedMediaTime = 0;
        let lastPresentedAt = 0;
        const eventScope = new AbortController();
        const observeFrame = (now, frame) => {
          const t = Number(frame.mediaTime);
          if (!Number.isFinite(t)) return;
          if (!firstPresentedAt) {
            firstPresentedAt = now;
            firstPresentedMediaTime = t;
            row.startupMs = Math.round(now - startedAt);
          } else {
            row.maxPresentedGapMs = Math.max(row.maxPresentedGapMs, now - lastPresentedAt);
          }
          lastPresentedAt = now;
          row.presentedFrames++;
          row.presentedMediaAdvanceSeconds = Math.max(0, t - firstPresentedMediaTime);
          row.playbackWallMs = now - firstPresentedAt;
          frameCallback = media.requestVideoFrameCallback(observeFrame);
        };
        try {
          media.addEventListener('waiting', () => {
            row.waitingEvents++;
            if (firstPresentedAt) row.waitingAfterFirstFrame++;
          }, {signal:eventScope.signal});
          media.addEventListener('stalled', () => row.stalledEvents++, {signal:eventScope.signal});
          if (typeof media.requestVideoFrameCallback === 'function') {
            frameCallback = media.requestVideoFrameCallback(observeFrame);
          }
          if (ownsMedia) {
            media.src = url;
            media.load();
          }
          const playAttempt = useDeck && typeof playVideoCleanly === 'function'
            ? playVideoCleanly(media)
            : media.play();
          await Promise.race([
            playAttempt,
            new Promise((_, reject) => {
              startupTimer = setTimeout(() => reject(new Error('play() startup timed out')), 20000);
            })
          ]);
          clearTimeout(startupTimer);
          row.actualPlaybackUrl = String(media.currentSrc || media.src || url);
          const deadline = performance.now() + 45000;
          while (performance.now() < deadline) {
            media.muted = true;
            media.defaultMuted = true;
            media.volume = 0;
            if (media.playbackRate !== 1) media.playbackRate = 1;
            const now = performance.now();
            const current = Number(media.currentTime || 0);
            if (current > lastTime + 0.002) {
              if (!firstProgressAt) {
                firstProgressAt = now;
                startTime = current;
                lastProgressAt = now;
              } else {
                row.maxProgressGapMs = Math.max(row.maxProgressGapMs, Math.round(now - lastProgressAt));
                lastProgressAt = now;
              }
              lastTime = current;
            }
            if (firstProgressAt && current - startTime >= ${seconds} && row.presentedMediaAdvanceSeconds >= ${seconds}) break;
            if (media.error) throw new Error('media error ' + media.error.code + ': ' + (media.error.message || 'unknown'));
            if (media.ended) break;
            if (firstProgressAt && now - lastProgressAt > 4500) throw new Error('playback stopped advancing for 4.5 seconds');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const endedAt = performance.now();
          row.wallMs = Math.round(endedAt - startedAt);
          row.mediaAdvanceSeconds = Number(Math.max(0, Number(media.currentTime || 0) - startTime).toFixed(3));
          row.muted = media.muted === true && Number(media.volume) === 0;
          row.actualPlaybackUrl = String(media.currentSrc || media.src || row.actualPlaybackUrl || url);
          row.videoWidth = Number(media.videoWidth || 0);
          row.videoHeight = Number(media.videoHeight || 0);
          row.ended = media.ended === true;
          row.durationSeconds = Number.isFinite(media.duration) ? media.duration : null;
          row.currentTimeSeconds = Number(media.currentTime || 0);
          Object.assign(row, classifyPlaybackObservation(row, ${seconds}));
        } catch (error) {
          clearTimeout(startupTimer);
          row.error = String(error?.message || error || 'playback failed');
          row.wallMs = Math.round(performance.now() - startedAt);
          row.mediaAdvanceSeconds = Number(Math.max(0, Number(media.currentTime || 0) - startTime).toFixed(3));
          row.actualPlaybackUrl = String(media.currentSrc || media.src || row.actualPlaybackUrl || url);
          row.videoWidth = Number(media.videoWidth || 0);
          row.videoHeight = Number(media.videoHeight || 0);
        } finally {
          eventScope.abort();
          if (frameCallback && typeof media.cancelVideoFrameCallback === 'function') media.cancelVideoFrameCallback(frameCallback);
          try { media.pause(); } catch (_) {}
          if (ownsMedia) {
            try { media.removeAttribute('src'); media.load(); } catch (_) {}
            try { media.remove(); } catch (_) {}
          }
        }
        run.results.push(row);
        run.lastCompletedIndex = index;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      run.state = run.results.length === urls.length && run.results.every(row => row.passed) ? 'complete' : 'failed';
      run.completedAt = Date.now();
      return run.state;
    })().catch(error => {
      run.state = 'failed';
      run.error = String(error?.stack || error?.message || error || 'qualification failed');
      run.completedAt = Date.now();
    });
    return { started: true, available: run.available, testing: urls.length };
  })()`;
}

const compactSnapshotScript = `(() => {
  const run = window.__pongAndroidRecallRun || {};
  return {
    state: String(run.state || ''),
    startedAt: Number(run.startedAt || 0),
    completedAt: Number(run.completedAt || 0),
    requested: Number(run.requested || 0),
    available: Number(run.available || 0),
    activeIndex: Number.isFinite(run.activeIndex) ? run.activeIndex : -1,
    completed: Array.isArray(run.results) ? run.results.length : 0,
    last: Array.isArray(run.results) && run.results.length ? run.results[run.results.length - 1] : null,
    error: String(run.error || '')
  };
})()`;

const finalSnapshotScript = `(() => {
  const run = window.__pongAndroidRecallRun || {};
  return {
    state: String(run.state || ''), startedAt: Number(run.startedAt || 0), completedAt: Number(run.completedAt || 0),
    requested: Number(run.requested || 0), available: Number(run.available || 0), playSeconds: Number(run.playSeconds || 0),
    results: Array.isArray(run.results) ? run.results : [], error: String(run.error || '')
  };
})()`;

async function main() {
  const target = await getTarget();
  // App fragments can contain observer pairing material; never persist or log it.
  const safeTargetUrl = new URL(target.url);
  safeTargetUrl.search = '';
  safeTargetUrl.hash = '';
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on('Page.javascriptDialogOpening', () => {
      cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }).catch(() => {});
    });
    await cdp.send('Network.enable', { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 128_000 });
    const networkById = new Map();
    const networkEvents = [];
    cdp.on('Network.requestWillBeSent', event => {
      const url = String(event.request?.url || '');
      if (!/\/(?:proxy|video-cache\/stream|media-browser-relay\/stream)(?:[/?]|$)/i.test(url)) return;
      const row = {
        requestId: String(event.requestId || ''), url,
        startedAt: Number(event.timestamp || 0),
        range: String(event.request?.headers?.Range || event.request?.headers?.range || ''),
        status: 0, contentRange: '', contentLength: '', finishedAt: 0, failed: ''
      };
      networkById.set(row.requestId, row);
      networkEvents.push(row);
    });
    cdp.on('Network.responseReceived', event => {
      const row = networkById.get(String(event.requestId || ''));
      if (!row) return;
      row.status = Number(event.response?.status || 0);
      row.contentRange = String(event.response?.headers?.['content-range'] || event.response?.headers?.['Content-Range'] || '');
      row.contentLength = String(event.response?.headers?.['content-length'] || event.response?.headers?.['Content-Length'] || '');
    });
    cdp.on('Network.loadingFinished', event => {
      const row = networkById.get(String(event.requestId || ''));
      if (row) row.finishedAt = Number(event.timestamp || 0);
    });
    cdp.on('Network.loadingFailed', event => {
      const row = networkById.get(String(event.requestId || ''));
      if (row) row.failed = String(event.errorText || 'failed');
    });
    if (RELOAD_APP) {
      await cdp.send('Page.reload', { ignoreCache: true });
      const readyDeadline = Date.now() + 45_000;
      while (Date.now() < readyDeadline) {
        await delay(250);
        const ready = await cdp.eval(
          `document.readyState !== 'loading' && typeof startSimpCityRecall === 'function'`,
        ).catch(() => false);
        if (ready) break;
      }
    }
    const app = await cdp.eval(hardMuteScript);
    console.log(JSON.stringify({ event: 'android-ready', target: { title: target.title, url: safeTargetUrl.toString() }, app }));

    await cdp.eval(`Promise.resolve(startSimpCityRecall(${CHANNEL})).then(() => true)`, { timeoutMs: 120_000 });
    const loadDeadline = Date.now() + 120_000;
    let available = 0;
    while (Date.now() < loadDeadline) {
      available = Number(await cdp.eval(`Array.isArray(allVideoUrls) ? allVideoUrls.length : 0`) || 0);
      if (available >= Math.min(EXPECTED, LIMIT)) break;
      await delay(500);
    }
    if (available < Math.min(EXPECTED, LIMIT)) {
      throw new Error(`Recall loaded ${available}; expected at least ${Math.min(EXPECTED, LIMIT)}`);
    }
    console.log(JSON.stringify({ event: 'recall-loaded', label: LABEL, available, expected: EXPECTED }));

    const started = await cdp.eval(playbackStartScript(
      Math.min(LIMIT, available), PLAY_SECONDS, SOURCE_MODE, PAGE_PATTERN
    ));
    console.log(JSON.stringify({ event: 'playback-started', ...started }));
    let lastCompleted = -1;
    const deadline = Date.now() + Math.max(120_000, Math.min(LIMIT, available) * (PLAY_SECONDS + 55) * 1000);
    while (Date.now() < deadline) {
      const progress = await cdp.eval(compactSnapshotScript);
      if (progress.completed !== lastCompleted) {
        lastCompleted = progress.completed;
        console.log(JSON.stringify({ event: 'playback-progress', label: LABEL, ...progress }));
      }
      if (progress.state === 'complete' || progress.state === 'failed') break;
      await delay(1000);
    }
    const run = await cdp.eval(finalSnapshotScript);
    const passed = run.state === 'complete' && run.results.length === Math.min(LIMIT, available) && run.results.every(row => row.passed);
    const report = {
      generatedAt: new Date().toISOString(),
      label: LABEL,
      channel: CHANNEL,
      app,
      target: { title: target.title, url: safeTargetUrl.toString() },
      expected: EXPECTED,
      limit: LIMIT,
      available,
      playSeconds: PLAY_SECONDS,
      sourceMode: SOURCE_MODE,
      networkEvents: networkEvents.slice(-500),
      passed,
      ...run,
    };
    await mkdir(path.dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ event: 'complete', output: OUTPUT, passed, tested: run.results.length }));
    if (!passed) process.exitCode = 1;
  } finally {
    cdp.close();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
