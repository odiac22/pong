(() => {
  const s = window.__pongDomSwap;
  if (!s) return {none: true};
  const o = s.overlay, v = s.original;
  const describe = el => el && ({tag: el.tagName, cls: String(el.className).slice(0, 60), size: el.videoWidth !== undefined ? `${el.videoWidth}x${el.videoHeight}` : `${el.width}x${el.height}`,
    css: (() => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })(),
    readyState: el.readyState, paused: el.paused, currentTime: el.currentTime, buffered: el.buffered ? [...Array(el.buffered.length)].map((_, i) => [+el.buffered.start(i).toFixed(2), +el.buffered.end(i).toFixed(2)]) : null,
    src: String(el.currentSrc || el.src || '').replace(/^(https?:\/\/[^/]+).*/, '$1/…').replace(/^blob:.*/, 'blob:…'),
    quality: el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null, opacity: getComputedStyle(el).opacity});
  const keys = Object.keys(s).filter(k => typeof s[k] !== 'function').slice(0, 40);
  return {keys, visible: s.visible, session: String(s.sessionId || '').slice(0, 8), transport: s.transport || s.mode || null,
    overlay: describe(o), original: describe(v),
    swapVideos: [...document.querySelectorAll('.pong-tiktok-swap-stream, canvas')].map(describe)};
})()
