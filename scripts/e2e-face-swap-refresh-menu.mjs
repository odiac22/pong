import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.PONG_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PONG = process.env.PONG_TEST_URL || 'http://127.0.0.1:8787/pong';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) {}
    await delay(100);
  }
  throw new Error(`${label} timed out`);
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  profile = await mkdtemp(path.join(os.tmpdir(), 'pong-swap-menu-'));
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
  await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!document.getElementById('pong-face-swap-button')`), 20_000, 'swap button');

  const openAndRead = async () => {
    await cdp.eval(`document.getElementById('pong-face-swap-button').click()`);
    return waitFor(() => cdp.eval(`(() => {
      const menu=document.getElementById('pong-face-swap-menu');
      const choices=menu?.querySelectorAll('.pong-face-swap-menu-choice').length || 0;
      return menu?.classList.contains('open') && choices >= 19
        ? { choices, text:menu.textContent, cached:sessionStorage.getItem('pong_face_swap_faces_cache_v2') !== null }
        : null;
    })()`), 15_000, 'face menu');
  };

  const first = await openAndRead();
  assert(!/unavailable|aborted/i.test(first.text), first.text);
  assert.equal(first.cached, true);
  await cdp.send('Page.reload', { ignoreCache: true });
  // Page.reload acknowledges before the old document has necessarily been
  // replaced, so do not let the old button satisfy the post-refresh wait.
  await delay(300);
  await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!document.getElementById('pong-face-swap-button')`), 20_000, 'swap button after refresh');
  const refreshed = await openAndRead();
  assert(!/unavailable|aborted/i.test(refreshed.text), refreshed.text);
  assert.equal(refreshed.choices, first.choices);
  console.log(JSON.stringify({ ok: true, first, refreshed }, null, 2));
} finally {
  cdp?.close();
  await stopTree(chrome);
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => null);
}
