// Real Recall UI/controller, isolated fixture response; no shared Recall writes.
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,mkdtemp,stat} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import http from 'node:http';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {summarizePlaybackFps} from './playback-fps-metrics.mjs';
const root=process.env.PONG_BENCH_ROOT||'E:/Pong Benchmarks/v3002-throughput',repo=path.resolve(import.meta.dirname,'..');
const recallChannel=Number(process.env.PONG_RECALL_CHANNEL||1);
const snapshot=process.env.PONG_UI_SNAPSHOT?await readFile(process.env.PONG_UI_SNAPSHOT,'utf8'):null;
if(![1,2].includes(recallChannel))throw Error('Recall channel must be 1 or 2');
const out=path.join(root,process.env.PONG_UI_LABEL||'recall-baseline');
const base=process.env.SWAP_BASE||'http://127.0.0.1:8792';
const appBase=process.env.PONG_APP_BASE||'http://127.0.0.1:8787';
const desktopCapture=process.env.PONG_DESKTOP_CAPTURE==='1';
// This mode writes a Recall list. Never permit it against the user's helper.
if(desktopCapture&&appBase!=='http://127.0.0.1:18887')throw Error('Desktop capture audit requires the isolated helper on 18887');
const corpus=process.env.PONG_CORPUS_ROOT||path.join(repo,'Pong Swap/benchmarks/realtime-stock-corpus');
const manifest=JSON.parse(await readFile(path.join(corpus,'manifest.json'),'utf8'));
const ids=(process.env.PONG_BENCH_CLIPS||'1,2,3,4,5,8,9,10,12,23').split(',').map(Number);
const fullPlayback=process.env.PONG_FULL_PLAYBACK==='1';
const startupOnly=process.env.PONG_STARTUP_ONLY==='1';
const networkSources=process.env.PONG_NETWORK_SOURCES==='1';
const clips=manifest.clips.filter(c=>ids.includes(c.ordinal)).map(c=>({...c,file:path.isAbsolute(c.path)?c.path:path.join(corpus,c.path)}));
if(ids.some(id=>!clips.some(c=>c.ordinal===id)))throw Error('Requested clip missing from this corpus; refusing a partial baseline');
if(process.env.PONG_LONG==='1')clips.push({ordinal:'eating',file:'E:/Pong Benchmarks/v2906-occlusion/segments/minute.mp4',durationSeconds:64.6,fps:'60000/1001'});
const report={silent:true,environment:'Headless incognito Chrome; isolated fixture Recall response and real Recall controller; fixture-only proxy URLs are delivered directly from a loopback range server because production proxy rejects private origins. No public-network or Android latency claim.',clips:[],errors:[]};
if(networkSources)report.environment='Headless incognito Chrome; isolated fixture Recall response and real Recall controller; original public licensed CDN source through production Pong proxy/cache and swap services. Not Android or actual website discovery.';
const emulatorPort=Number(process.env.PONG_BENCH_EMULATOR_PORT||0);
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
let chrome,ws,server,sid,receiver,injection,reversePort;let seq=0;const pending=new Map();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(p,method='GET')=>{const r=await fetch(base+p,{method});if(!r.ok)throw Error(p+': '+r.status);return r.json();};
const send=(method,params={})=>receiver?receiver.call(method,params,method==='Runtime.evaluate'?60000:30000):new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},method==='Runtime.evaluate'?60000:30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
async function wait(expression,label,ms=30000){const t=performance.now();while(performance.now()-t<ms){const v=await ev(expression);if(v)return v;await delay(70);}throw Error(label+' timeout');}
const save=()=>writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
try{
 await mkdir(out,{recursive:false});report.settings=await api('/settings');report.health=await api('/health');
 report.corpus=path.resolve(corpus);report.fixtureEvidence=[];
 for(const c of clips){const digest=createHash('sha256');for await(const chunk of createReadStream(c.file))digest.update(chunk);const sha256=digest.digest('hex');if(c.sha256&&sha256!==c.sha256)throw Error('Fixture bytes changed: '+c.ordinal);report.fixtureEvidence.push({clip:c.ordinal,path:c.file,sha256,duration:c.durationSeconds});}
 report.transportCapabilities=await fetch(appBase+'/media-page/desktop-capture',{signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(c=>({boundedRanges:c.boundedMediaRanges===true})).catch(()=>({boundedRanges:false}));
 if(report.health.runtime.swapAudioEnabled!==false)throw Error('Audio enabled');
 if((await api('/sessions')).sessions.some(s=>!s.complete&&!s.playbackPaused))throw Error('Another render is active');
 const face=(await api('/faces')).faces.find(f=>f.name===(process.env.PONG_BENCH_FACE||'Approved 3'));if(!face)throw Error('Requested approved face missing');report.face=face.id;
 const files=new Map();for(const c of clips)files.set('/'+c.ordinal+'.mp4',{file:c.file,size:(await stat(c.file)).size});
 server=http.createServer((req,res)=>{
  if(req.method==='OPTIONS'){
   res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Range'});res.end();return;
  }
  if(req.url.startsWith('/pong-swap/')&&base!=='http://127.0.0.1:8792'){
   // Keep the normal playback URL shape: the UI uses /pong-swap/ to
   // distinguish managed streams from original media. Test routing only.
   const target=new URL(base+req.url.replace('/pong-swap',''));
   const upstream=http.request(target,{method:req.method,headers:{...req.headers,host:target.host}},reply=>{
    if(reply.statusCode>=400){report.transportErrors??=[];report.transportErrors.push({path:new URL(req.url,'http://localhost').pathname,status:reply.statusCode});}
    res.writeHead(reply.statusCode,{...reply.headers,'access-control-allow-origin':'*'});reply.pipe(res);
   });
   upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
   res.on('close',()=>upstream.destroy());req.pipe(upstream);return;
  }
  const f=files.get(new URL(req.url,'http://localhost').pathname);if(!f){res.writeHead(404);res.end();return;}
  const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||''),start=m?Number(m[1]):0,end=m&&m[2]?Math.min(f.size-1,Number(m[2])):f.size-1;
  if(start>end){res.writeHead(416);res.end();return;}
  res.writeHead(m?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,'Access-Control-Allow-Origin':'*',...(m?{'Content-Range':`bytes ${start}-${end}/${f.size}`}:{})});
  if(req.method==='HEAD'){res.end();return;}const rs=createReadStream(f.file,{start,end});res.on('close',()=>rs.destroy());rs.pipe(res);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 if(emulatorPort){
  if(snapshot)throw Error('Snapshot override is not supported on the receiver');
  receiver=await connectWebView(emulatorPort,'pong');
  report.receiverTikTokInitiallyOpen=await receiver.read('window.PongNativeSwap?.tiktokModeActive?.()===true');
  if(report.receiverTikTokInitiallyOpen){
   // Navigating the base WebView does not close its native TikTok layer.
   // Use the app's normal Back handling before injecting Recall fixtures.
   execFileSync(adb,['-s','emulator-5582','shell','input','keyevent','4'],{windowsHide:true});
   await wait('window.PongNativeSwap?.tiktokModeActive?.()!==true','TikTok mode closed',3000);
  }
  reversePort=server.address().port;
  execFileSync(adb,['-s','emulator-5582','reverse',`tcp:${reversePort}`,`tcp:${reversePort}`],{windowsHide:true});
  report.environment='Pong2 APK in the existing silent Android emulator; real Recall controller with isolated fixture response and local range source. Not a physical-phone or public-network measurement.';
  report.appVersion=execFileSync(adb,['-s','emulator-5582','shell','dumpsys','package','com.odiac22.pong2'],{encoding:'utf8'}).split(/\r?\n/).find(line=>line.includes('versionName='))?.trim();
 }else{
 const profile=await mkdtemp(path.join(out,'chrome-'));
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--incognito','--mute-audio','--disable-audio-output','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking','--disable-component-update','--autoplay-policy=no-user-gesture-required','about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<150&&!port;i++){try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}await delay(100);}
 const tab=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.type==='page');
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data)),p=pending.get(m.id);if(m.method==='Fetch.requestPaused'&&snapshot)void send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(snapshot).toString('base64')});if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.text);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 }
 await send('Page.enable');await send('Runtime.enable');if(!emulatorPort)await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true});
 if(snapshot)await send('Fetch.enable',{patterns:[{urlPattern:appBase+'/pong',resourceType:'Document'}]});
 injection=await send('Page.addScriptToEvaluateOnNewDocument',{source:`
 localStorage.setItem('pong_autoplay','0');
 window.__benchmarkAlerts=[];window.alert=message=>window.__benchmarkAlerts.push(String(message));
 for(const [key,value] of [['muted',true],['volume',0]]){const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);Object.defineProperty(HTMLMediaElement.prototype,key,{...d,set(){d.set.call(this,value)}});}
 window.__benchmarkOwnedSwapSessions=new Set();
 const rf=window.fetch;window.fetch=(input,options)=>{
  const u=new URL(typeof input==='string'?input:input.url,location.href);
  if(${desktopCapture}&&(u.pathname==='/simpcity/recall'||u.pathname.startsWith('/media-page/')||u.pathname.startsWith('/video-cache/')||u.pathname==='/proxy'))input=${JSON.stringify(appBase)}+u.pathname+u.search;
  if(u.pathname==='/simpcity/recall'&&window.__fixtureRecall)return Promise.resolve(new Response(JSON.stringify(window.__fixtureRecall),{status:200,headers:{'Content-Type':'application/json'}}));
  const createsSession=u.pathname==='/pong-swap/sessions'&&String(options?.method||input?.method||'GET').toUpperCase()==='POST';
  if(${JSON.stringify(base)}!=='http://127.0.0.1:8792'&&u.pathname.startsWith('/pong-swap/'))input=${JSON.stringify(origin)}+u.pathname+u.search;
  const response=rf(input,options);
  if(createsSession)void response.then(r=>r.clone().json()).then(r=>{if(r.session?.id)window.__benchmarkOwnedSwapSessions.add(r.session.id)}).catch(()=>{});
  return response;
 };
 for(const klass of [HTMLMediaElement,HTMLImageElement]){const src=Object.getOwnPropertyDescriptor(klass.prototype,'src');Object.defineProperty(klass.prototype,'src',{...src,set(value){const u=new URL(value,location.href),target=u.searchParams.get('url');if(u.pathname==='/proxy'&&target?.startsWith(${JSON.stringify(origin+'/')}))value=target;if(${JSON.stringify(base)}!=='http://127.0.0.1:8792'&&u.pathname.startsWith('/pong-swap/'))value=${JSON.stringify(origin)}+u.pathname+u.search;src.set.call(this,value);}});}
 `});
 for(const c of clips){
  const row={clip:c.ordinal,sourceFps:c.fps,duration:c.durationSeconds};report.clips.push(row);
  try {
  const previousOrigin=await ev('performance.timeOrigin');
  await send('Page.navigate',{url:appBase+'/pong'});
  await wait(`performance.timeOrigin!==${previousOrigin}&&document.readyState==='complete'&&!!window.PongModernUI&&typeof hideControls==='function'`,'UI');
  // Native gateway handoff can replace a briefly-ready document. Do not let
  // that navigation race enter a scored Recall click or lose the fixture.
  let stable=false;
  for(let attempt=0;attempt<10&&!stable;attempt++){
   const documentOrigin=await ev('performance.timeOrigin');await delay(500);
   stable=await ev(`performance.timeOrigin===${documentOrigin}&&document.readyState==='complete'&&typeof hideControls==='function'`);
  }
  if(!stable)throw Error('App document did not settle before the scored trial');
  // Public MP4 fixtures enter through the generic cache API, which validates
  // and authorizes public media. /proxy alone intentionally denies unknown
  // hosts; bypassing that guard would not model the normal import flow.
  let sourceUrl=networkSources&&c.sourceVariant?.link?c.sourceVariant.link:networkSources?null:origin+'/'+c.ordinal+'.mp4';
  if(!sourceUrl)throw Error('Requested network case has no attributed source variant');
  let actualPayload=null;
  if(desktopCapture){
   report.environment='Silent Pong2 APK on Android emulator; real desktop capture queue, public source resolution, isolated Recall list and real Recall button. Not a physical-phone network measurement.';
   if(await ev('location.origin')!==appBase)throw Error('Receiver left isolated audit origin');
   const pageUrl=process.env.PONG_CAPTURE_DIRECT==='1'?c.sourceVariant.link:c.pageUrl;
   if(!pageUrl)throw Error('No attributed public capture page');
   row.capture={pageUrl,id:randomUUID(),events:[]};
   const captureAt=performance.now();
   const response=await fetch(appBase+'/media-page/desktop-capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:row.capture.id,channel:recallChannel,sourceUrl:pageUrl,targets:[{url:pageUrl}],mode:'main',ignoreUnder30:false}),signal:AbortSignal.timeout(10000)});
   const ack=await response.json();row.capture.acceptedMs=performance.now()-captureAt;
   if(!response.ok||!ack.desktopOwned)throw Error('Desktop capture was not accepted');
   let job=ack.job;
   while(true){
    row.capture.events.push({elapsedMs:performance.now()-captureAt,job});await save();
    if(job.state!=='running')break;
    if(performance.now()-captureAt>135000)throw Error('Desktop capture deadline');
    await delay(200);
    job=(await(await fetch(appBase+'/media-page/desktop-capture?id='+row.capture.id,{signal:AbortSignal.timeout(5000)})).json()).job;
   }
   row.capture.readyMs=performance.now()-captureAt;row.capture.job=job;
   if(job.readyCount!==1)throw Error('Desktop capture failed: '+job.targets[0]?.error);
   const recallAt=performance.now();
   actualPayload=await(await fetch(appBase+'/simpcity/recall?channel='+recallChannel,{signal:AbortSignal.timeout(5000)})).json();
   row.capture.receiptReadMs=performance.now()-recallAt;
   const video=actualPayload.recall?.genericBundles?.flatMap(b=>b.videos||[])[0];
   if(!video?.videoUrl)throw Error('Ready capture missing from Recall receipt');
   sourceUrl=video.videoUrl;c.durationSeconds=video.durationSeconds||c.durationSeconds;row.duration=c.durationSeconds;
   row.capture.receipt={videoCount:actualPayload.recall.genericBundles.flatMap(b=>b.videos||[]).length,durationSeconds:c.durationSeconds};
   await save();
  }else if(networkSources){
   const resolveAt=performance.now();
   const response=await fetch(appBase+'/media-page/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:sourceUrl}),signal:AbortSignal.timeout(30000)});
   const resolved=await response.json();row.sourceRegistrationMs=performance.now()-resolveAt;
   if(!response.ok||!resolved.videoUrls?.includes(sourceUrl))throw Error('Public source registration failed');
  }
  const payload=actualPayload||{mediaTransport:report.transportCapabilities,recall:{id:'silent-benchmark-'+c.ordinal,channel:recallChannel,names:[],albums:[],genericBundles:[{title:'Licensed silent fixture '+c.ordinal,pageUrl:sourceUrl,videos:[{videoUrl:sourceUrl,pageUrl:sourceUrl,durationSeconds:c.durationSeconds}]}]}};
  await ev(`document.getElementById('pong-overlay')?.classList.add('hidden');hideControls();window.pongFaceSwapChannel=()=> 'test';window.__fixtureRecall=${desktopCapture?'null':JSON.stringify(payload)}`);
  const recallStart=performance.now();await ev(`document.getElementById('simpcity-recall-${recallChannel}').click()`);
  await wait("document.querySelector('.video-wrapper video')?.readyState>=2",'Recall source');
  if(emulatorPort&&await ev("window.PongNativeSwap?.tiktokModeActive?.()===true||document.querySelector('.video-wrapper')?.dataset.pongExternalPlaybackAuthority==='true'"))
   throw Error('Recall fixture contaminated by TikTok mode; no playback or swap score is valid');
  row.recallFirstFrameMs=performance.now()-recallStart;
  row.recallTransportPath=await ev("new URL(document.querySelector('.video-wrapper video').currentSrc,location.href).pathname");
  await ev("(()=>{const w=document.querySelector('.video-wrapper'),v=w.querySelector('video');v.pause();v.currentTime=0;w.dataset.userPaused='false';w.dataset.playIntent='true';document.getElementById('pong-face-swap-button').click();})()");
  await wait(`[...document.querySelectorAll('#pong-face-swap-menu button')].some(b=>b.textContent.trim()===${JSON.stringify(face.name)})`,'Face menu');
  const start=performance.now();
  await ev(`(()=>{const v=document.querySelector('.video-wrapper video');window.__swapStartupFrames=[];window.__swapStartupEvents=[];window.__swapClickAt=performance.now();for(const name of ['waiting','stalled','playing','ended'])v.addEventListener(name,()=>window.__swapStartupEvents.push({name,t:performance.now(),media:v.currentTime,src:v.currentSrc}));const cb=(t,m)=>{window.__swapStartupFrames.push({elapsedMs:t-window.__swapClickAt,t,media:m.mediaTime,src:v.currentSrc,presentedFrames:m.presentedFrames});if(!window.__fullObserver)v.requestVideoFrameCallback(cb);};v.requestVideoFrameCallback(cb);[...document.querySelectorAll('#pong-face-swap-menu button')].find(b=>b.textContent.trim()===${JSON.stringify(face.name)}).click();})()`);
  sid=await wait("(()=>{const w=document.querySelector('.video-wrapper'),v=w?.querySelector('video');return w?.dataset.pongFaceSwapActive==='true'&&w.dataset.pongFaceSwapBusy!=='true'&&v.readyState>=2&&w.dataset.pongFaceSwapSessionId;})()",'Swap',60000);
  row.swapFirstPlayableMs=performance.now()-start;
  row.startupSession=(await api('/sessions/'+sid)).session;
  const faceDeadline=performance.now()+3000;
  while(!row.startupSession.firstTransformedFrameAt&&performance.now()<faceDeadline){await delay(100);row.startupSession=(await api('/sessions/'+sid)).session;}
  // Do not label an original/no-face first stream frame as a fast swap.
  // This conservative timestamp gate checks both the engine's target lock
  // and a browser-presented frame owned by the matching stream session.
  row.transformedStartupConfirmed=row.startupSession.transformedFrames>0;
  if(row.transformedStartupConfirmed){
   const targetTime=Math.max(0,Number(row.startupSession.automaticTargetLockSeconds||0));
   const firstFace=await wait(`window.__swapStartupFrames.find(f=>f.src.includes('/sessions/'+${JSON.stringify(sid)}+'/stream')&&f.media>=${targetTime})`,'Presented transformed track',5000);
   row.faceAppliedMs=firstFace.elapsedMs;
   row.faceAppliedEvidence={kind:'owned_presented_frame_after_engine_target_lock',mediaTime:firstFace.media,targetLockSeconds:targetTime};
  }
  row.startupDiagnostics=await ev("pongRuntimeDiagnostics.slice(-35)");
  // A preview is a real exact output frame, but is not evidence of continuous
  // playback. Keep its latency separate from the first video-frame metric.
  const preview=row.startupDiagnostics.find(d=>d.type==='swap.startup-preview-frame');
  if(preview&&row.startupSession.firstRenderedFrameTransformed===true&&Number.isFinite(preview.detail?.activationMs)){
   row.exactSwappedPreviewMs=preview.detail.activationMs;
   row.firstVisibleSwapMs=Math.min(row.exactSwappedPreviewMs,row.faceAppliedMs??Infinity);
  }else row.firstVisibleSwapMs=row.faceAppliedMs??null;
  row.sourceDimensions={width:c.width,height:c.height};
  if(startupOnly){
   await ev("document.querySelector('.video-wrapper video').pause()");
   await api('/sessions/'+sid+'?defer=false','DELETE');sid=null;
   console.log(JSON.stringify({clip:c.ordinal,swapMs:row.swapFirstPlayableMs,faceAppliedMs:row.faceAppliedMs,firstInferenceMs:row.startupSession.firstTransformedFrameAt?1000*(row.startupSession.firstTransformedFrameAt-row.startupSession.createdAt):null}));await save();continue;
  }
  if(process.env.PONG_INTERACTIONS==='1'){
   await delay(1500);
   row.interactions=await ev(`(async()=>{
    const w=document.querySelector('.video-wrapper'),v=w.querySelector('video'),result=[];
    window.__interactionResults=result;
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    async function toggle(label){
     const start=performance.now(),wantPaused=label.startsWith('pause');let presentedMs=null;
     const cb=v.requestVideoFrameCallback(()=>{presentedMs=performance.now()-start;});
     toggleVideoPlaybackFromIntent(w,v);const commandMs=performance.now()-start;
     for(let n=0;n<50&&v.paused!==wantPaused;n++)await sleep(20);
     const stateMs=v.paused===wantPaused?performance.now()-start:null;
     await sleep(250);v.cancelVideoFrameCallback(cb);
     result.push({action:label,commandMs,stateMs,presentedMs,wallMs:performance.now()-start,paused:v.paused,time:pongFaceSwapAbsoluteTime(w,v),intent:w.dataset.userPaused});
    }
    await toggle('pause');
    const firstOffset=Number(v.__pongSwapOriginal?.startSeconds||0);
    const targets=[firstOffset+.3,firstOffset+.7,${process.env.PONG_SEEK_PROBE==='1'?'':c.ordinal==='eating'?'10,20,40':'3.2,3.6'}];
    for(const target of targets){
     const oldSession=w.dataset.pongFaceSwapSessionId;
     const ranges=r=>Array.from({length:r.length},(_,i)=>[r.start(i),r.end(i)]);
     const before={buffered:ranges(v.buffered),seekable:ranges(v.seekable),time:v.currentTime,offset:Number(v.__pongSwapOriginal?.startSeconds||0),paused:v.paused};
     const start=performance.now();let presentedMs=null,cb;
     const onFrame=()=>{
      const session=w.dataset.pongFaceSwapSessionId;
      const owns=Boolean(session&&w.dataset.pongFaceSwapActive==='true'&&v.currentSrc.includes('/pong-swap/sessions/'+encodeURIComponent(session)+'/stream'));
      if(owns&&Math.abs(pongFaceSwapAbsoluteTime(w,v)-target)<.15)presentedMs=performance.now()-start;
      else cb=v.requestVideoFrameCallback(onFrame);
     };
     cb=v.requestVideoFrameCallback(onFrame);
     const success=${process.env.PONG_SEEK_PROBE==='1'?'(v.currentTime=target-Number(v.__pongSwapOriginal?.startSeconds||0),true)':'await seekPongVideoTo(w,v,target)'};
     const completedMs=performance.now()-start;
     for(let n=0;n<400&&presentedMs===null;n++)await sleep(20);
     v.cancelVideoFrameCallback(cb);
     const owned=Boolean(w.dataset.pongFaceSwapSessionId&&w.dataset.pongFaceSwapActive==='true'&&v.currentSrc.includes('/pong-swap/sessions/'+encodeURIComponent(w.dataset.pongFaceSwapSessionId)+'/stream'));
     result.push({action:'seek',target,success,completedMs,presentedMs,owned,sameSession:oldSession===w.dataset.pongFaceSwapSessionId,before,after:{time:pongFaceSwapAbsoluteTime(w,v),paused:v.paused,sourceDuration:pongFaceSwapFullDuration(w,v)}});
     if(!owned)break;
    }
    await toggle('play');await toggle('pause-again');await toggle('play-again');
    if(${process.env.PONG_PLAYING_SEEK==='1'}){
     const target=${c.ordinal==='eating'?'10':'1.5'},start=performance.now();let presentedMs=null,cb;
     const onFrame=()=>{const id=w.dataset.pongFaceSwapSessionId;
      if(id&&w.dataset.pongFaceSwapActive==='true'&&v.currentSrc.includes('/pong-swap/sessions/'+encodeURIComponent(id)+'/stream')&&Math.abs(pongFaceSwapAbsoluteTime(w,v)-target)<.4)presentedMs=performance.now()-start;
      else cb=v.requestVideoFrameCallback(onFrame);
     };cb=v.requestVideoFrameCallback(onFrame);
     const success=await seekPongVideoTo(w,v,target);
     for(let n=0;n<400&&presentedMs===null;n++)await sleep(20);
     v.cancelVideoFrameCallback(cb);const first=pongFaceSwapAbsoluteTime(w,v);await sleep(300);
     result.push({action:'playing-seek',success,target,presentedMs,paused:v.paused,advanced:pongFaceSwapAbsoluteTime(w,v)-first});
    }
    return result;
   })()`);
   row.diagnostics=await ev("pongRuntimeDiagnostics.slice(-100)");
   sid=await ev("document.querySelector('.video-wrapper').dataset.pongFaceSwapSessionId");
   if(!sid){row.diagnostics=await ev("pongRuntimeDiagnostics.slice(-20)");throw Error('Swap ownership was lost during interaction test; original-video frames are not a pass');}
   row.finalSession=(await api('/sessions/'+sid)).session;
   row.interactionPass=row.interactions.every(a=>a.action==='seek'?a.success&&a.owned&&a.presentedMs!==null&&Math.abs(a.after.time-a.target)<.15:a.action==='playing-seek'?a.success&&a.presentedMs!==null&&!a.paused&&a.advanced>.15:a.paused===a.action.startsWith('pause'));
   await ev("document.querySelector('.video-wrapper video').pause()");
   await api('/sessions/'+sid+'?defer=false','DELETE');sid=null;
   console.log(JSON.stringify({clip:c.ordinal,interactions:row.interactions}));await save();continue;
  }
  row.playStart=await ev(`(()=>{const v=document.querySelector('.video-wrapper video'),token='/sessions/'+${JSON.stringify(sid)}+'/stream';window.__fullObserver=true;window.__frames=window.__swapStartupFrames.filter(f=>f.src.includes(token)).map((f,i,a)=>({...f,src:undefined,gap:i?f.t-a[i-1].t:0}));const first=window.__frames[0]||{t:performance.now(),media:v.currentTime};window.__events=window.__swapStartupEvents.filter(e=>e.src.includes(token)&&e.t>=first.t).map(e=>({...e,src:undefined}));let prev=window.__frames.at(-1)?.t;const cb=(t,m)=>{window.__frames.push({gap:prev?t-prev:0,media:m.mediaTime,t,presentedFrames:m.presentedFrames});prev=t;v.requestVideoFrameCallback(cb);};v.requestVideoFrameCallback(cb);for(const name of ['waiting','stalled','playing','ended'])v.addEventListener(name,()=>window.__events.push({name,t:performance.now(),media:v.currentTime}));v.loop=false;v.muted=true;v.volume=0;void v.play();return {t:first.t,media:first.media};})()`);
  const playStart=performance.now();let last;
  while(performance.now()-playStart<(fullPlayback?(c.durationSeconds*2000+30000):(c.ordinal==='eating'?35000:14000))){
   last=await ev("(()=>{const v=document.querySelector('.video-wrapper video');return {t:v.currentTime,browserNow:performance.now(),duration:v.duration,paused:v.paused,ended:v.ended,frames:window.__frames.length,events:window.__events}})()");
   if(last.events.some(e=>e.name==='ended')||(!fullPlayback&&last.t>=c.durationSeconds-.2))break;await delay(120);
  }
  row.playWallSeconds=((last.events.find(e=>e.name==='ended')?.t||last.browserNow)-row.playStart.t)/1000;row.playback=last;
  row.frames=await ev("window.__frames");row.finalSession=(await api('/sessions/'+sid)).session;
  row.presentedSeconds=row.frames.at(-1)?.media||0;
  row.bufferEvents=last.events.filter(e=>e.name==='waiting'||e.name==='stalled');
  // Both clocks are browser-relative. Repeated waiting/stalled events must
  // not double-count an interval; stalled alone means network, not playback.
  let waitingAt=null,waitMs=0;row.rebufferCount=0;
  for(const e of last.events){
   if(e.name==='waiting'&&waitingAt===null){waitingAt=e.t;row.rebufferCount++;}
   if((e.name==='playing'||e.name==='ended')&&waitingAt!==null){waitMs+=Math.max(0,e.t-waitingAt);waitingAt=null;}
  }
  if(waitingAt!==null)waitMs+=Math.max(0,last.browserNow-waitingAt);
  row.bufferedWaitSeconds=waitMs/1000;
  row.fullPlaybackCompleted=last.events.some(e=>e.name==='ended')&&row.presentedSeconds>=last.duration-Math.max(.10,2/row.finalSession.fps);
  row.advancementRatio=(last.t-row.playStart.media)/row.playWallSeconds;row.maxPresentedGapMs=Math.max(0,...row.frames.map(f=>f.gap));
  row.transformedRatio=row.finalSession.transformedFrames/Math.max(1,row.finalSession.frames);
  // A completed benchmark is not a playback pass. Short prebuffered clips
  // must not conceal a sustained underrun or the existing high-FPS cap.
  const outputFps=row.finalSession.fps;
  row.acceptance={
   advancement:row.advancementRatio>=.98 && (!fullPlayback||row.fullPlaybackCompleted),
   presentationGaps:row.maxPresentedGapMs<=Math.max(120,3000/outputFps),
   transformedFrames:row.transformedRatio>=.999,
   nativeSourceCadence:outputFps>=row.finalSession.sourceFps*.98,
   outputFps,sourceFps:row.finalSession.sourceFps,
  };
  // Natural no-face/occluded footage must remain original. Transformation
  // coverage is separate evidence, not a reason to fake pixels or miss a stall.
  row.acceptance.outputPlaybackPass=row.acceptance.advancement&&row.acceptance.presentationGaps&&row.bufferedWaitSeconds<.15;
  row.playbackQuality=await ev("(()=>{const v=document.querySelector('.video-wrapper video');return v?.getVideoPlaybackQuality?.()||null})()");
  if(process.env.PONG_BENCH_SAVE_MEDIA==='1'){
   const response=await fetch(base+'/sessions/'+encodeURIComponent(sid)+'/stream',{signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw Error('Unable to retain benchmark output for grading');
   row.outputFile=path.join(out,'clip-'+c.ordinal+'-swapped.mp4');
   await writeFile(row.outputFile,Buffer.from(await response.arrayBuffer()));
   const shot=await send('Page.captureScreenshot',{format:'png'});
   row.screenshot=path.join(out,'clip-'+c.ordinal+'-end.png');await writeFile(row.screenshot,Buffer.from(shot.data,'base64'));
  }
  await ev("document.querySelector('.video-wrapper video').pause()");
  await api('/sessions/'+sid+'?defer=false','DELETE');sid=null;
  console.log(JSON.stringify({clip:row.clip,loadMs:row.recallFirstFrameMs,swapMs:row.swapFirstPlayableMs,advance:row.advancementRatio,gap:row.maxPresentedGapMs,transformed:row.transformedRatio}));await save();
  } catch(error) {
   row.error=error.stack;report.errors.push({clip:c.ordinal,error:error.message});
   if(process.env.PONG_INTERACTIONS==='1')row.interactions=await ev('window.__interactionResults||null').catch(()=>null);
   row.failureDiagnostics=await ev("pongRuntimeDiagnostics.slice(-40)").catch(()=>null);
   row.failureMedia=await ev("[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,network:v.networkState,error:v.error?.message,sourcePath:(()=>{try{return new URL(v.currentSrc).pathname}catch{return ''}})()}))").catch(()=>null);
   if(sid){row.finalSession=await api('/sessions/'+sid).catch(()=>null);await api('/sessions/'+sid+'?defer=false','DELETE').catch(()=>{});sid=null;}
   console.error(JSON.stringify({clip:c.ordinal,error:error.message}));await save();
  } finally {
   // Recovery can create a replacement session after the last saved `sid`.
   // Retire only IDs created by this benchmark page, never arbitrary sessions.
   const owned=await ev('[...(window.__benchmarkOwnedSwapSessions||[])]').catch(()=>[]);
   for(const id of owned)await api('/sessions/'+encodeURIComponent(id)+'?defer=false','DELETE').catch(()=>{});
  }
 }
 report.completed=true;
 if(fullPlayback&&!startupOnly&&process.env.PONG_INTERACTIONS!=='1')report.fpsSummary=summarizePlaybackFps(report);
 if(report.fpsSummary){
  report.fpsAcceptance={allClipsAtLeast34:report.fpsSummary.allRenderWorkAtLeast34,medianAtLeast40:report.fpsSummary.medianRenderWorkAtLeast40,zeroBuffering:report.fpsSummary.allZeroBuffering};
  report.fpsAcceptance.passed=Object.values(report.fpsAcceptance).every(v=>v===true);
  if(!report.fpsAcceptance.passed)process.exitCode=2;
 }
 report.acceptance=startupOnly?{allUnder1500ms:report.clips.length>0&&report.clips.every(c=>!c.error&&c.transformedStartupConfirmed&&c.faceAppliedMs<1500),maxMs:Math.max(...report.clips.map(c=>c.faceAppliedMs||Infinity))}:process.env.PONG_INTERACTIONS==='1'?{allInteractionsPassed:report.clips.every(c=>c.interactionPass)}:{allOutputPlaybackPassed:report.clips.every(c=>c.acceptance?.outputPlaybackPass),allNativeCadencesPreserved:report.clips.every(c=>c.acceptance?.nativeSourceCadence)};
 if(process.env.PONG_INTERACTIONS==='1'&&!report.acceptance.allInteractionsPassed)process.exitCode=2;
 if(!startupOnly&&process.env.PONG_INTERACTIONS!=='1'&&(!report.acceptance.allOutputPlaybackPassed||!report.acceptance.allNativeCadencesPreserved))process.exitCode=2;
 if(startupOnly&&!report.acceptance.allUnder1500ms)process.exitCode=2;
}catch(e){report.error=e.stack;report.failureUi=await ev("({text:document.body.innerText.slice(-1800),videos:[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc,ready:v.readyState,error:v.error?.message})),recall:window.__fixtureRecall})").catch(()=>null);console.error(e.stack);console.error(JSON.stringify(report.failureUi));process.exitCode=1;}
finally{
 if(sid)await api('/sessions/'+sid+'?defer=false','DELETE').catch(()=>{});
 if(receiver){
  if(injection?.identifier)await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection.identifier}).catch(()=>{});
  await send('Page.reload').catch(()=>{});receiver.close();
 }
 if(reversePort)execFileSync(adb,['-s','emulator-5582','reverse','--remove',`tcp:${reversePort}`],{windowsHide:true});
 if(ws?.readyState===1)await send('Browser.close').catch(()=>{});ws?.close();
 server?.closeAllConnections();server?.close();await save();
}
