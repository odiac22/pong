(async()=>{const w=pongFaceSwapCurrentWrapper(),id=w?.dataset.pongFaceSwapSessionId;
const state=JSON.parse(window.PongTikTokLiveIntegratedState?.()||'{}');
const route=value=>{try{const u=new URL(value,location.href);return {origin:u.origin,path:u.pathname,queryKeys:[...u.searchParams.keys()]}}catch{return null}};
const p=id?await pongFaceSwapBackgroundFetch('/pong-swap/sessions/'+encodeURIComponent(id),{cache:'no-store'}).then(r=>r.json()):{};const s=p.session||{};
return {page:location.origin,stream:route(state.streamUrl),frames:s.frames,bytesWritten:s.bytesWritten,sourceFps:s.sourceFps,fps:s.fps,start:s.startSeconds,subscribers:s.subscribers,fragments:s.completeFragments,muxed:s.muxedMediaSeconds,created:s.createdAt,firstByte:s.firstByteAt,playable:s.playableAt,streamRequests:s.streamRequests};})()
