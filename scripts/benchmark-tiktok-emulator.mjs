import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {open as openFile,writeFile as writeAsync} from 'node:fs/promises';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {incomingVideoForTrial,firstQualifiedPaint,firstOriginalPaint,auditPostReady,countDistinctVideoVisit,navigationAndTimingSatisfied,sameTrialVisualEvidence,confirmedPhotoPost} from './lib/tiktok-audit-identity.mjs';
import {hostAvcDecoderMetadata} from './lib/tiktok-audit-device-metadata.mjs';
import {trialPaintedCadence,reconcileRunCadence} from './lib/tiktok-painted-cadence.mjs';
import {createTerminalSourceFailureLookup,safeRendererErrorCode,terminalSourceFailureOwner} from './lib/tiktok-audit-source-failure.mjs';
import {reconcileFaceVisibleTiming} from './lib/tiktok-face-visible-timing.mjs';
import {summarizePlaybackEvents} from './lib/tiktok-playback-events.mjs';
const count=Number(process.argv[2]||40),holdMs=Number(process.env.PONG_AUDIT_HOLD_MS||4000),port=Number(process.env.PONG_AUDIT_CDP_PORT||60195);
if(!Number.isInteger(holdMs)||holdMs<4000||holdMs>10000)throw Error('Audit dwell must be 4000–10000ms');
const originalOnly=process.argv.includes('--original-only');
const stageDiagnostics=process.env.PONG_AUDIT_STAGE_DIAGNOSTICS==='1';
const captureVisualEvidence=process.env.PONG_AUDIT_VISUAL_EVIDENCE==='1';
const visualAtMs=Number(process.env.PONG_AUDIT_VISUAL_AT_MS||2000);
if(!Number.isFinite(visualAtMs)||visualAtMs<300||visualAtMs>2800)
  throw Error('Visual diagnostic capture must be scheduled between 300 and 2800ms');
const countVideos=process.argv.includes('--videos');
if(!Number.isInteger(count)||count<1||count>100)throw Error('Expected 1–100 benchmark visits');
const sampleMs=Number(process.env.PONG_AUDIT_SAMPLE_MS||100);
if(!Number.isFinite(sampleMs)||sampleMs<100||sampleMs>1000)throw Error('Audit sample interval must be 100–1000ms');
const device=process.env.PONG_AUDIT_DEVICE||'emulator-5582';
if(!/^emulator-\d+$/.test(device))throw Error('This benchmark is restricted to an explicit emulator');
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const directory='E:/Pong Benchmarks/tiktok-webview-2026-09-29';mkdirSync(directory,{recursive:true});
const output=`${directory}/swipes-${Date.now()}.json`;
const tik=await connectWebView(port,'tiktok'),pong=await connectWebView(port,'pong');
const faceReviews=process.env.PONG_AUDIT_FACE_REVIEW_FILE
  ? JSON.parse(readFileSync(process.env.PONG_AUDIT_FACE_REVIEW_FILE,'utf8')).videos || {} : {};
const run={measurementSchema:6,device,count,holdMs,originalOnly,sampleMs,variant:process.env.PONG_AUDIT_VARIANT||'default',started:new Date().toISOString(),trials:[],paintDrains:[],pass:false,
  note:'Swap speed begins at independently reviewed visible original face, NOT swipe or detector success. Unknown face eligibility is not failure or exemption. RAF is not physical screen FPS.'};
