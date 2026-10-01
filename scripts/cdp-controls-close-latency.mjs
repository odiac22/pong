const port = Number(process.env.PONG_CDP_PORT || 9232);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const target = targets.find(candidate => candidate.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error(`No page target on CDP port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

const expression = String.raw`(async () => {
  document.querySelectorAll('video').forEach(video => {
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    try { video.pause(); } catch (_) {}
  });
  const saved = {
    editor: pongFaceSwapState.settingsEditor,
    settings: pongFaceSwapState.settings,
    dirty: pongFaceSwapState.settingsDirty,
    closing: pongFaceSwapState.settingsClosing,
    drain: pongFaceSwapState.settingsApplyDrainPromise,
    pending: pongFaceSwapState.settingsApplyPending,
    release: releasePongFaceSwapSettingsFrame,
    dispose: disposePongFaceSwapFrameEditor,
    play: playVideoCleanly,
    fetch: pongFaceSwapControlFetch,
    apply: applyPongFaceSwapSettingsPreview
  };
  const panel = document.getElementById('pong-face-swap-settings-panel');
  const panelHidden = panel?.hidden;
  let applyStartedAt = 0;
  let releasedAt = 0;
  const wrapper = {
    dataset: { pongFaceSwapSessionId: '', userPaused: 'true', playIntent: 'false' },
    isConnected: true,
    querySelector: () => null
  };
  const video = { pause() {}, paused: true, ended: false };
  try {
    pongFaceSwapState.settingsEditor = {
      frame: { wrapper, video, wasPlaying: true, faceId: 'test' }
    };
    pongFaceSwapState.settings = { parameters: {}, runtime: {} };
    pongFaceSwapState.settingsDirty = true;
    pongFaceSwapState.settingsClosing = false;
    pongFaceSwapState.settingsApplyDrainPromise = null;
    pongFaceSwapState.settingsApplyPending = null;
    releasePongFaceSwapSettingsFrame = () => { releasedAt = performance.now(); };
    disposePongFaceSwapFrameEditor = async () => {
      pongFaceSwapState.settingsEditor = null;
    };
    playVideoCleanly = async () => true;
    pongFaceSwapControlFetch = async () => ({ ok: true, json: async () => ({}) });
    applyPongFaceSwapSettingsPreview = async () => {
      applyStartedAt = performance.now();
      await new Promise(resolve => setTimeout(resolve, 5000));
      return true;
    };
    const startedAt = performance.now();
    const closed = await closePongFaceSwapSettingsPanel({ persist: false });
    const returnedAt = performance.now();
    for (let index = 0; index < 20 && !applyStartedAt; index++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return {
      version: document.querySelector('.version-number')?.textContent?.trim() || '',
      closed,
      closeReturnMs: returnedAt - startedAt,
      videoReleasedMs: releasedAt - startedAt,
      backgroundApplyStarted: applyStartedAt > 0,
      simulatedBackgroundApplyMs: 5000
    };
  } finally {
    pongFaceSwapState.settingsEditor = saved.editor;
    pongFaceSwapState.settings = saved.settings;
    pongFaceSwapState.settingsDirty = saved.dirty;
    pongFaceSwapState.settingsClosing = saved.closing;
    pongFaceSwapState.settingsApplyDrainPromise = saved.drain;
    pongFaceSwapState.settingsApplyPending = saved.pending;
    releasePongFaceSwapSettingsFrame = saved.release;
    disposePongFaceSwapFrameEditor = saved.dispose;
    playVideoCleanly = saved.play;
    pongFaceSwapControlFetch = saved.fetch;
    applyPongFaceSwapSettingsPreview = saved.apply;
    if (panel) panel.hidden = panelHidden;
  }
})()`;

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP close-latency check timed out')), 15_000);
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error || message.result?.exceptionDetails) {
      reject(new Error(message.error?.message || message.result.exceptionDetails.text));
      return;
    }
    resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true, userGesture: false }
  }));
});

socket.close();
console.log(JSON.stringify(result, null, 2));
