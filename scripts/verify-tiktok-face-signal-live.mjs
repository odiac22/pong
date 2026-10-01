// Measures Pong state change -> native handoff request, NOT visible swap time.
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const p=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/face-signal-${Date.now()}.json`;
const result={scope:'native-request-latency-only-not-painted-frame',runs:[]};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
try{
  await p.read(pause);
  await p.read(`(()=>{if(window.__pongUndoFaceSignalTest)throw Error('Test already installed');
    if(typeof PongNativeSwap?.selectionChanged!=='function')throw Error('New APK not installed');
    const notify=notifyPongTikTokFaceSelectionChanged,request=window.PongTikTokLiveSwapCurrent;
    window.__pongFaceSignalTimes=[];
    window.PongTikTokLiveSwapCurrent=(...args)=>{window.__pongFaceSignalTimes.push(performance.now());return request(...args);};
    window.__pongSetFaceSignalTestMode=enabled=>{notifyPongTikTokFaceSelectionChanged=enabled?notify:()=>{};};
    window.__pongUndoFaceSignalTest=()=>{notifyPongTikTokFaceSelectionChanged=notify;window.PongTikTokLiveSwapCurrent=request;delete window.__pongSetFaceSignalTestMode;delete window.__pongUndoFaceSignalTest;};return true;})()`);
  for(const enabled of [false,true,true,false,false,true,true,false]){
    await p.read('window.__pongSetFaceSignalTestMode(true);true');await p.read(pause);
    // The no-event arm deliberately bypasses JS notification bookkeeping.
    // Give native's 500ms fallback time to observe OFF before the next ON;
    // otherwise a 200ms reset can conflate a missed OFF with ON latency.
    // Reset time is outside the measured activation interval.
    await new Promise(r=>setTimeout(r,750));
    const start=await p.read(`(()=>{window.__pongSetFaceSignalTestMode(${enabled});window.__pongFaceSignalTimes=[];
      const at=performance.now();setPongFaceSwapPersistentEnabled(true);return at;})()`);
    let times=[];const deadline=Date.now()+2000;
    while(Date.now()<deadline){times=await p.read('window.__pongFaceSignalTimes');if(times.length)break;await new Promise(r=>setTimeout(r,20));}
    result.runs.push({eventEnabled:enabled,nativeRequestMs:times.length?times[0]-start:null});
  }
}catch(error){result.error=error.message;process.exitCode=1;}
finally{
  result.restored=await p.read('window.__pongUndoFaceSignalTest?.();!window.__pongUndoFaceSignalTest').catch(()=>false);
  await p.read(pause).catch(()=>{});p.close();
  writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
