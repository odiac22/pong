import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
try{
 const ids=await pong.read(`[...pongFaceSwapState.prefetches.values()].map(e=>e.sessionId).filter(Boolean)`);
 for(const id of ids.slice(0,2)){
  for(const [layer,base] of [['renderer','http://127.0.0.1:8792/sessions/'],['helper','http://127.0.0.1:8787/pong-swap/sessions/']]){
   const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),2500),started=performance.now();
   try{const r=await fetch(base+encodeURIComponent(id)+'/stream?attach=1&transport=mse',{signal:stop.signal});const part=await r.body.getReader().read();
    console.log(JSON.stringify({layer,id,status:r.status,bytes:part.value?.byteLength||0,done:part.done,length:r.headers.get('content-length'),type:r.headers.get('content-type'),ms:performance.now()-started}));
   }catch(e){console.log(JSON.stringify({layer,id,error:e.name}))}finally{clearTimeout(timer);stop.abort()}
  }
  console.log(await tik.read(`(async()=>{const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),2500),started=performance.now();try{const r=await fetch('/__pong_swap/'+${JSON.stringify(id)}+'?attach=1',{signal:stop.signal,cache:'no-store'});const p=await r.body.getReader().read();return {layer:'native',id:${JSON.stringify(id)},status:r.status,bytes:p.value?.byteLength||0,done:p.done,length:r.headers.get('content-length'),type:r.headers.get('content-type'),ms:performance.now()-started}}catch(e){return {layer:'native',error:e.name}}finally{clearTimeout(timer);stop.abort()}})()`));
 }
}finally{pong.close();tik.close()}
