import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/cold-lead-trial-${Date.now()}.json`;
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const result={};
try{
 await pong.read(pause);
 result.installed=await pong.read(`(()=>{
  const prior=startPongFaceSwap;
  window.__pongColdLeadCalls=[];
  window.__pongUndoColdLead=()=>{startPongFaceSwap=prior;delete window.__pongUndoColdLead;};
  startPongFaceSwap=(faceId,options={})=>{
   if(document.documentElement.classList.contains('pong-tiktok-original-overlay')&&options.absoluteSourceTimeline&&!options.prefetchedEntry){
    const time=Number(pongTikTokLiveState.timelineSeconds||0),duration=Number(pongTikTokLiveState.durationSeconds||0);
    if(time<=.8&&(!duration||duration-time>1.5)){
     options={...options,startSeconds:time+.6};
     window.__pongColdLeadCalls.push({time,target:options.startSeconds});
    }
   }
   return prior(faceId,options);
  };return true;
 })()`);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 await new Promise(r=>setTimeout(r,6000));
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','8'],{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_VARIANT:'29.11-cold-start-lead-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 result.calls=await pong.read('window.__pongColdLeadCalls');
}finally{
 await pong.read(pause).catch(()=>{});
 await pong.read('window.__pongUndoColdLead?.();true').catch(()=>{});pong.close();
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
