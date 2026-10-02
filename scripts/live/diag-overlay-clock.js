(async () => {
  // While the swap is visible: media-time advance rate (1.0 = real time) and
  // decoded/dropped frame counts of the overlay vs the original.
  window.__pongRevealMinHeadroom = 0;
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 9000) {
    const s = window.__pongDomSwap, o = s?.overlay, v = s?.original;
    if (!s?.visible || !o || o.paused) { await new Promise(r => setTimeout(r, 100)); continue; }
    const q = el => { const x = el.getVideoPlaybackQuality(); return [x.totalVideoFrames, x.droppedVideoFrames]; };
    const a0 = o.currentTime, b0 = v.currentTime, qo0 = q(o), qv0 = q(v), w0 = performance.now(), id = s.sessionId;
    await new Promise(r => setTimeout(r, 500));
    if (window.__pongDomSwap?.sessionId !== id) continue;
    const secs = (performance.now() - w0) / 1000, qo = q(o), qv = q(v);
    out.push({overlayClock: +((o.currentTime - a0) / secs).toFixed(2), originalClock: +((v.currentTime - b0) / secs).toFixed(2),
      overlayDecodedPerSec: +((qo[0] - qo0[0]) / secs).toFixed(1), overlayDropped: qo[1] - qo0[1],
      originalDecodedPerSec: +((qv[0] - qv0[0]) / secs).toFixed(1), stillVisible: !!s.visible, readyState: o.readyState});
  }
  return out;
})()
