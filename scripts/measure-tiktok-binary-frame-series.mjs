// Sequential same-video, full-resolution raw render. No pixels are painted or saved.
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {summarizeVisibleFrameSeries} from './lib/visible-frame-series-summary.mjs';

const count=Number(process.argv[2]??32);
const steady=process.argv.includes('--steady');
if(!Number.isInteger(count)||count<1||count>120)throw Error('Specify 1..120 series frames');
const client=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/binary-frame-series-${Date.now()}.json`;
let result=null,failure=null,preflight=null,cleanup=false,originalBaseline=null;
try {
  for(let attempt=0;attempt<40;attempt++) {
    preflight=await client.read(`(()=>{
      const v=window.__pongTikTokObservedVideo?.video;
      return {swap:!!window.__pongDomSwap||!!window.__pongDomSwapWarm,
        audit:typeof window.__pongVisibleFrameAuditSeries==='function',
        observed:!!v,playing:!!v&&!v.paused,ready:v?.readyState??0,muted:v?.muted===true,
        challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')};
    })()`);
    if(preflight.challenge)throw Error('Verification requires user; no frame submitted');
    if(!preflight.swap&&preflight.audit&&preflight.observed&&preflight.playing&&
      preflight.ready>=2&&preflight.muted)break;
    if(attempt===39)throw Error('Need muted original video, swaps off, and native series audit flag');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(steady) {
    // Separate steady-state attribution from first-swipe/startup qualification.
    // Rewind only this muted test clip after five seconds of original playback.
    const baseline=await client.call('Runtime.evaluate',{
      awaitPromise:true,returnByValue:true,expression:`(async()=>{
        const owner=window.__pongTikTokObservedVideo, v=owner?.video;
        const gaps=[];let last=0,id=0;
        const started=performance.now(), q0=v?.getVideoPlaybackQuality?.();
        const tick=at=>{if(last)gaps.push(at-last);last=at;id=requestAnimationFrame(tick)};
        id=requestAnimationFrame(tick);
        await new Promise(resolve=>setTimeout(resolve,5000));cancelAnimationFrame(id);
        const q1=v?.getVideoPlaybackQuality?.();
        const valid=v===window.__pongTikTokObservedVideo?.video&&
          owner?.pageUrl===window.__pongTikTokObservedVideo?.pageUrl&&v?.muted&&
          !document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]');
        if(valid)v.currentTime=0;
        return {ok:!!valid,totalMs:performance.now()-started,rafIntervalsMs:gaps,
          decodedFrames:q0&&q1?q1.totalVideoFrames-q0.totalVideoFrames:null,
          droppedFrames:q0&&q1?q1.droppedVideoFrames-q0.droppedVideoFrames:null};
      })()`},7000);
    originalBaseline=baseline.result?.value;
    if(baseline.exceptionDetails||!originalBaseline?.ok)throw Error('Steady original-video baseline changed');
    for(let attempt=0;attempt<20;attempt++) {
      if(await client.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
        return !!v&&!v.seeking&&!v.paused&&v.readyState>=2&&v.currentTime<2})()`))break;
      if(attempt===19)throw Error('Steady diagnostic rewind did not settle');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  const evaluated=await client.call('Runtime.evaluate',{
    awaitPromise:true,returnByValue:true,expression:`(async()=>{
      const video=window.__pongTikTokObservedVideo?.video;
      const page=window.__pongTikTokObservedVideo?.pageUrl;
      const longTasks=[];let observer;
      try{observer=new PerformanceObserver(list=>{
        for(const entry of list.getEntries())if(longTasks.length<200)longTasks.push(entry.duration);
      });observer.observe({entryTypes:['longtask']})}catch{}
      try {
        const series=await window.__pongVisibleFrameAuditSeries(${count},{mode:'pc-render'});
        return {...series,longTaskMs:longTasks,
          sourceUnchanged:video===window.__pongTikTokObservedVideo?.video&&
            page===window.__pongTikTokObservedVideo?.pageUrl};
      }finally{observer?.disconnect()}
    })()`},35000);
  if(evaluated.exceptionDetails)throw Error('Series evaluation failed');
  result=evaluated.result?.value;
  if(!result?.ok||!result.sourceUnchanged)failure=`Series stopped: ${result?.reason??'source-changed'}`;
}catch(error){failure=error.message;}
finally {
  cleanup=await client.read(`(()=>{
    window.__pongVisibleFrameAuditSeriesCancel?.();return true;
  })()`).catch(()=>false);
  client.close();
  const summary=summarizeVisibleFrameSeries(result);
  writeFileSync(output,JSON.stringify({diagnosticOnly:true,
    scope:'full_resolution_continuous_offscreen_raw_not_visible_paint_or_phone_fps',
    failure,cleanup,preflight,steadyDiagnostic:steady,originalBaseline,
    originalBaselineSummary:originalBaseline?summarizeVisibleFrameSeries(originalBaseline):null,
    summary,result},null,2));
  console.log(JSON.stringify({output,failure,cleanup,...summary}));
  if(failure||!cleanup)process.exitCode=1;
}
