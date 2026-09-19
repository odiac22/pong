const port = Number(process.argv[2] || 9227);
const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
const target = targets.find(item => item.type === 'page' && /Pong/i.test(item.title || '')) || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error('Connected Pong WebView target was not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

const expression = `JSON.stringify((() => {
  const active = document.querySelector('.video-wrapper.deck-active') ||
    document.querySelector('.video-wrapper.most-visible');
  const safeSource = media => {
    try {
      const url = new URL(media.currentSrc || media.src || '', location.href);
      return url.pathname.slice(-180);
    } catch (_) {
      return '';
    }
  };
  return {
    visibility: document.visibilityState,
    audioPreference: window.pongUserWantsAudio,
    storedAudio: localStorage.getItem('pong_player_audio_pref_v1'),
    currentPlaying: Boolean(window.currentlyPlayingVideo),
    currentMatchesActive: window.currentlyPlayingVideo === active?.querySelector('video'),
    activeDataset: active ? Object.fromEntries(
      Object.entries(active.dataset).filter(([key]) =>
        /audio|faceSwap|visibleFrame|userPaused|playIntent|index/i.test(key)
      )
    ) : null,
    media: [...document.querySelectorAll('video,audio')].map((media, index) => ({
      index,
      tag: media.tagName,
      className: media.className,
      active: media.closest('.video-wrapper') === active,
      connected: media.isConnected,
      paused: media.paused,
      ended: media.ended,
      muted: media.muted,
      defaultMuted: media.defaultMuted,
      volume: media.volume,
      currentTime: media.currentTime,
      duration: media.duration,
      readyState: media.readyState,
      networkState: media.networkState,
      width: media.videoWidth || 0,
      height: media.videoHeight || 0,
      sourcePath: safeSource(media),
      audioDecodedBytes: Number(media.webkitAudioDecodedByteCount || 0),
      videoDecodedBytes: Number(media.webkitVideoDecodedByteCount || 0),
      presentedFrames: media.dataset?.pongPresentedFrameCount || '',
      error: media.error ? { code: media.error.code, message: media.error.message } : null
    }))
  };
})())`;

const id = 1;
const result = new Promise((resolve, reject) => {
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== id) return;
    socket.close();
    if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
    else resolve(message.result?.result?.value);
  };
});
socket.send(JSON.stringify({
  id,
  method: 'Runtime.evaluate',
  params: { expression, returnByValue: true }
}));

console.log(JSON.stringify(JSON.parse(await result), null, 2));
