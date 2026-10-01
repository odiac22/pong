import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60196,'pong');
try{
 if(process.argv.includes('--seek')) console.log(await c.read(`(async()=>{const w=pongFaceSwapCurrentWrapper(),v=w.querySelector('video');silenceAllPongAudioExcept();v.muted=true;v.volume=0;v.pause();w.dataset.userPaused='true';w.dataset.playIntent='false';delete w.dataset.userAudioIntent;delete w.dataset.pongFaceSwapBusy;return seekPongVideoTo(w,v,100)})()`));
 for(let i=0;i<12;i++){
 console.log(await c.read(`(()=>{const w=pongFaceSwapCurrentWrapper(),v=w.querySelector('video');return {phase:w.dataset.pongFaceSwapPhase,busy:w.dataset.pongFaceSwapBusy,start:v.__pongSwapOriginal?.startSeconds,time:v.currentTime,duration:v.duration,ended:v.ended,ready:v.readyState,presented:v.__pongSwapPresentedMediaTime,session:w.dataset.pongFaceSwapSessionId,events:PongRuntimeDiagnostics.snapshot().events.filter(e=>e.type==='swap.prefetch-selection').slice(-2)}})()`));
 await new Promise(r=>setTimeout(r,1000));
 }
}finally{c.close()}
