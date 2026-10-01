// Emulator-only attribution test. No credentials, cookies or quality settings
// are read or changed. Every condition starts at the same actual creator grid.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const device='emulator-5582',pkg='com.odiac22.pong2';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/clean-navigation-${Date.now()}.json`;
const run={diagnosticOnly:true,audio:'silent emulator',conditions:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const shell=(...args)=>execFileSync(adb,['-s',device,...args],{encoding:'utf8',timeout:15000});
let tik,pong;
async function wait(expression,timeout=20000){
 const deadline=performance.now()+timeout;
 while(performance.now()<deadline){
  if(await tik.read(`!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')`))throw Error('Verification required; stopped without puzzle interaction');
  if(await tik.read(expression))return;
  await sleep(150);
 }
 throw Error('Timed out waiting for test page');
}
async function boot(clean){
 tik?.close();pong?.close();tik=pong=null;
 shell('shell','am','force-stop',pkg);
 shell('shell','am','start','-n',`${pkg}/com.odiac22.pong.MainActivity`,'--ez','pong_audit_clean_tiktok',String(clean));
 for(let i=0;i<40;i++){
  await sleep(200);
  try{
   const pid=shell('shell','pidof',pkg).trim();if(!/^\d+$/.test(pid))continue;
   shell('forward','tcp:60195',`localabstract:webview_devtools_remote_${pid}`);
   pong=await connectWebView(60195,'pong');break;
  }catch{}
 }
 if(!pong)throw Error('Receiver WebView unavailable');
 for(let i=0;i<50;i++){
  const ready=await pong.read('typeof window.PongTikTokLiveSwapCurrent==="function"');
  if(ready)break;await sleep(200);
 }
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await pong.read(readFileSync('scripts/open-tiktok-emulator.js','utf8'));
 for(let i=0;i<40&&!tik;i++){try{tik=await connectWebView(60195,'tiktok')}catch{await sleep(200)}}
 if(!tik)throw Error('TikTok WebView unavailable');
}
try{
 for(const condition of ['integrated-before','clean-layout-only','integrated-after']){
  const clean=condition==='clean-layout-only';await boot(clean);
  await tik.read(readFileSync('scripts/tiktok-audit-open-creator.js','utf8'));
  await wait('!!document.querySelector("[data-e2e=user-post-item] a[href*=\\"/video/\\"]")');
  const opened=await tik.read(readFileSync('scripts/tiktok-audit-open-profile-video.js','utf8'));
  if(!opened.opened)throw Error('Creator video not opened');
  await wait('!!document.querySelector("button[aria-label=\\"Next video\\"]") && [...document.querySelectorAll("video")].some(v=>!v.paused&&v.readyState>=2)');
  const state=await tik.read('({stream:typeof window.__pongDomSwapSync,observer:typeof window.__pongTikTokScan,ua:navigator.userAgent,viewport:[innerWidth,innerHeight],path:location.pathname})');
  if(clean&&state.stream!=='undefined')throw Error('Clean experiment did not exclude swap instrumentation');
  const result={condition,state,trials:[]};run.conditions.push(result);
  for(let i=0;i<4;i++){
   const trial=await tik.read(`new Promise(resolve=>{
    const before=location.pathname,start=performance.now(),next=document.querySelector('button[aria-label="Next video"]');
    if(!next)return resolve({error:'No actual Next control'});
    let routeMs=null,playingMs=null,paintMs=null,previous=0;const raf=[],frames=new Map();
    const frame=now=>{if(previous)raf.push(now-previous);previous=now;if(performance.now()-start<4000)requestAnimationFrame(frame)};
    requestAnimationFrame(frame);
    const sample=()=>{
     if(location.pathname!==before&&routeMs===null)routeMs=performance.now()-start;
     for(const v of document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')){
      const r=v.getBoundingClientRect(),visible=r.bottom>innerHeight*.5&&r.top<innerHeight*.5&&r.width>100;
      if(routeMs!==null&&visible&&!v.paused&&v.readyState>=2&&playingMs===null)playingMs=performance.now()-start;
      if(!frames.has(v)&&v.requestVideoFrameCallback){
       const f=(now,m)=>{const r=v.getBoundingClientRect();if(routeMs!==null&&paintMs===null&&!v.paused&&r.top<innerHeight*.5&&r.bottom>innerHeight*.5)paintMs=performance.now()-start;frames.set(v,v.requestVideoFrameCallback(f))};
       frames.set(v,v.requestVideoFrameCallback(f));
      }
     }
    };
    const timer=setInterval(sample,40);sample();next.click();const handlerMs=performance.now()-start;
    setTimeout(()=>{clearInterval(timer);for(const [v,id]of frames)v.cancelVideoFrameCallback?.(id);resolve({before,after:location.pathname,handlerMs,routeMs,playingMs,paintMs,raf})},4000);
   })`);
   result.trials.push(trial);
   console.log(JSON.stringify({condition,index:i+1,handlerMs:trial.handlerMs,routeMs:trial.routeMs,paintMs:trial.paintMs,error:trial.error}));
  }
 }
}catch(error){run.error=error.message;process.exitCode=1}
finally{
 // Restore the ordinary APK path even if a clean trial fails.
 try{await boot(false);run.normalModeRestored=true}catch(error){run.restoreError=error.message}
 tik?.close();pong?.close();writeFileSync(output,JSON.stringify(run,null,2));console.log(JSON.stringify({saved:output,error:run.error,normalModeRestored:run.normalModeRestored}));
}
