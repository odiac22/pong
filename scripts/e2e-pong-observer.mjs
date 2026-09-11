import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const endpoint = process.env.PONG_OBSERVER_TEST_ENDPOINT;
const token = process.env.PONG_OBSERVER_TEST_TOKEN;
const adminToken = process.env.PONG_OBSERVER_ADMIN_TOKEN;
const instance = process.env.PONG_OBSERVER_TEST_INSTANCE === '2' ? '2' : '1';
assert(endpoint && token && adminToken, 'Observer test endpoint, ingest token, and admin token are required');
assert(new URL(endpoint).pathname.endsWith('/test/ingest'), 'Tests must use the isolated /test/ingest endpoint, never production ingest');

const chromePath = process.env.PONG_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const debugPort = Number(process.env.PONG_CDP_PORT || 9241);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pong-observer-e2e-'));
const mediaPath = path.join(profile, 'observer-fixture.mp4');
await promisify(execFile)('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2',
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', mediaPath
]);
const mediaBytes = await fs.readFile(mediaPath);
const mediaServer = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', 'video/mp4');
  const range = String(request.headers.range || '');
  if (!range) {
    response.writeHead(200, { 'Content-Length': mediaBytes.length });
    response.end(mediaBytes);
    return;
  }
  const match = range.match(/bytes=(\d+)-(\d*)/);
  const start = Math.min(mediaBytes.length - 1, Number(match?.[1] || 0));
  const end = Math.min(mediaBytes.length - 1, Number(match?.[2] || mediaBytes.length - 1));
  response.writeHead(206, {
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${mediaBytes.length}`
  });
  response.end(mediaBytes.subarray(start, end + 1));
});
await new Promise((resolve, reject) => {
  mediaServer.once('error', reject);
  mediaServer.listen(0, '127.0.0.1', resolve);
});
const mediaUrl = `http://127.0.0.1:${mediaServer.address().port}/observer-fixture.mp4`;
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
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
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
  assert.equal(state.version, '26.94');
  assert.equal(state.hash, '', 'Pairing token must be removed from the visible URL');

  const handoffUrl = await evaluate(`(() => {
    const target = new URL('http://127.0.0.1:8787/pong?pongInstance=${instance}&pongObserverHandoffTest=1&pongRecallChannel=2');
    target.hash = 'pongState=' + btoa('{}').replace(/=+$/, '');
    return PongLiveObserver.decorateUrl(target.href);
  })()`);
  assert.ok(new URL(handoffUrl).hash.includes('pongObserve='), 'LAN handoff must carry observer pairing in the URL fragment');
  assert.ok(new URL(handoffUrl).hash.includes('pongState='), 'LAN playback state must coexist with observer pairing');
  await evaluate(`pongAssignLanLocation(new URL(${JSON.stringify(handoffUrl)}))`);
  await delay(500);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      state = await evaluate(`(() => ({ observer: document.documentElement.dataset.pongObserver || '', observerError: document.documentElement.dataset.pongObserverError || '', hash: location.hash, handoff: new URLSearchParams(location.search).get('pongObserverHandoffTest'), instance: new URLSearchParams(location.search).get('pongInstance'), recallChannel: new URLSearchParams(location.search).get('pongRecallChannel') }))()`);
      if (state?.observer === 'connected' && state?.handoff === '1') break;
    } catch (_) {}
    await delay(250);
  }
  assert.equal(state?.observer, 'connected', state?.observerError || 'observer did not reconnect after LAN handoff');
  assert.equal(state?.hash, '', 'LAN observer pairing token must be removed after handoff');
  assert.equal(state?.instance, instance, 'LAN handoff must preserve the Pong app instance');
  assert.equal(state?.recallChannel, '2', 'LAN handoff must preserve Recall 2');

  const pasted = `#PONG_ARTIST ${JSON.stringify({ artistDisplayName: 'Observer Real Media', artistKey: 'observer-real', artistSources: ['direct'] })}\n${mediaUrl}`;
  await evaluate(`(() => {
    handleCapturedPasteText(${JSON.stringify(pasted)});
    document.getElementById('load-videos').click();
    return true;
  })()`);
  let telemetry;
  for (let attempt = 0; attempt < 80; attempt++) {
    telemetry = await evaluate(`(async () => {
      const video = document.querySelector('.video-wrapper.deck-active video') || document.querySelector('.video-wrapper video');
      if (video) {
        video.muted = true;
        try { await video.play(); } catch (_) {}
      }
      await new Promise(resolve => setTimeout(resolve, 80));
      const snapshot = PongLiveObserver.snapshot();
      void PongLiveObserver.send();
      return snapshot;
    })()`);
    if (telemetry?.playback?.playing && telemetry.playback.currentTime > 0) break;
    await delay(100);
  }
  assert.equal(telemetry.playback.artist, 'Observer Real Media');
  assert.equal(telemetry.playback.artistVideoCount, 1);
  assert.equal(telemetry.playback.playing, true, 'real HTML video never entered playing state');
  assert.equal(telemetry.playback.paused, false);
  assert.ok(telemetry.playback.currentTime > 0, 'real HTML video clock did not advance');
  assert.ok(telemetry.playback.duration > 1, 'real HTML video metadata did not load');
  assert.equal(telemetry.workflow.mode, 'normal');

  const statusUrl = endpoint.replace(/\/test\/ingest$/, `/test/instances/pong${instance}`);
  let received;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(statusUrl, { headers: { Authorization: `Bearer ${adminToken}` } });
    if (response.ok) {
      received = (await response.json()).instance;
      if (received?.sessionId === telemetry.sessionId && received?.state?.playback?.artist === 'Observer Real Media') break;
    }
    await delay(100);
  }
  assert.equal(received?.sessionId, telemetry.sessionId, 'VPS did not receive the active browser session');
  assert.equal(received?.state?.playback?.status, 'playing');

  await evaluate(`(() => {
    localStorage.setItem('pong_session_v1', JSON.stringify({ allVideoUrls: ['https://media.example/stale.mp4'], currentVideoIndex: 9 }));
    document.querySelector('.refresh-button').click();
  })()`);
  await delay(500);
  let refreshed;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      refreshed = await evaluate(`(() => ({
        observer: document.documentElement.dataset.pongObserver || '',
        version: document.querySelector('.version-number')?.textContent || '',
        session: localStorage.getItem('pong_session_v1'),
        wrappers: document.querySelectorAll('.video-wrapper').length,
        autoStart: new URLSearchParams(location.search).get('pongAutoStart'),
        hash: location.hash
      }))()`);
      if (refreshed?.observer === 'connected' && refreshed?.version === '26.94') break;
    } catch (_) {}
    await delay(250);
  }
  assert.equal(refreshed?.observer, 'connected', 'observer must survive a clean refresh');
  assert.equal(refreshed?.session, null, 'clean refresh must not recreate the prior playback session');
  assert.equal(refreshed?.wrappers, 0, 'clean refresh must return to an empty Pong deck');
  assert.equal(refreshed?.autoStart, null, 'clean refresh must not restart the previous workflow');
  assert.equal(refreshed?.hash, '', 'observer fragment must be removed after the clean reload');
  socket.close();
  console.log(JSON.stringify({ ok: true, instance: `pong${instance}`, version: '26.94', observer: refreshed.observer, handoff: true, cleanRefresh: true, realMedia: { artist: telemetry.playback.artist, videos: telemetry.playback.artistVideoCount, playing: telemetry.playback.playing, currentTime: telemetry.playback.currentTime } }));
} finally {
  chrome.kill();
  await delay(250);
  await new Promise(resolve => mediaServer.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
