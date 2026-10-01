// Actual Pong WebView + silent public stock. No Recall queue or preset writes.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const out=process.argv[2] || 'E:/Pong Benchmarks/v3038-detect/android-valid-selection';
const runNonce=Date.now().toString(36);
const base='http://127.0.0.1:8792';
const cdpPortText=process.env.PONG_DETECT_CDP_PORT||'9224';
if(!/^\d+$/.test(cdpPortText)||Number(cdpPortText)<1||Number(cdpPortText)>65535)throw Error('Invalid PONG_DETECT_CDP_PORT');
const cdpPort=Number(cdpPortText);
const request=async(path,method='GET')=>{
  const r=await fetch(base+path,{method,signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error(`renderer ${r.status}`);return r.json();
};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sessions=(await request('/sessions')).sessions;
if(sessions.some(s=>!s.complete&&!s.playbackPaused))throw Error('Active user playback; no sessions interrupted');
if(sessions.some(s=>s.channel==='test'))throw Error('Test channel already owned');
const initialIds=new Set(sessions.map(s=>s.id));
const config=(await request('/settings')).config;
if(config.runtime.swapAudioEnabled!==false)throw Error('Silent renderer required');
const faces=(await request('/faces')).faces;
const faceId=faces.find(f=>f.name==='Approved 3').id;
const manifest=JSON.parse(await readFile('E:/Pong Benchmarks/v3029-overnight/corpus/manifest.json','utf8'));
const clipIds=(process.env.PONG_DETECT_CLIPS||'1,2,4').split(',').map(Number);
const disableBackdrop=process.env.PONG_DETECT_DISABLE_BACKDROP==='1';
const expectedUiVersion=process.env.PONG_DETECT_EXPECT_UI_VERSION||'30.38';
if(!/^\d+\.\d+(?:\.\d+)?$/.test(expectedUiVersion))throw Error('Invalid expected UI version');
const clips=manifest.clips.filter(c=>clipIds.includes(c.ordinal));
const pongPages=(await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(r=>r.json()))
  .filter(t=>t.type==='page'&&new URL(t.url).pathname==='/pong');
if(pongPages.length!==1)throw Error(`Expected exactly one Pong page on CDP port ${cdpPort}; found ${pongPages.length}`);
const target=pongPages[0];
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pending=new Map(), mediaDiagnostics=new Map(), networkRequests=new Map(), networkStreams=[];
ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);
  if(m.method==='Network.requestWillBeSent'){
    const match=/\/pong-swap\/sessions\/([^/?#]+)\/stream(?:[?#]|$)/.exec(m.params?.request?.url||'');
    if(match&&networkStreams.length<30){
      const row={sessionId:match[1],requestWallTime:m.params.wallTime,requestTimestamp:m.params.timestamp,
        responseStatus:null,firstDataTimestamp:null,firstDataBytes:null,totalDataBytes:0,finishedTimestamp:null,error:null};
      networkStreams.push(row);networkRequests.set(m.params.requestId,row);
    }
  }else if(m.method==='Network.responseReceived'){
    const row=networkRequests.get(m.params?.requestId);
    if(row){row.responseTimestamp=m.params.timestamp;row.responseStatus=m.params.response?.status??null;}
  }else if(m.method==='Network.dataReceived'){
    const row=networkRequests.get(m.params?.requestId);
    if(row){if(row.firstDataTimestamp===null){row.firstDataTimestamp=m.params.timestamp;row.firstDataBytes=m.params.dataLength??0;}
      row.totalDataBytes+=m.params.dataLength??0;}
  }else if(m.method==='Network.loadingFinished'||m.method==='Network.loadingFailed'){
    const row=networkRequests.get(m.params?.requestId);
    if(row){row.finishedTimestamp=m.params.timestamp;
      if(m.method==='Network.loadingFailed')row.error=String(m.params.errorText||'failed').slice(0,120);
      networkRequests.delete(m.params.requestId);}
  }
  if(m.method?.startsWith('Media.')){
    const params=m.params||{}, key=params.playerId;
    if(key){
      const row=mediaDiagnostics.get(key)||{properties:{},bufferingEvents:[]};mediaDiagnostics.set(key,row);
      for(const prop of params.properties||[]){
        if(/decoder|resolution|frame_rate|codec/i.test(prop.name)&&!/(?:https?:|file:|blob:|[A-Za-z]:\\)/i.test(prop.value))row.properties[prop.name]=prop.value;
        if(prop.name==='url')row.sourceKind=/\/pong-swap\/sessions\/[^/]+\/stream/.test(prop.value)?'swap':'other';
      }
      for(const event of params.events||[]){
        let value;try{value=JSON.parse(event.value);}catch{continue;}
        for(const name of ['video_buffering_state','pipeline_buffering_state','audio_buffering_state']){
          const state=value[name];if(state&&row.bufferingEvents.length<150)row.bufferingEvents.push({timestamp:event.timestamp,type:name,state:state.state,reason:state.reason});
        }
      }
    }
  }
  if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);
};
const send=(method,params={},timeout=30000)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject,timer:setTimeout(()=>{pending.delete(n);reject(Error(method+' timed out'));},timeout)});ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async(expression,timeout=30000)=>{
  const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},timeout);
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result?.value;
};
const until=async(expression,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){try{const value=await evaluate(expression);if(value)return value;}catch(error){if(!/context|not defined/i.test(error.message))throw error;}await delay(100);}throw Error('UI condition timeout');};
const report={scope:'Pong Android emulator WebView. Public direct-media import (NOT Recall/Tampermonkey). Warm renderer. Unchanged quality. No audio.',
  serviceVersion:(await request('/health')).serviceVersion,cdpPort,disableBackdrop,expectedUiVersion,configHash:hash(config),cases:[]};
