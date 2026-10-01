// Isolated, silent Android WebView transport comparison. Never changes Pong UI or settings.
import {readFile, mkdir, writeFile} from 'node:fs/promises';

const renderer='http://127.0.0.1:8792';
const portText=process.env.PONG_DETECT_CDP_PORT||'9225';
if(!/^\d+$/.test(portText)||Number(portText)<1||Number(portText)>65535)throw Error('Invalid CDP port');
const cdpPort=Number(portText);
const out=process.argv[2]||'E:/Pong Benchmarks/v3039-continuation/android-fmp4-transport';
const clipIds=(process.env.PONG_DETECT_CLIPS||'1,10,19').split(',').map(Number);
const request=async(path,method='GET',body)=>{
  const response=await fetch(renderer+path,{method,headers:{'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(`Renderer HTTP ${response.status} on ${path.split('/').slice(0,2).join('/')}`);
  return response.json();
};
const sessions=()=>request('/sessions').then(x=>x.sessions);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitDeleted=async id=>{
  for(let i=0;i<24;i++){
    if(!(await sessions()).some(s=>s.id===id))return true;
    await delay(250);
  }
  return false;
};
const initialSessions=await sessions();
if(initialSessions.some(s=>!s.complete&&!s.playbackPaused))throw Error('Active user playback; no sessions interrupted');
if(initialSessions.some(s=>s.channel==='test'))throw Error('Test channel already owned');
const initialIds=new Set(initialSessions.map(s=>s.id));
const config=(await request('/settings')).config;
if(config.runtime.swapAudioEnabled!==false)throw Error('Silent renderer required');
const faces=(await request('/faces')).faces;
const face=faces.find(f=>f.name==='Approved 3');
if(!face)throw Error('Approved 3 missing');
const manifest=JSON.parse(await readFile('E:/Pong Benchmarks/v3029-overnight/corpus/manifest.json','utf8'));
const clips=clipIds.map(n=>manifest.clips.find(c=>c.ordinal===n));
if(clips.some(c=>!c?.sourceVariant?.link))throw Error('Selected stock clip missing source');
const tabs=await(await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const pongPages=tabs.filter(t=>t.type==='page'&&new URL(t.url).pathname==='/pong');
if(pongPages.length!==1)throw Error(`Expected exactly one /pong page; found ${pongPages.length}`);
const ws=new WebSocket(pongPages[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let cdpId=0;
const pending=new Map(), activeRequests=new Map(), network=[];
ws.onmessage=event=>{
  const message=JSON.parse(event.data);
  if(message.method==='Network.requestWillBeSent'){
    const match=/\/pong-swap\/sessions\/([^/?#]+)\/stream(?:[?#]|$)/.exec(message.params?.request?.url||'');
    if(match&&network.length<20){
      const row={sessionId:match[1],requestWallTime:message.params.wallTime,requestTimestamp:message.params.timestamp,
        responseStatus:null,firstDataTimestamp:null,firstDataBytes:null,totalDataBytes:0,finishedTimestamp:null,failed:false};
      network.push(row);activeRequests.set(message.params.requestId,row);
    }
  }else if(message.method==='Network.responseReceived'){
    const row=activeRequests.get(message.params?.requestId);
    if(row){row.responseTimestamp=message.params.timestamp;row.responseStatus=message.params.response?.status??null;}
  }else if(message.method==='Network.dataReceived'){
    const row=activeRequests.get(message.params?.requestId);
    if(row){if(row.firstDataTimestamp===null){row.firstDataTimestamp=message.params.timestamp;row.firstDataBytes=message.params.dataLength??0;}
      row.totalDataBytes+=message.params.dataLength??0;}
  }else if(message.method==='Network.loadingFinished'||message.method==='Network.loadingFailed'){
    const row=activeRequests.get(message.params?.requestId);
    if(row){row.finishedTimestamp=message.params.timestamp;
      if(message.method==='Network.loadingFailed')row.failed=true;
      activeRequests.delete(message.params.requestId);}
  }
  const waiter=pending.get(message.id);
  if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);
    message.error?waiter.reject(Error(message.error.message)):waiter.resolve(message.result);}
};
const send=(method,params={},timeout=30000)=>new Promise((resolve,reject)=>{
  const id=++cdpId;
  pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(Error(`${method} timeout`));},timeout)});
  ws.send(JSON.stringify({id,method,params}));
});
const evaluate=async(expression,timeout=30000)=>{
  const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},timeout);
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result?.value;
};

