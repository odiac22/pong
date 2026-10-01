(() => {
  if (typeof window.__pongDomSwapSync !== 'function') return {installed:false};
  // Seek once, allow the decoder to finish, then reveal a painted frame.
  // Repeated 100ms seeks could keep an otherwise buffered stream invisible.
  const sync = (paintReceipt=null) => {
    const s = window.__pongDomSwap;
    if (!s) return {active:false,visible:false};
    const observed=window.__pongTikTokObservedVideo;
    if(s.pageUrl&&(!observed||observed.pageUrl!==s.pageUrl||observed.video!==s.original)){
      window.__pongDomSwapClear('',s.sessionId);return {active:false,visible:false};
    }
    if(s.direct)return s.direct.sync();
    const v=s.original,o=s.overlay,clock=performance.now();
    if(o.error){
      // Polling can observe the MediaError before its DOM error event runs.
      // Keep the same owner-aware recovery path in either ordering.
      if(typeof s.fail==='function')s.fail('media element error');
      else window.__pongDomSwapClear();
      return {active:false,visible:false};
    }
    if (!v?.isConnected || !s.host?.isConnected) {
      window.__pongDomSwapClear(); return {active:false,visible:false};
    }
    const target=Number(v.currentTime||0)-s.start;
    const hide=()=>{if(!s.visible)return;s.visible=false;v.style.opacity=v.dataset.pongDomOriginalOpacity||'';o.style.opacity='0';document.documentElement.classList.remove('pong-dom-swap');};
    let end=0,contains=false;
    for(let i=0;i<o.buffered.length;i++){
      end=Math.max(end,o.buffered.end(i));
      if(o.buffered.start(i)<=target&&o.buffered.end(i)>=target+.05)contains=true;
    }
    // Baseline 1.2: a scrub (or a stall) that leaves the playhead outside this
    // session's rendered frames must never keep stale swapped pixels on top
    // of the original. Hide at once and ask native for a session at the new
    // position. Natural startup (session starts up to 0.6 s ahead, or a cold
    // producer still filling) keeps the existing missed-handoff rule.
    const drift=target-Number(o.currentTime||0);
    const scrubbedBefore=target<-.9;
    const outsideRendered=!contains&&Math.abs(drift)>1;
    if(s.visible&&(target<-.05||outsideRendered)){s.reseekHide=true;hide();if(!o.paused)o.pause();}
    const needsReseek=scrubbedBefore||(!!s.reseekHide&&!s.visible&&target>end+1);
    const result=()=>({active:true,visible:!!s.visible,lag:Math.max(0,target-o.currentTime),target,
      bufferEnd:end,bufferHeadroom:end-target,readyState:o.readyState,ageMs:clock-s.createdAt,
      firstVisibleAt:s.firstVisibleAt||0,sessionId:s.sessionId,seeking:!!o.seeking,
      presentedMediaTime:s.lastPaintedMediaTime??-1,needsReseek,
      paintedRecently:!!s.lastPaintedAt&&(v.paused||clock-s.lastPaintedAt<750)});
    if(target<-.05){hide();if(!o.paused)o.pause();return {...result(),waitingForSourceTime:true};}
    let delta=Math.max(0,target)-Number(o.currentTime||0);
    // A prepared next-video element is paused. Resume it BEFORE alignment:
    // returning early for a seek used to leave it chasing a moving original
    // while still paused, then initiating another seek before ever playing.
    // This does not reveal pixels; the aligned rVFC receipt below still owns
    // visibility. Preserve intentional pause when the overlay is ahead.
    if(v.paused||(!s.visible&&delta<-.15)){if(!o.paused)o.pause();}
    else if(o.paused)o.play().catch(()=>{});
    if(o.seeking)return result();
    const seekThreshold=s.visible?1.25:.45;
    let seekTarget=Math.max(0,target),canSeek=contains;
    // Qualification-only: a producer slightly behind the original cannot
    // buffer target+50ms yet. Align to an ALREADY buffered frame with decoder
    // headroom instead of playing from zero at 2x and repeatedly starving.
    // Preserve the existing timestamp tolerance and never seek through gaps.
    if(window.__pongBufferedStartupSeekTrial===true&&!s.visible&&!contains&&
        o.readyState>=1&&delta>seekThreshold){
      for(let i=0;i<o.buffered.length;i++){
        const candidate=Math.min(Math.max(0,target),o.buffered.end(i)-.1);
        if(candidate>=o.buffered.start(i)&&target-candidate<=.35&&
            candidate-o.currentTime>.15){seekTarget=candidate;canSeek=true;break;}
      }
    }
    if(Math.abs(delta)>seekThreshold&&canSeek&&clock-(s.lastAlignmentSeekAt??-Infinity)>=500){
      s.lastAlignmentSeekAt=clock;
      try{o.currentTime=seekTarget;}catch(_){}
      // Do not use a pre-seek delta to pause or accelerate the new position.
      return result();
    }
    const base=Math.max(.25,Math.min(3,Number(v.playbackRate||1)));
    const rate=delta>.12&&end-o.currentTime>.15?Math.min(3,base+(s.visible?.3:1)):
      delta<-.12?Math.max(.25,base-.2):base;
    if(Math.abs(Number(o.playbackRate||1)-rate)>.01)o.playbackRate=rate;
    // Audit-only until a matched live A/B qualifies the handoff. Production
    // keeps its existing reveal path; numeric model quality is not sufficient
    // evidence that a browser scheduling change improves end-to-end latency.
    const ownedReceipt=window.__pongEventDrivenReveal===true&&paintReceipt?.owner===s&&Number.isFinite(paintReceipt.metadata?.mediaTime);
    if(!s.visible&&o.readyState>=2&&Math.abs(delta)<=.45&&(!s.revealPending||ownedReceipt)){
      if(ownedReceipt&&s.frameSyncRevealCallbackId!=null){
        o.cancelVideoFrameCallback?.(s.frameSyncRevealCallbackId);
        s.frameSyncRevealCallbackId=null;
      }
      s.revealPending=true;
      const commit=(_now,metadata)=>{
        s.frameSyncRevealCallbackId=null;
        s.revealPending=false;
        if(window.__pongDomSwap!==s||!v.isConnected||o.error||o.seeking||o.readyState<2)return;
        const actual=Number(metadata?.mediaTime??o.currentTime),wanted=Number(v.currentTime||0)-s.start;
        if(wanted<-.05||Math.abs(actual-Math.max(0,wanted))>.45)return;
        s.visible=true;s.reseekHide=false;s.firstVisibleAt=performance.now();
        s.lastPaintedMediaTime=actual;s.lastPaintedAt=performance.now();
        // A loop/seek can hide and reveal this same session repeatedly. Start
        // its permanent paint observer only once, or every reveal adds another
        // self-renewing callback to every subsequent decoded frame.
        if(typeof o.requestVideoFrameCallback==='function'&&!s.frameSyncTracking){
          s.frameSyncTracking=true;
          const trackPaint=(_time,frame)=>{
            s.frameSyncTrackCallbackId=null;
            if(window.__pongDomSwap!==s||!s.frameSyncTracking)return;
            s.lastPaintedMediaTime=frame.mediaTime;s.lastPaintedAt=performance.now();
            s.frameSyncTrackCallbackId=o.requestVideoFrameCallback(trackPaint);
          };
          s.frameSyncTrackCallbackId=o.requestVideoFrameCallback(trackPaint);
        }
        if(!Object.prototype.hasOwnProperty.call(v.dataset,'pongDomOriginalOpacity'))v.dataset.pongDomOriginalOpacity=v.style.opacity||'';
        v.style.setProperty('opacity','0','important');o.style.opacity='1';
        document.documentElement.classList.add('pong-dom-swap');
        try{window.PongTikTokSwap?.presented?.(s.sessionId);}catch(_){}
      };
      // A startup decoder callback already proves which frame was painted.
      // Committing that same aligned receipt avoids waiting for the 100 ms
      // polling timer and then a second frame. Never accept another owner's
      // receipt, a seek-in-flight, or an unaligned timestamp.
      if(ownedReceipt)
        commit(paintReceipt.now,paintReceipt.metadata);
      else if(typeof o.requestVideoFrameCallback==='function')s.frameSyncRevealCallbackId=o.requestVideoFrameCallback(commit);
      else requestAnimationFrame(commit);
    }
    return result();
  };
  sync.pongFrameSync=1;
  window.__pongDomSwapSync=sync;
  return {installed:true};
})()
