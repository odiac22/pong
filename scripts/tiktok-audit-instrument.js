(() => {
  window.__pongAuditStop?.();
  const audit={rafIntervals:[],longTasks:[],paintEvents:[],originalPaintEvents:[],mediaEvents:[],media:new WeakMap(),watched:new Map(),cleanups:[],started:performance.now(),snapshotCount:0,snapshotMs:0,maxSnapshotMs:0};
  // Observe the application's own synchronizer. A benchmark snapshot must
  // never add playback-rate changes, seeks, DOM writes or duplicate sync work.
  const existingSync=window.__pongDomSwapSync;
  let lastSync=null,syncCalls=0;
  const syncErrors=[];
  const observedSync=typeof existingSync==='function'?function(...args){
    syncCalls++;
    try{lastSync=existingSync.apply(this,args);for(const video of audit.watched.keys())visibilityEvent(video);return lastSync;}
    catch(error){if(syncErrors.length<10)syncErrors.push(String(error));throw error;}
  }:null;
  if(observedSync){
    observedSync.pongFrameSync=existingSync.pongFrameSync;
    window.__pongDomSwapSync=observedSync;
    audit.cleanups.push(()=>{if(window.__pongDomSwapSync===observedSync)window.__pongDomSwapSync=existingSync;});
  }
  let running=true,last=0;
  const bounded=(a,x)=>{a.push(x);if(a.length>4000)a.shift()};
  const tick=t=>{if(!running)return;if(last)bounded(audit.rafIntervals,t-last);last=t;requestAnimationFrame(tick)};
  requestAnimationFrame(tick);
  let observer;
  try{observer=new PerformanceObserver(list=>list.getEntries().forEach(e=>bounded(audit.longTasks,{at:e.startTime,ms:e.duration})));observer.observe({type:'longtask',buffered:false})}catch{}
  const recordMediaEvent=(video,type)=>{
    const swap=window.__pongDomSwap,observed=window.__pongTikTokObservedVideo;
    const original=observed?.video===video,overlay=swap?.overlay===video;
    if(!original&&!overlay)return;
    const visible=!document.hidden&&(original?
      !(swap?.visible&&swap.original===video):!!swap.visible);
    const state=audit.media.get(video);
    if(type==='visibility'&&state?.visible===visible)return;
    if(state)state.visible=visible;
    bounded(audit.mediaEvents,{type,at:performance.now(),role:original?'original':'swap',
      videoId:(original?observed.pageUrl:swap.pageUrl||'').match(/video\/(\d+)/)?.[1]||'',
      session:overlay?swap.sessionId:'',mediaTime:video.currentTime,ready:video.readyState,
      paused:video.paused,seeking:video.seeking,visible});
  };
  const visibilityEvent=video=>recordMediaEvent(video,'visibility');
  const unwatch=video=>{audit.watched.get(video)?.();audit.watched.delete(video)};
  const watch=video=>{
    if(!video||!video.isConnected||audit.watched.has(video))return;
    const state={painted:0,mediaTime:0,lastPaintAt:0,waiting:0};audit.media.set(video,state);
    let callbackId;
    const callback=(now,frame)=>{if(!running||!video.isConnected){unwatch(video);return;}state.painted++;state.mediaTime=frame.mediaTime;state.lastPaintAt=now;
      const swap=window.__pongDomSwap;
      if(swap?.overlay===video&&swap.visible)bounded(audit.paintEvents,{session:swap.sessionId,videoId:(swap.pageUrl||'').match(/video\/(\d+)/)?.[1]||'',mediaTime:frame.mediaTime,at:now,presentationKind:swap.presentationKind||'video-rVFC'});
      const observed=window.__pongTikTokObservedVideo;
      if(observed?.video===video)bounded(audit.originalPaintEvents,{videoId:(observed.pageUrl||'').match(/video\/(\d+)/)?.[1]||'',at:now,mediaTime:frame.mediaTime,paused:video.paused});
      callbackId=video.requestVideoFrameCallback(callback)};
    if(video.requestVideoFrameCallback)callbackId=video.requestVideoFrameCallback(callback);
    const events=['waiting','stalled','playing','pause','seeking','seeked','ended','error'];
    const event=ev=>{
      if(!running)return;
      if(ev.type==='waiting')state.waiting++;
      recordMediaEvent(video,ev.type);
    };
    events.forEach(type=>video.addEventListener(type,event));
    audit.watched.set(video,()=>{events.forEach(type=>video.removeEventListener(type,event));if(callbackId!==undefined)video.cancelVideoFrameCallback(callbackId)});
  };
  const media=video=>{
    if(!video)return null;watch(video);visibilityEvent(video);const q=video.getVideoPlaybackQuality?.(),state=audit.media.get(video);
    return {...state,time:video.currentTime,paused:video.paused,ready:video.readyState,width:video.videoWidth,height:video.videoHeight,
      decoded:q?.totalVideoFrames??null,dropped:q?.droppedVideoFrames??null,seeking:video.seeking};
  };
  // MainActivity can republish the production synchronizer after this audit
  // installs (onPageFinished / mode resume). Never call it from a snapshot:
  // that would issue a second seek/play decision. Read the current DOM state
  // instead, so a replaced observation wrapper cannot freeze the reported
  // alignment while the application's own 100ms sync timer keeps running.
  const sampledSync=swap=>{
    const v=swap?.original,o=swap?.overlay;
    if(!v||!o)return null;
    try{
      const target=Number(v.currentTime||0)-Number(swap.start||0);
      let end=0;
      for(let i=0;i<o.buffered.length;i++)end=Math.max(end,o.buffered.end(i));
      return {active:true,visible:!!swap.visible,lag:Math.max(0,target-Number(o.currentTime||0)),
        target,bufferEnd:end,bufferHeadroom:end-target,readyState:o.readyState,
        ageMs:performance.now()-swap.createdAt,firstVisibleAt:swap.firstVisibleAt||0,
        sessionId:swap.sessionId,seeking:!!o.seeking,
        presentedMediaTime:swap.lastPaintedMediaTime??-1,
        paintedRecently:!!swap.lastPaintedAt&&(v.paused||performance.now()-swap.lastPaintedAt<750),
        sampledFrom:'dom-read'};
    }catch{return null}
  };
  const currentPost=()=>{
    const area=v=>{const r=v.getBoundingClientRect();return Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))};
    const videos=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')];
    const original=videos.sort((a,b)=>(area(b)+(area(b)>innerWidth*innerHeight*.22&&!b.paused?1e9:0))-(area(a)+(area(a)>innerWidth*innerHeight*.22&&!a.paused?1e9:0)))[0];
    const activeVideo=!!original&&area(original)>innerWidth*innerHeight*.22;
    const observed=window.__pongTikTokObservedVideo;
    // A route-ahead observer can still point at the outgoing video. Bind its
    // page ID to the actual visible player before claiming a video post.
    const videoKey=activeVideo&&observed?.video===original?
      (observed.pageUrl||'').match(/video\/(\d+)/)?.[1]||'':'';
    const photo=!activeVideo?[...document.querySelectorAll('img[class*="ImgPhotoSlide"]')]
      .find(e=>area(e)>innerWidth*innerHeight*.22):null;
    const photoCard=photo?.closest?.('[data-e2e="recommend-list-item-container"]')||
      photo?.closest?.('.swiper-slide')||null;
    const postEvidence=window.__pongTikTokPostEvidence;
    // A slide image is not a post identity: horizontal carousel navigation may
    // change its URL without any vertical feed navigation. Require the mobile
    // observer's React post ID bound to this exact visible image and card.
    const photoId=String(postEvidence?.photoId||'');
    const photoKey=photo&&photoCard?.isConnected&&postEvidence?.kind==='photo'&&
      postEvidence.photoCard===photoCard&&postEvidence.photoMedia===photo&&
      /^\d{15,22}$/.test(photoId)?'photo:'+photoId:'';
    const adId=String(window.__pongTikTokPostEvidence?.adId||'');
    const ad=window.__pongTikTokPostEvidence?.kind==='ad'&&
      /^\d{15,22}$/.test(adId)&&(!videoKey||adId===videoKey);
    // A valid active video outranks a lingering photo slide, matching the
    // production feed observer's positive-photo-only classification.
    const postKind=ad?'ad':videoKey?'video':photoKey?'photo':'unknown';
    const postKey=ad?'ad:'+window.__pongTikTokPostEvidence.adId:videoKey?'video:'+videoKey:
      photoKey;
    return {original,postKind,postKey};
  };
  window.__pongAuditCurrentPostKey=()=>currentPost().postKey;
  audit.cleanups.push(()=>{delete window.__pongAuditCurrentPostKey});
  const loginBlocked=()=>{
    const selectors='[role="dialog"],[aria-modal="true"],[data-e2e="login-modal"],[class*="DivLoginContainer"],[class*="DivModalContainer"]';
    return [...document.querySelectorAll(selectors)].some(node=>{
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
      if(rect.width<=0||rect.height<=0||rect.bottom<=0||rect.top>=innerHeight||style.display==='none'||style.visibility==='hidden')return false;
      const text=String(node.innerText||'');
      return /(?:Log in|Sign in|Sign up) (?:to|for) TikTok/i.test(text)&&
        /Use (?:QR code|phone or email)|Continue with (?:Google|Facebook|Apple)/i.test(text);
    });
  };
  window.__pongAuditSnapshot=()=>{
    const began=performance.now();
    // Observing 40 posts must not keep 40 retired media elements/decoders alive.
    // Only the site's still-connected elements may remain under observation.
    for(const video of audit.watched.keys())if(!video.isConnected)unwatch(video);
    const {original,postKind,postKey}=currentPost(),swap=window.__pongDomSwap;
    const challenge=!!document.querySelector('[class*="captcha-drag-icon"],[id^="captcha-verify-container"]');
    const originalState=media(original),swapState=media(swap?.overlay),elapsed=performance.now()-began;
    audit.snapshotCount++;audit.snapshotMs+=elapsed;audit.maxSnapshotMs=Math.max(audit.maxSnapshotMs,elapsed);
    return {at:performance.now(),challenge,loginBlocked:loginBlocked(),path:location.pathname,postKind,postKey,original:originalState,swap:swapState,session:swap?.sessionId||'',
      visible:!!swap?.visible,presentationKind:swap?.presentationKind||'video-rVFC',sourceStart:swap?.start??null,lastPaintedMediaTime:swap?.lastPaintedMediaTime??null,lastPaintedAt:swap?.lastPaintedAt??0,
      transport:swap?.transport??null,
      transportQueue:swap?{chunks:swap.queue?.length??0,bytes:(swap.queue||[]).reduce((n,b)=>n+b.byteLength,0),
        updating:!!swap.sourceBuffer?.updating,mediaSource:swap.mediaSource?.readyState||'',
        ended:!!swap.ended,aborted:!!swap.abort?.signal.aborted}:null,
      sync:window.__pongDomSwapSync===observedSync&&lastSync?.sessionId===swap?.sessionId?
        lastSync:sampledSync(swap),
      warm:window.__pongDomSwapWarm?{session:window.__pongDomSwapWarm.sessionId,ready:window.__pongDomSwapWarm.overlay.readyState,bytes:window.__pongDomSwapWarm.transport.bytes}:null,
      observerCost:{snapshots:audit.snapshotCount,totalMs:audit.snapshotMs,maxMs:audit.maxSnapshotMs},
      syncObservation:{calls:syncCalls,stillInstalled:window.__pongDomSwapSync===observedSync,
        currentFrameSync:!!window.__pongDomSwapSync?.pongFrameSync,
        currentStableHandoff:window.__pongDomSwapSync?.pongStableHandoff||0,
        productionSyncKnown:!!(window.__pongDomSwapSync?.pongFrameSync||
          window.__pongDomSwapSync?.pongStableHandoff===2),
        errors:syncErrors.slice()},
      originalPaintEvents:audit.originalPaintEvents.splice(0),paintEvents:audit.paintEvents.splice(0),mediaEvents:audit.mediaEvents.splice(0),rafIntervals:audit.rafIntervals.splice(0),longTasks:audit.longTasks.splice(0)};
  };
  document.querySelectorAll('video').forEach(watch);
  // Observe frames immediately when a decoder joins the real DOM, independent
  // of diagnostic polling frequency. No geometry, styles or playback mutations
  // in this hook, and no retention of retired elements between snapshots.
  if(typeof MutationObserver==='function'){
    const additions=new MutationObserver(records=>{
      for(const record of records)for(const node of record.addedNodes||[]){
        if(node.nodeType!==1)continue;
        if(node.tagName==='VIDEO')watch(node);
        node.querySelectorAll?.('video').forEach(watch);
      }
    });
    additions.observe(document.documentElement,{childList:true,subtree:true});
    audit.cleanups.push(()=>additions.disconnect());
  }
  window.__pongAuditStop=()=>{running=false;observer?.disconnect();for(const video of audit.watched.keys())unwatch(video);audit.cleanups.forEach(f=>f())};
  return {instrumented:true};
})()
