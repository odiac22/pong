(async () => {
  const videos = [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
    return {
      cls: String(v.className || '').slice(0, 30), playing: !v.paused && !v.ended,
      w: v.videoWidth, h: v.videoHeight,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      onScreen: r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0,
      dropped: q.droppedVideoFrames, total: q.totalVideoFrames, opacity: getComputedStyle(v).opacity
    };
  });
  const t0 = performance.now();
  let frames = 0, worst = 0, last = t0;
  await new Promise(resolve => {
    const tick = now => {
      frames++; worst = Math.max(worst, now - last); last = now;
      if (now - t0 < 3000) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  return {
    viewport: [innerWidth, innerHeight], rafFps: +(frames / 3).toFixed(1), worstFrameGapMs: Math.round(worst),
    videos,
    swap: window.__pongDomSwap ? {visible: !!window.__pongDomSwap.visible, session: String(window.__pongDomSwap.sessionId || '').slice(0, 8)} : null
  };
})()
