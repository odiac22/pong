import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok');
const result={experimental:true,startedAt:Date.now()},output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/original-visibility-${Date.now()}.json`;
try{
  result.installed=await tik.read(readFileSync('scripts/tiktok-original-visibility-trial.js','utf8'));
  const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
      PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_VARIANT:'29.21-original-visibility'}});
  let log='';child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk)});
  result.exit=await new Promise(resolve=>child.once('exit',resolve));
  result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
  result.stats=await tik.read('window.__pongOriginalVisibilityStats');
}finally{
  result.restored=await tik.read('window.__pongUndoOriginalVisibility?.();!window.__pongUndoOriginalVisibility').catch(()=>false);
  tik.close();result.finishedAt=Date.now();writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({saved:output,...result}));
}
