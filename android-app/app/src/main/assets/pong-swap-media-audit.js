// Exact emulator-audit Worker asset. No imports, cookies, TikTok API calls, or
// network access other than the native-owned current __pong_swap session route.
(() => {
  'use strict';
  const VERSION=1,MAX_QUEUE=2*1024*1024;
  let started=false,confirmed=false,closed=false,source=null,buffer=null,ended=false,metadata=false;
  let queuedBytes=0,credit=null,reportTimer=0,metadataTimer=0,fragmentBatch=null,nativePort=null,nativeExpected=false;
  const queue=[],abort=new AbortController();
  const stats={workerMse:true,fragmentBatch:true,bytes:0,chunks:0,packets:0,appendCalls:0,appendedBytes:0};
  const stamp=()=>performance.timeOrigin+performance.now();
  const report=()=>{if(!closed)postMessage({type:'transport',stats:{...stats,queuedBytes,
    queuedPackets:queue.length,partialBytes:fragmentBatch?.retainedBytes||0,updating:!!buffer?.updating}})};
  const release=()=>{const resolve=credit;credit=null;resolve?.()};
  const close=()=>{if(closed)return;closed=true;abort.abort();release();
    if(nativePort){try{nativePort.postMessage(JSON.stringify({type:'close'}));nativePort.close()}catch{}nativePort=null;}
    clearInterval(reportTimer);clearTimeout(metadataTimer);fragmentBatch?.dispose();queue.length=0;queuedBytes=0;};
  const fail=reason=>{if(closed)return;report();postMessage({type:'failure',reason});close();};
  const enqueue=packet=>{
    if(closed)return;
    stats.packets++;queuedBytes+=packet.byteLength;queue.push(packet);pump();
  };
  const pump=()=>{
    if(closed||!buffer||buffer.updating)return;
    if(queue.length){
      // Packetizer emits init and whole moof/mdat groups. Preserve those
      // boundaries at MSE; never concatenate a partial next fragment here.
      const packet=queue.shift();queuedBytes-=packet.byteLength;release();stats.appendCalls++;
      try{buffer.appendBuffer(packet);stats.appendedBytes+=packet.byteLength}catch{fail('Worker SourceBuffer append failed')}
      return;
    }
    if(ended&&source.readyState==='open'){
      if(!stats.bytes){fail('Worker stream ended without media');return;}
      if(!metadata){if(!metadataTimer)metadataTimer=setTimeout(()=>fail('Worker stream ended before metadata'),1500);return;}
      clearTimeout(metadataTimer);
      try{source.endOfStream();report()}catch{fail('Worker end-of-stream failed')}
    }
  };
  const receive=async url=>{
    try{
      stats.requestAt=stamp();
      const response=await fetch(url,{signal:abort.signal,cache:'no-store',credentials:'omit'});
      stats.headersAt=stamp();stats.http=response.status;report();
      if(!response.ok||!response.body){fail('Worker stream HTTP '+response.status);return;}
      if(!(response.headers.get('content-type')||'').split(',').every(x=>/^video\/mp4(?:\s*;|\s*$)/i.test(x.trim()))){
        fail('Worker response is not MP4');return;
      }
      if(typeof self.__pongCreateFragmentBatch!=='function'){
        fail('Worker fragment packetizer unavailable');return;
      }
      fragmentBatch=self.__pongCreateFragmentBatch(enqueue);
      const reader=response.body.getReader();
      while(!closed){
        if(queuedBytes>=MAX_QUEUE)await new Promise(resolve=>{credit=resolve});
        if(closed)return;
        const part=await reader.read();if(closed)return;if(part.done)break;
        if(part.value?.byteLength){const first=!stats.bytes;
          stats.firstChunkAt??=stamp();stats.bytes+=part.value.byteLength;stats.chunks++;
          for(let offset=0;offset<part.value.byteLength;offset+=256*1024){
            if(queuedBytes>=MAX_QUEUE)await new Promise(resolve=>{credit=resolve});
            if(closed)return;
            fragmentBatch.push(part.value.subarray(offset,offset+256*1024));
          }
          if(first)report();}
      }
      fragmentBatch.finish();
      ended=true;pump();report();
    }catch(e){if(e?.name!=='AbortError')fail('Worker media transport failed')}
  };
  // Experimental binary native channel. The decoder sees the same MP4 bytes
  // and whole-fragment packets as Fetch, without thousands of 2–4 KiB reads
  // through WebResourceResponse. Native has its own 256 KiB credit ceiling;
  // acknowledge only after the packetizer/append queue accepts this chunk.
  const receiveNative=port=>{
    if(closed||!nativeExpected||nativePort){try{port.close()}catch{}return;}
    nativePort=port;stats.nativeBinary=true;stats.requestAt=stamp();
    let chain=Promise.resolve(),headers=false;
    const accept=async data=>{
      if(closed)return;
      if(typeof data==='string'){
        let message;try{message=JSON.parse(data)}catch{throw Error('Native message rejected')}
        if(message.type==='headers'){
          if(headers||message.status!==200||message.contentType!=='video/mp4')throw Error('Native response rejected');
          headers=true;stats.http=message.status;stats.headersAt=stamp();
          fragmentBatch=self.__pongCreateFragmentBatch(enqueue);report();return;
        }
        if(message.type==='end'&&headers){fragmentBatch.finish();ended=true;pump();report();return;}
        throw Error('Native media channel failed');
      }
      if(!headers||ended||!(data instanceof ArrayBuffer)||data.byteLength<1||data.byteLength>64*1024)
        throw Error('Native media packet rejected');
      while(!closed&&queuedBytes>=MAX_QUEUE)await new Promise(resolve=>{credit=resolve});
      if(closed)return;
      const size=data.byteLength,first=!stats.bytes;
      stats.firstChunkAt??=stamp();stats.bytes+=size;stats.chunks++;
      fragmentBatch.push(new Uint8Array(data));
      port.postMessage(JSON.stringify({type:'ack',bytes:size}));
      if(first)report();
    };
    port.onmessage=event=>{chain=chain.then(()=>accept(event.data)).catch(()=>fail('Native media channel failed'));};
    port.onmessageerror=()=>fail('Native media message failed');
    port.start();port.postMessage(JSON.stringify({type:'ready'}));
  };
  self.onmessage=event=>{
    const message=event.data||{};
    if(message.type==='close'){close();return;}
    if(message.type==='challenge'&&!confirmed&&!started&&!closed){
      if(typeof message.nonce==='string'&&/^[a-f0-9]{32}$/.test(message.nonce)){
        confirmed=true;postMessage({type:'echo',version:VERSION,nonce:message.nonce});
      }
      return;
    }
    if(message.type==='metadata'){metadata=true;pump();return;}
    if(message.type==='native-port'&&started&&nativeExpected&&message.port){receiveNative(message.port);return;}
    if(message.type!=='start'||!confirmed||started||closed)return;
    started=true;
    nativeExpected=message.native===true;
    let url;try{url=new URL(message.url)}catch{fail('Invalid worker media route');return;}
    if(url.origin!=='https://www.tiktok.com'||
       !/^\/__pong_swap\/[A-Za-z0-9_-]+$/.test(url.pathname)||
       !['','?attach=1'].includes(url.search)||url.hash){fail('Invalid worker media route');return;}
    source=new MediaSource();
    source.addEventListener('sourceopen',()=>{
      if(closed||source.readyState!=='open'||buffer)return;
      stats.sourceOpenAt=stamp();
      const mime=['video/mp4; codecs="avc1.64001F"','video/mp4; codecs="avc1.4D401F"','video/mp4'].find(x=>MediaSource.isTypeSupported(x));
      if(!mime){fail('Worker H.264 MSE unsupported');return;}
      try{buffer=source.addSourceBuffer(mime);buffer.mode='segments';
        buffer.addEventListener('error',()=>fail('Worker SourceBuffer rejected media'));
        buffer.addEventListener('updateend',()=>{const first=!stats.firstAppendAt;
          stats.firstAppendAt??=stamp();pump();if(first)report()});pump();report();
      }catch{fail('Worker MSE initialization failed')}
    });
    try{const handle=source.handle;postMessage({type:'handle',handle},[handle]);}
    catch{fail('Worker MediaSourceHandle unavailable');return;}
    reportTimer=setInterval(report,250);if(!nativeExpected)void receive(url.href);
  };
  postMessage({type:'ready',version:VERSION});
})();
