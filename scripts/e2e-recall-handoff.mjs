import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chromePath = process.env.PONG_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const debugPort = Number(process.env.PONG_CDP_PORT || 9249);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pong-recall-e2e-'));
const startUrl = `https://odiac22.github.io/pong/?pongInstance=2&audit=${Date.now()}`;
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--mute-audio', '--allow-running-insecure-content',
  '--disable-features=BlockInsecurePrivateNetworkRequests',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, startUrl
], { stdio: 'ignore', windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function targets() {
  return fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json());
}

async function connect(target) {
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
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({
      id: requestId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true }
    }));
  }).then(result => result.result.value);
  return { socket, evaluate };
}

try {
  let page;
  for (let attempt = 0; attempt < 80; attempt++) {
    page = (await targets().catch(() => [])).find(item => item.type === 'page' && item.url.includes('/pong'));
    if (page?.webSocketDebuggerUrl) break;
    await delay(100);
  }
  assert(page?.webSocketDebuggerUrl, 'Pong page did not open');
  const source = await connect(page);
  await source.evaluate(`localStorage.setItem('pong_random40_local_endpoint_v1','http://127.0.0.1:8787'); location.reload(); true`);
  source.socket.close();
  await delay(2500);

  page = (await targets()).find(item => item.type === 'page' && item.url.startsWith('https://odiac22.github.io/pong/'));
  assert(page, 'Reloaded GitHub Pong page was not found');
  const reloaded = await connect(page);
  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await reloaded.evaluate(`Boolean(document.getElementById('simpcity-recall-2') && typeof startSimpCityRecall === 'function')`).catch(() => false);
    if (ready) break;
    await delay(100);
  }
  void reloaded.evaluate(`window.alert = message => { window.__pongLastAlert = String(message) }; document.getElementById('simpcity-recall-2').click(); true`).catch(() => true);

  let landed;
  for (let attempt = 0; attempt < 80; attempt++) {
    landed = (await targets().catch(() => [])).find(item => {
      try {
        const url = new URL(item.url);
        return item.type === 'page' && url.port === '8787' && url.pathname.startsWith('/pong');
      } catch (_) { return false; }
    });
    if (landed) break;
    await delay(150);
  }
  const finalTargets = await targets().catch(() => []);
  reloaded.socket.close();
  assert(landed, `Recall did not hand off to the reachable PC server: ${finalTargets.map(item => item.url).join(', ')}`);
  const landedUrl = new URL(landed.url);
  assert.equal(landedUrl.hostname, '192.168.1.124');
  assert.equal(landedUrl.searchParams.get('pongAutoStart'), 'scRecall');
  assert.equal(landedUrl.searchParams.get('pongRecallChannel'), '2');
  assert.equal(landedUrl.searchParams.get('pongInstance'), '2');
  console.log(JSON.stringify({ ok: true, staleEndpoint: '127.0.0.1', landed: landedUrl.href }));
} finally {
  chrome.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
