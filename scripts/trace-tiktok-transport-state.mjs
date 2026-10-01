import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const samples=[],began=performance.now(),out=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/transport-${Date.now()}.json`;
try{
 while(performance.now()-began<20000){
  const view=await tik.read(`(()=>{const s=window.__pongDomSwap,w=window.__pongDomSwapWarm;const read=x=>x?{session:x.sessionId,warm:x.warm,ready:x.overlay.readyState,transport:x.transport,queued:x.queue.length,visible:x.visible,ended:x.ended,aborted:x.abort.signal.aborted}:null;return {path:location.pathname,active:read(s),warm:read(w),failure:window.__pongDomSwapLastFailure||null,original:s?{time:s.original?.currentTime,ready:s.original?.readyState,paused:s.original?.paused}:null}})()`);
  const owner=await pong.read(`(()=>{const w=pongFaceSwapCurrentWrapper();return {post:pongTikTokLiveState.current?.match(/video\\/(\\d+)/)?.[1],session:w?.dataset.pongFaceSwapSessionId,phase:w?.dataset.pongFaceSwapPhase,selected:pongFaceSwapState.selectedFaceIds?.length}})()`);
  const server=await fetch('http://127.0.0.1:8792/sessions').then(r=>r.json()).then(x=>(x.sessions||[]).map(s=>({id:s.id,state:s.state,complete:s.complete,frames:s.frames,bytes:s.bytesWritten,error:s.errorCode,transformed:s.transformedFrames,reason:s.multiFace?.reason,sourceMs:s.sourceOpenedAt?(s.sourceOpenedAt-s.createdAt)*1000:null,timings:s.timingTotals}))).catch(()=>[]);
  samples.push({at:performance.now()-began,view,owner,server});
  await new Promise(r=>setTimeout(r,500));
 }
}finally{tik.close();pong.close();writeFileSync(out,JSON.stringify(samples,null,2));console.log(JSON.stringify({saved:out,first:samples[0],last:samples.at(-1)}));}
