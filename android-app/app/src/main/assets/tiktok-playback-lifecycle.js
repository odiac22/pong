// Remember playback intent only across Pong-owned pauses. Never start an
// offscreen post, a replacement source, or a video the user had paused.
(() => {
  if (window.__pongTikTokPauseForPong) return;
  let pending = null;
  const source = v => v.currentSrc || v.src || '';
  const area = v => {
    const r = v.getBoundingClientRect();
    return Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) *
      Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
  };
  window.__pongTikTokPauseForPong = () => {
    const videos = [...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')];
    const playing = videos.filter(v => v.isConnected && !v.paused && !v.ended && area(v) > innerWidth * innerHeight * .22)
      .sort((a,b) => area(b)-area(a))[0];
    if (playing) pending = {video: playing, source: source(playing)};
    // Repeated native lifecycle callbacks must not erase the first pause's
    // intent merely because that first callback already stopped playback.
    document.querySelectorAll('video,audio').forEach(v => {v.pause();v.muted=true;v.volume=0;});
  };
  window.__pongTikTokResumeFromPong = async () => {
    const intent = pending;
    if (!intent) return false;
    if (document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')) return false;
    pending = null;
    const v = intent.video;
    if (!v.isConnected || source(v) !== intent.source || area(v) < innerWidth * innerHeight * .22) return false;
    v.muted=true;v.defaultMuted=true;v.volume=0;
    try {await v.play();window.__pongTikTokScan?.();return !v.paused;} catch {return false;}
  };
})();