// This function is serialized into the WebView. It creates only one temporary video.
async function runBrowserCase({mode,url,durationMs}){
  const start=performance.now();
  window.__pongTransportAbort=false;
  const result={mode,events:[],waiting:0,frames:0,maxGapMs:0};
  const mark=(type,extra={})=>result.events.push({type,ms:performance.now()-start,...extra});
  const video=document.createElement('video');
  video.muted=true;video.defaultMuted=true;video.volume=0;video.autoplay=false;video.playsInline=true;
  video.preload='auto';
  video.style.cssText='position:fixed;left:0;top:0;width:100vw;height:100vh;object-fit:contain;background:#000;z-index:2147483647';
  let objectUrl=null,controller=null,reader=null,sourceBuffer=null,mediaSource=null,frameHandle=null,lastFrame=null,abortTimer=null;
  const aborted=new Promise((_,reject)=>{abortTimer=setInterval(()=>{
    if(window.__pongTransportAbort)reject(Error('Foreign playback started'));
  },250);});
  let firstPaintResolve;
  const firstPaint=new Promise(resolve=>{firstPaintResolve=resolve;});
  const frame=(now,meta)=>{
    result.frames++;
    if(lastFrame!==null)result.maxGapMs=Math.max(result.maxGapMs,now-lastFrame);
    lastFrame=now;
    if(result.firstPaintMs===undefined){result.firstPaintMs=performance.now()-start;firstPaintResolve();}
    if(result.frames%25===1)result.samples??=[],result.samples.push({ms:performance.now()-start,
      mediaTime:meta.mediaTime,processingDuration:meta.processingDuration,
      bufferedAhead:video.buffered.length?video.buffered.end(video.buffered.length-1)-video.currentTime:null});
    frameHandle=video.requestVideoFrameCallback(frame);
  };
  const awaitEvent=(target,type,timeoutMs)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{target.removeEventListener(type,onEvent);reject(Error(`${type} timeout`));},timeoutMs);
    const onEvent=()=>{clearTimeout(timer);target.removeEventListener(type,onEvent);resolve();};
    target.addEventListener(type,onEvent,{once:true});
  });
  const append=bytes=>new Promise((resolve,reject)=>{
    const done=()=>{sourceBuffer.removeEventListener('updateend',done);sourceBuffer.removeEventListener('error',fail);resolve();};
    const fail=()=>{sourceBuffer.removeEventListener('updateend',done);sourceBuffer.removeEventListener('error',fail);reject(Error('SourceBuffer error'));};
    sourceBuffer.addEventListener('updateend',done,{once:true});sourceBuffer.addEventListener('error',fail,{once:true});
    try{sourceBuffer.appendBuffer(bytes);}catch(error){fail();reject(error);}
  });
  const u32=(bytes,p)=>(bytes[p]*2**24+bytes[p+1]*2**16+bytes[p+2]*256+bytes[p+3]);
  const boxType=(bytes,p)=>String.fromCharCode(...bytes.subarray(p+4,p+8));
  const initEnd=bytes=>{
    let p=0;
    while(p+8<=bytes.length){const size=u32(bytes,p);if(size<8)throw Error('Invalid fMP4 box');
      if(p+size>bytes.length)return 0;
      if(boxType(bytes,p)==='moov')return p+size;
      p+=size;
    }
    return 0;
  };
  const codecFromInit=bytes=>{
    for(let p=4;p+8<bytes.length;p++){
      if(bytes[p]===97&&bytes[p+1]===118&&bytes[p+2]===99&&bytes[p+3]===67){
        const size=u32(bytes,p-4),version=bytes[p+4];
        if(size>=11&&p-4+size<=bytes.length&&version===1){
          return 'avc1.'+[bytes[p+5],bytes[p+6],bytes[p+7]].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
        }
      }
    }
    throw Error('No valid avcC box in actual init segment');
  };
  const concat=(a,b)=>{const out=new Uint8Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;};
  for(const type of ['loadstart','loadedmetadata','loadeddata','canplay','waiting','stalled','error'])
    video.addEventListener(type,()=>{mark(type,{readyState:video.readyState});if(type==='waiting')result.waiting++;});
  try{
    document.body.appendChild(video);
    frameHandle=video.requestVideoFrameCallback(frame);
    if(mode==='direct'){
      video.src=url;video.load();mark('requestStart');
    }else{
      if(typeof MediaSource!=='function')throw Error('MediaSource unsupported');
      controller=new AbortController();mark('requestStart');
      const response=await fetch(url,{cache:'no-store',signal:controller.signal});
      result.responseStatus=response.status;mark('headers');
      if(!response.ok||!response.body)throw Error(`Stream HTTP ${response.status}`);
      reader=response.body.getReader();
      let pendingBytes=new Uint8Array(0),ended=0;
      while(!ended){const part=await reader.read();if(part.done)throw Error('Stream ended before moov');
        if(result.firstBytesMs===undefined){result.firstBytesMs=performance.now()-start;result.firstBytesLength=part.value.length;}
        pendingBytes=concat(pendingBytes,part.value);ended=initEnd(pendingBytes);
        if(pendingBytes.length>8*1024*1024)throw Error('Init segment exceeded 8 MiB');
      }
      const codec=codecFromInit(pendingBytes.subarray(0,ended));
      const mime=`video/mp4; codecs="${codec}"`;result.codec=codec;
      if(!MediaSource.isTypeSupported(mime))throw Error(`MSE codec unsupported: ${codec}`);
      mediaSource=new MediaSource();objectUrl=URL.createObjectURL(mediaSource);
      const opened=awaitEvent(mediaSource,'sourceopen',5000);
      video.src=objectUrl;video.load();await opened;
      sourceBuffer=mediaSource.addSourceBuffer(mime);
      await append(pendingBytes);
      // Keep appends sequential; do not inspect or alter encoded samples.
      void (async()=>{try{while(true){const part=await reader.read();if(part.done)break;
        if(mediaSource.readyState!=='open')break;await append(part.value);}
        if(mediaSource.readyState==='open'&&!sourceBuffer.updating)mediaSource.endOfStream();
      }catch(error){if(!controller.signal.aborted)result.appendError=String(error.message).slice(0,120);}})();
    }
    void video.play().catch(error=>{result.playError=String(error.message).slice(0,120);});
    await Promise.race([firstPaint,aborted,new Promise((_,reject)=>setTimeout(()=>reject(Error('first paint timeout')),15000))]);
    const before=video.getVideoPlaybackQuality?.();
    const paintedAt=performance.now();
    await Promise.race([new Promise(resolve=>setTimeout(resolve,durationMs)),aborted]);
    const after=video.getVideoPlaybackQuality?.();
    result.playbackWallMs=performance.now()-paintedAt;
    result.quality=before&&after?{total:after.totalVideoFrames-before.totalVideoFrames,
      dropped:after.droppedVideoFrames-before.droppedVideoFrames,corrupted:after.corruptedVideoFrames-before.corruptedVideoFrames}:null;
    result.endMediaTime=video.currentTime;result.width=video.videoWidth;result.height=video.videoHeight;
  }catch(error){result.failure=String(error.message).slice(0,160);}
  finally{
    clearInterval(abortTimer);
    if(frameHandle!==null)video.cancelVideoFrameCallback(frameHandle);
    controller?.abort();try{await reader?.cancel();}catch{}
    video.pause();video.removeAttribute('src');try{video.load();}catch{}video.remove();
    if(objectUrl)URL.revokeObjectURL(objectUrl);
  }
  return result;
}

