// Controlled same-page diagnostic, not the forty-video acceptance benchmark.
// Withhold speculative sessions until the external player has really painted.
// Source cache warming, foreground pixels/models and reveal evidence are unchanged.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const pool=process.argv[2];
if(!pool)throw Error('An observed single-page pool is required');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/foreground-admission-${Date.now()}.json`;
const result={diagnosticOnly:true,qualityChanged:false,sequence:['guard','baseline','baseline','guard'],runs:[]};
const run=variant=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['scripts/diagnose-tiktok-repeatable-pages.mjs',pool,'--current-page'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_PAGE_LIMIT:'1',
   PONG_AUDIT_DIAGNOSTIC_MS:'4000',PONG_AUDIT_VARIANT:`foreground-admission-${variant}`}});
 let log='';child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk)});
 child.once('error',reject);child.once('exit',code=>{
  try {const record=JSON.parse(log.trim().split(/\r?\n/).at(-1));
   if(code!==0||record.error)reject(Error(`Replay failed: ${record.error||code}`));else resolve(record);
  } catch(error){reject(error)}
 });
});
try {
 await pong.read(pause);
 const h=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
 if(!h.ready||h.stageDiagnosticsTrial?.active)throw Error('Expected warm ordinary renderer');
 result.rendererReadyBefore=h.ready;
 for(const variant of result.sequence){
  await pong.read(pause);
  if(variant==='guard') await pong.read(`(()=>{
   if(window.__pongUndoAdmissionTrial)throw Error('Trial already installed');
   const previous=schedulePongFaceSwapPrefetch;
   schedulePongFaceSwapPrefetch=function(delay){
    const w=pongFaceSwapCurrentWrapper();
    if(pongTikTokLiveState.activeVideo!==false&&w?.dataset.pongExternalPlaybackAuthority==='true'&&
       (!w.dataset.pongFaceSwapSessionId||w.dataset.pongTikTokPresentedSession!==w.dataset.pongFaceSwapSessionId)){
      clearTimeout(pongFaceSwapState.prefetchTimer);pongFaceSwapState.prefetchTimer=null;return;
    }
    return previous(delay);
   };
   window.__pongUndoAdmissionTrial=()=>{schedulePongFaceSwapPrefetch=previous;delete window.__pongUndoAdmissionTrial;};
   return true;
  })()`);
  const record=await run(variant);result.runs.push({variant,...record});
  await pong.read('window.__pongUndoAdmissionTrial?.();true');
  writeFileSync(output,JSON.stringify(result,null,2));
 }
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 await pong.read(pause).catch(()=>{});
 result.restored=await pong.read('window.__pongUndoAdmissionTrial?.();!window.__pongUndoAdmissionTrial').catch(()=>false);
 pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
