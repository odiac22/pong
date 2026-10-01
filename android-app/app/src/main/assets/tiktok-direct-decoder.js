// Emulator opt-in trial. Uses the unchanged AVC samples and pixels, with a
// bounded decoded-frame queue instead of MSE seeking/buffering. Not enabled by
// an APK setting until measured presentation and lifecycle tests qualify it.
(() => {
  window.__pongCreateDirectDecoder=(s,{owned,fail})=>{
    const canvas=s.overlay,ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
    if(!ctx)throw Error('Direct compositor unavailable');
    const frames=[],waiters=new Set();let decoder,closed=false,configured=false,received=0,submitted=0,raf=0,firstTime=null,lastEnd=0,seekTarget=0;
    let requestSequence=0;const callbacks=new Map();
    const wake=()=>{for(const resolve of waiters)resolve();waiters.clear();};
    const release=f=>{try{f.close()}catch(_){}};
    const wait=()=>new Promise(resolve=>{waiters.add(resolve);});
    const close=()=>{
      if(closed)return;closed=true;cancelAnimationFrame(raf);s.abort.abort();wake();callbacks.clear();
      frames.splice(0).forEach(release);try{decoder?.close()}catch(_){}
    };
    const hide=()=>{if(!s.visible)return;s.visible=false;if(s.original)s.original.style.opacity=s.original.dataset.pongDomOriginalOpacity||'';canvas.style.opacity='0';document.documentElement.classList.remove('pong-dom-swap');};
    canvas.load=()=>{};canvas.pause=()=>{};canvas.play=()=>Promise.resolve();
    canvas.requestVideoFrameCallback=f=>{const id=++requestSequence;callbacks.set(id,f);return id;};
    canvas.cancelVideoFrameCallback=id=>callbacks.delete(id);
    Object.defineProperties(canvas,{
      currentTime:{get:()=>s.lastPaintedMediaTime??0,set:value=>{seekTarget=Number(value)||0;}},
      readyState:{get:()=>frames.length||s.lastPaintedAt?4:configured?1:0},
      paused:{get:()=>!!s.warm||!!s.original?.paused},seeking:{get:()=>false},
      error:{get:()=>null},videoWidth:{get:()=>canvas.width},videoHeight:{get:()=>canvas.height},
      buffered:{get:()=>({length:received?1:0,start:()=>Math.max(0,frames[0]?.timestamp/1e6||s.lastPaintedMediaTime||0),end:()=>lastEnd})}
    });
    s.presentationKind='canvas-rAF';
    s.direct={close,sync:()=>{
      const clock=performance.now(),v=s.original,target=Math.max(0,Number(v?.currentTime||0)-s.start);
      return{active:true,visible:!!s.visible,sessionId:s.sessionId,target,lag:Math.max(0,target-(s.lastPaintedMediaTime||0)),
        bufferEnd:lastEnd,bufferHeadroom:lastEnd-target,readyState:canvas.readyState,ageMs:clock-s.createdAt,
        firstVisibleAt:s.firstVisibleAt||0,presentedMediaTime:s.lastPaintedMediaTime??-1,
        paintedRecently:!!s.lastPaintedAt&&(v?.paused||clock-s.lastPaintedAt<750),
        presentationKind:s.presentationKind,decodedFrames:received,queuedFrames:frames.length,
        submittedFrames:submitted,pendingFrames:submitted-received,decoderQueue:decoder?.decodeQueueSize||0,seekTarget};
    }};
    const paint=()=>{
      if(closed||!owned(s))return;
      raf=requestAnimationFrame(paint);
      if(s.warm||!s.original?.isConnected||!s.host?.isConnected)return;
      const target=Number(s.original.currentTime||0)-s.start;
      if(target<-.05){hide();return;}
      // Keep the newest frame not beyond the original clock. Unlike repeated
      // MSE seeks this never flushes the decoder or re-decodes a GOP.
      while(frames.length>1&&frames[1].timestamp/1e6<=target+.025){const retired=frames.shift();if(retired.timestamp/1e6!==s.lastPaintedMediaTime)s.transport.unpresentedFrames=(s.transport.unpresentedFrames||0)+1;release(retired);wake();}
      const f=frames[0];if(!f||Math.abs(f.timestamp/1e6-target)>.45)return;
      if(f.timestamp/1e6===s.lastPaintedMediaTime)return;
      ctx.drawImage(f,0,0,canvas.width,canvas.height);
      s.lastPaintedMediaTime=f.timestamp/1e6;s.lastPaintedAt=performance.now();s.transport.paintedFrames=(s.transport.paintedFrames||0)+1;
      if(!s.visible){
        s.visible=true;s.firstVisibleAt=s.lastPaintedAt;
        if(!Object.prototype.hasOwnProperty.call(s.original.dataset,'pongDomOriginalOpacity'))s.original.dataset.pongDomOriginalOpacity=s.original.style.opacity||'';
        s.original.style.setProperty('opacity','0','important');canvas.style.opacity='1';document.documentElement.classList.add('pong-dom-swap');
        try{window.PongTikTokSwap?.presented?.(s.sessionId)}catch(_){}
      }
      const pending=[...callbacks.values()];callbacks.clear();
      for(const callback of pending)callback(s.lastPaintedAt,{mediaTime:s.lastPaintedMediaTime,presentedFrames:s.transport.paintedFrames});
    };
    raf=requestAnimationFrame(paint);
    (async()=>{
      try{
        decoder=new VideoDecoder({error:e=>{if(!closed)fail(e)},output:f=>{
          if(closed){release(f);return;}received++;firstTime??=f.timestamp/1e6;
          lastEnd=Math.max(lastEnd,(f.timestamp+(f.duration||33333))/1e6);frames.push(f);
          s.transport.firstDecodeAt??=performance.now();wake();
        }});
        const parser=new PongAvcFragments(config=>{
          canvas.width=config.codedWidth;canvas.height=config.codedHeight;
          decoder.configure({...config,optimizeForLatency:true,hardwareAcceleration:'prefer-hardware'});configured=true;
        },async sample=>{
          // Count in-flight outputs as well as decodeQueueSize: implementations
          // may submit work before delivering output callbacks.
          // Decoders may need more inputs before producing their first output
          // (optimizeForLatency is a hint, not an output-depth guarantee).
          // Combining decoded and in-flight frames under an eight-frame cap
          // can deadlock startup: no output -> no painted frame -> no credit.
          // Bound ready frames separately from submitted-but-not-output work.
          // A late decoder burst is still bounded by 8 + 24 total surfaces.
          while(!closed&&owned(s)&&(frames.length>=8||submitted-received>=24||decoder.decodeQueueSize>=8))await wait();
          if(closed||!owned(s))return;
          submitted++;decoder.decode(new EncodedVideoChunk(sample));
        });
        decoder.addEventListener('dequeue',wake);
        s.transport.requestAt=performance.now();
        const response=await fetch(s.url,{signal:s.abort.signal,cache:'no-store'});s.transport.headersAt=performance.now();
        if(!response.ok||!response.body)throw Error('Direct stream HTTP '+response.status);
        const reader=response.body.getReader();
        while(!closed&&owned(s)){
          const part=await reader.read();if(part.done)break;
          s.transport.firstChunkAt??=performance.now();s.transport.bytes+=part.value.byteLength;s.transport.chunks++;
          await parser.push(part.value);
        }
        if(!closed){parser.finish();await decoder.flush();s.ended=true;}
      }catch(error){if(!closed&&error.name!=='AbortError')fail(error);}
    })();
    return s.direct;
  };
})();
