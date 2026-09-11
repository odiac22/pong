import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const endpoint = process.env.PONG_OBSERVER_TEST_ENDPOINT;
const token = process.env.PONG_OBSERVER_TEST_TOKEN;
const instance = process.env.PONG_OBSERVER_TEST_INSTANCE === '2' ? '2' : '1';
assert(endpoint && token, 'Observer test endpoint and token are required');

const chromePath = process.env.PONG_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const debugPort = Number(process.env.PONG_CDP_PORT || 9241);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pong-observer-e2e-'));
const encoded = Buffer.from(JSON.stringify({ endpoint, token })).toString('base64url');
const testUrl = `http://127.0.0.1:8787/pong?pongInstance=${instance}#pongObserve=${encoded}`;
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--mute-audio',
  '--autoplay-policy=user-gesture-required', `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`, testUrl
], { stdio: 'ignore', windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  let target;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json());
      target = targets.find(item => item.type === 'page' && item.url.includes('/pong'));
      if (target?.webSocketDebuggerUrl) break;
    } catch (_) {}
    await delay(100);
  }
  assert(target?.webSocketDebuggerUrl, 'Headless Pong page did not start');
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
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  }).then(result => {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result.value;
  });

  let state;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      state = await evaluate(`(() => ({ ready: document.readyState, observer: document.documentElement.dataset.pongObserver || '', observerError: document.documentElement.dataset.pongObserverError || '', title: document.title, label: document.getElementById('pong-instance-label')?.textContent || '', version: document.querySelector('.version-number')?.textContent || '', hash: location.hash }))()`);
    } catch (_) {
      await delay(250);
      continue;
    }
    if (state?.observer === 'connected') break;
    await delay(250);
  }
  assert(state, 'Pong browser state was unavailable');
  assert.equal(state.observer, 'connected', state.observerError || 'observer did not connect');
  assert.equal(state.title, `Pong ${instance}`);
  assert.equal(state.label, `Pong ${instance}`);
  assert.equal(state.version, '26.91');
  assert.equal(state.hash, '', 'Pairing token must be removed from the visible URL');

  const handoffUrl = await evaluate(`PongLiveObserver.decorateUrl('http://127.0.0.1:8787/pong?pongInstance=${instance}&pongObserverHandoffTest=1')`);
  assert.match(handoffUrl, /#pongObserve=/, 'LAN handoff must carry observer pairing in the URL fragment');
  await evaluate(`location.assign(${JSON.stringify(handoffUrl)})`);
  await delay(500);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      state = await evaluate(`(() => ({ observer: document.documentElement.dataset.pongObserver || '', observerError: document.documentElement.dataset.pongObserverError || '', hash: location.hash, handoff: new URLSearchParams(location.search).get('pongObserverHandoffTest') }))()`);
      if (state?.observer === 'connected' && state?.handoff === '1') break;
    } catch (_) {}
    await delay(250);
  }
  assert.equal(state?.observer, 'connected', state?.observerError || 'observer did not reconnect after LAN handoff');
  assert.equal(state?.hash, '', 'LAN observer pairing token must be removed after handoff');

  const telemetry = await evaluate(`(() => {
    document.querySelectorAll('.video-wrapper').forEach(node => node.remove());
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper deck-active';
    wrapper.dataset.index = '0';
    wrapper.dataset.originalVideoUrl = 'https://media.example/test.mp4';
    const video = document.createElement('video');
    Object.defineProperties(video, {
      paused: { configurable: true, value: false },
      ended: { configurable: true, value: false },
      duration: { configurable: true, value: 42 },
      currentTime: { configurable: true, value: 3 },
      readyState: { configurable: true, value: 4 },
      networkState: { configurable: true, value: 1 }
    });
    wrapper.appendChild(video);
    document.body.appendChild(wrapper);
    const tiktok = document.getElementById('simpcity-tiktok-button');
    tiktok.style.display = 'block';
    tiktok.classList.add('active');
    tiktok.textContent = 'TikTok';
    window.PongObserverStateBridge = () => ({
      allVideoUrls: ['https://media.example/test.mp4'],
      allVideoMetadata: [{ artistDisplayName: 'Observer Test Artist', artistKey: 'observer-test', source: 'erome' }],
      videoUrls: ['https://media.example/test.mp4'], videoMetadata: [],
      pasteEvents: [{ startIndex: 0, count: 17, source: 'erome' }],
      currentPasteIndex: 0, currentVideoIndex: 0, currentLoadedRangeStart: 0, currentLoadedRangeEnd: 17,
      pendingPastes: [], random40PostFetchQueue: [], random40PostFetchActive: 0,
      random40SourceFetchQueue: [], random40SourceFetchActive: 0, random40PreloadActive: 0,
      random40State: null, activeSimpCityRecallContext: null, activeRecallChannel: 1, loadedSavedMode: ''
    });
    const snapshot = PongLiveObserver.snapshot();
    void PongLiveObserver.send();
    return snapshot;
  })()`);
  assert.equal(telemetry.playback.artist, 'Observer Test Artist');
  assert.equal(telemetry.playback.artistVideoCount, 17);
  assert.equal(telemetry.playback.playing, true);
  assert.equal(telemetry.playback.paused, false);
  assert.equal(telemetry.workflow.mode, 'recall1');
  assert.equal(telemetry.ui.tiktokButton.visible, true);
  assert.equal(telemetry.ui.tiktokButton.active, true);
  await delay(500);
  socket.close();
  console.log(JSON.stringify({ ok: true, instance: `pong${instance}`, version: '26.91', observer: state.observer, handoff: true, telemetry: { artist: telemetry.playback.artist, videos: telemetry.playback.artistVideoCount, playing: telemetry.playback.playing, tiktok: telemetry.ui.tiktokButton.visible } }));
} finally {
  chrome.kill();
  await delay(250);
  await fs.rm(profile, { recursive: true, force: true });
}
