(() => {
  const previous=window.__pongDomSwapSync;
  if(typeof previous!=='function')return {installed:false,reason:'No compositor'};
  if(previous.pongStableHandoff===3)return {installed:true};
  const sync=(paintReceipt=null)=>{
    const s=window.__pongDomSwap;
    if(!s)return previous(paintReceipt);
    const v=s.original,o=s.overlay;
    const target=Number(v.currentTime||0)-s.start;
    // A future-offset stream must never be shown over the beginning of a loop.
    if(target<-.05){
      if(s.visible){s.visible=false;v.style.opacity=v.dataset.pongDomOriginalOpacity||'';o.style.opacity='0';document.documentElement.classList.remove('pong-dom-swap');}
      o.pause();
      return {active:true,visible:false,lag:0,waitingForSourceTime:true,readyState:o.readyState,ageMs:performance.now()-s.createdAt,sessionId:s.sessionId};
    }
    let bufferEnd=0;
    for(let i=0;i<o.buffered.length;i++)if(o.buffered.start(i)<=target+.05&&o.buffered.end(i)>=target)bufferEnd=o.buffered.end(i);
    const drift=target-o.currentTime;
    // Correct a seek using already-buffered swapped frames, without flashing
    // the original between seek request and decoder completion.
    if(s.visible&&Math.abs(drift)>1.25&&bufferEnd>target+.05&&!o.seeking)o.currentTime=target;
    if(s.visible&&o.seeking)return {active:true,visible:true,lag:0,bufferHeadroom:bufferEnd-target,ageMs:performance.now()-s.createdAt,readyState:o.readyState,sessionId:s.sessionId};
    const wasVisible=s.visible;
    // Preserve the decoder's exact owner/timestamp receipt. Dropping this
    // argument silently disabled event-driven first-frame reveal and forced
    // another polling tick/frame even though the decoded frame was ready.
    const result=previous(paintReceipt);
    // Once this exact source has a presented swapped frame, decoder/buffer
    // recovery must not expose its unswapped pixels. Keep the last swapped
    // frame during recovery; normal clear still handles navigation/off/errors.
    if(wasVisible&&!s.visible&&window.__pongDomSwap===s&&v.isConnected&&!o.error){
      s.visible=true;
      v.style.setProperty('opacity','0','important');
      o.style.opacity='1';
      document.documentElement.classList.add('pong-dom-swap');
      return {...result,visible:true,holdingForSwapBuffer:true};
    }
    return result;
  };
  sync.pongStableHandoff=3;
  sync.pongFrameSync=previous.pongFrameSync;
  window.__pongDomSwapSync=sync;
  return {installed:true,guards:['future-offset-loop','buffered-seek-handoff']};
})()
