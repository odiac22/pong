import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'Pong Swap', 'benchmarks', 'realtime-stock-corpus', 'input');
const CHROME = process.env.PONG_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PONG = process.env.PONG_TEST_URL || 'http://127.0.0.1:8787/pong';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(callback, timeout, label) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
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
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
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

  close() {
    try { this.socket?.close(); } catch {}
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

async function startSilentMediaServer() {
  const server = http.createServer(async (request, response) => {
    const match = /^\/clip-(\d+)\.mp4$/.exec(new URL(request.url, 'http://localhost').pathname);
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const ordinal = String(Number(match[1])).padStart(2, '0');
    const filename = path.join(CORPUS, `clip-${ordinal}.mp4`);
    try {
      const info = await stat(filename);
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': 'video/mp4',
      };
      const range = /^bytes=(\d*)-(\d*)$/i.exec(String(request.headers.range || ''));
      if (range) {
        const start = range[1] ? Math.min(info.size - 1, Number(range[1])) : 0;
        const end = range[2] ? Math.min(info.size - 1, Number(range[2])) : info.size - 1;
        Object.assign(headers, {
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Content-Length': String(end - start + 1),
        });
        response.writeHead(206, headers);
        createReadStream(filename, { start, end }).pipe(response);
        return;
      }
      headers['Content-Length'] = String(info.size);
      response.writeHead(200, headers);
      createReadStream(filename).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

const server = await startSilentMediaServer();
const address = server.address();
const mediaBase = `http://127.0.0.1:${address.port}`;
let chrome;
let profile;
let cdp;

try {
  profile = await mkdtemp(path.join(os.tmpdir(), 'pong-paperclip-integrity-'));
  chrome = spawn(CHROME, [
    '--headless=new',
    '--incognito',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=MediaRouter,Translate',
    PONG,
  ], { stdio: 'ignore', windowsHide: true });

  const port = await waitFor(async () => {
    const raw = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(raw.split(/\r?\n/)[0]) || 0;
  }, 15_000, 'Chrome DevTools');
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
    return targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 10_000, 'Pong page');

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await waitFor(
    () => cdp.eval(`document.readyState === 'complete' && typeof displayPasteEventAtIndex === 'function' && typeof getPaperclipProgressCount === 'function'`),
    20_000,
    'Pong Paperclip runtime',
  );

  const seeded = await cdp.eval(`(() => {
    const base = ${JSON.stringify(mediaBase)};
    const urls = Array.from({length: 12}, (_, index) => base + '/clip-' + (index + 1) + '.mp4');
    const counts = [2, 3, 2, 3];
    let startIndex = 0;
    const events = counts.map((count, index) => {
      const key = 'stock-bundle-' + (index + 1);
      const event = {
        source: 'benchmark', artistName: key, artistKey: key, bundleKey: key,
        startIndex, count, loadAll: true
      };
      startIndex += count;
      return event;
    });
    invalidatePongDatasetOwnership('paperclip-integrity-test');
    resetPasteEvents();
    allVideoUrls = urls;
    allVideoMetadata = urls.map((url, index) => ({
      source: 'benchmark', artistName: events.find(event => index >= event.startIndex && index < event.startIndex + event.count)?.artistName || '',
      originalUrl: url, playbackUrl: url
    }));
    pasteEvents = events;
    resetPaperclipQueue();
    window.autoplayEnabled = false;
    window.PongLoadAllVideosOnce = false;
    document.getElementById('pong-overlay')?.style.setProperty('display', 'none');
    return displayPasteEventAtIndex(0);
  })()`);
  assert.equal(seeded, true, 'first Paperclip bundle could not be displayed');

  async function visibleState() {
    return cdp.eval(`(() => {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      const counter = document.getElementById('paste-nav-button')?.getAttribute('data-count') || '';
      return {
        currentPasteIndex,
        counter,
        history: paperclipHistory.slice(),
        historyPosition: paperclipHistoryPosition,
        paperclipStepCount,
        activeStart: Number(activePlaybackRange?.start ?? -1),
        activeEnd: Number(activePlaybackRange?.end ?? -1),
        wrapperIndex: Number(wrapper?.dataset?.index ?? -1),
        readyState: Number(video?.readyState || 0),
        width: Number(video?.videoWidth || 0),
        duration: Number(video?.duration || 0),
        currentTime: Number(video?.currentTime || 0),
        source: String(video?.currentSrc || video?.src || ''),
        paused: Boolean(video?.paused),
        muted: Boolean(video?.muted),
      };
    })()`);
  }

  async function waitForVisibleFrame(expectedCounter, excludedIndexes = []) {
    try {
      await waitFor(async () => {
        const state = await visibleState();
        return !excludedIndexes.includes(state.currentPasteIndex) && state.counter === expectedCounter &&
          state.readyState >= 2 && state.width > 0 && state.duration >= 5 && state.source;
      }, 15_000, `Paperclip ${expectedCounter} first frame`);
    } catch (error) {
      console.error(JSON.stringify({
        label: expectedCounter,
        state: await visibleState(),
        events: await cdp.eval(`pasteEvents.map((event, index) => ({index,key:getPasteEventPaperclipKey(event,index),start:event.startIndex,count:event.count,retired:isPasteEventRetiredForPaperclip(event,index),visited:isPasteEventPreviouslyVisitedForPaperclip(event,index)}))`),
        loadedUrls: await cdp.eval(`videoUrls.slice()`),
        wrappers: await cdp.eval(`[...document.querySelectorAll('.video-wrapper')].map(wrapper => { const video=wrapper.querySelector('video'); return {index:wrapper.dataset.index,active:wrapper.classList.contains('deck-active'),src:video?.currentSrc||video?.src||'',readyState:video?.readyState||0,error:video?.error?.message||''}; })`),
      }, null, 2));
      throw error;
    }
    await cdp.eval(`(async () => {
      const wrapper = document.querySelector('.video-wrapper.deck-active');
      const video = wrapper?.querySelector('video');
      if (!video) return false;
      video.muted = true; video.defaultMuted = true; video.volume = 0;
      wrapper.dataset.playIntent = 'true';
      await video.play();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('presented frame timeout')), 6000);
        const done = () => { clearTimeout(timer); resolve(); };
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(done);
        else setTimeout(done, 200);
      });
      return true;
    })()`);
    await waitFor(async () => (await visibleState()).currentTime > 0.05, 5_000, `Paperclip ${expectedCounter} progression`);
    const state = await visibleState();
    assert.equal(state.muted, true, 'test playback must remain silent');
    return state;
  }

  const states = [];
  states.push(await waitForVisibleFrame('1/4'));
  await cdp.eval(`PongNavigateToNextPasteEvent()`);
  states.push(await waitForVisibleFrame('2/4', states.map(state => state.currentPasteIndex)));

  const lateAppend = await cdp.eval(`(() => {
    pasteEvents.push({
      source:'benchmark', artistName:'stock-bundle-5', artistKey:'stock-bundle-5',
      bundleKey:'stock-bundle-5', startIndex:10, count:2, loadAll:true
    });
    updatePasteNavigationButton();
    return {
      counter: document.getElementById('paste-nav-button')?.getAttribute('data-count') || '',
      step: paperclipStepCount,
      total: getPaperclipTotalBundleCount()
    };
  })()`);
  assert.deepEqual(lateAppend, { counter: '2/5', step: 2, total: 5 }, 'late arrivals must grow only the denominator');

  for (let index = 2; index < 5; index++) {
    await cdp.eval(`PongNavigateToNextPasteEvent()`);
    states.push(await waitForVisibleFrame(
      `${index + 1}/5`,
      states.map(state => state.currentPasteIndex),
    ));
  }

  assert.equal(new Set(states.map(state => state.currentPasteIndex)).size, 5, 'Paperclip must visit every bundle exactly once');
  assert.deepEqual(states.map(state => state.counter), ['1/4', '2/4', '3/5', '4/5', '5/5']);
  assert.equal(new Set(states.map(state => state.source)).size, 5, 'each bundle must present a distinct first source');
  assert.ok(states.every(state => state.width > 0 && state.currentTime > 0), 'every bundle must present and advance real video pixels');

  // Forward after Previous must replay history instead of truncating it and
  // letting the visited filter silently skip a formerly visible bundle.
  await cdp.eval(`PongNavigateToPreviousPasteEvent(); PongNavigateToPreviousPasteEvent()`);
  const rewound = await waitForVisibleFrame('3/5');
  assert.equal(rewound.currentPasteIndex, states[2].currentPasteIndex, 'Previous must rewind two history entries');
  const historyBeforeReplay = await cdp.eval(`paperclipHistory.slice()`);
  await cdp.eval(`PongNavigateToNextPasteEvent()`);
  const replayedOne = await waitForVisibleFrame('4/5');
  assert.equal(replayedOne.currentPasteIndex, states[3].currentPasteIndex, 'Next must replay forward history');
  await cdp.eval(`PongNavigateToNextPasteEvent()`);
  const replayedTwo = await waitForVisibleFrame('5/5');
  assert.equal(replayedTwo.currentPasteIndex, states[4].currentPasteIndex, 'Next must reach the history tail');
  assert.deepEqual(await cdp.eval(`paperclipHistory.slice()`), historyBeforeReplay, 'history replay must not truncate or duplicate entries');

  // Removing a bundle before the current history cursor must preserve the
  // visible history identity, decrement the explicit viewed count, and keep
  // late denominator growth from making the numerator jump forward again.
  await cdp.eval(`PongNavigateToPreviousPasteEvent(); PongNavigateToPreviousPasteEvent(); PongNavigateToPreviousPasteEvent()`);
  const beforeRemoval = await waitForVisibleFrame('2/5');
  const removal = await cdp.eval(`(() => {
    normalizePaperclipHistoryToStableKeys();
    const removedKey = String(paperclipHistory[0] || '');
    const eventIndex = pasteEvents.findIndex((event, index) => getPasteEventPaperclipKey(event, index) === removedKey);
    const bounds = getPasteEventVideoBounds(pasteEvents[eventIndex]);
    for (let globalIndex = bounds.end - 1; globalIndex >= bounds.start; globalIndex--) {
      removePongVideoRecord(globalIndex);
    }
    updatePasteNavigationButton();
    return {
      removedKey,
      currentKey: String(paperclipHistory[paperclipHistoryPosition] || ''),
      currentPasteIndex,
      counter: document.getElementById('paste-nav-button')?.getAttribute('data-count') || '',
      step: paperclipStepCount,
      total: getPaperclipTotalBundleCount(),
      history: paperclipHistory.slice(),
      historyPosition: paperclipHistoryPosition,
    };
  })()`);
  assert.equal(removal.currentPasteIndex, beforeRemoval.currentPasteIndex - 1, 'event indexes must shift with the removed earlier bundle');
  assert.equal(removal.currentKey, historyBeforeReplay[1], 'history cursor must remain on the same visible bundle');
  assert.equal(removal.counter, '1/4');
  assert.equal(removal.step, 4, 'tail progress must decrement exactly once for a removed visited bundle');
  assert.equal(removal.total, 4);

  await cdp.eval(`PongNavigateToNextPasteEvent()`);
  const afterRemovalNext = await waitForVisibleFrame('2/4');
  assert.equal(
    String((await cdp.eval(`paperclipHistory[paperclipHistoryPosition]`)) || ''),
    historyBeforeReplay[2],
    'Next after removal must advance to the original next history identity',
  );

  const postRemovalAppend = await cdp.eval(`(() => {
    const base = ${JSON.stringify(mediaBase)};
    const startIndex = allVideoUrls.length;
    const added = [base + '/clip-13.mp4', base + '/clip-14.mp4'];
    allVideoUrls.push(...added);
    allVideoMetadata.push(...added.map(url => ({
      source:'benchmark', artistName:'stock-bundle-6', originalUrl:url, playbackUrl:url
    })));
    pasteEvents.push({
      source:'benchmark', artistName:'stock-bundle-6', artistKey:'stock-bundle-6',
      bundleKey:'stock-bundle-6', startIndex, count:added.length, loadAll:true
    });
    updatePasteNavigationButton();
    return {
      counter: document.getElementById('paste-nav-button')?.getAttribute('data-count') || '',
      step: paperclipStepCount,
      total: getPaperclipTotalBundleCount()
    };
  })()`);
  assert.deepEqual(
    postRemovalAppend,
    { counter: '2/5', step: 4, total: 5 },
    'a late bundle after history removal must grow only the denominator',
  );

  console.log(JSON.stringify({
    ok: true,
    bundles: states.length,
    counters: states.map(state => state.counter),
    firstSources: states.map(state => state.source),
    minimumDuration: Math.min(...states.map(state => state.duration)),
    historyRemoval: { removal, afterRemovalNext, postRemovalAppend },
  }, null, 2));
} finally {
  cdp?.close();
  await stopTree(chrome);
  await new Promise(resolve => server.close(resolve));
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => null);
}
