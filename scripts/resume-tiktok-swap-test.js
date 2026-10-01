(()=>{
 const selected=typeof pongFaceSwapSelectionKey==='function'&&pongFaceSwapSelectionKey();
 if(!selected)return {started:false,reason:'Approved face selection needed after app update'};
 if(!pongTikTokLiveState.current)return {started:false,reason:'Waiting for active TikTok video'};
 window.PongTikTokLiveEnableSelectedSwap();
 return {started:window.PongTikTokLiveSwapCurrent(pongTikTokLiveState.current,0)};
})()
