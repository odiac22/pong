// Disposable queue policy: one speculative TikTok GPU job, still cache later
// source bytes. No model, encoder, resolution or saved settings changes.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/nearest-prefetch-${Date.now()}.json`;
const result={};
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 result.installed=await pong.read(`(()=>{
  const previous=schedulePongFaceSwapPrefetch;
  let source=previous.toString();
  const budget='const withinDeckBudget = paperclipPredictions.length';
  const jobs='const paperclipJobs = paperclipPredictions';
  if(!source.includes(budget)||!source.includes(jobs))throw Error('Scheduler source changed; experiment not installed');
  source=source.replace(budget,'const withinDeckBudget = isTikTokDeck ? 1 : paperclipPredictions.length')
    .replace(jobs,'const paperclipJobs = (isTikTokDeck ? [] : paperclipPredictions)');
  schedulePongFaceSwapPrefetch=eval('('+source+')');
  window.__pongUndoNearestPrefetch=()=>{schedulePongFaceSwapPrefetch=previous;delete window.__pongUndoNearestPrefetch;};
  return true;
 })()`);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const combined=process.argv.includes('--settled');
 const child=spawn(process.execPath,combined?['scripts/trial-tiktok-scroll-settled.mjs']:['scripts/benchmark-tiktok-emulator.mjs',process.env.PONG_AUDIT_COUNT||'8','--videos'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'500',PONG_AUDIT_VARIANT_PREFIX:process.env.PONG_AUDIT_VARIANT_PREFIX||'protected-bootstrap-nearest',PONG_AUDIT_VARIANT:process.env.PONG_AUDIT_VARIANT||'nearest-only-prefetch-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));
 result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 await pong.read('window.__pongUndoNearestPrefetch?.();true').catch(()=>{});
 pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
