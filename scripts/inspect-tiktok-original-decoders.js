(()=>[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].map(v=>{
 const rect=v.getBoundingClientRect();return {preload:v.preload,ready:v.readyState,network:v.networkState,paused:v.paused,time:v.currentTime,
 width:v.videoWidth,height:v.videoHeight,rect:{x:rect.x,y:rect.y,w:rect.width,h:rect.height},
 buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),
 sourceKind:(v.currentSrc||'').startsWith('blob:')?'mse':v.currentSrc?'network':'none',
 parentClass:v.parentElement?.className};}))()
