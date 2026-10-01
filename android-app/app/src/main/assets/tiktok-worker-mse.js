// Opt-in receiver experiment: identical MP4 bytes, MSE work off TikTok's main
// thread. It never contacts TikTok APIs or changes their requests/cookies.
(() => {
  function workerMain() {
    let started=false,closed=false,source=null,buffer=null,ended=false,metadata=false;
    let queuedBytes=0,credit=null,reportTimer=0,metadataTimer=0;
    const queue=[],abort=new AbortController(),stats={workerMse:true,bytes:0,chunks:0,appendCalls:0,coalescedReads:0};
    const stamp=()=>performance.timeOrigin+performance.now();
    const report=()=>{if(!closed)postMessage({type:'transport',stats:{...stats}})};
    const release=()=>{const resolve=credit;credit=null;resolve?.()};
    const fail=reason=>{
      if(closed)return;
      report();postMessage({type:'failure',reason});
      closed=true;abort.abort();release();clearInterval(reportTimer);clearTimeout(metadataTimer);
    };
    const pump=()=>{
      if(closed||!buffer||buffer.updating)return;
      if(queue.length){
        const parts=[queue.shift()];let size=parts[0].byteLength;
        while(queue.length&&size+queue[0].byteLength<=256*1024){const part=queue.shift();parts.push(part);size+=part.byteLength;}
        let chunk=parts[0];
        if(parts.length>1){chunk=new Uint8Array(size);let offset=0;for(const part of parts){chunk.set(part,offset);offset+=part.byteLength;}}
        queuedBytes-=size;release();stats.appendCalls++;stats.coalescedReads+=parts.length-1;
        try{buffer.appendBuffer(chunk)}catch{fail('Worker SourceBuffer append failed')}
        return;
      }
      if(ended&&source.readyState==='open'){
        if(!stats.bytes){fail('Worker stream ended without media');return;}
        if(!metadata){
          if(!metadataTimer)metadataTimer=setTimeout(()=>fail('Worker stream ended before metadata'),1500);
          return;
        }
        clearTimeout(metadataTimer);
        try{source.endOfStream();report()}catch{fail('Worker end-of-stream failed')}
      }
    };
    const receive=async url=>{
      try{
        stats.requestAt=stamp();
        const response=await fetch(url,{signal:abort.signal,cache:'no-store'});
        stats.headersAt=stamp();stats.http=response.status;report();
        if(!response.ok||!response.body){fail('Worker stream HTTP '+response.status);return;}
        if(!(response.headers.get('content-type')||'').split(',').every(x=>/^video\/mp4(?:\s*;|\s*$)/i.test(x.trim()))){fail('Worker response is not MP4');return;}
        const reader=response.body.getReader();
        while(!closed){
          if(queuedBytes>=2*1024*1024)await new Promise(resolve=>{credit=resolve});
          if(closed)return;
          const part=await reader.read();if(closed)return;if(part.done)break;
          if(part.value?.byteLength){
            const first=!stats.bytes;stats.firstChunkAt??=stamp();stats.bytes+=part.value.byteLength;stats.chunks++;
            // Keep the view: copying every read's ArrayBuffer is unnecessary.
            queuedBytes+=part.value.byteLength;queue.push(part.value);pump();if(first)report();
          }
        }
        ended=true;pump();report();
      }catch(e){if(e?.name!=='AbortError')fail('Worker media transport failed')}
    };
    self.onmessage=event=>{
      const message=event.data||{};
      if(message.type==='metadata'){metadata=true;pump();return;}
      if(message.type!=='start'||started||closed)return;
      started=true;
      // The native bridge owns this exact local route; arbitrary remote media
      // or API URLs must never be accepted by the dedicated worker.
      let url;try{url=new URL(message.url)}catch{fail('Invalid worker media route');return;}
      if(url.origin!=='https://www.tiktok.com'||!/^\/__pong_swap\/[A-Za-z0-9_-]+$/.test(url.pathname)||!['','?attach=1'].includes(url.search)){
        fail('Invalid worker media route');return;
      }
      source=new MediaSource();
      source.addEventListener('sourceopen',()=>{
        if(closed||source.readyState!=='open'||buffer)return;
        stats.sourceOpenAt=stamp();
        const mime=['video/mp4; codecs="avc1.64001F"','video/mp4; codecs="avc1.4D401F"','video/mp4'].find(x=>MediaSource.isTypeSupported(x));
        if(!mime){fail('Worker H.264 MSE unsupported');return;}
        try{
          buffer=source.addSourceBuffer(mime);buffer.mode='segments';
          buffer.addEventListener('error',()=>fail('Worker SourceBuffer rejected media'));
          buffer.addEventListener('updateend',()=>{const first=!stats.firstAppendAt;stats.firstAppendAt??=stamp();pump();if(first)report()});
          pump();report();
        }catch{fail('Worker MSE initialization failed')}
      });
      const handle=source.handle;postMessage({type:'handle',handle},[handle]);
      reportTimer=setInterval(report,250);void receive(url.href);
    };
  }
  window.__pongCreateWorkerMse=(s,{owned,fail,sync})=>{
    const workerUrl=URL.createObjectURL(new Blob(['('+workerMain.toString()+')()'],{type:'text/javascript'}));
    let worker,closed=false;
    const close=()=>{if(closed)return;closed=true;worker?.terminate();URL.revokeObjectURL(workerUrl);};
    s.worker={close};s.abort.signal.addEventListener('abort',close,{once:true});
    const timestampKeys=new Set(['requestAt','headersAt','firstChunkAt','sourceOpenAt','firstAppendAt']);
    try{
      worker=new Worker(workerUrl,{name:'pong-swap-media'});
      worker.onmessage=event=>{
        if(closed||!owned(s))return;
        const message=event.data||{};
        if(message.type==='handle'){s.overlay.srcObject=message.handle;s.overlay.load();}
        else if(message.type==='transport'){
          for(const [key,value] of Object.entries(message.stats))s.transport[key]=timestampKeys.has(key)?value-performance.timeOrigin:value;
        }else if(message.type==='failure')fail(message.reason);
      };
      worker.onerror=event=>{if(!closed&&owned(s))fail('Worker media startup failed: '+String(event?.message||'no detail').replace(/https?:\/\/\S+/g,'[resource]').slice(0,200))};
      for(const event of ['loadedmetadata','loadeddata','canplay','playing'])s.overlay.addEventListener(event,()=>{
        s.transport[event]??=performance.now();
        if(event==='loadedmetadata'&&!closed)worker.postMessage({type:'metadata'});
        if(!s.warm)sync();
      },{passive:true});
      s.overlay.addEventListener('error',()=>fail('Worker media element error'),{once:true});
      s.overlay.addEventListener('ended',()=>{
        if(window.__pongDomSwap!==s)return;
        if(s.start<.1){try{s.overlay.currentTime=0;s.overlay.play().catch(()=>{})}catch{}}
        else window.__pongDomSwapClear();
      });
      worker.postMessage({type:'start',url:s.url});
    }catch(error){fail('Worker media unavailable: '+String(error?.name||'unknown'))}
  };
})()
