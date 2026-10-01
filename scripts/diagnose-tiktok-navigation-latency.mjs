// Diagnostic only: records real Next-handler, route, decoder and paint timing.
// Does not read media URLs, authentication storage or alter playback settings.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/navigation-phases-${Date.now()}.json`;
const events=[],frames=new Map(),result={diagnosticOnly:true,trials:[]};
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
try{
 if(process.argv.includes('--original-only'))await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await tik.read(`(()=>{
  const previous=window.__pongTikTokStep,events=[],frames=new Map();let lastPath=location.pathname,epoch=0;
  const record=(kind,extra={})=>{events.push({at:performance.now(),kind,path:location.pathname,epoch,...extra});if(events.length>500)events.shift()};
  const onMedia=e=>{if(e.target.tagName==='VIDEO'&&!e.target.classList.contains('pong-tiktok-swap-stream'))record(e.type,{ready:e.target.readyState,time:e.target.currentTime})};
  const names=['loadstart','loadedmetadata','loadeddata','playing','waiting','emptied'];names.forEach(n=>document.addEventListener(n,onMedia,true));
  const scan=()=>{
   if(location.pathname!==lastPath){lastPath=location.pathname;record('route')}
   for(const [v,id] of frames)if(!v.isConnected){v.cancelVideoFrameCallback?.(id);frames.delete(v)}
   for(const v of document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')){
    if(frames.has(v)||!v.requestVideoFrameCallback)continue;
    const paint=(now,m)=>{if(!v.isConnected)return;record('paint',{time:m.mediaTime,paused:v.paused,ready:v.readyState});frames.set(v,v.requestVideoFrameCallback(paint))};
    frames.set(v,v.requestVideoFrameCallback(paint));
   }
  };
  const timer=setInterval(scan,100);scan();
  window.__pongTikTokStep=direction=>{epoch++;record('step-start');const r=previous(direction);record('step-end',{accepted:r});return r};
  window.__pongNavigationEvents=events;
  window.__pongUndoNavigationEvents=()=>{clearInterval(timer);window.__pongTikTokStep=previous;names.forEach(n=>document.removeEventListener(n,onMedia,true));for(const [v,id]of frames)v.cancelVideoFrameCallback?.(id);delete window.__pongUndoNavigationEvents};
  return true;
 })()`);
 for(let i=0;i<3;i++){
  if(await tik.read(`!!document.querySelector('#captcha-verify-container')`))throw Error('Verification shown; no further input');
  const started=performance.now();
  execFileSync(adb,['-s','emulator-5582','shell','input','swipe','650','1550','650','650','150']);
  await new Promise(r=>setTimeout(r,4000-Math.min(4000,performance.now()-started)));
  result.trials.push(await tik.read(`(()=>{const e=window.__pongNavigationEvents,s=[...e].reverse().find(x=>x.kind==='step-start');return {events:s?e.filter(x=>x.at>=s.at).map(x=>({...x,at:Math.round(x.at-s.at)})):e,noStep:!s}})()`));
 }
}catch(e){result.error=e.message;process.exitCode=1}
finally{
 await tik.read('window.__pongUndoNavigationEvents?.();true').catch(()=>{});
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({saved:output,trials:result.trials.map(t=>({noStep:t.noStep,phases:t.events.filter(e=>e.kind!=='paint'||e.time<.1).slice(0,20)})),error:result.error}));
}
