(() => [...document.querySelectorAll('video')].map(v => ({
  cls: String(v.className).slice(0, 40), paused: v.paused, readyState: v.readyState, networkState: v.networkState,
  hasSrc: !!(v.currentSrc || v.src), size: `${v.videoWidth}x${v.videoHeight}`, preload: v.preload,
  decoded: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null,
  display: getComputedStyle(v).display, inDoc: v.isConnected
})))()
