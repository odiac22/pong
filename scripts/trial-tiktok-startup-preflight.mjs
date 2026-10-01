// Matched-source, fresh-renderer diagnostic. Not a visible-paint/FPS benchmark.
// Restores normal service flags and keeps the signed test receiver's login.
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/startup-preflight-${Date.now()}.json`;
const source='https://www.tiktok.com/@spambiebambi/video/7689552051906432270';
const report={diagnosticOnly:true,scope:'matched_source_offscreen_first_frame_not_visible_swipe',runs:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function child(binary,args){
 return new Promise((resolve,reject)=>{
  const proc=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='';
  proc.stdout.on('data',data=>{if(stdout.length<64000)stdout+=data;});
  // Discard stderr: a nested launch error could include private arguments.
  proc.stderr.resume();
  proc.once('error',()=>reject(Error('Diagnostic child could not start')));
  proc.once('exit',code=>{
   // A launched background renderer can inherit Windows pipe handles even
   // though its own log files are redirected. Do not let those keep this
   // finished diagnostic process alive after the PowerShell child exits.
   proc.stdout.destroy();proc.stderr.destroy();proc.unref();
   const objects=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
   if(code!==0)reject(Error(`Diagnostic child failed with exit ${code}`));
   else resolve(objects);
  });
 });
}
async function restart(warm,diagnostics=true){
 const args=['-NoProfile','-File','scripts/restart-pong-renderer-thread-trial.ps1','-WaitForWarm','-Apply'];
 if(diagnostics)args.push('-RemoteFrameDiagnostics');
 if(warm)args.push('-FullPathWarmup');
 // The launcher contains Python -c arguments; PS7 preserves their quotes.
 // Windows PowerShell 5 strips those quotes before Python can validate hashes.
 await child('pwsh.exe',args);
 const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
 return health.remoteFullPathWarmup??{enabled:false};
}
async function navigateSource(){
 const tik=await connectWebView(60195,'tiktok');
 try {
  await tik.call('Page.navigate',{url:source});
  for(let attempt=0;attempt<60;attempt++){
   const state=await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
    return {ready:location.pathname==='/@spambiebambi/video/7689552051906432270'&&
      !!v&&v.readyState>=2&&!v.paused&&v.muted,
      challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')};})()`);
   if(state.challenge)throw Error('Verification requires user; no frame captured');
   if(state.ready)return;
   await pause(250);
  }
  throw Error('Known muted source did not become ready');
 }finally{tik.close()}
}
try{
 for(const warm of [false,true]){
  const started=performance.now();
  const health=await restart(warm);
  const startupMs=performance.now()-started;
  await navigateSource();
  // This source loops quickly. One frame captures the fresh-process cost
  // without mistaking a later loop/seek for a transport regression.
  const run={warm,startupMs,health};report.runs.push(run);
  const artifacts=await child(process.execPath,['scripts/trial-tiktok-binary-frame-render.mjs','1','--reverse']);
  run.artifacts=artifacts;
  writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({warm,startupMs,health,artifacts}));
 }
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
 try{await restart(false,false);report.normalRendererRestored=true;}
 catch{report.normalRendererRestored=false;process.exitCode=1;}
 writeFileSync(output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({output,error:report.error??null,normalRendererRestored:report.normalRendererRestored}));
}
