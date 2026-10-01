// Read-only bounded transport probe for the first video fragment of a public HLS master.
// No file media is saved; each GET asks for 64 KiB and reads at most that amount.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const base='http://127.0.0.1:17929';
const master='https://stream.mux.com/BV3YZtogl89mg9VcNBhhnHm02Y34zI1nlMuMQfAbl3dM.m3u8';
const masterText=await (await fetch(`${base}/generic-media/hls?url=${encodeURIComponent(master)}`,{signal:AbortSignal.timeout(15000)})).text();
const masterLines=masterText.split(/\r?\n/);
const streamIndex=masterLines.findIndex(line=>line.startsWith('#EXT-X-STREAM-INF'));
if(streamIndex<0)throw Error('No stream variant');
const renditionPath=masterLines[streamIndex+1].trim();
const renditionText=await (await fetch(base+renditionPath,{signal:AbortSignal.timeout(15000)})).text();
const renditionLines=renditionText.split(/\r?\n/);
const fragmentIndex=renditionLines.findIndex(line=>line.startsWith('#EXTINF'));
if(fragmentIndex<0)throw Error('No first video fragment');
const proxy=base+renditionLines[fragmentIndex+1].trim();
const direct=new URL(proxy).searchParams.get('url');
if(!direct||!direct.startsWith('https://'))throw Error('Unsafe HLS fragment URL');
async function request(label,url,method,range=''){
  const started=performance.now();
  const headers=range?{Range:range}:{};
  try{
    const response=await fetch(url,{method,headers,signal:AbortSignal.timeout(15000)});
    const result={label,method,range,status:response.status,headersMs:Math.round(performance.now()-started),
      acceptRanges:response.headers.get('accept-ranges'),etag:response.headers.get('etag'),
      lastModified:response.headers.get('last-modified'),contentRange:response.headers.get('content-range'),
      contentLength:response.headers.get('content-length'),contentType:response.headers.get('content-type')};
    if(method==='GET'){
      let bytes=0;
      const reader=response.body.getReader();
      while(bytes<65536){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;}
      await reader.cancel();
      result.receivedBytes=bytes;
      result.first64kMs=Math.round(performance.now()-started);
    }
    return result;
  }catch(error){return {label,method,range,error:error.name,elapsedMs:Math.round(performance.now()-started)}}
}
const ranges=['bytes=0-65535','bytes=1048576-1114111'];
const results=await Promise.all([
  request('direct',''+direct,'HEAD'),
  ...ranges.map(range=>request('direct',direct,'GET',range)),
  request('proxy',proxy,'HEAD'),
  ...ranges.map(range=>request('proxy',proxy,'GET',range))
]);
const report={master,streamInfo:masterLines[streamIndex],fragmentHost:new URL(direct).hostname,results};
const artifact='E:/Pong Benchmarks/v3029-overnight/userscript/videojs-pong/segment-range-probe.json';
await mkdir(path.dirname(artifact),{recursive:true});
await writeFile(artifact,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
