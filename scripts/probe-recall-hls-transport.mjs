// Bounded, metadata/bytes-only probe; never renders media or emits source URLs.
import fs from 'node:fs/promises';
const snapshot=JSON.parse(await fs.readFile('.pong-local-ai/recall-restart-1790550172338.json','utf8'));
const channel=Number(process.argv[2]||2);
const video=snapshot.channels.find(c=>c.channel===channel).recall.genericBundles[0].videos[0];
let current=new URL(video.videoUrl,'http://127.0.0.1:8787');
if(current.pathname!=='/generic-media/hls')current=new URL(`/generic-media/hls?url=${encodeURIComponent(current.href)}`,'http://127.0.0.1:8787');
for(let level=0;level<4;level++){
 const began=Date.now();const r=await fetch(current,{signal:AbortSignal.timeout(12000)});
 const text=await r.text();const origin=new URL(current.searchParams.get('url'));console.log(JSON.stringify({level,status:r.status,type:r.headers.get('content-type'),queryKeys:[...origin.searchParams.keys()],pathDepth:origin.pathname.split('/').length,bytes:text.length,elapsedMs:Date.now()-began}));
 if(!text.startsWith('#EXTM3U'))throw Error('Not a playlist');
 const child=text.split(/\r?\n/).find(line=>line.trim()&&!line.startsWith('#'));
 current=new URL(child,current);
 console.log(JSON.stringify({childIsDiagnosedLeaf:new URL(current.searchParams.get('url')).pathname.endsWith('/index-v1-a1.m3u8')}));
 if(!text.includes('#EXT-X-STREAM-INF'))break;
}
for(const range of [null,'bytes=0-1023','bytes=0-']){
 const began=Date.now();
 try{
  const r=await fetch(current,{headers:range?{Range:range}:{},signal:AbortSignal.timeout(15000)});
  const reader=r.body.getReader();const chunk=await reader.read();await reader.cancel();
  const upstream=new URL(current.searchParams.get('url'));
  console.log(JSON.stringify({phase:'segment',proxyPath:current.pathname,queryKeys:[...upstream.searchParams.keys()],pathDepth:upstream.pathname.split('/').length,upstreamExtension:upstream.pathname.match(/\.[a-z0-9]+$/i)?.[0],range,status:r.status,type:r.headers.get('content-type'),length:r.headers.get('content-length'),bytes:chunk.value?.length||0,elapsedMs:Date.now()-began}));
 }catch(e){console.log(JSON.stringify({phase:'segment',range,error:e.name,elapsedMs:Date.now()-began}));}
}
for(const referer of [null,video.pageUrl]){
 const began=Date.now();
 try{
  const r=await fetch(current.searchParams.get('url'),{headers:{Range:'bytes=0-1023','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',...(referer?{Referer:referer}:{})},signal:AbortSignal.timeout(10000)});
  console.log(JSON.stringify({phase:'direct-segment',refererSupplied:!!referer,status:r.status,type:r.headers.get('content-type'),elapsedMs:Date.now()-began}));await r.body?.cancel();
 }catch(e){console.log(JSON.stringify({phase:'direct-segment',refererSupplied:!!referer,error:e.name}));}
}