run.stageDiagnostics=stageDiagnostics;
run.decisionDiagnostics=process.env.PONG_AUDIT_DECISIONS==='1';
if(run.decisionDiagnostics)run.note+=' Count-only face-decision instrumentation is enabled; this run diagnoses eligibility, not uninstrumented latency qualification.';
run.visualEvidence=captureVisualEvidence;
if(captureVisualEvidence)run.visualAtMs=visualAtMs;
if(captureVisualEvidence)run.note+=' Native screenshots are diagnostic visual evidence; their overhead disqualifies this run for frame-rate performance qualification.';
if(stageDiagnostics)run.note+=' Diagnostic CUDA-event instrumentation is enabled; these timings are attribution data, not an uninstrumented performance qualification.';
run.targetKind=countVideos?'distinct-advanced-video-posts':'all-posts';
const seenVideos=new Set();
// Photo posts still consume real four-second visits. A 3x swipe bound stopped
// a valid 120-swipe run at only 38 videos. Keep a finite bound, but do not count
// photos as videos just to satisfy the requested corpus size.
run.videoVisits=0;run.maximumSwipeAttempts=countVideos?count*6:count;
run.receiver={cores:Number(execFileSync(adb,['-s',device,'shell','getconf','_NPROCESSORS_ONLN'],{encoding:'utf8'}).trim()),
  buildFingerprint:execFileSync(adb,['-s',device,'shell','getprop','ro.build.fingerprint'],{encoding:'utf8'}).trim(),
  hostAvcDecoder:hostAvcDecoderMetadata(
    execFileSync(adb,['-s',device,'shell','getprop','qemu.hwcodec.avcdec'],{encoding:'utf8'}),
    execFileSync(adb,['-s',device,'shell','getprop','ro.boot.qemu.hwcodec.avcdec'],{encoding:'utf8'})),
  appVersion:execFileSync(adb,['-s',device,'shell','dumpsys','package','com.odiac22.pong2'],{encoding:'utf8'}).split(/\r?\n/).find(line=>line.includes('versionName='))?.trim()||'unavailable',
  webViewProvider:execFileSync(adb,['-s',device,'shell','dumpsys','webviewupdate'],{encoding:'utf8'}).split(/\r?\n/).find(line=>line.includes('Current WebView package'))?.trim()||'unavailable',
  memory:execFileSync(adb,['-s',device,'shell','cat','/proc/meminfo'],{encoding:'utf8'}).split(/\r?\n/).filter(line=>/^MemTotal:|^SwapTotal:/.test(line)),
  graphics:execFileSync(adb,['-s',device,'shell','dumpsys','SurfaceFlinger'],{encoding:'utf8',maxBuffer:8*1024*1024}).split(/\r?\n/).find(line=>/^GLES:/.test(line))||'unavailable'};
