(async () => {
  // Presented-frame rate of TikTok's own playing video (rVFC), 1.5 s windows over ~8 s.
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 8000) {
    const v = [...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].find(x => !x.paused && x.readyState >= 2 && x.getBoundingClientRect().height > innerHeight * .5);
    if (!v) { await new Promise(r => setTimeout(r, 100)); continue; }
    let frames = 0, p0 = null, p1 = null, cbs = 0; const start = performance.now(); const src = v.currentSrc;
    await new Promise(resolve => {
      const tick = (now, meta) => { cbs++; if (p0 === null) p0 = meta.presentedFrames; p1 = meta.presentedFrames; if (performance.now() - start < 1500 && v.currentSrc === src) v.requestVideoFrameCallback(tick); else resolve(); };
      v.requestVideoFrameCallback(tick); setTimeout(resolve, 1700);
    });
    const secs = (performance.now() - start) / 1000;
    if (secs > .5) out.push({fps: p0 === null ? 0 : +((p1 - p0) / secs).toFixed(1), callbacksPerSec: +(cbs / secs).toFixed(1), swapVisible: !!window.__pongDomSwap?.visible});
  }
  return out;
})()
