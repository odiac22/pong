(() => ({
 activation:navigator.userActivation?.hasBeenActive,
 visibility:document.visibilityState,
 viewport:[innerWidth,innerHeight,devicePixelRatio],
 domNodes:document.querySelectorAll('*').length,
 videos:[...document.querySelectorAll('video')].map(v=>({
  swap:v.classList.contains('pong-tiktok-swap-stream'),paused:v.paused,muted:v.muted,
  time:v.currentTime,ready:v.readyState,error:v.error?.code||0,
  quality:v.getVideoPlaybackQuality?.(),
 })),
 overlayStats:window.PongTikTokOverlayStats||null,
 swapError:window.__pongDomSwapLastError||null
}))()
