// On-device opt-in experiment, with ordinary source selection and renderer.
// The APK's own receiver batches unchanged bytes; no global fetch interception.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/owned-fragments-${Date.now()}.json`;
const result={experimental:true};
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 result.installed=await tik.read(`(()=>{
   if(typeof window.__pongCreateFragmentBatch!=='function')throw Error('Install the fragment-test APK first');
   window.__pongFragmentBatchTrial=true;return true;
 })()`);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs','--production'],{
   windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
     PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',
     PONG_AUDIT_VARIANT:'29.25-owned-fragment-batches'}});
 let log='';child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));
 try{result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1))}catch{result.error='Missing benchmark result'}
}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 result.restored=await tik.read('window.__pongFragmentBatchTrial=false;window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();window.__pongFragmentBatchTrial===false').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({saved:output,...result}));
}
