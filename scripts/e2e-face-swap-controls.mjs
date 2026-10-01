import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.PONG_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PONG = process.env.PONG_TEST_URL || 'http://127.0.0.1:8787/pong';
const SWAP_CONTROL = process.env.PONG_SWAP_CONTROL_URL || 'http://127.0.0.1:8793/pong-swap';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(callback, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
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

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function startVideoServer(filePath) {
  const file = await stat(filePath);
  const server = http.createServer((request, response) => {
    const range = request.headers.range;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'video/mp4');
    if (!range) {
      response.writeHead(200, { 'Content-Length': file.size });
      createReadStream(filePath).pipe(response);
      return;
    }
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Math.max(0, Number(match?.[1] || 0));
    const end = Math.min(file.size - 1, match?.[2] ? Number(match[2]) : file.size - 1);
    response.writeHead(206, {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
    });
    createReadStream(filePath, { start, end }).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

const token = `codex-ui-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const approvedRoot = path.join(ROOT, 'Pong Swap', 'approved-faces');
const temporaryFace = path.join(approvedRoot, `${token}.jpg`);
const sourceFace = path.join(approvedRoot, 'Approved 10', 'source.jpg');
const targetFace = path.join(approvedRoot, 'Approved 4', 'source.jpg');
let profile;
let mediaDirectory;
let mediaServer;
let chrome;
let cdp;
let previewConfigToRestore;
const testSessionIds = new Set();
try {
  previewConfigToRestore = await fetch(`${SWAP_CONTROL}/settings`)
    .then(response => response.json())
    .then(payload => payload.config);
  await copyFile(sourceFace, temporaryFace);
  mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'pong-swap-held-frame-'));
  const mediaPath = path.join(mediaDirectory, 'timeline.mp4');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-i', targetFace, '-t', '6',
    '-vf', 'scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:black',
    '-r', '10',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mediaPath,
  ]);
  mediaServer = await startVideoServer(mediaPath);
  const mediaPort = mediaServer.address().port;
  const mediaUrl = `http://127.0.0.1:${mediaPort}/timeline.mp4`;
  profile = await mkdtemp(path.join(os.tmpdir(), 'pong-swap-controls-'));
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
  await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!document.getElementById('pong-face-swap-button')`), 20_000, 'Pong UI');
  // Never claim or retire the live Pong 1/Pong 2 foreground channels while
  // exercising the headless UI. The engine reserves "test" as an isolated
  // benchmark channel.
  await cdp.eval(`window.pongFaceSwapChannel = () => 'test'`);

  await cdp.eval(`(() => {
    const input = document.getElementById('video-urls');
    input.value = ${JSON.stringify(mediaUrl)};
    document.getElementById('load-videos').click();
  })()`);
  await waitFor(() => cdp.eval(`(() => {
    const video = document.querySelector('.video-wrapper video');
    if (!video) return false;
    video.muted = true; video.volume = 0;
    return video.readyState >= 2;
  })()`), 20_000, 'deterministic video');

  await cdp.eval(`document.getElementById('pong-face-swap-button').click()`);
  const menu = await waitFor(() => cdp.eval(`(() => {
    const menu = document.getElementById('pong-face-swap-menu');
    const controls = [...(menu?.querySelectorAll('button') || [])].find(button => button.textContent.includes('Controls'));
    const face = [...(menu?.querySelectorAll('button') || [])].find(button => button.textContent.includes(${JSON.stringify(token)}));
    return menu?.classList.contains('open') && controls && face ? { choices: menu.querySelectorAll('button').length } : null;
  })()`), 20_000, 'face menu and temporary face');
  assert(menu.choices >= 21);

  await cdp.eval(`(() => {
    const menu = document.getElementById('pong-face-swap-menu');
    const face = [...menu.querySelectorAll('button')].find(button => button.textContent.includes('Approved 8'));
    face.click();
  })()`);
  const initialTestSessionId = await waitFor(() => cdp.eval(`(() => {
    const wrapper = document.querySelector('.video-wrapper');
    const video = wrapper?.querySelector('video');
    return wrapper?.dataset.pongFaceSwapActive === 'true' &&
      wrapper?.dataset.pongFaceSwapBusy !== 'true' && Number(video?.readyState || 0) >= 2
        ? wrapper.dataset.pongFaceSwapSessionId || null
        : null;
  })()`), 45_000, 'initial real swap');
  if (initialTestSessionId) testSessionIds.add(initialTestSessionId);

  await cdp.eval(`new Promise(async resolve => {
    const wrapper = document.querySelector('.video-wrapper');
    const video = wrapper.querySelector('video');
    video.muted = true; video.volume = 0;
    wrapper.dataset.userPaused = 'false'; wrapper.dataset.playIntent = 'true';
    await video.play().catch(() => null);
    setTimeout(() => {
      video.pause();
      wrapper.dataset.userPaused = 'true'; wrapper.dataset.playIntent = 'false';
      resolve(true);
    }, 750);
  })`);

  await cdp.eval(`document.getElementById('pong-face-swap-button').click()`);
  await waitFor(() => cdp.eval(`document.getElementById('pong-face-swap-menu')?.classList.contains('open')`), 5_000, 'controls menu');
  await cdp.eval(`[...document.querySelectorAll('#pong-face-swap-menu button')].find(button => button.textContent.includes('Controls')).click()`);
  const panel = await waitFor(() => cdp.eval(`(() => {
    const panel = document.getElementById('pong-face-swap-settings-panel');
    const diff = panel?.querySelector('[data-name="DiffSlider"]');
    return !panel?.hidden && diff ? {
      controls: panel.querySelectorAll('[data-name]').length,
      value: diff.value,
      width: panel.getBoundingClientRect().width
    } : null;
  })()`), 20_000, 'live controls panel');
  assert(panel.controls >= 50);
  assert(panel.width <= 248, `settings panel remained too wide: ${panel.width}px`);
  const editorReady = await waitFor(() => cdp.eval(`(() => {
    const editor = document.querySelector('.pong-swap-frame-editor');
    const video = document.querySelector('.video-wrapper video');
    const image = editor?.querySelector('.pong-swap-frame-editor-image');
    const er = editor?.getBoundingClientRect();
    const vr = video?.getBoundingClientRect();
    if (!editor || !image || image.hidden || !/Picture updated/i.test(document.getElementById('pong-face-swap-settings-status')?.textContent || '')) return null;
    return {
      editorWidth: er.width, editorHeight: er.height,
      videoWidth: vr.width, videoHeight: vr.height,
      sessionId: document.querySelector('.video-wrapper')?.dataset.pongFaceSwapSessionId || '',
      imageSrc: image.src
    };
  })()`), 45_000, 'still-frame editor');
  assert(Math.abs(editorReady.editorWidth - editorReady.videoWidth) <= 1, 'editor width did not match video');
  assert(Math.abs(editorReady.editorHeight - editorReady.videoHeight) <= 1, 'editor height did not match video');

  // Prove that changing the production restorer changes the decoded pixels the
  // user actually sees. Production intentionally exposes only InSwapper 128
  // plus GPEN256/GPEN512; retired comparison models must never be selectable
  // or become resident in the playback worker. A fresh blob URL alone can
  // still contain the same image, which used to let this test report success
  // for an unchanged frame.
  const displayedPreview = () => cdp.eval(`(() => {
    const image = document.querySelector('.pong-swap-frame-editor-image');
    if (!image?.complete || !image.naturalWidth || image.hidden) return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index++) {
      hash ^= pixels[index];
      hash = Math.imul(hash, 16777619);
    }
    const style = getComputedStyle(image);
    const rect = image.getBoundingClientRect();
    return {
      hash: (hash >>> 0).toString(16).padStart(8, '0'),
      source: image.src,
      width: canvas.width,
      height: canvas.height,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0,
      swapper: document.querySelector('#pong-face-swap-settings-panel [data-name="SwapperTypeTextSel"]')?.value || '',
      restorer: document.querySelector('#pong-face-swap-settings-panel [data-name="RestorerTypeTextSel"]')?.value || ''
    };
  })()`);
  const visualBaseline = await waitFor(displayedPreview, 5_000, 'decoded baseline preview pixels');
  assert.equal(visualBaseline.visible, true, 'baseline preview image was not visibly displayed');

  const changedControls = await cdp.eval(`(() => {
    const swapper = document.querySelector('#pong-face-swap-settings-panel [data-name="SwapperTypeTextSel"]');
    const restorer = document.querySelector('#pong-face-swap-settings-panel [data-name="RestorerTypeTextSel"]');
    const restoreSwitch = document.querySelector('#pong-face-swap-settings-panel [data-name="RestorerSwitch"]');
    if (!swapper || !restorer) throw new Error('model/restorer controls were missing');
    const before = {
      swapper: swapper.value,
      restorer: restorer.value,
      restoreEnabled: Boolean(restoreSwitch?.checked),
      swapperOptions: [...swapper.options].map(option => option.value),
      restorerOptions: [...restorer.options].map(option => option.value)
    };
    const targetRestorer = restorer.value === 'GPEN512' ? 'GPEN256' : 'GPEN512';
    if (restoreSwitch && !restoreSwitch.checked) {
      restoreSwitch.checked = true;
      restoreSwitch.dispatchEvent(new Event('change', { bubbles: true }));
    }
    restorer.value = targetRestorer;
    restorer.dispatchEvent(new Event('change', { bubbles: true }));
    return { ...before, targetRestorer };
  })()`);
  assert.deepEqual(changedControls.swapperOptions, ['128']);
  assert.deepEqual(changedControls.restorerOptions, ['GPEN256', 'GPEN512']);
  const changedVisual = await waitFor(async () => {
    const status = await cdp.eval(`document.getElementById('pong-face-swap-settings-status')?.textContent || ''`);
    const preview = await displayedPreview();
    return /Picture updated/i.test(status) && preview?.source !== visualBaseline.source ? preview : null;
  }, 45_000, 'Approved 8 model/restorer visual update');
  assert.equal(changedVisual.visible, true, 'updated preview image was not visibly displayed');
  assert.notEqual(changedVisual.hash, visualBaseline.hash, 'model/restorer controls produced unchanged displayed pixels');
  assert.equal(changedVisual.swapper, '128');
  assert.equal(changedVisual.restorer, changedControls.targetRestorer);

  await cdp.eval(`(() => {
    const swapper = document.querySelector('#pong-face-swap-settings-panel [data-name="SwapperTypeTextSel"]');
    const restorer = document.querySelector('#pong-face-swap-settings-panel [data-name="RestorerTypeTextSel"]');
    const restoreSwitch = document.querySelector('#pong-face-swap-settings-panel [data-name="RestorerSwitch"]');
    swapper.value = ${JSON.stringify(changedControls.swapper)};
    swapper.dispatchEvent(new Event('change', { bubbles: true }));
    restorer.value = ${JSON.stringify(changedControls.restorer)};
    restorer.dispatchEvent(new Event('change', { bubbles: true }));
    if (restoreSwitch) {
      restoreSwitch.checked = ${JSON.stringify(Boolean(changedControls.restoreEnabled))};
      restoreSwitch.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  const restoredVisual = await waitFor(async () => {
    const status = await cdp.eval(`document.getElementById('pong-face-swap-settings-status')?.textContent || ''`);
    const preview = await displayedPreview();
    return /Picture updated/i.test(status) && preview?.source !== changedVisual.source ? preview : null;
  }, 45_000, 'restored model/restorer visual update');
  assert.equal(restoredVisual.hash, visualBaseline.hash, 'restoring the controls did not restore the displayed pixels');
  const viewControls = await cdp.eval(`(() => {
    const controls = document.getElementById('pong-face-swap-settings-view-controls');
    const original = document.getElementById('pong-face-swap-settings-original');
    const face = document.getElementById('pong-face-swap-settings-face-button');
    if (!controls || controls.hidden || !original || !face) return null;
    original.click();
    const editor = document.querySelector('.pong-swap-frame-editor');
    const originalVisible = !editor.querySelector('canvas').hidden && editor.querySelector('.pong-swap-frame-editor-image').hidden;
    original.click();
    const swapVisibleAgain = !editor.querySelector('.pong-swap-frame-editor-image').hidden;
    face.click();
    const source = editor.querySelector('.pong-swap-frame-editor-source-face');
    return {
      originalVisible,
      swapVisibleAgain,
      faceVisible: !source.hidden,
      faceChoicesVisible: !document.getElementById('pong-face-swap-settings-faces').hidden,
      source: source.src,
      buttons: controls.querySelectorAll(':scope > button').length
    };
  })()`);
  assert.equal(viewControls.buttons, 3, 'bottom preview bar must contain exactly three main actions');
  assert.equal(viewControls.originalVisible, true, 'Original did not show the untouched captured frame');
  assert.equal(viewControls.swapVisibleAgain, true, 'Original did not toggle back to the rendered swap');
  assert.equal(viewControls.faceVisible, true, 'Face did not show the approved source photo');
  assert.equal(viewControls.faceChoicesVisible, true, 'Face did not open the outside face chooser');
  assert.match(viewControls.source, /\/source|data:image/);
  const switchedFace = await cdp.eval(`new Promise((resolve, reject) => {
    const host = document.getElementById('pong-face-swap-settings-faces');
    const button = [...host.querySelectorAll('button')].find(item => item.title === 'Approved 11');
    const wrapper = document.querySelector('.video-wrapper');
    const initialSessionId = wrapper.dataset.pongFaceSwapSessionId || '';
    const initialImage = document.querySelector('.pong-swap-frame-editor-image')?.src || '';
    if (!button) { reject(new Error('Approved 11 settings face was missing')); return; }
    button.click();
    const deadline = Date.now() + 45000;
    const timer = setInterval(() => {
      const image = document.querySelector('.pong-swap-frame-editor-image');
      const selected = document.querySelector('.pong-swap-settings-face.selected')?.title || '';
      const status = document.getElementById('pong-face-swap-settings-status')?.textContent || '';
      if (selected === 'Approved 11' && image?.src && image.src !== initialImage && /Picture updated/i.test(status)) {
        clearInterval(timer);
        resolve({
          selected,
          selectedFaceId: pongFaceSwapState.selectedFaceId,
          sessionUnchanged: (wrapper.dataset.pongFaceSwapSessionId || '') === initialSessionId
        });
      } else if (Date.now() > deadline || /failed|unavailable|could not/i.test(status)) {
        clearInterval(timer); reject(new Error('settings face switch failed: ' + status));
      }
    }, 50);
  })`);
  assert.equal(switchedFace.selected, 'Approved 11');
  assert.equal(switchedFace.sessionUnchanged, true, 'switching preview face reloaded the video');

  const zoomed = await cdp.eval(`(() => {
    const editor = document.querySelector('.pong-swap-frame-editor');
    [...editor.querySelectorAll('button')].find(button => button.textContent === '+').click();
    return document.querySelector('.pong-swap-frame-editor-zoom')?.textContent || '';
  })()`);
  assert.notEqual(zoomed, '100%', 'zoom button did not enlarge the still frame');

  const dragged = await cdp.eval(`(() => {
    const panel = document.getElementById('pong-face-swap-settings-panel');
    const handle = document.getElementById('pong-face-swap-settings-drag');
    const before = panel.getBoundingClientRect();
    const startX = before.left + 12, startY = before.top + 10;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, button:0, pointerId:7, clientX:startX, clientY:startY }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, button:0, pointerId:7, clientX:startX-24, clientY:startY+18 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, button:0, pointerId:7, clientX:startX-24, clientY:startY+18 }));
    const after = panel.getBoundingClientRect();
    return { before:{left:before.left,top:before.top}, after:{left:after.left,top:after.top} };
  })()`);
  assert.notDeepEqual(dragged.after, dragged.before);

  const heldFrame = await cdp.eval(`new Promise((resolve, reject) => {
    const wrapper = document.querySelector('.video-wrapper');
    const video = wrapper.querySelector('video');
    const original = video.__pongSwapOriginal;
    const presented = video.__pongSwapPresentedGeneration === wrapper.dataset.pongFaceSwapGeneration
      ? Number(video.__pongSwapPresentedMediaTime) : Number(video.currentTime || 0);
    const expected = Number(original?.startSeconds || 0) + Math.max(0, presented || 0);
    const input = document.querySelector('#pong-face-swap-settings-panel [data-name="DiffSlider"]');
    const step = Math.max(1, Number(input.step || 1));
    const startValue = Number(input.value);
    const values = [1, 2, 3].map(offset => Math.min(Number(input.max), startValue + step * offset));
    const samples = [];
    const initialSessionId = wrapper.dataset.pongFaceSwapSessionId || '';
    const initialSource = video.currentSrc || video.src || '';
    const initialImage = document.querySelector('.pong-swap-frame-editor-image')?.src || '';
    let editorGap = false;
    let mediaReloaded = false;
    let errorStatus = '';
    const timer = setInterval(() => {
      const state = pongFaceSwapProgressState(wrapper, video);
      const editor = document.querySelector('.pong-swap-frame-editor');
      if (!editor?.isConnected) editorGap = true;
      if ((wrapper.dataset.pongFaceSwapSessionId || '') !== initialSessionId || (video.currentSrc || video.src || '') !== initialSource) mediaReloaded = true;
      const status = document.getElementById('pong-face-swap-settings-status')?.textContent || '';
      if (/could not|did not become ready|failed/i.test(status)) errorStatus = status;
      samples.push({ time: state.currentTime, paused: video.paused, editor: Boolean(editor?.isConnected) });
      const image = editor?.querySelector('.pong-swap-frame-editor-image');
      const ready = /Picture updated/i.test(status) && image?.src && image.src !== initialImage;
      if (!ready) return;
      clearInterval(timer); clearTimeout(deadline);
      resolve({ expected, after: pongFaceSwapProgressState(wrapper, video).currentTime, samples, editorGap, mediaReloaded, errorStatus, initialSessionId });
    }, 25);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('exact held-frame preview timed out')); }, 45000);
    values.forEach((next, index) => setTimeout(() => {
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, index * 110));
  })`);
  assert(heldFrame.samples.every(sample => sample.paused), 'paused media played during the settings preview');
  assert.equal(heldFrame.editorGap, false, 'the still-frame editor disappeared during a live update');
  assert.equal(heldFrame.mediaReloaded, false, 'a slider change reloaded the underlying video');
  assert.equal(heldFrame.errorStatus, '', `live settings reported an error: ${heldFrame.errorStatus}`);
  const maxDeviation = Math.max(...heldFrame.samples.map(sample => Math.abs(sample.time - heldFrame.expected)));
  // currentTime can lead the last compositor-presented frame by decoder
  // buffering. Stability across the edit, rather than that fixed offset, is
  // the correct proof that the paused frame did not move.
  const sampledTimes = heldFrame.samples.map(sample => sample.time);
  const heldFrameDrift = Math.max(...sampledTimes) - Math.min(...sampledTimes);
  assert(heldFrameDrift <= 0.02, `held frame clock drifted by ${heldFrameDrift.toFixed(3)} seconds`);
  assert(Math.abs(heldFrame.after - sampledTimes.at(-1)) <= 0.02, 'still editor moved during the settings preview');

  // Restore the exact live DiffSlider value that existed before this test.
  await cdp.eval(`new Promise((resolve, reject) => {
    const input = document.querySelector('#pong-face-swap-settings-panel [data-name="DiffSlider"]');
    input.value = ${JSON.stringify(String(panel.value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const deadline = Date.now() + 45000;
    const timer = setInterval(() => {
      const status = document.getElementById('pong-face-swap-settings-status')?.textContent || '';
      if (/Picture updated/i.test(status)) { clearInterval(timer); resolve(true); }
      else if (/failed|did not become ready|could not/i.test(status) || Date.now() > deadline) {
        clearInterval(timer); reject(new Error('DiffSlider restoration failed: ' + status));
      }
    }, 50);
  })`);

  await cdp.eval(`document.getElementById('pong-face-swap-settings-video').click()`);
  const closed = await waitFor(() => cdp.eval(`(() => {
    const wrapper = document.querySelector('.video-wrapper');
    const video = wrapper?.querySelector('video');
    if (document.querySelector('.pong-swap-frame-editor')) return null;
    if (!document.getElementById('pong-face-swap-settings-panel')?.hidden) return null;
    if (!document.getElementById('pong-face-swap-settings-view-controls')?.hidden) return null;
    if (wrapper?.dataset.pongFaceSwapBusy === 'true' || wrapper?.dataset.pongFaceSwapActive !== 'true' || Number(video?.readyState || 0) < 2) return null;
    return {
      sessionId: wrapper.dataset.pongFaceSwapSessionId || '',
      faceId: wrapper.dataset.pongFaceSwapFaceId || ''
    };
  })()`), 45_000, 'single close-time video apply');
  assert.notEqual(closed.sessionId, heldFrame.initialSessionId, 'closing controls did not create the one final replacement stream');
  assert.equal(closed.faceId, switchedFace.selectedFaceId, 'the selected settings face did not become the live video face');
  if (closed.sessionId) testSessionIds.add(closed.sessionId);

  await cdp.eval(`document.getElementById('pong-face-swap-button').click()`);
  await waitFor(() => cdp.eval(`document.getElementById('pong-face-swap-menu')?.classList.contains('open')`), 5_000, 'reopened face menu');
  await cdp.eval(`new Promise(resolve => {
    const button = [...document.querySelectorAll('#pong-face-swap-menu button')].find(item => item.textContent.includes(${JSON.stringify(token)}));
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, button:0, clientX:10, clientY:10 }));
    setTimeout(() => {
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, button:0, clientX:10, clientY:10 }));
      resolve(true);
    }, 3200);
  })`);
  await waitFor(async () => {
    try { await stat(temporaryFace); return false; } catch (error) { return error?.code === 'ENOENT'; }
  }, 15_000, 'permanent face deletion');
  console.log(JSON.stringify({
    ok: true,
    menuChoices: menu.choices,
    liveControls: panel.controls,
    panelWidth: panel.width,
    heldFrameDeviationSeconds: maxDeviation,
    heldFrameDriftSeconds: heldFrameDrift,
    rapidEdits: 3,
    sliderMediaReloaded: heldFrame.mediaReloaded,
    switchedSettingsFace: switchedFace.selected,
    zoomed,
    pausedThroughout: true,
    modelRestorerPixelChange: `${visualBaseline.hash}->${changedVisual.hash}->${restoredVisual.hash}`,
    deleted: token
  }, null, 2));
} finally {
  cdp?.close();
  await stopTree(chrome);
  for (const sessionId of testSessionIds) {
    await fetch(`${SWAP_CONTROL}/sessions/${encodeURIComponent(sessionId)}?defer=1`, { method: 'DELETE' }).catch(() => null);
  }
  if (previewConfigToRestore) {
    await fetch(`${SWAP_CONTROL}/settings/preview`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewConfigToRestore),
    }).catch(() => null);
  }
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => null);
  if (mediaServer) await new Promise(resolve => mediaServer.close(resolve));
  if (mediaDirectory) await rm(mediaDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => null);
  // Exact, uniquely named test artifact only. The UI normally removes it.
  await rm(temporaryFace, { force: true }).catch(() => null);
}
