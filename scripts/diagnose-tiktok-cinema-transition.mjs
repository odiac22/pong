import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok');
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/cinema-transition-${Date.now()}.json`;
try{
 await tik.read(`(()=>{const samples=[];let ticks=0;const begin=performance.now();window.__pongCinemaTiming=samples;
 const sample=()=>{const videos=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')];const v=videos.find(v=>!v.paused)||videos[0];let p=v,scroll=null;while(p){if(p.scrollHeight>p.clientHeight+20&&getComputedStyle(p).overflowY==='auto'){scroll={top:p.scrollTop,behavior:getComputedStyle(p).scrollBehavior};break;}p=p.parentElement;}
 samples.push({at:performance.now()-begin,path:location.pathname,scroll,videos:videos.map(v=>({id:v.closest('[id^=xgwrapper]')?.id,top:v.getBoundingClientRect().top,paused:v.paused,ready:v.readyState,time:v.currentTime}))});
 if(++ticks<80)window.__pongCinemaTimer=setTimeout(sample,25);};sample();return true;})()`);
 execFileSync(adb,['-s','emulator-5582','shell','input','swipe','650','1550','650','650','150']);
 await new Promise(r=>setTimeout(r,4000));
 const samples=await tik.read('window.__pongCinemaTiming');
 writeFileSync(output,JSON.stringify(samples,null,2));
 console.log(JSON.stringify({saved:output,samples:samples.filter((_,i)=>i%5===0)}));
}finally{await tik.read('clearTimeout(window.__pongCinemaTimer);delete window.__pongCinemaTiming;true').catch(()=>{});tik.close()}
