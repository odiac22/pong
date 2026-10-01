// Own the benchmark lifecycle; leave no test GPU sessions running on failure.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/live-audit-${Date.now()}.json`;
const count=Number(process.env.PONG_AUDIT_COUNT||40);
if(!Number.isInteger(count)||count<1||count>40)throw Error('Expected 1–40 videos');
const result={startedAt:Date.now(),count,visualEvidence:process.env.PONG_AUDIT_VISUAL_EVIDENCE==='1',paused:false};
const run=args=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_COUNT:String(count)}});
 let log='';child.stdout.on('data',data=>{log+=data;process.stdout.write(data)});
 child.once('error',reject);child.once('exit',code=>code===0?resolve(log):reject(Error(`Audit command failed (${code})`)));
});
try{
 const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
 result.colorGraphTrialBefore=health.colorGraphTrial||null;
 await run(['scripts/prepare-tiktok-audit-receiver.mjs']);
 if(process.env.PONG_AUDIT_EVENT_HANDOFF==='1'){
  await run(['scripts/activate-tiktok-stream-test.mjs']);
  result.eventHandoffCandidate=true;
 }
 const log=await run(['scripts/trace-tiktok-pipeline.mjs','--production']);
 result.trace=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 try{
  const pong=await connectWebView(60195,'pong');
  try{result.pauseResult=await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));result.paused=true}
  finally{pong.close()}
 }catch(error){result.pauseError=error.message;process.exitCode=1}
 try{const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());result.colorGraphTrialAfter=health.colorGraphTrial||null}catch{}
 result.finishedAt=Date.now();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({saved:output,...result}));
}
