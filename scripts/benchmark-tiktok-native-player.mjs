// Isolated architecture comparison, NOT the 40-video acceptance benchmark.
import {writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/native-player-${Date.now()}.json`;
const result={experimental:true,pass:false,note:'FirstFrame is Media3 callback. Visible is DOM handoff acknowledgment, not physical presentation proof. Native position does not qualify transformed-frame paint.',trials:[]};
// Check before every gesture, including the first. TikTok uses suffixed IDs
// for the same verification panel; an exact #captcha-verify-container query
// missed those variants. Do not inject input into a blocked verification UI.
const verificationBlocked=`!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')`;
try {
 if(await tik.read(verificationBlocked))throw Error('User verification required; no input dispatched');
 if(!await tik.read('window.__pongNativePresentationInstalled===true'))throw Error('Native trial was not installed');
 execFileSync(adb,['-s','emulator-5582','shell','dumpsys','gfxinfo','com.odiac22.pong2','reset']);
 const origin=performance.now();let previous=await tik.read('window.__pongTikTokObservedVideo?.pageUrl');
 for(let i=0;i<8;i++){
  if(await tik.read(verificationBlocked))throw Error('User verification required; no input dispatched');
  const start=performance.now(),trial={index:i+1,rows:[],firstVisibleUpperMs:null,advanced:false};
  execFileSync(adb,['-s','emulator-5582','shell','input','swipe','650','1550','650','650','150']);
  while(performance.now()<origin+(i+1)*4000){
   const state=await tik.read(`(()=>{const n=window.__pongNativeState,s=window.__pongNativeDecoderStatus,p=window.__pongTikTokObservedVideo;
    return {page:p?.pageUrl,video:p?.video?{time:p.video.currentTime,ready:p.video.readyState,paused:p.video.paused,opacity:p.video.style.opacity}:null,
    native:n,decoder:s,error:window.__pongNativeError??null,challenge:${verificationBlocked}};})()`);
   if(state.challenge)throw Error('User verification required');
   const at=performance.now()-start;
   if(performance.now()>=origin+(i+1)*4000)break;
   if(state.page&&state.page!==previous)trial.advanced=true;
   if(trial.advanced&&state.native?.pageUrl===state.page&&state.native.visible&&trial.firstVisibleUpperMs===null)trial.firstVisibleUpperMs=at;
   // Preserve post IDs only; no signed stream URLs or account/session content.
   const id=page=>(page||'').match(/video\/(\d+)/)?.[1]||'';
   state.videoId=id(state.page);delete state.page;
   if(state.native){state.native.videoId=id(state.native.pageUrl);delete state.native.pageUrl;}
   trial.rows.push({at,...state});
   await new Promise(r=>setTimeout(r,200));
  }
  previous=await tik.read('window.__pongTikTokObservedVideo?.pageUrl');
  result.trials.push(trial);console.log(JSON.stringify({index:i+1,advanced:trial.advanced,firstVisibleUpperMs:trial.firstVisibleUpperMs,error:trial.rows.at(-1)?.error}));
 }
}catch(e){result.error=e.message;process.exitCode=1;}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 result.frameStats=execFileSync(adb,['-s','emulator-5582','shell','dumpsys','gfxinfo','com.odiac22.pong2'],{encoding:'utf8'}).split(/\r?\n/).filter(x=>/^(Total frames|Janky frames|\d+th percentile)/.test(x));
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,error:result.error,pass:false}));
}
