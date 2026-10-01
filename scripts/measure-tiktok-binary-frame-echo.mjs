// Full-source, one-frame-at-a-time native echo. This is a transport diagnostic,
// not a face-swap or sustained FPS qualification. No pixels/URLs are persisted.
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';

const count=Number(process.argv[2]??12);
const render=process.argv.includes('--render');
if(!Number.isInteger(count)||count<1||count>30)throw Error('Specify 1..30 echo samples');
const client=await connectWebView(60195,'tiktok');
const records=[];
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/binary-frame-${render?'render':'echo'}-${Date.now()}.json`;
let failure=null, cleanup=false, preflight=null;
try {
  for(let attempt=0;attempt<30;attempt++) {
    preflight=await client.read(`(()=>{
    const v=window.__pongTikTokObservedVideo?.video;
    return {swap:!!window.__pongDomSwap||!!window.__pongDomSwapWarm,
      busy:!!window.__pongBinaryEchoSample,
      audit:typeof window.__pongVisibleFrameAuditRun==='function',
      observed:!!v,playing:!!v&&!v.paused,ready:v?.readyState??0,muted:v?.muted===true,
      challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')};
  })()`);
    if(preflight.challenge)throw Error('Verification requires user; no frame submitted');
    if(!preflight.swap&&!preflight.busy&&preflight.audit&&preflight.observed&&
      preflight.playing&&preflight.ready>=2&&preflight.muted)break;
    if(attempt===29)throw Error('Need muted original video, swaps off, and native audit flag');
    await new Promise(r=>setTimeout(r,250));
  }
  for(let index=0;index<count;index++) {
    const evaluated=await client.call('Runtime.evaluate',{
      awaitPromise:true,returnByValue:true,expression:`(async()=>{
        if(window.__pongBinaryEchoSample)throw Error('sample already active');
        const v=window.__pongTikTokObservedVideo?.video;
        const owner={video:v,page:window.__pongTikTokObservedVideo?.pageUrl};
        const state={raf:0,gaps:[],last:0,longTasks:[],finished:false};
        window.__pongBinaryEchoSample=state;
        const q0=v?.getVideoPlaybackQuality?.();
        const frame=at=>{if(state.finished)return;if(state.last)state.gaps.push(at-state.last);
          state.last=at;state.raf++;state.id=requestAnimationFrame(frame)};
        state.id=requestAnimationFrame(frame);
        let observer;
        try{observer=new PerformanceObserver(list=>{
          for(const e of list.getEntries())state.longTasks.push(e.duration);
        });observer.observe({entryTypes:['longtask']})}catch{}
        const started=performance.now();
        try {
          const result=await window.__pongVisibleFrameAuditRun({mode:${JSON.stringify(render?'pc-render':'echo')}});
          await new Promise(r=>setTimeout(r,250));
          const q1=v?.getVideoPlaybackQuality?.();
          return {result,windowMs:performance.now()-started,rafCallbacks:state.raf,
            rafGapsMs:state.gaps,longTaskMs:state.longTasks,
            sourceUnchanged:owner.video===window.__pongTikTokObservedVideo?.video&&
              owner.page===window.__pongTikTokObservedVideo?.pageUrl,
            decodedFrames:q0&&q1?q1.totalVideoFrames-q0.totalVideoFrames:null,
            droppedFrames:q0&&q1?q1.droppedVideoFrames-q0.droppedVideoFrames:null};
        } finally {
          state.finished=true;cancelAnimationFrame(state.id);observer?.disconnect();
          if(window.__pongBinaryEchoSample===state)delete window.__pongBinaryEchoSample;
        }
      })()`},16000);
    if(evaluated.exceptionDetails)throw Error('Echo sample evaluation failed');
    const record=evaluated.result?.value;
    records.push({index:index+1,...record});
    if(!record?.result?.ok||!record.sourceUnchanged)throw Error('Echo failed or source changed');
    await new Promise(r=>setTimeout(r,250));
  }
} catch(error) {
  failure=error.message;
} finally {
  cleanup=await client.read(`(()=>{const s=window.__pongBinaryEchoSample;
    if(s){s.finished=true;cancelAnimationFrame(s.id);delete window.__pongBinaryEchoSample}
    return !window.__pongBinaryEchoSample;})()`).catch(()=>false);
  client.close();
  const timings=records.filter(x=>x.result?.ok).map(x=>x.result.nativeBinaryRoundtripMs).sort((a,b)=>a-b);
  const percentile=p=>timings.length?timings[Math.ceil(p*timings.length)-1]:null;
  const summary={samples:records.length,successes:timings.length,
    ...(render?{transformedSamples:records.filter(x=>x.result?.ok&&x.result?.transformed===true).length}:{}),
    binaryRoundtripMedianMs:percentile(.5),binaryRoundtripP90Ms:percentile(.9),
    binaryRoundtripMaxMs:timings.at(-1)??null};
  writeFileSync(output,JSON.stringify({diagnosticOnly:true,
    scope:render?'full_resolution_native_pc_render_offscreen_not_paint_not_continuous_throughput':
      'full_resolution_native_echo_not_swap_not_continuous_throughput',
    failure,cleanup,preflight,summary,records},null,2));
  console.log(JSON.stringify({output,failure,cleanup,...summary}));
  if(failure)process.exitCode=1;
}
