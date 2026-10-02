(async () => {
  // Frame rate of the swapped overlay vs the TikTok original over ~8 s,
  // counted only while the overlay is visible, plus presented-frame gaps.
  const out = {windows: []};
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    const s = window.__pongDomSwap, o = s?.overlay, v = s?.original;
    if (!s?.visible || !o || o.paused || !o.requestVideoFrameCallback) { await new Promise(r => setTimeout(r, 100)); continue; }
    const q0 = o.getVideoPlaybackQuality(), start = performance.now();
    const ahead = () => { const b = o.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= o.currentTime + .05 && b.end(i) >= o.currentTime) return +(b.end(i) - o.currentTime).toFixed(2); return 0; };
    const ahead0 = ahead(), ready0 = o.readyState;
    let minAhead = ahead0;
    const sampler = setInterval(() => { minAhead = Math.min(minAhead, ahead()); }, 100);
    let frames = 0, last = 0, worstGap = 0, gaps = 0, p0 = null, p1 = null;
    const session = s.sessionId;
    await new Promise(resolve => {
      const tick = (now, meta) => {
        if (last) { const g = now - last; worstGap = Math.max(worstGap, g); if (g > 50) gaps++; }
        last = now; frames++; if (p0 === null) p0 = meta.presentedFrames; p1 = meta.presentedFrames;
        if (performance.now() - start < 1500 && window.__pongDomSwap?.sessionId === session && window.__pongDomSwap?.visible) o.requestVideoFrameCallback(tick);
        else resolve();
      };
      o.requestVideoFrameCallback(tick);
      setTimeout(resolve, 1700);
    });
    clearInterval(sampler);
    const secs = (performance.now() - start) / 1000, q = o.getVideoPlaybackQuality();
    if (secs > 0.5) out.windows.push({fps: p0 === null ? 0 : +((p1 - p0) / secs).toFixed(1), callbacksPerSec: +(frames / secs).toFixed(1), worstGapMs: Math.round(worstGap), gapsOver50ms: gaps,
      dropped: q.droppedVideoFrames - q0.droppedVideoFrames, rate: o.playbackRate, size: `${o.videoWidth}x${o.videoHeight}`, ahead0, minAhead, ready0,
      origPaused: v?.paused, origRate: v?.playbackRate});
  }
  return out;
})()
