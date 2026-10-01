(()=>{
 const w=pongFaceSwapCurrentWrapper();
 const b=document.getElementById('pong-face-swap-button');
 return {overlay:document.documentElement.classList.contains('pong-tiktok-original-overlay'),label:b?.textContent,green:b?.classList.contains('active'),session:w?.dataset.pongFaceSwapSessionId,evidenceSession:w?.dataset.pongSwapEvidenceSession,transformedFrames:w?.dataset.pongSwapTransformedFrames,presentedSession:w?.dataset.pongTikTokPresentedSession};
})()
