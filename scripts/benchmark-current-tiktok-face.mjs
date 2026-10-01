// Repeatable current-video activation test, not a feed-swipe or cold-source benchmark.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {reconcileFaceVisibleTiming} from './lib/tiktok-face-visible-timing.mjs';
import {summarizePlaybackEvents} from './lib/tiktok-playback-events.mjs';
const out=path.resolve(process.argv[2]),reviews=JSON.parse(await readFile(process.argv[3],'utf8')).videos;
const id=process.argv[4],count=3,holdMs=5000;
if(!/^\d{19}$/.test(id||'')||!reviews[id])throw Error('Explicit reviewed video required');
await mkdir(out,{recursive:false});
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const pause=await readFile('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const run={measurementSchema:6,holdMs,trials:[],paintDrains:[],noAudio:true,
  kind:'controlled current-video activation, three repetitions; model residency recorded, not swipe or cold-network qualification',videoId:id};
const fragmentTrial=process.env.PONG_AUDIT_FRAGMENT_BATCH==='1';
const revealTrial=process.env.PONG_AUDIT_EVENT_REVEAL==='1';
const bufferedSeekTrial=process.env.PONG_AUDIT_BUFFERED_SEEK==='1';
let priorBatch,priorReveal,priorBufferedSeek;
const ownedState=`(()=>{const w=pongFaceSwapCurrentWrapper();return {session:w?.dataset.pongFaceSwapSessionId||'',videoId:(pongTikTokLiveState.current||'').match(/video\\/(\\d+)/)?.[1]||''}})()`;
try {
  priorBatch=await tik.read('window.__pongFragmentBatchTrial===true');
  priorReveal=await tik.read('window.__pongEventDrivenReveal===true');
  priorBufferedSeek=await tik.read('window.__pongBufferedStartupSeekTrial===true');
  if(bufferedSeekTrial&&!revealTrial)throw Error('Buffered startup seek qualification requires the current event-driven asset');
  if(revealTrial){
    await pong.read(pause);
    // The installed APK can contain an older stream producer. Updating only
    // its synchronizer would benchmark a flag with no decoder callback.
    const stream=await readFile('android-app/app/src/main/assets/tiktok-stream.js','utf8');
    await tik.read('window.__pongDomSwapClear();window.__pongDomSwapWarmClear();window.__pongDomSwapInstalled=false;true');
    await tik.read(stream);
    run.injectedStreamSha256=createHash('sha256').update(stream).digest('hex');
    await tik.read(await readFile('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8'));
    await tik.read(await readFile('android-app/app/src/main/assets/tiktok-stable-handoff.js','utf8'));
    await tik.read('window.__pongEventDrivenReveal=true;true');
  }
  run.eventDrivenReveal=revealTrial;
  run.bufferedStartupSeek=bufferedSeekTrial;
  if(bufferedSeekTrial)await tik.read('window.__pongBufferedStartupSeekTrial=true;true');
  if(fragmentTrial){
    if(!(await tik.read("typeof window.__pongCreateFragmentBatch==='function'")))throw Error('Fragment factory not installed in this APK');
    await tik.read('window.__pongFragmentBatchTrial=true;true');
  }
  run.fragmentBatch=fragmentTrial;
  const calibration=[];
  for(let n=0;n<5;n++){const before=performance.now(),remote=await tik.read('performance.now()'),after=performance.now();calibration.push({minOffset:before-remote,maxOffset:after-remote,roundTripMs:after-before});}
  run.clockCalibration=calibration.sort((a,b)=>a.roundTripMs-b.roundTripMs)[0];
  for(let index=1;index<=count;index++) {
    await pong.read(pause);
    const correct=await tik.read(`(async()=>{const o=window.__pongTikTokObservedVideo;if(!o?.pageUrl?.endsWith('/${id}'))return false;const v=o.video;v.muted=true;v.volume=0;v.pause();v.currentTime=.1;await new Promise(r=>setTimeout(r,150));return true})()`);
    if(!correct)throw Error('Video identity changed');
    await pong.read(`(async()=>{const faces=(await pongFaceSwapControlFetch('/pong-swap/faces').then(r=>r.json())).faces;const f=faces.find(f=>f.name==='Approved 8');if(!f)throw Error('Approved 8 missing');pongFaceSwapState.faces=faces;setPongFaceSwapSelection([f.id]);return true})()`);
    await tik.read(await readFile('scripts/tiktok-audit-instrument.js','utf8'));
    await tik.read('window.__pongTikTokObservedVideo.video.currentTime=0;true');
    let prior;
    for(let n=0;n<30&&!prior;n++){
      await sleep(25);const snapshot=await tik.read('window.__pongAuditSnapshot()');
      prior=snapshot.originalPaintEvents.find(p=>p.videoId===id&&p.paused&&p.mediaTime<.05);
    }
    if(!prior)throw Error('No presentation receipt for the original paused face; do not fabricate activation timing');
    const health=await fetch('http://127.0.0.1:8792/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
    const trial={index,kind:'current-video-activation',preActivationOriginalPaint:prior,startedAt:performance.now(),beforeVideoId:'',beforePostKey:'',samples:[],paintEvidence:[],originalPaintEvidence:[]};run.trials.push(trial);
    trial.rendererBefore={ready:health.ready,modelResidency:health.modelResidency,
      gpuWorker:health.gpuWorker,activityWarmth:health.activityWarmth};
    const enabled=pong.read('window.PongTikTokLiveEnableSelectedSwap();true');
    await tik.read('window.__pongTikTokObservedVideo.video.play().catch(()=>{});true');await enabled;
    while(performance.now()-trial.startedAt<holdMs){
      const [view,p]=await Promise.all([tik.read('window.__pongAuditSnapshot()'),pong.read(ownedState)]);
      if(revealTrial&&view.transport&&!view.transport.eventDrivenReveal)
        throw Error('Requested event-driven stream producer is not active; do not score the wrong variant');
      if(view.challenge||view.loginBlocked)throw Error('User verification or login required');
      run.paintDrains.push(view);
      let b={};
      if(p.session)b=await fetch('http://127.0.0.1:8792/sessions/'+p.session,{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).then(r=>r.session||{});
      trial.paintEvidence.push(...view.paintEvents);trial.originalPaintEvidence.push(...view.originalPaintEvents);
      trial.samples.push({at:performance.now()-trial.startedAt,view,pong:p,renderer:{id:b.id,fps:b.fps,state:b.state,
        frames:b.frames,transformedFrames:b.transformedFrames,transformedFrameRanges:b.transformedFrameRanges,
        createdAt:b.createdAt,sourceOpenedAt:b.sourceOpenedAt,modelsReadyAt:b.modelsReadyAt,
        firstSourceFrameAt:b.firstSourceFrameAt,firstByteAt:b.firstByteAt,timingTotals:b.timingTotals}});
      await sleep(200);
    }
    trial.observedDwellMs=holdMs;
    run.paintDrains.push(await tik.read('window.__pongAuditSnapshot()'));
    await tik.read('window.__pongAuditStop();window.__pongTikTokObservedVideo.video.pause();true');
    run.faceVisibleTiming=reconcileFaceVisibleTiming(run,reviews);run.playback=summarizePlaybackEvents(run);
    await writeFile(path.join(out,'report.json'),JSON.stringify(run,null,2));
    console.log(JSON.stringify({trial:index,faceTiming:run.faceVisibleTiming.trials.at(-1),playback:run.playback.at(-1)}));
  }
}catch(error){run.error=error.message;process.exitCode=1;}
finally {
  await tik.read('window.__pongAuditStop?.();true').catch(()=>{});
  await pong.read(pause).catch(()=>{});
  if(fragmentTrial)await tik.read(`window.__pongFragmentBatchTrial=${priorBatch===true};true`).catch(()=>{});
  if(revealTrial)await tik.read(`window.__pongEventDrivenReveal=${priorReveal===true};true`).catch(()=>{});
  if(bufferedSeekTrial)await tik.read(`window.__pongBufferedStartupSeekTrial=${priorBufferedSeek===true};true`).catch(()=>{});
  tik.close();pong.close();
  await writeFile(path.join(out,'report.json'),JSON.stringify(run,null,2));
  console.log(JSON.stringify({saved:path.join(out,'report.json'),error:run.error||null}));
}
