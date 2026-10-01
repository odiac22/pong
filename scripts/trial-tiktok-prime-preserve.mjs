import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/prime-preserve-${Date.now()}.json`;
const result={experimental:true,qualityChanged:false,restored:false};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
try{
  await pong.read(pause);
  result.installed=await tik.read(readFileSync('scripts/tiktok-prime-preserve-trial.js','utf8'));
  if(!result.installed)throw Error('Trial not installed');
  await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
  const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs','--production'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
      PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_TRANSPORT_NETWORK:'0',
      PONG_AUDIT_VARIANT:'29.26-connected-first-frame-preserve-no-seek-trial'}});
  let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
  result.exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  try{result.trace=JSON.parse(log.trim().split(/\r?\n/).at(-1))}catch{result.error='Missing final trace'}
}finally{
  await pong.read(pause).catch(()=>{});
  result.evidence=await tik.read('window.__pongPrimePreserveEvidence||[]').catch(()=>[]);
  result.restored=await tik.read('window.__pongUndoPrimePreserve?.();!window.__pongUndoPrimePreserve').catch(()=>false);
  tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({saved:output,...result}));
}
