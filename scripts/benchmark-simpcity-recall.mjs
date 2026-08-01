import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9347;
const profile = await mkdtemp(path.join(os.tmpdir(), 'pong-sc-recall-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--mute-audio', '--autoplay-policy=user-gesture-required',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--disable-gpu', '--no-first-run', 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let target;
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
      target = targets.find(item => item.type === 'page' && !String(item.url).startsWith('chrome-extension://'));
    } catch {}
    if (target?.webSocketDebuggerUrl) break;
    await sleep(100);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('Headless Chrome did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8787/pong?simpcityBenchmark=1' });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const ready = await send('Runtime.evaluate', {
      expression: `typeof startSimpCityRecall === 'function' && typeof allVideoUrls !== 'undefined'`,
      returnByValue: true
    });
    if (ready.result?.value === true) break;
    if (i === 99) {
      const debug = await send('Runtime.evaluate', {
        expression: `JSON.stringify({url:location.href,title:document.title,ready:document.readyState,text:document.body?.innerText?.slice(0,300)})`,
        returnByValue: true
      });
      throw new Error(`Pong scripts did not initialize: ${debug.result?.value || ''}`);
    }
  }
  await send('Runtime.evaluate', {
    expression: `document.getElementById('pong-hotspot')?.click(); globalThis.__scResult='running'; startSimpCityRecall(1).then(()=>globalThis.__scResult='done').catch(error=>globalThis.__scResult=String(error?.stack||error));`,
    awaitPromise: false
  });
  const started = Date.now();
  let state;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const result = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        elapsedMs: ${Date.now()} - ${started},
        allVideoUrls: allVideoUrls.length,
        videoUrls: videoUrls.length,
        pasteEvents: pasteEvents.length,
        wrappers: document.querySelectorAll('.video-wrapper').length,
        message: document.querySelector('.loading-message')?.textContent || '',
        progress: document.querySelector('#erome-progress-detail')?.textContent || ''
        ,result: globalThis.__scResult
        ,buttonDisabled: document.getElementById('simpcity-recall-1')?.disabled
        ,indicator: document.getElementById('sorting-indicator')?.textContent || ''
      })`,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'State evaluation failed');
    state = JSON.parse(result.result?.value || '{}');
    if (state.allVideoUrls > 0 && state.wrappers > 0) break;
  }
  console.log(JSON.stringify(state, null, 2));
  if (!state?.allVideoUrls || !state?.wrappers) process.exitCode = 1;
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await sleep(250);
  await rm(profile, { recursive: true, force: true });
}
