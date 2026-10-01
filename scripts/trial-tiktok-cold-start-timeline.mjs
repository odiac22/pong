// Warm-renderer, current-page start-offset diagnostic. Never moves TikTok's
// original playhead forward or changes renderer pixels/quality. Not swipe QA.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),pool=process.argv[2];
if(!pool)throw Error('Observed source-page pool required');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/start-timeline-${Date.now()}.json`;
const result={diagnosticOnly:true,qualityChanged:false,offsets:[0,.6,1,1,.6,0],runs:[]};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
try{
 await pong.read(pause);
 const h=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
 if(!h.ready||h.stageDiagnosticsTrial?.active)throw Error('Expected warm ordinary renderer');
 for(const offset of result.offsets){
  await pong.read(pause);
  await pong.read(`(()=>{
   if(window.__pongUndoStartTimelineTrial)throw Error('Trial already installed');
   const previous=startPongFaceSwap;window.__pongStartTimelineCalls=[];
   startPongFaceSwap=(faceId,options={})=>{
    const time=Number(pongTikTokLiveState.timelineSeconds||0),duration=Number(pongTikTokLiveState.durationSeconds||0);
    const wrapper=pongFaceSwapCurrentWrapper();
    if(${offset}>0&&wrapper?.dataset.pongExternalPlaybackAuthority==='true'&&
       options.absoluteSourceTimeline&&!options.prefetchedEntry&&time<=.8&&
       (!duration||duration-time>${offset}+.5)&&!pongFaceSwapState.prefetches.size){
     options={...options,startSeconds:time+${offset}};
     window.__pongStartTimelineCalls.push({time,start:options.startSeconds});
    }
    return previous(faceId,options);
   };
   window.__pongUndoStartTimelineTrial=()=>{startPongFaceSwap=previous;delete window.__pongUndoStartTimelineTrial;};
   return true;
  })()`);
  const record=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['scripts/diagnose-tiktok-repeatable-pages.mjs',pool,'--current-page'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_PAGE_LIMIT:'1',
     PONG_AUDIT_DIAGNOSTIC_MS:'4000',PONG_AUDIT_VARIANT:`cold-start-offset-${offset}`}});
   let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
   child.once('error',reject);child.once('exit',code=>{
    try{const r=JSON.parse(log.trim().split(/\r?\n/).at(-1));if(code||r.error)reject(Error(r.error||`Replay failed ${code}`));else resolve(r)}catch(e){reject(e)}
   });
  });
  result.runs.push({offset,...record,calls:await pong.read('window.__pongStartTimelineCalls')});
  await pong.read('window.__pongUndoStartTimelineTrial?.();true');
  writeFileSync(output,JSON.stringify(result,null,2));
 }
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 await pong.read(pause).catch(()=>{});
 result.restored=await pong.read('window.__pongUndoStartTimelineTrial?.();!window.__pongUndoStartTimelineTrial').catch(()=>false);
 pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
