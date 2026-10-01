// Controlled same-page replays in the real APK. NOT the swipe acceptance test.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {firstQualifiedPaint} from './lib/tiktok-audit-identity.mjs';
const pool=JSON.parse(readFileSync(process.argv[2],'utf8'));
const limit=Number(process.env.PONG_AUDIT_PAGE_LIMIT||6);
if(!Number.isInteger(limit)||limit<1||limit>6)throw Error('Expected 1–6 diagnostic pages');
const pages=pool.pages?.slice(0,limit);
if(!pages?.length||pages.some(raw=>{try{const u=new URL(raw);return u.origin!=='https://www.tiktok.com'||!/^\/@[^/]+\/video\/\d{15,22}\/?$/.test(u.pathname)||u.search||u.hash;}catch{return true;}}))throw Error('Expected observed canonical TikTok video pages');
const variant=process.env.PONG_AUDIT_VARIANT||'baseline';
const observationMs=Number(process.env.PONG_AUDIT_DIAGNOSTIC_MS||4000);
if(!Number.isInteger(observationMs)||observationMs<4000||observationMs>15000)throw Error('Diagnostic window must be 4000–15000ms; acceptance remains four seconds');
const currentPage=process.argv.includes('--current-page');
const fragmentBatch=process.argv.includes('--fragment-batch');
const muteOriginal=process.argv.includes('--mute-original');
if(currentPage&&pages.length!==1)throw Error('Current-page replay requires exactly one observed page');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/repeated-pages-${Date.now()}.json`;
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const pauseOwned=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const instrument=readFileSync('scripts/tiktok-audit-instrument.js','utf8');
const result={diagnosticOnly:true,variant,fragmentBatch,muteOriginal,observationMs,note:'Page navigation and document bootstrap, not feed swipe latency. Sampling and post-window screenshots are diagnostic. Same source pages do not guarantee equal network/cache conditions. Extended windows cannot qualify the four-second swipe benchmark.',cases:[]};
let priorBatchFlag;
const stateExpression='(()=>{const w=pongFaceSwapCurrentWrapper();return {session:w?.dataset.pongFaceSwapSessionId||"",videoId:(pongTikTokLiveState.current||"").match(/video\\/(\\d+)/)?.[1]||"",enabled:pongFaceSwapState.enabled,green:pongSwapHasPresentedEvidence(w)}})()';
try {
  const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
  result.rendererBefore={ready:health.ready,embeddingPrimerActive:health.embeddingPrimerActive,
    acquisitionTrial:health.acquisitionTrial||null,stageDiagnosticsTrial:health.stageDiagnosticsTrial||null,
    decodeAheadTrial:health.decodeAheadTrial||null};
  result.acquisitionTrial=health.acquisitionTrial||null;
  for(const page of pages){
    await pong.read(pauseOwned);
    const row={videoId:page.match(/video\/(\d+)/)[1],samples:[]};result.cases.push(row);
    const start=performance.now();
    if(currentPage){
      const current=await tik.read('location.origin+location.pathname');
      if(current!==page)throw Error('Current page does not match observed replay target');
      // Teardown can temporarily clear the observed node while TikTok keeps
      // its original player. Wait for that same real page, not an arbitrary
      // video. This is preflight time, never counted as a successful handoff.
      let playable=false;
      for(let n=0;n<40;n++){
        const state=await tik.read('({path:location.origin+location.pathname,ready:!!window.__pongTikTokObservedVideo?.video?.isConnected&&window.__pongTikTokObservedVideo.video.readyState>=2,challenge:!!document.querySelector("[id^=captcha-verify-container],[class*=captcha-drag-icon]")})');
        if(state.challenge||state.path!==page)throw Error('Replay preflight changed page or requires verification');
        if(state.ready){playable=true;break;}await pause(100);
      }
      if(!playable)throw Error('No playable observed video to rewind');
      const rewind=await tik.read('(()=>{const v=window.__pongTikTokObservedVideo?.video;if(!v||v.readyState<2)return false;v.muted=true;v.currentTime=0;return true;})()');
      if(!rewind)throw Error('No playable observed video to rewind');
    }else await tik.call('Page.navigate',{url:page});
    let ready=false;
    for(let i=0;i<100;i++){
      await pause(150);
      const status=await tik.read('({path:location.pathname,ready:document.readyState!=="loading"&&typeof window.__pongDomSwapAttach==="function",challenge:!!document.querySelector("[id^=captcha-verify-container],[class*=captcha-drag-icon]")})').catch(()=>null);
      if(status?.challenge)throw Error('TikTok verification required; stopped without interacting with challenge');
      if(status?.ready&&status.path.includes('/video/'+row.videoId)){ready=true;break;}
    }
    if(!ready)throw Error('Observed video page did not initialize');
    if(muteOriginal){
      let muted=false;
      for(let i=0;i<20&&!muted;i++){
        muted=await tik.read('(()=>{const v=window.__pongTikTokObservedVideo?.video;'
          +'if(!v?.isConnected)return false;v.muted=true;v.defaultMuted=true;v.volume=0;'
          +'return v.muted&&v.volume===0})()');
        if(!muted)await pause(100);
      }
      if(!muted)throw Error('Observed original could not be muted for diagnostic');
    }
    row.documentReadyMs=performance.now()-start;
    row.currentPageReplay=currentPage;
    priorBatchFlag=await tik.read('window.__pongFragmentBatchTrial===true');
    if(fragmentBatch&&!await tik.read('typeof window.__pongCreateFragmentBatch==="function"'))throw Error('Byte-identical fragment batch implementation is not available');
    await tik.read('window.__pongFragmentBatchTrial='+String(fragmentBatch));
    await tik.read(instrument);
    const clocks=[];
    for(let n=0;n<5;n++){const before=performance.now(),remote=await tik.read('performance.now()'),after=performance.now();clocks.push({minOffset:before-remote,maxOffset:after-remote,roundTripMs:after-before});}
    row.clockCalibration=clocks.sort((a,b)=>a.roundTripMs-b.roundTripMs)[0];
    const windowStart=performance.now();
    const evidence={startedAt:windowStart,beforeVideoId:'',beforePostKey:'',beforePath:'',paintEvidence:[]};
    await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
    row.activationRequestMs=performance.now()-windowStart;
    while(performance.now()-windowStart<observationMs){
      const [view,p]=await Promise.all([tik.read('window.__pongAuditSnapshot()'),pong.read(stateExpression)]);
      if(view.session)view.nativeReads=await tik.read('JSON.parse(window.PongTikTokSwap?.streamReadAuditStatus?.('+JSON.stringify(view.session)+')||\'null\')');
      if(view.challenge||view.loginBlocked)throw Error('Verification or login required; stopped');
      let renderer=null;
      if(p.session&&p.videoId===row.videoId){
        const r=await fetch('http://127.0.0.1:8792/sessions/'+encodeURIComponent(p.session),{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(r=>r.session||{});
        renderer={id:r.id,state:r.state,frames:r.frames,transformedFrames:r.transformedFrames,firstTransformedFrameAt:r.firstTransformedFrameAt,createdAt:r.createdAt,fps:r.fps,transformedFrameRanges:r.transformedFrameRanges,reason:r.multiFace?.reason,errorCode:r.errorCode,
          sourceOpenedAt:r.sourceOpenedAt,modelsReadyAt:r.modelsReadyAt,firstSourceFrameAt:r.firstSourceFrameAt,firstByteAt:r.firstByteAt,encoderStartedAt:r.encoderStartedAt,timingTotals:r.timingTotals,adaptive:r.adaptiveRestoration,
          bytesWritten:r.bytesWritten,completeFragments:r.completeFragments,muxedMediaSeconds:r.muxedMediaSeconds,browserStartupReady:r.browserStartupReady,
          frameDiagnostics:r.diagnostics,error:String(r.error||'').replace(/https?:\/\/\S+/g,'[redacted]')};
      }
      const at=performance.now()-windowStart;
      if(at<observationMs){
        row.samples.push({at,view,pong:p,renderer});
        evidence.paintEvidence.push(...(view.paintEvents||[]));
        const paint=firstQualifiedPaint(evidence,view,p,renderer||{},row.clockCalibration,4000);
        if(paint&&(row.firstPaintUpperMs==null||paint.maxMs<row.firstPaintUpperMs))row.firstPaintUpperMs=paint.maxMs;
        const observed=firstQualifiedPaint(evidence,view,p,renderer||{},row.clockCalibration,observationMs);
        if(observed&&(row.firstObservedPaintUpperMs==null||observed.maxMs<row.firstObservedPaintUpperMs))row.firstObservedPaintUpperMs=observed.maxMs;
      }
      await pause(250);
    }
    await tik.read('window.__pongAuditStop?.()');
    // Optional bounded server-side encoder diagnostic. Collected only after
    // the observation window; never used to qualify visible paint or FPS.
    const afterHealth=await fetch('http://127.0.0.1:8792/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
    row.encoderHandoffTrace=afterHealth.encoderHandoffTrace||null;
    row.decodeAheadTrial=afterHealth.decodeAheadTrial||null;
    row.screenshot=output.replace('.json',`-${row.videoId}.png`);
    const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
    writeFileSync(row.screenshot,execFileSync(adb,['-s','emulator-5582','exec-out','screencap','-p'],{maxBuffer:12*1024*1024,windowsHide:true}));
    row.screenshotAfterWindow=true;
    row.endPostKey=await tik.read('window.__pongTikTokObservedVideo?.pageUrl?.match(/video\\/(\\d+)/)?.[1]||""');
    console.log(JSON.stringify({videoId:row.videoId,documentReadyMs:row.documentReadyMs,firstPaintUpperMs:row.firstPaintUpperMs??null,samples:row.samples.length,transformedFrames:row.samples.at(-1)?.renderer?.transformedFrames??null,reason:row.samples.at(-1)?.renderer?.reason??null}));
    writeFileSync(output,JSON.stringify(result,null,2));
  }
}catch(error){result.error=String(error.message).replace(/https?:\/\/\S+/g,'[redacted]');process.exitCode=1;}
finally{
  await tik.read('window.__pongAuditStop?.()').catch(()=>{});
  await pong.read(pauseOwned).catch(()=>{});
  if(priorBatchFlag!==undefined)await tik.read('window.__pongFragmentBatchTrial='+String(priorBatchFlag)).catch(()=>{});
  pong.close();tik.close();
  writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,cases:result.cases.length,error:result.error||null}));
}
