(async () => {
  // Wait up to 10 s for a playing, on-screen video, then measure 6 s.
  const playing = () => [...document.querySelectorAll('video')].filter(v => !v.paused && !v.ended && v.readyState >= 2);
  const t0 = performance.now();
  while (!playing().length && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 200));
  const vids = playing();
  if (!vids.length) return {result: 'no video playing'};
  const q0 = vids.map(v => v.getVideoPlaybackQuality());
  let frames = 0, worst = 0, last = performance.now(); const start = last;
  await new Promise(resolve => { const tick = now => { frames++; worst = Math.max(worst, now - last); last = now; if (now - start < 6000) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
  return {
    pageFps: +(frames / 6).toFixed(1), worstPageStallMs: Math.round(worst),
    decoders: vids.map((v, i) => {
      const q = v.getVideoPlaybackQuality();
      const shown = q.totalVideoFrames - q0[i].totalVideoFrames, dropped = q.droppedVideoFrames - q0[i].droppedVideoFrames;
      return {kind: v.classList.contains('pong-tiktok-swap-stream') ? 'swap overlay' : 'tiktok original',
              size: `${v.videoWidth}x${v.videoHeight}`, videoFps: +(shown / 6).toFixed(1), dropped, opacity: getComputedStyle(v).opacity};
    })
  };
})()