const report={scope:'Temporary muted Android WebView video; identical renderer fMP4 bytes for direct src and MSE append; not Pong integration',
  cdpPort,serviceVersion:(await request('/health')).serviceVersion,configUnchanged:null,cases:[],network};
await mkdir(out,{recursive:true});
const save=()=>writeFile(out+'/report.json',JSON.stringify(report,null,2));
let owned=null;
try{
  await send('Runtime.enable');await send('Network.enable');
  const t0=Date.now(),browserNow=await evaluate('Date.now()'),t1=Date.now();
  report.browserMinusHostMs=browserNow-(t0+t1)/2;report.clockRoundTripMs=t1-t0;
  // Production video.src uses the same-origin helper proxy. The background
  // control port intentionally rejects stream routes.
  const base=await evaluate('location.origin');
  if(!base)throw Error('WebView control plane unavailable');
  // Alternate the order so mode is not consistently favored by clip warming.
  for(let i=0;i<clips.length;i++)for(const mode of (i%2?['mse','direct']:['direct','mse'])){
    const current=await sessions();
    if(current.some(s=>!s.complete&&!s.playbackPaused&&s.id!==owned))throw Error('User playback started; benchmark stopped');
    if(current.some(s=>s.channel==='test'&&!initialIds.has(s.id)&&s.id!==owned))throw Error('Another test owner appeared');
    const clip=clips[i],row={clip:clip.ordinal,mode,sourceFps:clip.fps};report.cases.push(row);
    const payload=await request('/sessions','POST',{channel:'test',sourceUrl:clip.sourceVariant.link,
      faceId:face.id,faceIds:[face.id],navigationClass:'foreground',prefetch:false,prebufferSeconds:.5});
    owned=payload.session.id;row.sessionId=owned;
    const url=base+'/pong-swap/sessions/'+encodeURIComponent(owned)+'/stream';
    let monitoring=false,foreignAppeared=false;
    const monitor=setInterval(async()=>{if(monitoring)return;monitoring=true;
      try{const live=await sessions();if(live.some(s=>!s.complete&&!s.playbackPaused&&s.id!==owned)){
        foreignAppeared=true;await evaluate('window.__pongTransportAbort=true').catch(()=>{});
      }}catch{}finally{monitoring=false;}
    },1000);
    try{row.browser=await evaluate(`(${runBrowserCase.toString()})(${JSON.stringify({mode,url,durationMs:10000})})`,40000);}
    finally{clearInterval(monitor);}
    if(foreignAppeared)throw Error('Foreign playback started; benchmark stopped');
    const session=(await request('/sessions/'+owned)).session;
    row.server={createdAt:session.createdAt,firstSourceFrameAt:session.firstSourceFrameAt,
      firstTransformedFrameAt:session.firstTransformedFrameAt,firstByteAt:session.firstByteAt,
      playableAt:session.playableAt,firstRenderedFrameTransformed:session.firstRenderedFrameTransformed,
      width:session.width,height:session.height,fps:session.fps};
    const deletedId=owned;
    await request('/sessions/'+deletedId,'DELETE');owned=null;
    if(!(await waitDeleted(deletedId)))throw Error('Owned test session did not finish cleanup');
    await save();
    console.log(JSON.stringify({clip:row.clip,mode,firstPaintMs:row.browser.firstPaintMs,
      frames:row.browser.frames,dropped:row.browser.quality?.dropped,waits:row.browser.waiting,failure:row.browser.failure}));
  }
}catch(error){report.failure=String(error.message).slice(0,250);}
finally{
  if(owned){await request('/sessions/'+owned,'DELETE').catch(()=>{});await waitDeleted(owned).catch(()=>{});}
  report.configUnchanged=JSON.stringify((await request('/settings')).config)===JSON.stringify(config);
  const final=await sessions();report.foreignSessionsPreserved=initialSessions.every(s=>final.some(f=>f.id===s.id));
  report.ownedSessionsRemaining=final.filter(s=>s.channel==='test'&&!initialIds.has(s.id)).length;
  await save();ws.close();
}
