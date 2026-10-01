(() => ({
  mode:document.documentElement.classList.contains('pong-tiktok-original-overlay'),
  nativeMode:window.PongNativeSwap?.tiktokModeActive?.(),
  styleInstalled:!!document.getElementById('pong-tiktok-original-overlay-style'),
  backgrounds:['html','body','#video-container'].map(q=>{const n=document.querySelector(q);return {selector:q,color:n?getComputedStyle(n).backgroundColor:null};}),
  nodes:Array.from(document.querySelectorAll('video,canvas,img.pm-video-poster'))
    .filter(n=>n.getBoundingClientRect().width>0).map(n=>({
      tag:n.tagName,cls:n.className,insideVideoContainer:!!n.closest('#video-container'),
      paused:n.paused,time:n.currentTime,ready:n.readyState,
      display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility,
      opacity:getComputedStyle(n).opacity,inline:n.getAttribute('style'),
      ancestors:Array.from((function*(n){for(let i=0;n&&i<4;i++,n=n.parentElement)yield n;})(n.parentElement))
        .map(p=>({tag:p.tagName,id:p.id,cls:p.className,visibility:getComputedStyle(p).visibility,background:getComputedStyle(p).backgroundColor}))
    }))
}))()
