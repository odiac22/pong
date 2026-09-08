import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const chromePath = process.env.PONG_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const debugPort = Number(process.env.PONG_CDP_PORT || 9239);
const root = fileURLToPath(new URL('../', import.meta.url));
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await fs.readFile(target);
    response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(body);
  } catch (_) {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const testUrl = process.env.PONG_TEST_URL || `http://127.0.0.1:${server.address().port}/?pongPlaybackFresh=1`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pong-skip-e2e-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--mute-audio',
  '--autoplay-policy=user-gesture-required',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  testUrl
], { stdio: 'ignore', windowsHide: true });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getPageTarget() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json());
      const page = targets.find(target => target.type === 'page' && target.url.startsWith(testUrl.split('?')[0]));
      if (page?.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await delay(100);
  }
  throw new Error('Chrome test page did not start');
}

try {
  const page = await getPageTarget();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result.value;
  };

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && !!document.getElementById('skip-current-video-button')`)) break;
    await delay(100);
  }

  const before = await evaluate(`(() => {
    sessionSkippedVideoKeys = new Set();
    allVideoUrls = ['https://cdn.example.test/a.mp4', 'https://cdn.example.test/b.mp4', 'https://cdn.example.test/c.mp4'];
    allVideoMetadata = allVideoUrls.map((url, index) => ({ mediaKey: 'fixture-' + index, videoUrl: url, artistName: 'Fixture' }));
    pasteEvents = [{ startIndex: 0, count: 3, artistName: 'Fixture' }];
    currentPasteIndex = -1;
    activePlaybackRange = null;
    currentBatch = 0;
    setEromeTwentyCardMode(true, { respectRange: true });
    setActivePlaybackRangeForPasteEvent(0, { recordHistory: false });
    loadNextBatch(0);
    createVideoElements();
    setDeckActiveIndex(0, 'none', { pushHistory: false });
    return {
      button: document.getElementById('skip-current-video-button')?.textContent.replace(/\s+/g, ' ').trim(),
      current: allVideoUrls[0],
      count: allVideoUrls.length
    };
  })()`);
  assert.match(before.button, /Skip[\s\S]*Video/);
  assert.equal(before.count, 3);

  const after = await evaluate(`(async () => {
    document.getElementById('skip-current-video-button').click();
    await new Promise(resolve => setTimeout(resolve, 380));
    saveSession();
    return {
      urls: allVideoUrls.slice(),
      count: pasteEvents[0]?.count,
      active: allVideoUrls[getCurrentLoadedGlobalVideoIndex()],
      skipped: window.PongIsCurrentVideoSessionSkipped(),
      persisted: JSON.parse(localStorage.getItem('pong_session_v1') || '{}').sessionSkippedVideoKeys || []
    };
  })()`);
  assert.deepEqual(after.urls, ['https://cdn.example.test/b.mp4', 'https://cdn.example.test/c.mp4']);
  assert.equal(after.count, 2);
  assert.equal(after.active, 'https://cdn.example.test/b.mp4');
  assert.equal(after.skipped, false);
  assert.ok(after.persisted.includes('fixture-0'));

  const noRequeue = await evaluate(`(() => {
    allVideoUrls.push('https://cdn.example.test/a.mp4');
    allVideoMetadata.push({ mediaKey: 'fixture-0', videoUrl: 'https://cdn.example.test/a.mp4' });
    pasteEvents.push({ startIndex: 2, count: 1, artistName: 'Duplicate' });
    loadNextBatch(0);
    return { urls: allVideoUrls.slice(), events: pasteEvents.map(event => event.count) };
  })()`);
  assert.deepEqual(noRequeue.urls, ['https://cdn.example.test/b.mp4', 'https://cdn.example.test/c.mp4']);
  assert.deepEqual(noRequeue.events, [2]);
  console.log('Pong video skip end-to-end: PASS');
  socket.close();
} finally {
  chrome.kill();
  await delay(150);
  await fs.rm(profile, { recursive: true, force: true });
  await new Promise(resolve => server.close(resolve));
}
