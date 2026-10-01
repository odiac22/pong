import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/decoder-prime-${Date.now()}.json`;
const result={experimental:true};
try{
 result.installed=await tik.read(`(()=>{
  const prior=window.__pongDomSwapPrepare,cleanups=new Set();window.__pongPrimeEvidence=[];
  const prime=s=>{
   if(!s||s.primedByTrial||!s.warm)return;s.primedByTrial=true;
   const o=s.overlay;const event={session:s.sessionId,requestedAt:performance.now(),initialReady:o.readyState};
   window.__pongPrimeEvidence.push(event);
   o.style.cssText='position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;z-index:-1!important';
   o.setAttribute('aria-hidden','true');document.body.appendChild(o);
   let timer=0,frame;const stillWarm=()=>window.__pongDomSwapWarm===s&&s.warm&&!s.abort.signal.aborted;
   const clean=()=>{clearTimeout(timer);if(frame!==undefined)o.cancelVideoFrameCallback?.(frame);o.removeEventListener('loadeddata',run);cleanups.delete(clean)};
   const stop=()=>{if(stillWarm()){o.pause();try{o.currentTime=0}catch{}event.stoppedAt=performance.now();event.ready=o.readyState;}clean()};
   const run=()=>{if(!stillWarm()){clean();return}event.startedAt??=performance.now();
    if(o.requestVideoFrameCallback)frame=o.requestVideoFrameCallback(()=>{event.frameAt=performance.now();stop()});
    o.play().catch(()=>stop());timer=setTimeout(stop,250);
   };
   cleanups.add(clean);s.abort.signal.addEventListener('abort',clean,{once:true});
   o.addEventListener('loadeddata',run,{once:true});if(o.readyState>=2)run();
  };
  window.__pongDomSwapPrepare=(...args)=>{const value=prior(...args);prime(window.__pongDomSwapWarm);return value};
  prime(window.__pongDomSwapWarm);
  window.__pongUndoDecoderPrime=()=>{window.__pongDomSwapPrepare=prior;for(const f of cleanups)f();delete window.__pongUndoDecoderPrime};return true;
 })()`);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 await new Promise(r=>setTimeout(r,6000));
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','8'],{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_VARIANT:'29.12-decoder-prime'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 result.priming=await tik.read('window.__pongPrimeEvidence');
}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 result.restored=await tik.read('window.__pongUndoDecoderPrime?.();!window.__pongUndoDecoderPrime').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
