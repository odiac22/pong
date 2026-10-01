import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.PONG_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PONG = process.env.PONG_TEST_URL || 'http://127.0.0.1:8787/pong';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await delay(100);
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
try {
  profile = await mkdtemp(path.join(os.tmpdir(), 'pong-paperclip-resolver-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--incognito', '--mute-audio', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-features=MediaRouter,Translate', PONG,
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
    () => cdp.eval(`document.readyState === 'complete' && typeof resolveNextPaperclipEventIndex === 'function' && typeof navigateToNextPasteEvent === 'function'`),
    20_000,
    'shared Paperclip resolver',
  );

  const results = await cdp.eval(`(() => {
    const event = (key, startIndex, count = 1, extra = {}) => ({
      source: 'benchmark', artistName: key, artistKey: key, bundleKey: key,
      startIndex, count, loadAll: true, ...extra
    });
    const run = ({ name, events, urls, current = 0, history = [], historyPosition = -1, visited = [], retired = [], mode = '', simpCityActive = false, expected }) => {
      pasteEvents = events;
      allVideoUrls = urls;
      allVideoMetadata = urls.map(() => ({}));
      videoUrls = urls.slice(events[current].startIndex, events[current].startIndex + events[current].count);
      videoMetadata = videoUrls.map(() => ({}));
      currentPasteIndex = current;
      paperclipHistory = [...history];
      paperclipHistoryPosition = historyPosition;
      paperclipVisitedArtistTokens = new Set();
      paperclipRetiredBundleKeys = new Set();
      visited.forEach(index => markPasteEventVisitedForPaperclip(events[index], index));
      retired.forEach(index => paperclipRetiredBundleKeys.add(getPasteEventPaperclipKey(events[index], index)));
      window.PongLoadedSavedMode = mode;
      document.documentElement.dataset.pongSimpCityActive = simpCityActive ? 'true' : 'false';
      activePlaybackRange = { start:events[current].startIndex, end:events[current].startIndex + events[current].count, offset:0, currentOffset:0, loadAll:true };

      const predicted = resolveNextPaperclipEventIndex();
      let navigated = -1;
      const originalSync = syncCurrentPasteIndexFromVisibleVideo;
      const originalRetire = retireCurrentPasteEventForPaperclip;
      const originalDisplay = displayPasteEventAtIndex;
      syncCurrentPasteIndexFromVisibleVideo = () => currentPasteIndex;
      retireCurrentPasteEventForPaperclip = () => true;
      displayPasteEventAtIndex = index => { navigated = index; };
      try {
        navigateToNextPasteEvent();
      } finally {
        syncCurrentPasteIndexFromVisibleVideo = originalSync;
        retireCurrentPasteEventForPaperclip = originalRetire;
        displayPasteEventAtIndex = originalDisplay;
      }
      return { name, expected, predicted, navigated };
    };

    return [
      run({
        name:'loaded-first', expected:2,
        events:[event('current',0), event('one-loaded',1), event('two-loaded',2,2)],
        urls:['u0','u1','u2','u3']
      }),
      run({
        name:'erome-next', expected:1,
        events:[event('erome-a',0,1,{source:'erome'}), event('erome-b',1,1,{source:'erome'}), event('erome-c',2,1,{source:'erome'})],
        urls:['u0','u1','u2'], mode:'erome'
      }),
      run({
        name:'simpcity-pair-return', expected:0, current:1,
        events:[
          event('profile',0,1,{source:'simpcity',simpCityPairId:'pair-1',simpCityMediaKind:'bunkr'}),
          event('profile-tiktok',1,1,{source:'simpcity',simpCityPairId:'pair-1',simpCityMediaKind:'tiktok',paperclipHidden:true})
        ],
        urls:['u0','u1']
      }),
      run({
        name:'history-forward', expected:2, history:[0,2], historyPosition:0,
        events:[event('current',0), event('unused',1), event('history-target',2)],
        urls:['u0','u1','u2']
      }),
      run({
        name:'visited-and-retired', expected:3, visited:[1], retired:[2],
        events:[event('current',0), event('visited',1), event('retired',2), event('available',3)],
        urls:['u0','u1','u2','u3']
      })
    ];
  })()`);

  for (const result of results) {
    assert.equal(result.predicted, result.expected, `${result.name}: resolver chose the wrong event`);
    assert.equal(result.navigated, result.predicted, `${result.name}: navigation disagreed with prefetch prediction`);
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  cdp?.close();
  await stopTree(chrome);
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => null);
}
