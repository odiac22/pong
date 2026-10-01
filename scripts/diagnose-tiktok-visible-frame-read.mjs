// Diagnostic only: sample already-playing original pixels using ordinary
// browser APIs. Never weakens origin rules or fetches a denied source URL.
// No pixels, media URLs, page text, or credentials are saved or returned.
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
if(process.argv.length!==3||process.argv[2]!=='--run-emulator-frame-read')
  throw Error('Explicit emulator frame-read flag required');
const client=await connectWebView(60195,'tiktok');
try {
  const result=await client.read(`(async()=>{
    const observed=window.__pongTikTokObservedVideo,v=observed?.video;
    if(!v?.isConnected||v.paused||v.readyState<2||window.__pongDomSwap||window.__pongDomSwapWarm)
      return {valid:false,reason:'need-original-playing-without-swap'};
    if(document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'))
      return {valid:false,reason:'verification-required'};
    const page=observed.pageUrl,canvas=document.createElement('canvas');
    if(!v.videoWidth||!v.videoHeight||v.videoWidth*v.videoHeight>4096*2160)
      return {valid:false,reason:'invalid-or-oversized-source'};
    canvas.width=v.videoWidth;canvas.height=v.videoHeight;
    const context=canvas.getContext('2d',{willReadFrequently:true}),samples=[];
    const same=()=>v.isConnected&&window.__pongTikTokObservedVideo?.video===v&&
      window.__pongTikTokObservedVideo?.pageUrl===page;
    try {
      for(let i=0;i<3;i++){
        if(!same())return {valid:false,reason:'source-changed'};
        await new Promise((resolve,reject)=>{
          let callback=0;const timeout=setTimeout(()=>{
            if(callback)v.cancelVideoFrameCallback?.(callback);reject(Error('frame-timeout'));
          },1500);
          callback=v.requestVideoFrameCallback(()=>{clearTimeout(timeout);resolve()});
        });
        if(!same())return {valid:false,reason:'source-changed'};
        const began=performance.now();
        context.drawImage(v,0,0,canvas.width,canvas.height);
        const drawn=performance.now();
        const pixels=context.getImageData(0,0,canvas.width,canvas.height);
        const read=performance.now();
        samples.push({drawMs:drawn-began,readMs:read-drawn,totalMs:read-began,
          bytes:pixels.data.byteLength,mediaTime:v.currentTime});
      }
      return {valid:same(),width:canvas.width,height:canvas.height,samples,
        note:'CPU pixel readback only; no transport, render, or visible-swap claim'};
    }catch(error){return {valid:false,reason:error.name==='SecurityError'?'origin-readback-denied':
      error.message==='frame-timeout'?'frame-timeout':'readback-failed'};}
    finally{canvas.width=canvas.height=0;canvas.remove();}
  })()`);
  const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/visible-frame-read-${Date.now()}.json`;
  writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,...result}));
}finally{client.close()}
