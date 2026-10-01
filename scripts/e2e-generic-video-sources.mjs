import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chromePath = process.env.PONG_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const targetPage = 'https://allpornstream.com/post/a417bf80-1a19-4623-9724-f24b9a06ed39/mom-drips-wendy-raine-detention-or-sex-education-milf-teacher-cr-2026-08-14';
const appUrl = `http://127.0.0.1:8787/pong?pongInstance=1&pongNative=1&sourceSelectorTest=${Date.now()}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pong-source-selector-e2e-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  '--incognito',
  '--mute-audio',
  '--autoplay-policy=user-gesture-required',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  appUrl
], { stdio: 'ignore', windowsHide: true });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getPageTarget(debugPort) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json());
      const page = targets.find(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:8787/pong'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await delay(100);
  }
  throw new Error('Pong source-selector test page did not start');
}

async function stopTree(child) {
  if (!child?.pid) return;
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true
    });
    killer.once('close', resolve);
    killer.once('error', resolve);
  });
}

try {
  let debugPort = 0;
  for (let attempt = 0; attempt < 150 && !debugPort; attempt++) {
    try {
      const raw = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
      debugPort = Number(raw.split(/\r?\n/)[0]) || 0;
    } catch (_) {}
    if (!debugPort) await delay(100);
  }
  if (!debugPort) throw new Error('Chrome DevTools did not start');
  const page = await getPageTarget(debugPort);
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed');
    }
    return result.result.value;
  };

  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && typeof resolvePastedMediaPages === 'function'`)) break;
    await delay(100);
  }

  const result = await evaluate(`(async () => {
    window.pongUserWantsAudio = false;
    const resolved = await resolvePastedMediaPages(${JSON.stringify(targetPage)});
    allVideoUrls = resolved.urls.slice();
    allVideoMetadata = resolved.metadata.map(item => ({ ...item }));
    pasteEvents = resolved.pasteEvents.map(item => ({ ...item }));
    currentPasteIndex = -1;
    activePlaybackRange = null;
    currentBatch = 0;
    setEromeTwentyCardMode(true, { respectRange: true });
    setActivePlaybackRangeForPasteEvent(0, { recordHistory: false });
    loadNextBatch(0);
    createVideoElements();
    setDeckActiveIndex(0, 'none', { pushHistory: false });
    updatePasteNavigationButton();
    const button = document.getElementById('pong-video-source-button');
    button?.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const labels = [...document.querySelectorAll('.pong-video-source-option')].map(node => node.textContent.trim());
    await selectPongVideoSource(1);
    await new Promise(resolve => setTimeout(resolve, 800));
    const wrapper = getCurrentVideoWrapper();
    const video = wrapper?.querySelector('video');
    return {
      urlCount: allVideoUrls.length,
      paperclipCount: pasteEvents.length,
      paperclipVideoCount: pasteEvents[0]?.count,
      sourceCount: allVideoMetadata[0]?.videoSources?.length,
      labels,
      selectedSourceIndex: allVideoMetadata[0]?.selectedSourceIndex,
      buttonVisible: getComputedStyle(button).display,
      muted: video?.muted,
      declaredDuration: allVideoMetadata[0]?.duration
    };
  })()`);

  assert.equal(result.urlCount, 1);
  assert.equal(result.paperclipCount, 1);
  assert.equal(result.paperclipVideoCount, 1);
  assert.equal(result.sourceCount, 2);
  assert.deepEqual(result.labels, ['Streamtape 1', 'Streamtape 2']);
  assert.equal(result.selectedSourceIndex, 1);
  assert.equal(result.buttonVisible, 'flex');
  assert.equal(result.muted, true);
  assert.equal(result.declaredDuration, 2281);
  console.log('Pong generic source selector end-to-end: PASS');
  socket.close();
} finally {
  await stopTree(chrome);
  await delay(200);
  await fs.rm(profile, { recursive: true, force: true });
}
