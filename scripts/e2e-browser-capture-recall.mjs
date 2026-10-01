import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chromePath = process.env.PONG_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pong-browser-recall-'));
const appUrl = `http://127.0.0.1:8787/pong?pongInstance=1&pongNative=1&browserRecallTest=${Date.now()}`;
const chrome = spawn(chromePath, [
  '--headless=new', '--incognito', '--mute-audio', '--autoplay-policy=user-gesture-required',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', appUrl
], { stdio: 'ignore', windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stopTree = child => new Promise(resolve => {
  if (!child?.pid) return resolve();
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  killer.once('close', resolve); killer.once('error', resolve);
});

try {
  let port = 0;
  for (let attempt = 0; attempt < 150 && !port; attempt++) {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]) || 0; } catch (_) {}
    if (!port) await delay(100);
  }
  assert.ok(port, 'Chrome DevTools did not start');
  let target;
  for (let attempt = 0; attempt < 80 && !target; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
      target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:8787/pong'));
    } catch (_) {}
    if (!target) await delay(100);
  }
  assert.ok(target?.webSocketDebuggerUrl, 'Pong page did not start');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result.value;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && typeof loadGenericRecallBundles === 'function'`)) break;
    await delay(100);
  }
  const result = await evaluate(`(async () => {
    window.pongUserWantsAudio = false;
    await loadGenericRecallBundles([{ id:'one', title:'Captured listing', pageUrl:'https://example.com/list', videos:[
      { videoUrl:'https://cdn.example.com/one.mp4', pageUrl:'https://example.com/watch/1', durationSeconds:30 },
      { videoUrl:'https://cdn.example.com/two/master.m3u8', pageUrl:'https://example.com/watch/2', durationSeconds:60 }
    ] }], 1);
    const firstVideo = document.querySelector('video');
    return { count:allVideoUrls.length, bundles:pasteEvents.length, bundleCount:pasteEvents[0]?.count,
      first:allVideoUrls[0], second:allVideoUrls[1], muted:firstVideo?.muted, version:document.querySelector('.version-number')?.textContent };
  })()`);
  assert.equal(result.count, 2);
  assert.equal(result.bundles, 1);
  assert.equal(result.bundleCount, 2);
  assert.ok([result.first, result.second].some(value => /^\/proxy\?url=/.test(value)));
  assert.ok([result.first, result.second].some(value => /^\/generic-media\/hls\?url=/.test(value)));
  assert.equal(result.muted, true);
  assert.equal(result.version, '28.98');
  console.log('Browser capture Recall end-to-end: PASS');
  socket.close();
} finally {
  await stopTree(chrome);
  await delay(150);
  await fs.rm(profile, { recursive: true, force: true });
}
