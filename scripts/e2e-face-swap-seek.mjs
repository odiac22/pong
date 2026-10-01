import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const CHROME = process.env.PONG_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PONG = process.env.PONG_TEST_URL || 'http://127.0.0.1:8787/pong';
const BASE = new URL(PONG).origin;
const DIRECT = 'https://v20.erome.com/8726/pTrYBqm9/jrNsRhqI_720p.mp4';
const SOURCE = `https://pong-erome-proxy.arianslade-pong.workers.dev/erome.mp4?u=${encodeURIComponent(DIRECT)}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
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
let swapSessionId = '';
try {
  profile = await mkdtemp(path.join(os.tmpdir(), 'pong-swap-seek-'));
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
  await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable')]);
  await waitFor(() => cdp.eval(`document.readyState === 'complete' && typeof startPongFaceSwap === 'function'`), 20_000, 'Pong page');

  const faceId = await fetch(`${BASE}/pong-swap/faces`)
    .then(r => r.json()).then(payload => payload.faces?.[0]?.id || '');
  assert(faceId, 'approved test face is missing');
  await cdp.eval(`(() => {
    window.PongFaceSwapChannelOverride = 'test';
    window.__pongSwapFetchEvents = [];
    window.__pongSwapNativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const input = args[0];
      const options = args[1] || {};
      const url = String(input?.url || input || '');
      const method = String(options.method || input?.method || 'GET').toUpperCase();
      const relevant = /\\/pong-swap\\/sessions(?:\\/|$)/.test(url);
      const startedAt = Date.now();
      let body = null;
      if (relevant && options.body) {
        try { body = JSON.parse(String(options.body)); } catch (_) { body = String(options.body); }
      }
      if (relevant) window.__pongSwapFetchEvents.push({ phase:'start', at:startedAt, url, method, body });
      try {
        const response = await window.__pongSwapNativeFetch(...args);
        if (relevant) {
          let payload = null;
          try { payload = await response.clone().json(); } catch (_) {}
          window.__pongSwapFetchEvents.push({
            phase:'finish', at:Date.now(), url, method, body,
            status:response.status, sessionId:payload?.session?.id || ''
          });
        }
        return response;
      } catch (error) {
        if (relevant) window.__pongSwapFetchEvents.push({ phase:'error', at:Date.now(), url, method, body, error:String(error?.message || error) });
        throw error;
      }
    };
    const overlay = document.getElementById('pong-overlay');
    if (overlay) overlay.style.display = 'none';
    videoUrls = [${JSON.stringify(SOURCE)}];
    allVideoUrls = [...videoUrls];
    videoMetadata = [{ source: 'erome', artistName: 'pTrYBqm9 seek test', artistKey: 'https://www.erome.com/a/pTrYBqm9', videoUrl: videoUrls[0] }];
    allVideoMetadata = [...videoMetadata];
    pasteEvents = [{ source: 'erome', artistName: 'pTrYBqm9 seek test', artistKey: 'https://www.erome.com/a/pTrYBqm9', startIndex: 0, count: 1 }];
    currentVideoIndex = 0; currentLoadedRangeStart = 0; activePlaybackRange = null; currentBatch = 1;
    createVideoElements();
    return true;
  })()`);
  await waitFor(() => cdp.eval(`(() => { const v=document.querySelector('.video-wrapper.deck-active video'); return v && v.readyState >= 1 && v.duration > 900; })()`), 30_000, 'original metadata');
  await cdp.eval(`(() => {
    pongFaceSwapState.selectedFaceId = ${JSON.stringify(faceId)};
    pongFaceSwapState.enabled = true;
    updatePongFaceSwapLoading('qa-panel', 5, 'Swap on');
    return startPongFaceSwap(${JSON.stringify(faceId)});
  })()`);
  const initial = await waitFor(() => cdp.eval(`(() => {
    const w=document.querySelector('.video-wrapper.deck-active'); const v=w?.querySelector('video');
    if (!w || !v || w.dataset.pongFaceSwapBusy === 'true' || w.dataset.pongFaceSwapActive !== 'true' || v.readyState < 3) return null;
    v.muted=true; v.volume=0; return { id:w.dataset.pongFaceSwapSessionId, duration:pongFaceSwapFullDuration(w,v), label:w.querySelector('.video-duration')?.textContent, width:v.videoWidth, height:v.videoHeight };
  })()`), 20_000, 'initial swap stream');
  swapSessionId = initial.id;
  assert(initial.duration > 920 && initial.duration < 921, `full duration was ${initial.duration}`);
  assert.equal(initial.label, '15:20');
  assert.equal(initial.width, 1280);
  assert.equal(initial.height, 720);
  await delay(1_500);
  const panel = await cdp.eval(`(() => {
    const el=document.getElementById('pong-face-swap-loading');
    const before=el.getBoundingClientRect();
    const down=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:9,clientX:before.left+8,clientY:before.top+8});
    const move=new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:9,clientX:before.left+48,clientY:before.top+38});
    const up=new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:9,clientX:before.left+48,clientY:before.top+38});
    el.dispatchEvent(down); el.dispatchEvent(move); el.dispatchEvent(up);
    const after=el.getBoundingClientRect();
    return { hidden:el.hidden, ready:el.classList.contains('ready'), moved:Math.abs(after.left-before.left)>20 && Math.abs(after.top-before.top)>10 };
  })()`);
  assert.equal(panel.hidden, false, 'swap status panel disappeared while swap remained enabled');
  assert.equal(panel.ready, true, 'swap status panel did not retain ready state');
  assert.equal(panel.moved, true, 'swap status panel was not draggable');

  // Exercise the Android-style touch path, including the synthetic click that
  // WebView emits after touchend. The click must be suppressed or it seeks a
  // second time (historically back to the beginning).
  await cdp.eval(`(() => {
    const w=document.querySelector('.video-wrapper.deck-active');
    const bar=w?.querySelector('.video-progress-bar');
    if (!w || !bar) return false;
    const rect=bar.getBoundingClientRect();
    const clientX=rect.left + rect.width * (300 / pongFaceSwapFullDuration(w,w.querySelector('video')));
    const touch=new Touch({ identifier:7, target:bar, clientX, clientY:rect.top + rect.height/2, radiusX:2, radiusY:2, force:1 });
    bar.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true,touches:[touch],targetTouches:[touch],changedTouches:[touch]}));
    document.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[touch],targetTouches:[touch],changedTouches:[touch]}));
    document.dispatchEvent(new TouchEvent('touchend',{bubbles:true,cancelable:true,touches:[],targetTouches:[],changedTouches:[touch]}));
    bar.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:rect.left+1,clientY:rect.top+1}));
    return true;
  })()`);
  const forward = await waitFor(() => cdp.eval(`(() => {
    const w=document.querySelector('.video-wrapper.deck-active'); const v=w?.querySelector('video');
    if (!w || !v || w.dataset.pongFaceSwapBusy === 'true' || Number(v.__pongSwapOriginal?.startSeconds) < 299.9 || v.readyState < 3) return null;
    return { id:w.dataset.pongFaceSwapSessionId, start:Number(v.__pongSwapOriginal.startSeconds), duration:pongFaceSwapFullDuration(w,v), absolute:pongFaceSwapAbsoluteTime(w,v), label:w.querySelector('.video-duration')?.textContent };
  })()`), 20_000, 'forward swapped seek');
  assert.notEqual(forward.id, initial.id);
  assert(forward.absolute >= 300 && forward.absolute < 305);
  assert.equal(forward.label, '15:20');
  swapSessionId = forward.id;

  await cdp.eval(`(() => { const w=document.querySelector('.video-wrapper.deck-active'); return seekPongVideoTo(w,w.querySelector('video'),120); })()`);
  const backward = await waitFor(() => cdp.eval(`(() => {
    const w=document.querySelector('.video-wrapper.deck-active'); const v=w?.querySelector('video');
    if (!w || !v || w.dataset.pongFaceSwapBusy === 'true' || Math.abs(Number(v.__pongSwapOriginal?.startSeconds)-120) > .1 || v.readyState < 3) return null;
    return { id:w.dataset.pongFaceSwapSessionId, start:Number(v.__pongSwapOriginal.startSeconds), duration:pongFaceSwapFullDuration(w,v), absolute:pongFaceSwapAbsoluteTime(w,v), label:w.querySelector('.video-duration')?.textContent, muted:v.muted };
  })()`), 20_000, 'backward swapped seek');
  assert.notEqual(backward.id, forward.id);
  assert(backward.absolute >= 120 && backward.absolute < 125);
  assert.equal(backward.label, '15:20');
  assert.equal(backward.muted, true);
  swapSessionId = backward.id;

  // Fire two scrub requests while the first replacement is still preparing.
  // The old swapped frame must remain visible and the second target must win.
  const rapidFirstTarget = 420;
  const rapidLatestTarget = 510;
  const rapidStartedAt = Date.now();
  await cdp.eval(`(() => {
    clearInterval(window.__pongRapidSeekSampleTimer);
    window.__pongRapidSeekSamples = [];
    window.__pongRapidSeekResults = [];
    const sample = () => {
      const wrapper=document.querySelector('.video-wrapper.deck-active');
      const video=wrapper?.querySelector('video');
      const progress=wrapper && video ? pongFaceSwapProgressState(wrapper,video) : {currentTime:0,duration:0};
      const source=video?.currentSrc||video?.src||'';
      window.__pongRapidSeekSamples.push({
        at:Date.now(),
        sessionId:wrapper?.dataset?.pongFaceSwapSessionId||'',
        active:wrapper?.dataset?.pongFaceSwapActive||'',
        busy:wrapper?.dataset?.pongFaceSwapBusy||'',
        pending:Number(pongFaceSwapState.pendingSeekTarget?.target ?? pongFaceSwapState.pendingSeekTarget),
        generation:Number(pongFaceSwapState.seekGeneration||0),
        currentTime:Number(progress.currentTime||0),
        duration:Number(progress.duration||0),
        readyState:Number(video?.readyState||0),
        source,
        swapped:/\\/pong-swap\\/sessions\\/[^/]+\\/stream(?:[?#]|$)/.test(source),
        transitionOverlay:Boolean(wrapper?.__pongFaceSwapTransitionOverlay),
        transitionVideos:Number(wrapper?.__pongFaceSwapTransitionOverlay?.querySelectorAll?.('video')?.length||0)
      });
    };
    sample();
    window.__pongRapidSeekSampleTimer=setInterval(sample,25);
    const wrapper=document.querySelector('.video-wrapper.deck-active');
    const video=wrapper.querySelector('video');
    void seekPongVideoTo(wrapper,video,${rapidFirstTarget}).then(result => {
      window.__pongRapidSeekResults.push({target:${rapidFirstTarget},result,at:Date.now()});
    });
    setTimeout(() => {
      const latestWrapper=document.querySelector('.video-wrapper.deck-active');
      const latestVideo=latestWrapper.querySelector('video');
      void seekPongVideoTo(latestWrapper,latestVideo,${rapidLatestTarget}).then(result => {
        window.__pongRapidSeekResults.push({target:${rapidLatestTarget},result,at:Date.now()});
      });
    },40);
    return true;
  })()`);

  const preparing = await waitFor(() => cdp.eval(`(() => {
    const wrapper=document.querySelector('.video-wrapper.deck-active');
    const pending=Number(pongFaceSwapState.pendingSeekTarget?.target ?? pongFaceSwapState.pendingSeekTarget);
    if (!wrapper || Math.abs(pending-${rapidLatestTarget}) > .2) return null;
    return {
      sessionId:wrapper.dataset.pongFaceSwapSessionId||'',
      active:wrapper.dataset.pongFaceSwapActive||'',
      busy:wrapper.dataset.pongFaceSwapBusy||'',
      transitionOverlay:Boolean(wrapper.__pongFaceSwapTransitionOverlay),
      transitionVideos:Number(wrapper.__pongFaceSwapTransitionOverlay?.querySelectorAll?.('video')?.length||0),
      pending,
      seekGeneration:Number(pongFaceSwapState.seekGeneration||0)
    };
  })()`), 5_000, 'coalesced seek preparation');
  assert.equal(preparing.active, 'true', 'visible swap became inactive while its replacement was preparing');
  if (preparing.sessionId !== backward.id) {
    assert.equal(preparing.busy, 'true', 'replacement session was exposed without an in-progress swapped seek');
    assert.equal(preparing.transitionOverlay, true, 'replacement session removed the last swapped frame before presentation');
    assert.equal(preparing.transitionVideos, 0, 'seek transition exposed an original-source clone');
  }

  const oldDuringPrepareResponse = await fetch(`${BASE}/pong-swap/sessions/${backward.id}?t=${Date.now()}`);
  assert(
    oldDuringPrepareResponse.ok || oldDuringPrepareResponse.status === 404,
    `old swapped session returned unexpected status ${oldDuringPrepareResponse.status}`
  );

  const rapid = await waitFor(() => cdp.eval(`(() => {
    const wrapper=document.querySelector('.video-wrapper.deck-active'); const video=wrapper?.querySelector('video');
    const start=Number(video?.__pongSwapOriginal?.startSeconds);
    if (!wrapper || !video || wrapper.dataset.pongFaceSwapBusy === 'true' || wrapper.dataset.pongFaceSwapSessionId === ${JSON.stringify(backward.id)} || Math.abs(start-${rapidLatestTarget}) > .2 || video.readyState < 3) return null;
    return {
      id:wrapper.dataset.pongFaceSwapSessionId,
      start,
      absolute:pongFaceSwapAbsoluteTime(wrapper,video),
      muted:video.muted,
      source:video.currentSrc||video.src||''
    };
  })()`), 30_000, 'latest coalesced seek');
  swapSessionId = rapid.id;
  assert(Math.abs(rapid.start - rapidLatestTarget) <= .2, `latest seek landed at ${rapid.start}`);
  assert(rapid.absolute >= rapidLatestTarget && rapid.absolute < rapidLatestTarget + 5, `latest absolute time was ${rapid.absolute}`);
  assert.equal(rapid.muted, true);

  const oldRetired = await waitFor(async () => {
    const response = await fetch(`${BASE}/pong-swap/sessions/${backward.id}?t=${Date.now()}`);
    return response.ok ? null : response.status;
  }, 10_000, 'old seek session retirement');
  assert.equal(oldRetired, 404);

  const rapidDiagnostics = await cdp.eval(`(() => {
    clearInterval(window.__pongRapidSeekSampleTimer);
    const samples=window.__pongRapidSeekSamples.slice();
    return { samples, results:window.__pongRapidSeekResults.slice(), fetchEvents:window.__pongSwapFetchEvents.slice() };
  })()`);
  assert(rapidDiagnostics.samples.length > 1, 'rapid seek sampler did not run');
  assert(
    rapidDiagnostics.samples.some(sample => (
      sample.sessionId === backward.id ||
      (sample.transitionOverlay && sample.transitionVideos === 0)
    ) && Math.abs(sample.pending-rapidLatestTarget) <= .2),
    'no sample retained either the old swapped session or its frozen swapped transition frame'
  );
  assert(
    rapidDiagnostics.samples.every(sample => !sample.transitionOverlay || sample.transitionVideos === 0),
    `a seek transition exposed an original-source clone: ${JSON.stringify(rapidDiagnostics.samples.filter(sample => sample.transitionVideos > 0).slice(0,20))}`
  );
  assert(
    rapidDiagnostics.samples.every(sample => !sample.source || sample.swapped),
    `an unswapped source became visible during replacement: ${JSON.stringify(rapidDiagnostics.samples.filter(sample => sample.source && !sample.swapped).slice(0,20))}`
  );
  assert(
    Math.min(...rapidDiagnostics.samples.map(sample => sample.currentTime)) > 1,
    `progress reset to zero during replacement: ${JSON.stringify(rapidDiagnostics.samples.slice(0,20))}`
  );
  const rapidCreates = rapidDiagnostics.fetchEvents.filter(event => (
    event.at >= rapidStartedAt && event.phase === 'start' && event.method === 'POST' &&
    /\/pong-swap\/sessions$/.test(new URL(event.url, PONG).pathname)
  ));
  assert(rapidCreates.length > 0, `rapid seek created no prepared replacement: ${JSON.stringify(rapidDiagnostics.fetchEvents)}`);
  assert(
    Math.abs(Number(rapidCreates.at(-1)?.body?.startSeconds)-rapidLatestTarget) <= .2,
    `last prepared replacement was not the latest seek target: ${JSON.stringify(rapidCreates)}`
  );
  console.log(JSON.stringify({ ok: true, panel, initial, forward, backward, preparing, rapid, rapidCreates, samples:rapidDiagnostics.samples.length }, null, 2));
} finally {
  if (swapSessionId) await fetch(`${BASE}/pong-swap/sessions/${swapSessionId}`, { method: 'DELETE' }).catch(() => null);
  cdp?.close();
  await stopTree(chrome);
  await delay(500);
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }).catch(() => null);
}
