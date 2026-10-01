// Disposable emulator diagnostic: put the exact generated MP4 in TikTok's
// existing video element. Never installed by the APK or production page.
// A document reload is required afterwards because the site's detached
// MediaSource may not be reusable. This is not yet a shipping architecture.
(() => {
  if(window.__pongSingleElementTrial)throw Error('Single-element trial already installed');
  window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();
  const names=['__pongDomSwapAttach','__pongDomSwapSync','__pongDomSwapClear',
    '__pongDomSwapPrepare','__pongDomSwapWarmClear','__pongDomSwapDepart','__pongDomSwapObserveVideo'];
  const saved=new Map(names.map(name=>[name,window[name]]));
  const useWorker=window.__pongSingleElementUseWorker===true;
  if(useWorker&&typeof window.__pongCreateWorkerMseAudit!=='function')throw Error('Worker audit unavailable');
  const trial={records:[],reloadRequired:false,useWorker};window.__pongSingleElementTrial=trial;
  let active=null;
  const clear=(preservePage,expected)=>{
    const s=active;if(!s||preservePage===s.pageUrl||(expected!==undefined&&expected!==s.sessionId))return false;
    active=null;window.__pongDomSwap=null;s.abort.abort();
    if(s.frame!=null)s.video.cancelVideoFrameCallback?.(s.frame);
    for(const [name,fn] of s.listeners)s.video.removeEventListener(name,fn);
    // Never overwrite a new source assigned by the site's own navigation.
    if(s.video.isConnected&&s.ownsSource()){
      s.video.srcObject=null;
      s.video.pause();s.video.removeAttribute('src');s.video.load();
      if(s.originalSrc)s.video.setAttribute('src',s.originalSrc);
      s.video.load();
    }
    if(s.objectUrl)URL.revokeObjectURL(s.objectUrl);
    try{window.PongTikTokSwap?.hidden?.(s.sessionId)}catch{}
    return true;
  };
  window.__pongDomSwapClear=clear;
  window.__pongDomSwapWarmClear=()=>false;
  window.__pongDomSwapPrepare=()=>false;
  window.__pongDomSwapDepart=()=>clear();
  window.__pongDomSwapObserveVideo=(page,video)=>{
    if(active&&(active.pageUrl!==page||active.video!==video))clear();
    window.__pongTikTokObservedVideo={pageUrl:page||'',video:page?video:null};
    return false;
  };
  window.__pongDomSwapSync=()=>{
    const s=active;if(!s)return {active:false,visible:false};
    const v=s.video;let end=0;
    for(let i=0;i<v.buffered.length;i++)end=Math.max(end,v.buffered.end(i));
    return {active:true,visible:s.visible,sessionId:s.sessionId,ageMs:performance.now()-s.createdAt,
      lag:0,target:v.currentTime-s.start,bufferEnd:end-s.start,bufferHeadroom:end-v.currentTime,
      readyState:v.readyState,firstVisibleAt:s.firstVisibleAt||0,seeking:v.seeking,
      presentedMediaTime:s.lastPaintedMediaTime??-1,paintedRecently:performance.now()-(s.lastPaintedAt||0)<750};
  };
  window.__pongDomSwapAttach=(url,sessionId,startSeconds,observedVideo=null,pageUrl='')=>{
    if(active?.sessionId===sessionId)return true;
    const o=window.__pongTikTokObservedVideo,v=observedVideo||o?.video;
    if(!v?.isConnected||o?.pageUrl!==pageUrl||!window.MediaSource)return false;
    if(active)clear();
    const start=Math.max(0,Number(startSeconds||0)),mediaSource=useWorker?null:new MediaSource();
    if(useWorker&&start>.01){trial.rejectedOffset=start;return false;}
    const s={sessionId,pageUrl,url,video:v,original:v,overlay:v,host:v.parentElement,start,
      originalSrc:v.getAttribute('src'),duration:v.duration,mediaSource,objectUrl:useWorker?'':URL.createObjectURL(mediaSource),
      abort:new AbortController(),listeners:[],createdAt:performance.now(),visible:false,queue:[],bytes:0,queueBytes:0,frames:[],
      transport:{bytes:0,chunks:0,singleElement:true},warm:false};
    active=s;window.__pongDomSwap=s;trial.records.push(s);trial.reloadRequired=true;
    s.ownsSource=()=>useWorker?!!s.workerHandle&&v.srcObject===s.workerHandle:v.getAttribute('src')===s.objectUrl;
    const own=()=>active===s&&!s.abort.signal.aborted;
    const failed=reason=>{if(own()){s.failure=reason;s.visible=false;}};
    const listen=(name,fn)=>{v.addEventListener(name,fn);s.listeners.push([name,fn])};
    listen('error',()=>failed('media-error-'+(v.error?.code||0)));
    listen('loadedmetadata',()=>{s.metadataAt=performance.now();if(useWorker&&v.srcObject)s.workerHandle=v.srcObject;if(own()&&start>0){try{v.currentTime=start}catch{}}});
    listen('playing',()=>{s.playingAt??=performance.now()});
    listen('waiting',()=>{s.waits=(s.waits||0)+1});
    const frame=(now,meta)=>{
      if(!own())return;
      if(!s.ownsSource()){
        if(s.visible){failed('site-replaced-source');return;}
        s.frame=v.requestVideoFrameCallback(frame);return;
      }
      s.visible=true;s.firstVisibleAt??=now;s.lastPaintedAt=now;s.lastPaintedMediaTime=meta.mediaTime-start;
      s.frames.push({at:now,mediaTime:meta.mediaTime,presentedFrames:meta.presentedFrames});
      if(s.frames.length>600)s.frames.shift();
      s.frame=v.requestVideoFrameCallback(frame);
    };
    s.frame=v.requestVideoFrameCallback(frame);
    if(useWorker){
      v.muted=true;v.volume=0;
      window.__pongCreateWorkerMseAudit(s,{owned:own,fail:failed,sync:()=>{
        if(own()&&v.paused)v.play().catch(()=>failed('play-rejected'));
      }});
      return true;
    }
    let sourceBuffer=null,credit=null;
    const release=()=>{const c=credit;credit=null;c?.()};
    s.abort.signal.addEventListener('abort',release,{once:true});
    const pump=()=>{
      if(!own()||!sourceBuffer||sourceBuffer.updating)return;
      if(s.queue.length){
        const chunk=s.queue.shift();s.queueBytes-=chunk.byteLength;release();
        try{sourceBuffer.appendBuffer(chunk)}catch{failed('append-failed')}
      }else if(s.ended&&mediaSource.readyState==='open'){
        try{mediaSource.endOfStream()}catch{}
      }
    };
    mediaSource.addEventListener('sourceopen',()=>{
      if(!own())return;
      try{
        sourceBuffer=mediaSource.addSourceBuffer('video/mp4; codecs="avc1.64001F"');
        sourceBuffer.timestampOffset=start;
        if(Number.isFinite(s.duration)&&s.duration>start)mediaSource.duration=s.duration;
        sourceBuffer.addEventListener('updateend',pump);
        sourceBuffer.addEventListener('error',()=>failed('source-buffer-error'));
        pump();v.play().catch(()=>failed('play-rejected'));
      }catch{failed('source-open-failed')}
    },{once:true});
    v.muted=true;v.volume=0;v.src=s.objectUrl;v.load();
    (async()=>{
      try{
        const r=await fetch(url,{signal:s.abort.signal,cache:'no-store'});
        if(!r.ok||!r.body||!(r.headers.get('content-type')||'').split(',').every(x=>/^video\/mp4(?:\s*;|\s*$)/i.test(x.trim())))throw Error('stream-response');
        const reader=r.body.getReader();
        while(own()){
          if(s.queueBytes>=2*1024*1024)await new Promise(resolve=>credit=resolve);
          if(!own())break;
          const {done,value}=await reader.read();if(done)break;if(!own())break;
          if(value?.byteLength){s.queue.push(value);s.queueBytes+=value.byteLength;s.bytes+=value.byteLength;s.transport.bytes=s.bytes;s.transport.chunks++;pump();}
        }
        if(own()){s.ended=true;pump()}
      }catch(e){if(e.name!=='AbortError')failed(e.message==='stream-response'?e.message:'network-error')}
    })();
    return true;
  };
  trial.snapshot=()=>trial.records.map(s=>({sessionId:s.sessionId,start:s.start,ageMs:performance.now()-s.createdAt,
    firstVisibleAt:s.firstVisibleAt,metadataAt:s.metadataAt,playingAt:s.playingAt,frames:s.frames,
    ready:s.video.readyState,paused:s.video.paused,time:s.video.currentTime,bytes:s.bytes,waits:s.waits||0,
    failure:s.failure||null,active:active===s,sameSource:s.ownsSource(),rate:s.video.playbackRate,transport:s.transport}));
  trial.close=()=>{clear();for(const [name,value]of saved)window[name]=value;};
  return {installed:true,production:false};
})()