let storage,muteScript;
await mkdir(out,{recursive:true});
const save=()=>writeFile(out+'/report.json',JSON.stringify(report,null,2));
try{
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Media.enable').catch(()=>{});
  // Opaque in-memory snapshot only, not emitted or persisted in reports.
  storage=await evaluate('({local:{...localStorage},session:{...sessionStorage}})');
  const init=`(()=>{window.__detectAuditRunNonce=${JSON.stringify(runNonce)};window.PongFaceSwapChannelOverride='test';window.autoplayEnabled=false;window.pongUserWantsAudio=false;
    if(!window.__detectAuditMediaEvents){window.__detectAuditMediaEvents=[];
      for(const type of ['loadstart','loadedmetadata','loadeddata','canplay'])document.addEventListener(type,event=>{
        const video=event.target,match=/\\/pong-swap\\/sessions\\/([^/?#]+)\\/stream(?:[?#]|$)/.exec(video?.currentSrc||video?.src||'');
        if(match&&window.__detectAuditMediaEvents.length<40)window.__detectAuditMediaEvents.push({sessionId:match[1],type,
          wallTime:performance.timeOrigin/1000+performance.now()/1000,readyState:video.readyState,networkState:video.networkState});
      },true);}
    localStorage.setItem('pong_player_audio_pref_v2','muted');
    const originalPlay=window.__detectAuditNativePlay||HTMLMediaElement.prototype.play;window.__detectAuditNativePlay=originalPlay;
    HTMLMediaElement.prototype.play=function(...args){this.muted=true;this.defaultMuted=true;this.volume=0;return originalPlay.apply(this,args);};
    window.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0;v.pause();});});})()`;
  muteScript=(await send('Page.addScriptToEvaluateOnNewDocument',{source:init})).identifier;
  await evaluate(`window.__detectAuditBeforeReload=true`);
  await send('Page.reload',{ignoreCache:true});
  await until(`!window.__detectAuditBeforeReload && document.readyState==='complete' && typeof pongFaceSwapState==='object' && document.querySelector('.version-number')?.textContent===${JSON.stringify(expectedUiVersion)}`);
  await evaluate(init);
  await evaluate(`(()=>{window.PongFaceSwapChannelOverride='test'; window.autoplayEnabled=false;
    document.getElementById('pong-overlay').style.display='none';
    pongFaceSwapState.enabled=false;pongFaceSwapState.faceId='';clearPongFaceSwapPrefetches();return true;})()`);
  if(disableBackdrop){
    report.visibleBackdropElements=await evaluate(`Array.from(document.querySelectorAll('body *')).filter(e=>{
      const style=getComputedStyle(e),rect=e.getBoundingClientRect();
      return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&
        ((style.backdropFilter&&style.backdropFilter!=='none')||(style.webkitBackdropFilter&&style.webkitBackdropFilter!=='none'));
    }).length`);
    await evaluate(`(()=>{const style=document.createElement('style');style.id='pong-detect-no-backdrop';
      style.textContent='body * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }';
      document.head.appendChild(style);return true;})()`);
  }
  report.uiVersion=await evaluate(`document.querySelector('.version-number').textContent`);
  for(const clip of clips){
    if((await request('/sessions')).sessions.some(s=>s.channel!=='test'&&!s.complete&&!s.playbackPaused))throw Error('User playback started; benchmark stopped');
    const row={clip:clip.ordinal,sourceFps:clip.fps};report.cases.push(row);
    try{
      const imported=await evaluate(`(()=>{window.__detectAuditImport=performance.now();
        pongFaceSwapState.enabled=false;clearPongFaceSwapPrefetches();
        parsedVideoUrlsCache=[];parsedVideoMetadataCache=[];pendingPastes=[];
        videoUrlsInput.value=${JSON.stringify(clip.sourceVariant.link)};loadVideosButton.click();return true;})()`);
      row.originalReadyMs=await until(`(()=>{const v=pongFaceSwapCurrentWrapper()?.querySelector('video');return v?.readyState>=2&&v.videoWidth?performance.now()-window.__detectAuditImport:0;})()`,25000);
      if(process.argv.includes('--original-only')){
        row.originalPlayback=await evaluate(`(async()=>{const v=pongFaceSwapCurrentWrapper().querySelector('video');v.muted=true;v.volume=0;
          let frames=0,waiting=0,maxGapMs=0,last=null,callback;const samples=[];
          const wait=()=>waiting++;v.addEventListener('waiting',wait);
          const painted=(t,m)=>{frames++;if(last!==null)maxGapMs=Math.max(maxGapMs,t-last);last=t;if(frames%25===1)samples.push({wall:t,mediaTime:m.mediaTime,bufferedEnd:v.buffered.length?v.buffered.end(v.buffered.length-1):null});callback=v.requestVideoFrameCallback(painted);};
          callback=v.requestVideoFrameCallback(painted);const start=performance.now();await playVideoCleanly(v);
          await new Promise(r=>setTimeout(r,10000));v.cancelVideoFrameCallback(callback);v.removeEventListener('waiting',wait);
          const result={frames,waiting,maxGapMs,wallMs:performance.now()-start,paused:v.paused,ended:v.ended,samples};v.pause();return result;})()`);
        await save();console.log(JSON.stringify(row));continue;
      }
      row.swapCall=await evaluate(`(async()=>{window.__detectAuditSwap=performance.now();window.__detectAuditStartSequence=PongRuntimeDiagnostics.snapshot().latestSequence;
        setPongFaceSwapSelection([${JSON.stringify(faceId)}]);setPongFaceSwapPersistentEnabled(true);
        return await primePongFaceSwap(${JSON.stringify(faceId)});})()`);
      row.swapDisplayReadyMs=await until(`(()=>{const w=pongFaceSwapCurrentWrapper(),v=w?.querySelector('video');return w?.dataset.pongFaceSwapActive==='true'&&v?.readyState>=2&&v.videoWidth?performance.now()-window.__detectAuditSwap:0;})()`,25000);
      // A displayed swap stream is not proof every frame was transformed.
      const sid=await evaluate(`pongFaceSwapCurrentWrapper()?.dataset.pongFaceSwapSessionId||''`);
      const session=sid?(await request('/sessions/'+sid)).session:{};
      row.rendererTransformedFrames=session.transformedFrames??session.swappedFrames??null;
      row.rendererFirstTransformed=Boolean(session.firstTransformedFrameAt);
      row.rendererOpeningFrameTransformed=session.firstRenderedFrameTransformed??null;
      row.startupDiagnostics=await evaluate(`PongRuntimeDiagnostics.snapshot().events.filter(e=>e.sequence>window.__detectAuditStartSequence&&(e.type==='swap.session-owned'||e.type==='swap.startup-preview-frame'||e.type==='swap.first-frame'))`);
      row.startupPreviewActivationMs=row.startupDiagnostics.find(e=>e.type==='swap.startup-preview-frame')?.detail?.activationMs??null;
      if(process.argv.includes('--origin-probe')){
        row.nativeImageOriginProbe=await evaluate(`(async()=>{const base=await ensurePongFaceSwapBackgroundControlPlane();
          const url=(base||'')+'/pong-swap/sessions/'+encodeURIComponent(${JSON.stringify(sid)})+'/first-frame?waitMs=1000';const rows=[];
          for(const mode of ['no-cors','anonymous']){rows.push(await new Promise(resolve=>{const image=new Image(),start=performance.now();let timer;
            const done=outcome=>{clearTimeout(timer);image.onload=image.onerror=null;resolve({mode,outcome,elapsedMs:performance.now()-start,width:image.naturalWidth,height:image.naturalHeight});};
            if(mode==='anonymous')image.crossOrigin='anonymous';image.onload=()=>done('loaded');image.onerror=()=>done('failed');timer=setTimeout(()=>done('timeout'),2500);image.src=url;}));}
          return rows;})()`);
      }
      row.detect=await evaluate(`(async()=>{const t=performance.now();const frameTime=pongFaceSwapCurrentWrapper()?.querySelector('video')?.currentTime;const ok=await openQuickPongFaceDetect();
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return {ok,frameTime,paintOpportunityMs:performance.now()-t,boxCount:document.querySelectorAll('.pong-swap-face-detect-box').length,editorStillOpen:Boolean(pongFaceSwapState.settingsEditor),...pongFaceSwapState.lastDetectTimings};})()`);
      row.detectUnder1s=Boolean(row.detect.ok&&row.detect.boxCount&&row.detect.paintOpportunityMs<1000);
      if(process.argv.includes('--select')&&row.detect.ok){
        const point=await evaluate(`(()=>{const r=document.querySelector('.pong-swap-face-detect-box').getBoundingClientRect();window.__detectAuditConfirm=performance.now();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
        await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,radiusX:1,radiusY:1,force:1}]});
        await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        row.confirmToStreamReadyMs=await until(`(()=>{const w=pongFaceSwapCurrentWrapper(),v=w?.querySelector('video');return !pongFaceSwapState.settingsEditor&&w?.dataset.pongFaceSwapSessionId!==${JSON.stringify(sid)}&&w?.dataset.pongFaceSwapBusy!=='true'&&w?.dataset.pongFaceSwapActive==='true'&&v?.readyState>=2&&v.__pongSwapPresentedGeneration===w.dataset.pongFaceSwapGeneration?performance.now()-window.__detectAuditConfirm:0;})()`,20000);
        row.manualIdentityConfirmed=await evaluate(`pongFaceSwapState.manualTargets.size>0`);
        const confirmedSid=await evaluate(`pongFaceSwapCurrentWrapper()?.dataset.pongFaceSwapSessionId||''`);
        row.backendIdentityLocked=Boolean((await request('/sessions/'+confirmedSid)).session?.manualTarget?.identityLocked);
        if(!row.backendIdentityLocked)throw Error('Confirmed face descriptor missing from owning renderer session');
      }else if(await evaluate(`Boolean(pongFaceSwapState.settingsEditor)`)) await evaluate(`closePongFaceSwapSettingsPanel({persist:false})`);
      if(process.argv.includes('--select')){
        // A no-face opening is not a successful Detect result. Still measure
        // the entire playback independently instead of silently dropping it.
        row.playbackTargetMode=row.manualIdentityConfirmed?'confirmed_original':'automatic_no_manual_selection';
        await evaluate(`(async()=>{const w=pongFaceSwapCurrentWrapper(),v=w.querySelector('video');v.muted=true;v.volume=0;
          w.dataset.userPaused='false';w.dataset.playIntent='true';await playVideoCleanly(v);})()`);
        await until(`(()=>{const v=pongFaceSwapCurrentWrapper()?.querySelector('video');return v&&!v.paused&&v.currentTime>0;})()`,8000);
        row.mediaElements=await evaluate(`Array.from(document.querySelectorAll('video,audio'),v=>({tag:v.tagName,className:v.className,paused:v.paused,readyState:v.readyState,width:v.videoWidth,height:v.videoHeight,currentTime:v.currentTime,sourceKind:/\\/pong-swap\\/sessions\\//.test(v.currentSrc)?'swap':'other'}))`);
        if(process.argv.includes('--profile')){await send('Profiler.enable');await send('Profiler.start');}
        const playbackMs=process.argv.includes('--full')?Math.ceil(Number(clip.durationSeconds)*1000+15000):10000;
        row.playback=await evaluate(`(async()=>{const v=pongFaceSwapCurrentWrapper().querySelector('video');let frames=0,waiting=0,maxGapMs=0,last=null,callback;const samples=[],events=[],longTasks=[];
          const qualityBefore=v.getVideoPlaybackQuality?.();const listeners=[];let observer;
          try{observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));observer.observe({entryTypes:['longtask']});}catch{}
          for(const type of ['waiting','playing','stalled','seeking','seeked','pause','ratechange']){const fn=()=>{if(type==='waiting')waiting++;if(events.length<150)events.push({type,wall:performance.now(),time:v.currentTime,readyState:v.readyState,paused:v.paused,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])});};v.addEventListener(type,fn);listeners.push([type,fn]);}
          const painted=(t,m)=>{frames++;if(last!==null)maxGapMs=Math.max(maxGapMs,t-last);last=t;if(frames%25===1)samples.push({wall:t,mediaTime:m.mediaTime,currentTime:v.currentTime,processingDuration:m.processingDuration,bufferedEnd:v.buffered.length?v.buffered.end(v.buffered.length-1):null});callback=v.requestVideoFrameCallback(painted);};
          callback=v.requestVideoFrameCallback(painted);const start=performance.now();
          const startMediaTime=v.currentTime;
          await new Promise(r=>{let timer;const finish=()=>{clearTimeout(timer);v.removeEventListener('ended',finish);r();};timer=setTimeout(finish,${playbackMs});${process.argv.includes('--full')?"v.addEventListener('ended',finish,{once:true});if(v.ended)finish();":''}});
          v.cancelVideoFrameCallback(callback);for(const [type,fn] of listeners)v.removeEventListener(type,fn);observer?.disconnect();
          const q=v.getVideoPlaybackQuality?.();const quality=q&&{total:q.totalVideoFrames-qualityBefore.totalVideoFrames,dropped:q.droppedVideoFrames-qualityBefore.droppedVideoFrames,corrupted:q.corruptedVideoFrames-qualityBefore.corruptedVideoFrames};
          return {frames,waiting,maxGapMs,wallMs:performance.now()-start,startMediaTime,endMediaTime:v.currentTime,paused:v.paused,ended:v.ended,playbackRate:v.playbackRate,samples,events,longTasks,quality};})()`,playbackMs+10000);
        if(process.argv.includes('--profile')){
          const {profile}=await send('Profiler.stop');const nodes=new Map(profile.nodes.map(n=>[n.id,n])), sums=new Map();
          for(let i=0;i<(profile.samples||[]).length;i++){const name=nodes.get(profile.samples[i])?.callFrame?.functionName||'(anonymous)';sums.set(name,(sums.get(name)||0)+(profile.timeDeltas[i]||0)/1000);}
          row.scriptProfile={scope:'main-thread CPU samples only; no source URLs or source text',selfMs:[...sums].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([functionName,ms])=>({functionName,ms}))};
        }
        const activeSid=await evaluate(`pongFaceSwapCurrentWrapper()?.dataset.pongFaceSwapSessionId||''`);
        const playbackSession=activeSid?(await request('/sessions/'+activeSid)).session:{};
        row.rendererAfter=Object.fromEntries(Object.entries(playbackSession).filter(([k])=>/^(frames|transformedFrames|fps|sourceFps|bytesWritten|subscribers|complete|duration|fragmentSeconds|completeFragments|muxedMediaSeconds|scrubSuspended|playbackPaused|playbackPositionSeconds|timingTotals|state|errorCode|createdAt|firstSourceFrameAt|firstTransformedFrameAt|firstByteAt|playableAt)$/.test(k)));
      }
    }catch(error){row.failure=String(error.message).slice(0,250);}
    row.mediaEvents=await evaluate(`window.__detectAuditMediaEvents||[]`).catch(()=>[]);
    await evaluate(`(async()=>{pongFaceSwapState.enabled=false;clearPongFaceSwapPrefetches();
      await Promise.all([...document.querySelectorAll('.video-wrapper')].map(w=>stopPongFaceSwapForWrapper(w,{restore:false})));
      document.querySelectorAll('video,audio').forEach(v=>v.pause());return true;})()`).catch(()=>{});
    for(const s of (await request('/sessions')).sessions)if(s.channel==='test'&&!initialIds.has(s.id))await request('/sessions/'+s.id,'DELETE');
    await save();console.log(JSON.stringify({clip:row.clip,detectMs:row.detect?.paintOpportunityMs,swapMs:row.swapDisplayReadyMs,confirmMs:row.confirmToStreamReadyMs,waits:row.playback?.waiting,frames:row.playback?.frames,ended:row.playback?.ended,failure:row.failure}));
  }
}catch(error){report.failure=String(error.message).slice(0,300);}
finally{
  await evaluate(`(async()=>{pongFaceSwapState.enabled=false;clearPongFaceSwapPrefetches();
    if(pongFaceSwapState.settingsEditor)await closePongFaceSwapSettingsPanel({persist:false});
    await Promise.all([...document.querySelectorAll('.video-wrapper')].map(w=>stopPongFaceSwapForWrapper(w,{restore:false})));
    if(typeof stopBrowserWorkloadForRefresh==='function')stopBrowserWorkloadForRefresh();
    document.querySelectorAll('video,audio').forEach(v=>{v.pause();v.removeAttribute('src');v.load();});return true;})()`).catch(()=>{});
  for(const s of (await request('/sessions')).sessions)if(s.channel==='test'&&!initialIds.has(s.id))await request('/sessions/'+s.id,'DELETE');
  if(storage)await evaluate(`(()=>{localStorage.clear();sessionStorage.clear();for(const [k,v]of Object.entries(${JSON.stringify(storage.local)}))localStorage.setItem(k,v);for(const [k,v]of Object.entries(${JSON.stringify(storage.session)}))sessionStorage.setItem(k,v);return true;})()`);
  if(muteScript)await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:muteScript});
  if(disableBackdrop)await evaluate(`document.getElementById('pong-detect-no-backdrop')?.remove()`);
  report.settingsUnchanged=hash((await request('/settings')).config)===report.configHash;
  const remainingIds=new Set((await request('/sessions')).sessions.map(s=>s.id));
  report.foreignSessionsPreserved=sessions.every(s=>remainingIds.has(s.id));
  report.decoderDiagnostics=[...mediaDiagnostics.values()];
  report.networkStreams=networkStreams;
  await save();ws.close();
}
