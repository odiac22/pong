// Experimental receiver-only decoder priming. No seek, pixel reveal, source
// selection, timeline ownership or production matching-policy changes.
(() => {
  if (window.__pongUndoPrimePreserve) return false;
  const prepare=window.__pongDomSwapPrepare;
  if (typeof prepare!=='function') throw Error('Swap transport unavailable');
  const cleanups=new Set(), primed=new WeakSet();
  const evidence=window.__pongPrimePreserveEvidence=[];
  const prime=s=>{
    if(!s||!s.warm||s.direct||primed.has(s)||s.abort.signal.aborted)return;
    primed.add(s);
    const o=s.overlay;
    if(typeof o.requestVideoFrameCallback!=='function')return;
    const row={session:s.sessionId,requestedAt:performance.now(),initialReady:o.readyState};
    evidence.push(row);if(evidence.length>100)evidence.shift();
    const stillWarm=()=>window.__pongDomSwapWarm===s&&s.warm&&!s.abort.signal.aborted;
    let timer=null,callback=null,done=false;
    const finish=reason=>{
      if(done)return;done=true;
      if(timer!==null)clearTimeout(timer);
      if(callback!==null)o.cancelVideoFrameCallback(callback);
      s.abort.signal.removeEventListener('abort',onAbort);
      if(stillWarm()){
        o.pause();
        // DO NOT seek to zero: that invalidates the decoded frame and changes
        // readyState back to metadata-only on this Android WebView.
        row.stoppedAt=performance.now();row.ready=o.readyState;row.time=o.currentTime;
      }
      row.reason=reason;cleanups.delete(clean);
    };
    const onAbort=()=>finish('retired');
    const clean=()=>finish('restored');cleanups.add(clean);
    s.abort.signal.addEventListener('abort',onAbort,{once:true});
    o.style.cssText='position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;z-index:-1!important';
    o.muted=true;o.defaultMuted=true;o.volume=0;
    document.body.appendChild(o);
    callback=o.requestVideoFrameCallback((_now,frame)=>{
      callback=null;row.frameAt=performance.now();row.frameTime=frame.mediaTime;
      finish(stillWarm()?'primed':'adopted');
    });
    timer=setTimeout(()=>finish('timeout'),1800);
    // A pending play request starts decoding as bytes arrive, instead of
    // waiting for loadeddata to signal work that priming should initiate.
    o.play().catch(()=>finish('play-rejected'));
  };
  const wrapped=(...args)=>{const result=prepare(...args);prime(window.__pongDomSwapWarm);return result;};
  window.__pongDomSwapPrepare=wrapped;
  window.__pongUndoPrimePreserve=()=>{
    if(window.__pongDomSwapPrepare===wrapped)window.__pongDomSwapPrepare=prepare;
    for(const cleanup of [...cleanups])cleanup();
    delete window.__pongUndoPrimePreserve;
  };
  prime(window.__pongDomSwapWarm);
  return true;
})()
