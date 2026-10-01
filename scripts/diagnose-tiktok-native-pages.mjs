// Native decoder stage comparison. Never counts callbacks as physical paint.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {startSurfaceTrace} from './lib/tiktok-surface-trace.mjs';
import {surfaceBootNs,collectNativeSurfaceLatency} from './lib/tiktok-surface-latency.mjs';
const pages=JSON.parse(readFileSync(process.argv[2],'utf8')).pages.slice(0,Number(process.env.PONG_AUDIT_PAGE_LIMIT||3));
const windowMs=Number(process.env.PONG_AUDIT_DIAGNOSTIC_MS||4000);
if(!Number.isFinite(windowMs)||windowMs<1000||windowMs>12000)throw Error('Bounded diagnostic window required');
if(pages.some(p=>!/^https:\/\/www\.tiktok\.com\/@[^/?]+\/video\/\d+$/.test(p)))throw Error('Canonical observed pages required');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/native-pages-${Date.now()}.json`;
const result={pass:false,diagnosticOnly:true,windowMs,variant:process.env.PONG_AUDIT_VARIANT||'native-default',profile:'tiktok-gpen512',note:'Media3 first-frame and DOM reveal callbacks are not per-frame presentation proof. No acceptance FPS inferred.',cases:[]};
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const stop=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
let trace;
try{
 if(process.argv.includes('--frame-timeline'))trace=await startSurfaceTrace(output);
 await pong.read(`pongFaceSwapRestorationProfile=()=> 'tiktok-gpen512';true`);
 for(const page of pages){
  await pong.read(stop);
  const row={videoId:page.match(/video\/(\d+)/)[1],rows:[]};result.cases.push(row);
  await tik.call('Page.navigate',{url:page});
  let ready=false;
  for(let i=0;i<60;i++){
   const s=await tik.read(`({native:window.__pongNativePresentationInstalled===true,video:!!window.__pongTikTokObservedVideo?.video,challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')})`);
   if(s.challenge)throw Error('User verification required; no input dispatched');
   if(s.native&&s.video){ready=true;break;}await pause(150);
  }
  if(!ready)throw Error('Native trial not ready');
  await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo.video;v.muted=true;v.volume=0;v.currentTime=0;return true})()`);
  const initial=await pong.read('({sequence:PongRuntimeDiagnostics.snapshot().latestSequence,at:Date.now()})');
  await tik.read('window.__pongNativeTrialStart=performance.now();true');
  const start=performance.now();
  trace?.begin();
  if(process.argv.includes('--surface-latency'))row.surfaceStartNs=surfaceBootNs();
  await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
  while(performance.now()-start<windowMs){
   const s=await tik.read(`(()=>{const n=window.__pongNativeDecoderStatus,o=window.__pongTikTokObservedVideo;return {decoder:n?{sessionId:n.sessionId,ageMs:n.ageMs,firstFrameMs:n.firstNativeFrameMs,state:n.playbackState,position:n.position,target:n.target,lag:n.lag,bufferHeadroom:n.bufferHeadroom,requestMs:n.requestMs,headersMs:n.headersMs,firstByteMs:n.firstByteMs,readyMs:n.readyMs,bytes:n.bytes,seekable:n.seekable,rate:n.rate,surfaceType:n.surfaceType,freshness:{sessionId:n.sessionId,snapshotAgeMs:performance.now()-n.receivedAtPageMs,bufferedAheadSeconds:n.bufferedAheadSeconds,holdingAhead:n.holdingAhead,rebufferCount:n.rebufferCount,rebufferMs:n.rebufferMs,isLoading:n.isLoading}}:null,revealed:window.__pongNativeState?.pageUrl===o?.pageUrl&&window.__pongNativeState?.visible===true,revealedSession:window.__pongNativeState?.sessionId,firstRevealPageMs:window.__pongNativeState?.firstPresentAt-window.__pongNativeTrialStart,original:{ready:o?.video?.readyState,time:o?.video?.currentTime,paused:o?.video?.paused},error:window.__pongNativeError??null};})()`);
   const session=await pong.read('pongFaceSwapCurrentWrapper()?.dataset.pongFaceSwapSessionId||""');
   s.sessionId=session;
   s.revealed=s.revealed&&!!session&&s.revealedSession===session;
   if(s.revealed&&s.firstRevealPageMs>=0&&row.firstRevealPageMs===undefined)row.firstRevealPageMs=s.firstRevealPageMs;
   if(session){
    const b=await fetch('http://127.0.0.1:8792/sessions/'+session,{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(r=>r.session);
    s.backend=b?{frames:b.frames,transformedFrames:b.transformedFrames,ready:b.browserStartupReady,state:b.state,createdAt:b.createdAt,firstByteAt:b.firstByteAt,modelsReadyAt:b.modelsReadyAt,sourceOpenedAt:b.sourceOpenedAt,firstTransformedFrameAt:b.firstTransformedFrameAt,completeFragments:b.completeFragments,muxedMediaSeconds:b.muxedMediaSeconds,bytesWritten:b.bytesWritten,playbackPositionSeconds:b.playbackPositionSeconds,playbackPaused:b.playbackPaused,timingTotals:b.timingTotals,diagnostics:b.diagnostics}:null;
   }
   const at=performance.now()-start;
   if(at<windowMs){row.rows.push({at,...s});if(s.revealed&&row.firstRevealUpperMs===undefined)row.firstRevealUpperMs=at;}
   await pause(150);
  }
  trace?.end();
  if(row.surfaceStartNs){row.surfaceEndNs=surfaceBootNs();row.surfaceLatency=collectNativeSurfaceLatency(row.surfaceStartNs,row.surfaceEndNs);}
  row.diagnostics=await pong.read(`PongRuntimeDiagnostics.snapshot().events.filter(e=>e.sequence>${initial.sequence}).map(e=>({...e,at:e.at-${initial.at}}))`);
  if(process.argv.includes('--screenshot')){
   row.postWindowScreenshot=output.replace('.json','-'+row.videoId+'.png');
   const bytes=execFileSync(adb,['-s','emulator-5582','exec-out','screencap','-p'],{timeout:10000,windowsHide:true,maxBuffer:12*1024*1024});
   writeFileSync(row.postWindowScreenshot,bytes);
  }
  console.log(JSON.stringify({videoId:row.videoId,firstRevealUpperMs:row.firstRevealUpperMs??null,firstRevealPageMs:row.firstRevealPageMs??null,last:row.rows.at(-1)}));
 }
}catch(e){result.error=e.message;process.exitCode=1;}
finally{
 await pong.read(stop).catch(()=>{});pong.close();tik.close();
 if(trace)try{result.frameTimeline=await trace.close(pages.length)}catch(e){result.traceError=e.message}
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,cases:result.cases.length,error:result.error??null}));
}
