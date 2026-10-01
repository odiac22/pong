(async()=>{
 setPongFaceSwapPersistentEnabled(false);
 const wrappers=[...document.querySelectorAll('.video-wrapper')].filter(w=>w.dataset.pongExternalPlaybackAuthority==='true');
 await Promise.all(wrappers.map(w=>stopPongFaceSwapForWrapper(w,{restore:false,detachMedia:true})));
 return {pausedAuditWrappers:wrappers.length,selectedFacesPreserved:pongFaceSwapFaceIds().length};
})()