const pongState=String.raw`(()=>{const w=pongFaceSwapCurrentWrapper();return {session:w?.dataset.pongFaceSwapSessionId||'',videoId:(pongTikTokLiveState.current||'').match(/video\/(\d+)/)?.[1]||'',enabled:pongFaceSwapState.enabled,selected:pongFaceSwapFaceIds().length,green:pongSwapHasPresentedEvidence(w)}})()`;
const visualTasks=[];
const retainedTasks=[];
run.retainedMedia=[];
async function retainTrialMedia(trial,renderer){
 const row={trial:trial.index,session:renderer.id,requestedAtMs:performance.now()-trial.startedAt,
   note:'Read-only snapshot of existing encoded spool; no stream activation or additional rendering.'};
 run.retainedMedia.push(row);
 let handle;
 try{
  if(!/^[a-f0-9]{32}$/.test(renderer.id))throw Error('Invalid owned session ID');
  const spool=path.resolve('Pong Swap/cache/sessions',renderer.id+'.mp4');
  handle=await openFile(spool,'r');
  const size=Math.min((await handle.stat()).size,16*1024*1024);
  if(size<1024)throw Error('No retained fragment available');
  const data=Buffer.allocUnsafe(size);let offset=0;
  while(offset<size){const {bytesRead}=await handle.read(data,offset,size-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  row.file=output.replace(/\.json$/,`-trial-${trial.index}.mp4`);
  await writeAsync(row.file,data.subarray(0,offset));row.bytes=offset;
 }catch(error){row.error=String(error.code||error.name||'capture-error')}
 finally{await handle?.close();row.completedAtMs=performance.now()-trial.startedAt;}
}
const sourceFailureTasks=[];
const terminalSourceFailure = createTerminalSourceFailureLookup(async()=>{
 const response=await fetch('http://127.0.0.1:8787/video-cache/status',
   {signal:AbortSignal.timeout(2000)});
 if(!response.ok)throw Error('cache status unavailable');
 return response.json();
});
function retainDrain(view){
 if(view)run.paintDrains.push({at:view.at,observerCost:view.observerCost,
   paintEvents:view.paintEvents||[],originalPaintEvents:view.originalPaintEvents||[],mediaEvents:view.mediaEvents||[]});
 return view;
}
async function captureTrialScreen(trial,view,pong){
 const startedAt=performance.now()-trial.startedAt;
 try{
  const {stdout}=await promisify(execFile)(adb,['-s',device,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:12*1024*1024,timeout:5000,windowsHide:true});
  const finishedAt=performance.now()-trial.startedAt;
  // Do not consume __pongAuditSnapshot here: it drains the paint-event queue
  // belonging to the independent timing sampler.
  const afterKey=await tik.read('window.__pongAuditCurrentPostKey?.()||\'\'');
  if(stdout.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Screenshot was not PNG');
  const file=output.replace(/\.json$/,`-trial-${trial.index}.png`);
  writeFileSync(file,stdout);
  trial.visualEvidence={file,startedAt,finishedAt,postKey:view.postKey,
    originalMediaTimeAtRequest:view.original?.time??null,
    samePost:sameTrialVisualEvidence(trial,view,pong,afterKey,startedAt,finishedAt,holdMs),
    note:'Native composite including Pong controls; not an eligibility verdict.'};
 }catch(error){trial.visualEvidence={error:error.message.replace(/https?:\/\/\S+/g,'[redacted]')}}
}
try{
 const rendererHealth=await fetch('http://127.0.0.1:8792/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
 run.startupFullPathWarmup=rendererHealth.remoteFullPathWarmup
   ? Object.fromEntries(Object.entries(rendererHealth.remoteFullPathWarmup)
       .filter(([,value])=>typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)))
   : {enabled:false};
 run.acquisitionTrial=rendererHealth.acquisitionTrial?.installed?{
   installed:true,experimental:true,hairPrecheck:!!rendererHealth.acquisitionTrial.hairPrecheck,
   scope:rendererHealth.acquisitionTrial.scope
 }:null;
 if(run.acquisitionTrial)run.note+=' Disposable renderer acquisition experiment is active; this is not a production qualification.';
 run.receiver.appliedTikTokLayer=await tik.read('window.__pongCompositorLayer ?? null');
 run.directDecoderTrial=await tik.read('window.__pongDirectDecoderTrial===true');
 run.motionTrial=await pong.read('window.__pongMotionTrial===true');
 if(run.directDecoderTrial)run.note+=' Direct-decoder trial uses canvas draw/rAF timestamps, NOT decoder rVFC or physical-screen presentation proof.';
 const clocks=[];
 for(let i=0;i<5;i++){const before=performance.now(),remote=await tik.read('performance.now()'),after=performance.now();clocks.push({minOffset:before-remote,maxOffset:after-remote,roundTripMs:after-before})}
 run.clockCalibration=clocks.sort((a,b)=>a.roundTripMs-b.roundTripMs)[0];
 await tik.read(readFileSync('scripts/tiktok-audit-instrument.js','utf8'));
 const initial=await pong.read(pongState);
 if(originalOnly ? initial.enabled : (!initial.enabled||!initial.selected))
   throw Error(originalOnly?'Disable swap for the original-only comparison':'Select approved faces and enable swap before measuring');
 // Let initial page boot finish before measuring physical feed swipes.
 let lastKnown=initial,lastKnownView=null,activeTrial=null,sampling=true,sampleError=null;
 const sampler=(async()=>{
   let b={},backendAt=0;
   while(sampling){
     const owner=activeTrial;
     if(!owner){await new Promise(r=>setTimeout(r,25));continue;}
     try{
       const [view,p]=await Promise.all([tik.read('window.__pongAuditSnapshot()').then(retainDrain),pong.read(pongState)]);
       if(view.challenge)throw Error('User verification required; benchmark stopped');
       if(view.loginBlocked)throw Error('TikTok login required; benchmark stopped without scoring blocked navigation');
       lastKnown=p;
       lastKnownView=view;
       if(p.session&&(p.session!==b.id||performance.now()-backendAt>400)){
         b=await fetch('http://127.0.0.1:8792/sessions/'+encodeURIComponent(p.session),{signal:AbortSignal.timeout(2000)})
           .then(r=>r.json()).then(x=>x.session||{}).catch(()=>({}));backendAt=performance.now();
       }
       const at=performance.now()-owner.startedAt;
       // A late diagnostic response must never extend a viewing window or be
       // attributed to the next video. Swipes run on an independent deadline.
       if(owner!==activeTrial||at>=holdMs)continue;
       if(process.env.PONG_AUDIT_SAVE_MEDIA==='1'&&!owner.mediaRequested&&at>=holdMs-750&&
          view.postKind==='video'&&incomingVideoForTrial(owner,view,p)&&
          b.id===p.session&&view.session===b.id&&/^[a-f0-9]{32}$/.test(b.id||'')&&b.bytesWritten>1024){
         owner.mediaRequested=true;retainedTasks.push(retainTrialMedia(owner,b));
       }
       if(captureVisualEvidence&&!owner.visualRequested&&at>=visualAtMs&&at<3100&&view.postKind==='video'){
         owner.visualRequested=true;visualTasks.push(captureTrialScreen(owner,view,p));
       }
       const newVideo=incomingVideoForTrial(owner,view,p);
       if(newVideo&&owner.navigationObservedMs===null)owner.navigationObservedMs=at;
       if(newVideo&&owner.firstOriginalObservedMs===null&&view.original?.ready>=2&&
          !view.original.paused&&view.original.lastPaintAt>0&&view.at-view.original.lastPaintAt<250)
         owner.firstOriginalObservedMs=at;
       owner.originalPaintEvidence.push(...(view.originalPaintEvents||[]));
       if(owner.originalPaintEvidence.length>300)owner.originalPaintEvidence.splice(0,owner.originalPaintEvidence.length-300);
       const originalPaint=firstOriginalPaint(owner,view,run.clockCalibration,holdMs);
       if(originalPaint&&(owner.firstOriginalPaintUpperMs===null||originalPaint.maxMs<owner.firstOriginalPaintUpperMs))owner.firstOriginalPaintUpperMs=originalPaint.maxMs;
       const frame=Math.round(Number(view.lastPaintedMediaTime)*Number(b.fps||0));
       const transformed=!!view.visible&&view.session===b.id&&view.session===p.session&&view.lastPaintedMediaTime!=null&&
         (b.transformedFrameRanges||[]).some(([a,z])=>frame>=a&&frame<=z)&&
         view.lastPaintedAt>0&&view.at-view.lastPaintedAt<750;
       if(owner.firstSwapMs===null&&newVideo&&transformed)owner.firstSwapMs=at;
       // Local next-stream adoption can paint before the cross-WebView Pong
       // receipt arrives. Retain bounded evidence for later same-trial
       // validation instead of losing that genuine first frame timestamp.
       owner.paintEvidence.push(...(view.paintEvents||[]));
       if(owner.paintEvidence.length>300)owner.paintEvidence.splice(0,owner.paintEvidence.length-300);
       const first=firstQualifiedPaint(owner,view,p,b,run.clockCalibration,holdMs);
       if(first&&(owner.firstPaintUpperMs===null||first.maxMs<owner.firstPaintUpperMs)){
         owner.firstPaintLowerMs=first.minMs;owner.firstPaintUpperMs=first.maxMs;
       }
       owner.samples.push({at,view,pong:p,transformed,renderer:{id:b.id,state:b.state,frames:b.frames,
         transformedFrames:b.transformedFrames,fps:b.fps,bytesWritten:b.bytesWritten,fragments:b.completeFragments,
         firstByteAt:b.firstByteAt,playableAt:b.playableAt,error:safeRendererErrorCode(b.errorCode),
         firstTransformedFrameAt:b.firstTransformedFrameAt,createdAt:b.createdAt,sourceOpenedAt:b.sourceOpenedAt,
         modelsReadyAt:b.modelsReadyAt,embeddingReadyAt:b.embeddingReadyAt,
         firstSourceFrameAt:b.firstSourceFrameAt,encoderStartedAt:b.encoderStartedAt,
         transformedFrameRanges:b.transformedFrameRanges,decisionReason:b.multiFace?.reason,
         timings:b.timingTotals,adaptive:b.adaptiveRestoration,
         ...(stageDiagnostics?{stageMs:Object.fromEntries(Object.entries(b.diagnostics||{})
           .filter(([key,values])=>key.endsWith('Ms')&&Array.isArray(values)&&values.every(Number.isFinite))
           .map(([key,values])=>[key,values.slice(-256)]))}:{})}});
     }catch(error){sampleError=error;sampling=false;}
     await new Promise(r=>setTimeout(r,sampleMs));
   }
 })();
 try{
   const deadline=performance.now()+15000;let originalReady=false;
   while(performance.now()<deadline){
     const view=retainDrain(await tik.read('window.__pongAuditSnapshot()'));
     if(view.challenge)throw Error('User verification required; benchmark stopped');
     if(view.loginBlocked)throw Error('TikTok login required; no swipes scored');
     if(auditPostReady(view)){originalReady=true;break;}
     await new Promise(r=>setTimeout(r,200));
   }
   if(!originalReady)throw Error('No playable video or visible photo post in preflight; no swipes scored');
   lastKnown=await pong.read(pongState);
   lastKnownView=retainDrain(await tik.read('window.__pongAuditSnapshot()'));
   execFileSync(adb,['-s',device,'shell','dumpsys','gfxinfo','com.odiac22.pong2','reset'],{encoding:'utf8'});
   const scheduleStart=performance.now();
   for(let index=0;index<run.maximumSwipeAttempts&&(!countVideos||run.videoVisits<count);index++){
     if(sampleError)throw sampleError;
     const target=scheduleStart+index*holdMs;
     await new Promise(r=>setTimeout(r,Math.max(0,target-performance.now())));
     const trial={index:index+1,beforeVideoId:lastKnown.videoId,beforePostKey:lastKnownView?.postKey||'',beforePath:lastKnownView?.path||'',startedAt:performance.now(),
       dispatchDelayMs:Math.max(0,performance.now()-target),navigationObservedMs:null,firstOriginalObservedMs:null,
       firstSwapMs:null,firstPaintLowerMs:null,firstPaintUpperMs:null,paintEvidence:[],originalPaintEvidence:[],firstOriginalPaintUpperMs:null,samples:[]};
     activeTrial=trial;
     execFileSync(adb,['-s',device,'shell','input','swipe','650','1550','650','650','150']);
     await new Promise(r=>setTimeout(r,Math.max(0,scheduleStart+(index+1)*holdMs-performance.now())));
     activeTrial=null;trial.observedDwellMs=performance.now()-trial.startedAt;
     const last=trial.samples.at(-1);
     trial.advanced=!!last&&incomingVideoForTrial(trial,last.view,last.pong);
     trial.navigationAdvanced=trial.advanced||!!last?.view.postKey&&last.view.postKey!==trial.beforePostKey;
      trial.photoPost=confirmedPhotoPost(last?.view);
     trial.adPost=last?.view.postKind==='ad';
     trial.swipeToSwapUnderOneSecond=trial.firstPaintUpperMs!==null&&trial.firstPaintUpperMs<1000;
     trial.requiresFaceReview=true;
     trial.swappedCadence=trialPaintedCadence(trial,run.clockCalibration,holdMs,30);
     trial.distinctVideo=countDistinctVideoVisit(trial,last?.view,last?.pong,seenVideos);
     if(trial.distinctVideo)run.videoVisits++;
     const failedOwner=terminalSourceFailureOwner(trial);
     if(failedOwner)sourceFailureTasks.push(terminalSourceFailure(failedOwner).then(evidence=>{
       if(evidence)trial.sourceFailure={...evidence,
         checkedAfterTrialMs:Math.round(Math.max(0,performance.now()-trial.startedAt))};
     }));
     run.trials.push(trial);writeFileSync(output,JSON.stringify(run,null,2));
     console.log(JSON.stringify({trial:trial.index,advanced:trial.advanced,navigationAdvanced:trial.navigationAdvanced,firstSwapMs:trial.firstSwapMs,
       firstOriginalObservedMs:trial.firstOriginalObservedMs,
       firstOriginalPaintUpperMs:trial.firstOriginalPaintUpperMs,
       swipeToFirstSwapMs:trial.firstPaintUpperMs,faceTiming:'pending-independent-review',dwellMs:Math.round(trial.observedDwellMs),videoVisits:run.videoVisits,photo:trial.photoPost}));
   }
 }finally{
   activeTrial=null;sampling=false;await sampler;
   // Collect the final partial polling interval before stopping instrumentation.
   // This does not extend a viewing window or count later frames toward it.
   retainDrain(await tik.read('window.__pongAuditSnapshot()'));
   run.reconciledCadence=reconcileRunCadence(run,30);
 }
 if(sampleError)throw sampleError;
 // Never declare the full requirement passed from session totals or RAF alone.
 run.faceVisibleTiming=reconcileFaceVisibleTiming(run,faceReviews);
 run.playback=summarizePlaybackEvents(run);
 run.navigationPass=run.trials.every(t=>t.navigationAdvanced);
 run.timingPass=run.faceVisibleTiming.pass;
 for(const trial of run.trials) {
   trial.faceTiming=run.faceVisibleTiming.trials.find(t=>t.index===trial.index);
   trial.requiresFaceReview=trial.faceTiming?.status==='unreviewed';
 }
 run.cadenceFloor=30;
 run.pendingValidation=['unreviewed face intervals must be annotated before latency acceptance','30 FPS compositor trace','visual quality review'];
}catch(error){run.error=error.message;process.exitCode=1}
finally{
 await Promise.allSettled(visualTasks);
 await Promise.allSettled(sourceFailureTasks);
 await Promise.allSettled(retainedTasks);
 await tik.read('window.__pongAuditStop?.()').catch(()=>{});tik.close();pong.close();
 try{
   const gfx=execFileSync(adb,['-s',device,'shell','dumpsys','gfxinfo','com.odiac22.pong2'],{encoding:'utf8',maxBuffer:4*1024*1024});
   run.androidFrameStats={note:'Android app rendering counters, not source-video FPS or proof of a physical-display FPS floor',
     lines:gfx.split(/\r?\n/).filter(s=>/^(Stats since:|Total frames rendered:|Janky frames:|\d+th percentile:|Number (Missed Vsync|Slow UI thread|Frame deadline missed):|Pipeline=)/.test(s))};
 }catch(error){run.androidFrameStats={error:error.message}}
 writeFileSync(output,JSON.stringify(run,null,2));console.log(JSON.stringify({saved:output,trials:run.trials.length,error:run.error||null,pass:run.pass}));
}
