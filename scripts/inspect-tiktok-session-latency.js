(async()=>{
 const active=pongFaceSwapCurrentWrapper();
 const entries=[{id:active?.dataset.pongFaceSwapSessionId,kind:'active'},...Array.from(pongFaceSwapState.prefetches.values(),e=>({id:e.sessionId,kind:'prefetch',ready:e.ready,nativeWarm:!!e.nativeWarmRequested}))];
 return await Promise.all(entries.filter(e=>e.id).map(async e=>{
   const r=await pongFaceSwapBackgroundFetch('/pong-swap/sessions/'+encodeURIComponent(e.id),{cache:'no-store'});
   const {session:s={}}=await r.json();
   const elapsed=k=>s[k]&&s.createdAt?Math.round((s[k]-s.createdAt)*1000):null;
   return {...e,state:s.state,frames:s.frames,transformedFrames:s.transformedFrames,fps:s.fps,
    sourceMs:elapsed('sourceOpenedAt'),modelsMs:elapsed('modelsReadyAt'),firstFrameMs:elapsed('firstSourceFrameAt'),
    firstByteMs:elapsed('firstByteAt'),reason:s.multiFace?.reason,errorCode:s.errorCode,
    timingTotals:s.timingTotals};
 }));
})()
