import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/fragment-batch-${Date.now()}.json`,result={};
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 result.installed=await tik.read(readFileSync('scripts/tiktok-fragment-batch-trial.js','utf8'));
 if(!result.installed?.installed)throw Error('Fragment experiment was not installed');
 const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
   PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_VARIANT:'29.21-complete-fragment-appends'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));
 try{result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1))}catch{result.error='Missing benchmark summary'}
}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 result.stats=await tik.read('window.__pongFragmentBatchStats||null').catch(()=>null);
 result.restored=await tik.read('window.__pongUndoFragmentBatch?.();!window.__pongUndoFragmentBatch').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({saved:output,...result}));
}
