// Isolated receiver experiment. Reload is required because the observer reads
// its opt-in flag once; reinjecting the asset would duplicate event listeners.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/fast-clock-${Date.now()}.json`;
const result={experimental:true,startedAt:Date.now()},pause=ms=>new Promise(r=>setTimeout(r,ms));
const stableFeed=process.argv.includes('--stable-feed'),workerMse=process.argv.includes('--worker-mse');
const variant='29.29-'+(stableFeed?'stable-feed':'fast-clock')+(workerMse?'-worker-mse':'');
result.variant=variant;
const run=args=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
  PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_TRANSPORT_NETWORK:'0',
  PONG_AUDIT_VISUAL_EVIDENCE:'0',PONG_AUDIT_VARIANT:variant}});
 let log='';child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk)});
 child.once('error',reject);child.once('exit',code=>code===0?resolve(log):reject(Error(`Audit exited ${code}`)));
});
let tik,pong,scriptId;
try{
 await run(['scripts/prepare-tiktok-audit-receiver.mjs',...(workerMse?['--worker-mse']:[])]);
 tik=await connectWebView(60195,'tiktok');pong=await connectWebView(60195,'pong');
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await tik.call('Page.enable');
 scriptId=(await tik.call('Page.addScriptToEvaluateOnNewDocument',{source:'window.__pongMobileFastClockTrial=true;window.__pongMobileStableFeedTrial='+String(stableFeed)+';'})).identifier;
 await tik.call('Page.reload');
 let ready=false;
 for(let i=0;i<45;i++){
  const state=await tik.read(`({ready:window.__pongMobileFastClockTrial===true&&typeof window.__pongTikTokStep==='function'&&!!document.querySelector('video,img[class*=ImgPhotoSlide]'),flag:window.__pongMobileFastClockTrial===true,mobile:!!window.__pongMobileTikTokInstalled,step:typeof window.__pongTikTokStep,videos:document.querySelectorAll('video').length,challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')})`).catch(()=>({}));
  result.lastPreflight=state;
  if(state.challenge)throw Error('Verification requires user interaction; experiment not scored');
  if(state.ready){ready=true;break}await pause(1000);
 }
 if(!ready)throw Error('Trial observer did not initialize');
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const log=await run(['scripts/trace-tiktok-pipeline.mjs','--production']);
 result.trace=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 result.observerStats=await tik.read('window.__pongTikTokObserverStats||null');
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 if(pong){result.pause=await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(e=>({error:e.message}));pong.close()}
 if(tik){
  if(scriptId)await tik.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:scriptId}).catch(()=>{});
  await tik.call('Page.reload').catch(()=>{});
  for(let i=0;i<20;i++){
   result.restored=await tik.read('window.__pongMobileFastClockTrial!==true&&window.__pongMobileStableFeedTrial!==true&&typeof window.__pongTikTokStep==="function"').catch(()=>false);
   if(result.restored)break;await pause(500);
  }
  tik.close();
 }
 result.finishedAt=Date.now();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({saved:output,...result}));
}
