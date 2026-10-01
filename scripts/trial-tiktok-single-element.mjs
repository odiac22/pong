// Three disposable same-page transport probes, not a swipe acceptance run.
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {execFileSync} from 'node:child_process';
import {summarizeFrameTimeline} from './summarize-tiktok-frame-timeline.mjs';
const pages=JSON.parse(readFileSync(process.argv[2],'utf8')).pages.slice(0,3);
if(pages.some(p=>!/^https:\/\/www\.tiktok\.com\/@[^/?]+\/video\/\d+$/.test(p)))throw Error('Canonical observed pages required');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/single-element-${Date.now()}.json`;
const useWorker=process.env.PONG_SINGLE_WORKER==='1';
const result={pass:false,diagnosticOnly:true,qualityChanged:false,useWorker,profile:'tiktok-gpen512',cases:[]};
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const stop=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const traceEnabled=process.argv.includes('--frame-timeline');
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const device=(...args)=>execFileSync(adb,['-s','emulator-5582',...args],{encoding:'utf8',timeout:15000,windowsHide:true}).trim();
const uptime=()=>{const value=device('shell','cat','/proc/uptime').split(' ')[0];if(!/^\d+\.\d{2}$/.test(value))throw Error('Unexpected boot clock');return String(BigInt(value.replace('.',''))*10000000n)};
let tracePid='',remoteTrace='';
const windows={clock:'perfetto-trace-ns',windows:[]};
try{
 if(traceEnabled){
   const tag='pong-swap-'+Date.now();remoteTrace='/data/misc/perfetto-traces/'+tag+'.pftrace';
   tracePid=execFileSync(adb,['-s','emulator-5582','shell','perfetto','--background-wait','--txt','-c','-','-o',remoteTrace],{
     input:readFileSync('scripts/tiktok-frame-timeline-diagnostic.pbtxt'),encoding:'utf8',timeout:35000,windowsHide:true}).trim();
   if(!/^\d+$/.test(tracePid))throw Error('No owned trace PID');
 }
 await pong.read(`pongFaceSwapRestorationProfile=()=> 'tiktok-gpen512';true`);
 for(const page of pages){
  await pong.read(stop);await tik.call('Page.navigate',{url:page});
  let ready=false;
  for(let i=0;i<60;i++){
   const s=await tik.read(`({ready:typeof __pongDomSwapAttach==='function'&&!!window.__pongTikTokObservedVideo?.video?.isConnected,native:window.__pongNativePresentationInstalled===true,challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')})`);
   if(s.challenge)throw Error('User verification required; no input dispatched');
   if(s.native)throw Error('Native decoder audit must be OFF');
   if(s.ready){ready=true;break}await pause(150);
  }
  if(!ready)throw Error('No observed video');
  await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo.video;v.muted=true;v.volume=0;v.currentTime=0;return true})()`);
  await tik.read('window.__pongSingleElementUseWorker='+String(useWorker));
  await tik.read(readFileSync('scripts/lib/tiktok-single-element-trial.js','utf8'));
  const row={videoId:page.match(/video\/(\d+)/)[1],rows:[]};result.cases.push(row);
  row.startPageTime=await tik.read('performance.now()');
  if(traceEnabled)row.traceStartNs=uptime();
  const start=performance.now();await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
  while(performance.now()-start<6000){
   const state=await tik.read('window.__pongSingleElementTrial.snapshot()');
   const session=state.find(s=>s.active)?.sessionId;
   let renderer=null;
   if(session){
     const r=await fetch('http://127.0.0.1:8792/sessions/'+session).then(r=>r.json()).then(r=>r.session);
     if(r)renderer={frames:r.frames,transformedFrames:r.transformedFrames,state:r.state,fps:r.fps,
       playbackPositionSeconds:r.playbackPositionSeconds,playbackPaused:r.playbackPaused,bufferedSeconds:r.bufferedSeconds};
   }
   row.rows.push({at:performance.now()-start,state,renderer});await pause(250);
  }
  row.final=await tik.read('window.__pongSingleElementTrial.snapshot()');
  if(traceEnabled){row.traceEndNs=uptime();windows.windows.push({startNs:row.traceStartNs,endNs:row.traceEndNs});}
  console.log(JSON.stringify({videoId:row.videoId,records:row.final.map(s=>({firstMs:s.firstVisibleAt-row.startPageTime,frames:s.frames.length,ready:s.ready,failure:s.failure,sameSource:s.sameSource,time:s.time,rate:s.rate,waits:s.waits}))}));
  await tik.read('window.__pongSingleElementTrial.close();true');
 }
}catch(e){result.error=e.message;process.exitCode=1}
finally{
 await pong.read(stop).catch(()=>{});await tik.read('window.__pongSingleElementTrial?.close();true').catch(()=>{});
 await tik.call('Page.reload').catch(()=>{});result.reloadRequested=true;
 if(tracePid){
   try{
     const identity=device('shell','cat','/proc/'+tracePid+'/cmdline');
     if(identity.includes('perfetto')&&identity.includes(remoteTrace))device('shell','kill','-TERM',tracePid);
     else throw Error('Trace process identity changed; not stopped');
     await pause(500);
     const localTrace=output.replace('.json','.pftrace');device('pull',remoteTrace,localTrace);
     const processor='E:/Pong Benchmarks/tiktok-webview-2026-09-29/frame-timeline-smoke/trace_processor_shell.exe';
     const csv=execFileSync(processor,['query','-f','scripts/tiktok-frame-timeline.sql',localTrace],{encoding:'utf8',timeout:20000,windowsHide:true});
     writeFileSync(output.replace('.json','-frames.csv'),csv);
     result.frameTimeline={...summarizeFrameTimeline(csv,windows,{expectedWindows:pages.length}),
       clockUncertaintyMs:10,note:'/proc/uptime boot clock boundaries, 10ms precision. App surface updates do not prove unique transformed video frames.'};
   }catch(e){result.traceError=e.message;}
 }
 pong.close();tik.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,error:result.error??null,pass:false}));
}
