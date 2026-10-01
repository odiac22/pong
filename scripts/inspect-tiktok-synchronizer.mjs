import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const rows=[],errors=[];
const path=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/synchronizer-${Date.now()}.json`;
const off=tik.onEvent(event=>{
 if(event.method==='Runtime.exceptionThrown'){
  const d=event.params.exceptionDetails;
  errors.push({text:d.text,description:String(d.exception?.description||'').split('\n').slice(0,6).join('\n').replace(/https?:\/\/\S+/g,'[resource]')});
 }
});
try {
 await tik.call('Runtime.enable');
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 for(let i=0;i<10;i++){
  rows.push(await tik.read(`(()=>{const s=window.__pongDomSwap;try{return {active:!!s,stable:window.__pongDomSwapSync?.pongStableHandoff,frame:window.__pongDomSwapSync?.pongFrameSync,ready:s?.overlay.readyState,visible:s?.visible,sync:window.__pongDomSwapSync?.()}}catch(e){return {active:!!s,error:String(e),stack:e.stack?.split('\\n').slice(0,5)}}})()`));
  await new Promise(r=>setTimeout(r,500));
 }
}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 await tik.call('Runtime.disable').catch(()=>{});off();tik.close();pong.close();
 writeFileSync(path,JSON.stringify({rows,errors},null,2));console.log(JSON.stringify({saved:path,rows,errors}));
}
