// Manual-only byte-identical receive A/B on the same visible source section.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
if(process.argv.length!==3||!['--batch','--normal'].includes(process.argv[2]))
 throw Error('Use --batch or --normal');
const batch=process.argv[2]==='--batch';
const t=await connectWebView(60195,'tiktok'),p=await connectWebView(60195,'pong');
const result={diagnosticOnly:true,batch,started:new Date().toISOString()};
let prior;
try{
 await p.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 prior=await t.read(`(()=>{
  if(window.__pongDomSwap||window.__pongDomSwapWarm)throw Error('Receiver not idle');
  if(typeof window.__pongCreateFragmentBatch!=='function')throw Error('Fragment factory missing');
  const prior=window.__pongFragmentBatchTrial===true;
  window.__pongFragmentBatchTrial=${batch};return prior;
 })()`);
 const child=spawn(process.execPath,['scripts/experiment-tiktok-producer-jank.mjs',
  '--run-isolated-jank-trial','--same-playhead','--start-seconds','6'],
  {windowsHide:true,stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',data=>{log+=data;process.stdout.write(data)});
 child.stderr.on('data',data=>process.stderr.write(data));
 result.exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
 result.child=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 if(result.exit)process.exitCode=1;
}finally{
 await p.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 if(prior!==undefined)result.restored=await t.read(`(()=>{
  if(window.__pongFragmentBatchTrial!==${batch})return false;
  window.__pongFragmentBatchTrial=${prior};return true;
 })()`).catch(()=>false);
 t.close();p.close();
 const file=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/fragment-jank-${Date.now()}.json`;
 writeFileSync(file,JSON.stringify(result,null,2));
 console.log(JSON.stringify({file,...result}));
}
