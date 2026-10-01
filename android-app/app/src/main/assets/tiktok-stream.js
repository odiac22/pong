// One active compositor and at most one paused, decoded next-video stream.
// No URL, credential or page content is retained in diagnostic markers.
(() => {
  if(window.__pongDomSwapInstalled)return;
  window.__pongDomSwapInstalled=true;
  const mediaBox=v=>{
    let n=v,r=v?.getBoundingClientRect?.();
    for(let i=0;n&&i<7&&(!r||r.width<3||r.height<3);i++){n=n.parentElement;r=n?.getBoundingClientRect?.();}
    return {node:n||v,rect:r||{left:0,top:0,right:0,bottom:0,width:0,height:0}};
  };
  const mediaHost=v=>{
    let n=v?.parentElement,r=n?.getBoundingClientRect?.();
    for(let i=0;n&&i<7&&(!r||r.width<3||r.height<3);i++){n=n.parentElement;r=n?.getBoundingClientRect?.();}
    return n||null;
  };
  const visibleArea=v=>{
    const r=mediaBox(v).rect;
    return Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))*
      Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left));
  };
  const live=()=>Array.from(document.querySelectorAll('video:not(.pong-tiktok-swap-stream)'))
    .filter(v=>v.isConnected&&visibleArea(v)>4)
    .sort((a,b)=>(visibleArea(b)+(b.paused?0:1e9))-(visibleArea(a)+(a.paused?0:1e9)))[0]||null;
  const owned=s=>window.__pongDomSwap===s||window.__pongDomSwapWarm===s;
  const failedSessions=new Set();
  let departingPage='',departureAt=0;
  const awaitingNavigation=pageUrl=>{
    if(!departingPage)return false;
    // If the site's click did not navigate, recover the original post instead
    // of blocking it forever. This deadline is a failure recovery bound, not
    // a delay before admitting an observed incoming post.
    if(performance.now()-departureAt>=4000){departingPage='';return false;}
    return !!pageUrl&&pageUrl===departingPage;
  };
  function dispose(s){
    if(!s)return;
    s.direct?.close();s.worker?.close();
    clearInterval(s.timer);s.abort.abort();
    s.frameSyncTracking=false;
    for(const key of ['frameSyncTrackCallbackId','frameSyncRevealCallbackId','startupPaintCallbackId']){
      if(s[key]!=null)s.overlay.cancelVideoFrameCallback?.(s[key]);
      s[key]=null;
    }
    try{s.overlay.pause();s.overlay.removeAttribute('src');s.overlay.srcObject=null;s.overlay.load();s.overlay.remove();if(s.objectUrl)URL.revokeObjectURL(s.objectUrl);}catch(_){}
    if(s.original?.isConnected){
      s.original.style.opacity=s.original.dataset.pongDomOriginalOpacity||'';
      delete s.original.dataset.pongDomOriginalOpacity;
    }
    if(s.host?.isConnected&&s.host.dataset.pongDomPosition!==undefined){
      s.host.style.position=s.host.dataset.pongDomPosition;delete s.host.dataset.pongDomPosition;
    }
  }
  window.__pongDomSwapClear=(preservePageUrl,expectedSession)=>{
    if(preservePageUrl&&window.__pongDomSwap?.pageUrl===preservePageUrl)return false;
    // A native callback may have been queued before the local observer adopted
    // the incoming post. Retire only the session that callback actually saw.
    if(expectedSession!==undefined&&window.__pongDomSwap&&window.__pongDomSwap.sessionId!==expectedSession)return false;
    const prior=window.__pongDomSwap;window.__pongDomSwap=null;dispose(prior);
    // The original is visible now. Revoke the old painted receipt on this
    // event, not on a later timeline poll (which can trail a busy SPA swipe).
    if(prior){try{window.PongTikTokSwap?.hidden?.(prior.sessionId);}catch(_){}}
    document.documentElement.classList.remove('pong-dom-swap');return true;
  };
  window.__pongDomSwapWarmClear=()=>{
    const prior=window.__pongDomSwapWarm;window.__pongDomSwapWarm=null;dispose(prior);
  };
  window.__pongDomSwapDepart=()=>{
    departingPage=window.__pongTikTokObservedVideo?.pageUrl||window.__pongDomSwap?.pageUrl||'';
    departureAt=performance.now();
    window.__pongDomSwapClear();
  };
  // Replaced by the timestamp/paint-evidence synchronizer installed immediately
  // afterwards. Never reveal pixels using a timeout or a network-ready event.
  window.__pongDomSwapSync=()=>({active:!!window.__pongDomSwap,visible:false});
  function create(url,sessionId,startSeconds,warm){
    const direct=window.__pongDirectDecoderTrial===true&&typeof window.__pongCreateDirectDecoder==='function'&&typeof VideoDecoder==='function';
    const workerMse=!direct&&window.__pongWorkerMseAuditTrial===true&&
      typeof window.__pongCreateWorkerMseAudit==='function'&&window.MediaSource?.canConstructInDedicatedWorker===true;
    const overlay=document.createElement(direct?'canvas':'video');
    overlay.className='pong-tiktok-swap-stream';
    overlay.muted=true;overlay.defaultMuted=true;overlay.volume=0;
    overlay.autoplay=!warm;overlay.playsInline=true;overlay.preload='auto';overlay.disablePictureInPicture=true;
    const mediaSource=direct||workerMse?null:new MediaSource(),objectUrl=direct||workerMse?'':URL.createObjectURL(mediaSource),abort=new AbortController();
    const s={overlay,original:null,host:null,sessionId,url,pageUrl:'',start:Math.max(0,Number(startSeconds||0)),warm,
      createdAt:performance.now(),firstVisibleAt:0,visible:false,revealPending:false,timer:0,
      mediaSource,objectUrl,abort,queue:[],sourceBuffer:null,ended:false,
      transport:{createdAt:performance.now(),bytes:0,chunks:0,warm,
        eventDrivenReveal:window.__pongEventDrivenReveal===true}};
    if(warm)window.__pongDomSwapWarm=s;else window.__pongDomSwap=s;
    const sync=()=>window.__pongDomSwap===s&&window.__pongDomSwapSync();
    const fail=e=>{
      if(!owned(s))return;
      const active=window.__pongDomSwap===s;
      failedSessions.add(s.sessionId);
      if(failedSessions.size>8)failedSessions.delete(failedSessions.values().next().value);
      window.__pongDomSwapLastError=String(e?.message||e||'stream failed');
      window.__pongDomSwapLastFailure={sessionId:s.sessionId,warm:s.warm,
        bytes:s.transport.bytes,http:s.transport.http||0,chunks:s.transport.chunks,
        readyState:s.overlay.readyState||0,sourceOpened:!!s.transport.sourceOpenAt};
      if(active)window.__pongDomSwapClear();else window.__pongDomSwapWarmClear();
      // Report decoder/transport failure, not retirement or an aborted swipe.
      // The owner invalidates painted evidence before one bounded retry.
      // Never forward the exception text: network errors can contain signed URLs.
      if(active){try{window.PongTikTokSwap?.failed(s.sessionId);}catch(_){}}
    };
    s.fail=fail;
    if(direct){window.__pongCreateDirectDecoder(s,{owned,fail});return s;}
    if(workerMse){window.__pongCreateWorkerMseAudit(s,{owned,fail,sync});return s;}
    let queuedBytes=0,queueCredit=null,metadataTimer=0,fragmentBatch=null;
    const releaseCredit=()=>{const resolve=queueCredit;queueCredit=null;resolve?.();};
    abort.signal.addEventListener('abort',()=>{clearTimeout(metadataTimer);fragmentBatch?.dispose();s.queue.length=0;queuedBytes=0;releaseCredit();},{once:true});
    const pump=()=>{
      if(!owned(s)||!s.sourceBuffer||s.sourceBuffer.updating)return;
      if(s.queue.length){
        // Native networking can deliver a fragment in dozens of small reads.
        // Issuing one asynchronous demux/IPC operation for every read built a
        // long append queue even though all the frame bytes were already here.
        // Coalesce only bytes ALREADY queued, never wait for a timer or more
        // network data. The first fragment stays immediate; backlog is bounded.
        let chunk=s.queue.shift();
        const chunks=[chunk];let size=chunk.byteLength;
        while(s.queue.length&&size+s.queue[0].byteLength<=256*1024){
          const next=s.queue.shift();chunks.push(next);size+=next.byteLength;
        }
        if(chunks.length>1){
          const joined=new Uint8Array(size);let offset=0;
          for(const part of chunks){joined.set(new Uint8Array(part),offset);offset+=part.byteLength;}
          chunk=joined.buffer;
        }
        queuedBytes-=size;releaseCredit();
        s.transport.appendCalls=(s.transport.appendCalls||0)+1;
        s.transport.coalescedReads=(s.transport.coalescedReads||0)+chunks.length-1;
        try{s.sourceBuffer.appendBuffer(chunk);}catch(e){fail(e);}return;
      }
      if(s.ended&&mediaSource.readyState==='open'){
        // HTTP 200 plus EOF is not a playable MP4. Closing an uninitialized
        // MediaSource yields an opaque demuxer error, obscuring the real cause.
        if(!s.transport.bytes){fail('Swap stream ended without media');return;}
        if(overlay.readyState<1){
          if(!metadataTimer)metadataTimer=setTimeout(()=>{
            metadataTimer=0;if(owned(s)&&overlay.readyState<1)fail('Swap stream ended before metadata');
          },1500);
          return;
        }
        clearTimeout(metadataTimer);try{mediaSource.endOfStream();}catch(e){fail(e);}
      }
    };
    // Polling is still the recovery clock, but decoder progress must not wait
    // for its next tick. The startup-only callback ends once visible; normal
    // playback keeps its existing single paint observer and GPU workload.
    const startupPaint=(now,metadata)=>{
      s.startupPaintCallbackId=null;
      s.transport.startupPaintCallbacks=(s.transport.startupPaintCallbacks||0)+1;
      if(!owned(s)||abort.signal.aborted)return;
      if(window.__pongDomSwap===s&&!s.visible)
        window.__pongDomSwapSync({owner:s,now,metadata});
      if(!s.visible&&owned(s))s.startupPaintCallbackId=overlay.requestVideoFrameCallback(startupPaint);
    };
    if(window.__pongEventDrivenReveal===true&&typeof overlay.requestVideoFrameCallback==='function')
      s.startupPaintCallbackId=overlay.requestVideoFrameCallback(startupPaint);
    for(const event of ['loadedmetadata','loadeddata','canplay','playing',...(window.__pongEventDrivenReveal===true?['seeked']:[])])
      overlay.addEventListener(event,()=>{s.transport[event]??=performance.now();if(event==='loadedmetadata')pump();if(!s.warm)sync();},{passive:true});
    overlay.addEventListener('ended',()=>{
      if(window.__pongDomSwap!==s)return;
      if(s.start<.1){try{overlay.currentTime=0;overlay.play().catch(()=>{});}catch(_){}}
      else window.__pongDomSwapClear();
    });
    overlay.addEventListener('error',()=>fail(overlay.error?.message||'media element error'),{once:true});
    mediaSource.addEventListener('sourceopen',()=>{
      if(!owned(s)||mediaSource.readyState!=='open')return;
      try{
        s.transport.sourceOpenAt=performance.now();
        const mime=['video/mp4; codecs="avc1.64001F"','video/mp4; codecs="avc1.4D401F"','video/mp4'].find(x=>MediaSource.isTypeSupported(x));
        if(!mime)throw Error('H.264 MediaSource unsupported');
        s.sourceBuffer=mediaSource.addSourceBuffer(mime);s.sourceBuffer.mode='segments';
        s.sourceBuffer.addEventListener('error',()=>fail('SourceBuffer rejected media'));
        s.sourceBuffer.addEventListener('updateend',()=>{s.transport.firstAppendAt??=performance.now();pump();});
        pump();
      }catch(e){fail(e);}
    },{once:true});
    // Fetch and decoder setup are independent. Opening a detached MSE video
    // can be delayed by the site's React work; do not postpone network I/O too.
    // Bound pending encoded bytes to one read beyond 2 MiB, then backpressure
    // the ReadableStream until SourceBuffer drains them. Retiring wakes waiters.
    const enqueue=(part,ownsBuffer=false)=>{
      if(!owned(s)||abort.signal.aborted)return;
      queuedBytes+=part.byteLength;
      s.queue.push(ownsBuffer&&part.byteOffset===0&&part.byteLength===part.buffer.byteLength?
        part.buffer:part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength));pump();
    };
    // Complete-fragment appends preserve the exact encoded bytes. The phone
    // trace showed thousands of tiny native reads becoming separate demux
    // operations. Emit complete media immediately, with no batching timer.
    // Explicit false remains available for a controlled diagnostic rollback.
    if(window.__pongFragmentBatchTrial!==false&&typeof window.__pongCreateFragmentBatch==='function'){
      s.transport.fragmentBatch=true;s.transport.packets=0;
      // Retained partial fragments have their own 16 MiB ceiling. Backpressure
      // applies to emitted data at 2 MiB (+ one fragment/slice), not the partial
      // fragment, which would deadlock its completion. Parser/decoder copying
      // and the current network read can temporarily use additional memory.
      fragmentBatch=window.__pongCreateFragmentBatch(part=>{s.transport.packets++;enqueue(part,true);});
    }
    const receive=async()=>{
      try{
        s.transport.requestAt=performance.now();
        const response=await fetch(String(url||''),{signal:abort.signal,cache:'no-store'});
        s.transport.headersAt=performance.now();
        s.transport.http=response.status;
        if(!response.ok||!response.body)throw Error('Swap stream HTTP '+response.status);
        // Older APK bridges duplicated the MIME header supplied by
        // WebResourceResponse. Accept identical MP4 values, never HTML.
        if(!(response.headers.get('content-type')||'').split(',').every(x=>/^video\/mp4(?:\s*;|\s*$)/i.test(x.trim())))throw Error('Swap stream did not return MP4');
        const reader=response.body.getReader();
        while(owned(s)){
          if(queuedBytes>=2*1024*1024)await new Promise(resolve=>{queueCredit=resolve});
          if(!owned(s))return;
          const part=await reader.read();if(part.done)break;if(!owned(s))return;
          if(part.value?.byteLength){
            s.transport.firstChunkAt??=performance.now();s.transport.bytes+=part.value.byteLength;s.transport.chunks++;
            if(fragmentBatch){
              // read() has no specified chunk-size ceiling. Bound synchronous
              // parsing and honor emitted-queue credit even for one huge read.
              for(let offset=0;offset<part.value.byteLength;offset+=256*1024){
                if(queuedBytes>=2*1024*1024)await new Promise(resolve=>{queueCredit=resolve});
                if(!owned(s)||abort.signal.aborted)return;
                fragmentBatch.push(part.value.subarray(offset,offset+256*1024));
              }
            }else enqueue(part.value);
          }
        }
        if(!owned(s))return;
        fragmentBatch?.finish();s.ended=true;if(!s.transport.bytes)fail('Swap stream ended without media');else pump();
      }catch(e){if(e?.name!=='AbortError')fail(e);}
    };
    void receive();
    overlay.src=objectUrl;overlay.load();return s;
  }
  window.__pongDomSwapPrepare=(url,sessionId,pageUrl='')=>{
    if(failedSessions.has(sessionId))return false;
    if(window.__pongDomSwap?.sessionId===sessionId||window.__pongDomSwapWarm?.sessionId===sessionId)return true;
    window.__pongDomSwapWarmClear();
    if(!window.MediaSource||!sessionId)return false;
    create(url,sessionId,0,true).pageUrl=pageUrl;return true;
  };
  window.__pongDomSwapAttach=(url,sessionId,startSeconds,observedVideo=null,pageUrl='')=>{
    // Native's ready poll can lag behind a successful physical swipe. Do not
    // recreate the just-disposed outgoing decoder while React loads the next
    // post. Exact incoming identity releases this gate immediately.
    if(awaitingNavigation(pageUrl))return false;
    if(failedSessions.has(sessionId)){
      // Local warm adoption can precede native ownership. Re-report when the
      // native owner catches up; its bridge deduplicates the failed session.
      try{window.PongTikTokSwap?.failed(sessionId);}catch(_){}
      return false;
    }
    const observed=window.__pongTikTokObservedVideo;
    // Native/Pong's URL can trail a completed SPA navigation. Never overwrite
    // the new post with a ready callback belonging to the outgoing post.
    if(pageUrl&&(!observed||observed.pageUrl!==pageUrl||!observed.video?.isConnected))return false;
    if(window.__pongDomSwap?.sessionId===sessionId){window.__pongDomSwapSync();return true;}
    const original=observedVideo||(pageUrl?observed.video:live()),host=mediaHost(original);
    if(!original||!host||!window.MediaSource)return false;
    window.__pongDomSwapClear();
    let s=window.__pongDomSwapWarm?.sessionId===sessionId?window.__pongDomSwapWarm:null;
    if(s){window.__pongDomSwapWarm=null;window.__pongDomSwap=s;s.warm=false;s.transport.adoptedAt=performance.now();}
    else s=create(url,sessionId,startSeconds,false);
    s.original=original;s.host=host;s.start=Math.max(0,Number(startSeconds||0));s.pageUrl=pageUrl||s.pageUrl;
    s.createdAt=performance.now();window.__pongDomSwapLastError='';
    const style=getComputedStyle(original),hostStyle=getComputedStyle(host);
    if(hostStyle.position==='static'){host.dataset.pongDomPosition=host.style.position||'';host.style.position='relative';}
    s.overlay.style.cssText='position:absolute!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;pointer-events:none!important;z-index:2!important;opacity:0;transition:none!important;background:transparent!important;';
    s.overlay.style.objectFit=style.objectFit||'contain';s.overlay.style.objectPosition=style.objectPosition||'50% 50%';
    s.overlay.style.borderRadius=style.borderRadius||'0';s.overlay.loop=s.start<.1;host.appendChild(s.overlay);
    s.timer=setInterval(()=>window.__pongDomSwap===s&&window.__pongDomSwapSync(),100);
    window.__pongDomSwapSync();return true;
  };
  // Once the real visible card confirms its identity, adopt its existing
  // reader even if metadata/decoding is still pending. Waiting for readyState
  // let preparation of N+2 dispose N+1 before the native ready callback arrived,
  // causing another fetch and decoder startup on every fast swipe. Adoption
  // is ownership only: the frame synchronizer still controls visible pixels.
  // Adoption need not wait for two
  // cross-WebView round trips and a server activation acknowledgement. The
  // existing native/Pong handoff still owns activation and receipt evidence.
  window.__pongDomSwapObserveVideo=(pageUrl,video)=>{
    window.__pongTikTokObservedVideo={pageUrl:pageUrl||'',video:pageUrl?video:null};
    if(pageUrl&&pageUrl!==departingPage)departingPage='';
    if(!pageUrl){window.__pongDomSwapClear();return false;}
    // A site-driven transition can reuse the same <video> without going
    // through our gesture departure callback. Retire its outgoing pixels even
    // when no prepared replacement exists. URL-only native ready callbacks
    // must not leave the previous post covering the new original indefinitely.
    const active=window.__pongDomSwap;
    if(active&&(active.pageUrl!==pageUrl||active.original!==video))
      window.__pongDomSwapClear('',active.sessionId);
    const warm=window.__pongDomSwapWarm;
    if(!pageUrl||!video?.isConnected||!warm||warm.pageUrl!==pageUrl)return false;
    return window.__pongDomSwapAttach(warm.url,warm.sessionId,0,video,pageUrl);
  };
})()
