// Silent HTTP-streamed, fixed-input comparison. Does not mutate settings or Recall.
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {Writable} from 'node:stream';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
const repo=path.resolve(import.meta.dirname,'..');
const out=path.resolve(process.env.PONG_BENCH_OUT||'E:/Pong Benchmarks/v3002-throughput/baseline-live');
const base=process.env.SWAP_BASE||'http://127.0.0.1:8792';
const corpus=process.env.PONG_CORPUS_ROOT||path.join(repo,'Pong Swap/benchmarks/realtime-stock-corpus');
const manifest=JSON.parse(await readFile(path.join(corpus,'manifest.json'),'utf8'));
const ordinals=process.env.PONG_BENCH_CLIPS?process.env.PONG_BENCH_CLIPS.split(',').map(Number):[1,2,3,4,5,8,9,10,12,23];
const clips=manifest.clips.filter(c=>ordinals.includes(c.ordinal));
if(ordinals.some(id=>!clips.some(c=>c.ordinal===id)))throw Error('Requested clip missing; refusing a partial throughput baseline');
if(process.env.PONG_LONG==='1')clips.push({ordinal:'eating',path:'E:/Pong Benchmarks/v2906-occlusion/segments/minute.mp4',durationSeconds:64.6,fps:'60000/1001',sha256:'a21a039eb00e00c058c8d41465956b0149db06d954df1746b927691f13347fc3',audioRemoved:true});
const report={schema:'pong-stream-throughput-v1',silent:true,scope:'HTTP streamed render throughput, NOT Recall or paced browser playback',startedAt:new Date().toISOString(),clips:[]};
const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(route+': '+r.status+' '+await r.text());return r.json();};
const save=()=>writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
let server,sid;
try{
 await mkdir(out,{recursive:false});
 report.settings=await api('/settings');report.health=await api('/health');
 if(report.health.runtime.swapAudioEnabled!==false)throw Error('Audio must be disabled');
 const sessions=(await api('/sessions')).sessions;
 if(sessions.some(s=>!s.complete&&!s.playbackPaused))throw Error('Another render is active');
 const faces=(await api('/faces')).faces;
 const face=faces.find(f=>f.name==='Approved 3');if(!face)throw Error('Fixed approved identity missing');
 report.face={id:face.id,name:face.name};
 const files=new Map();
 for(const c of clips){
  const file=path.isAbsolute(c.path)?c.path:path.join(corpus,c.path),bytes=await readFile(file);
  if(createHash('sha256').update(bytes).digest('hex')!==c.sha256)throw Error('Fixture changed');
  if(!c.audioRemoved)throw Error('Fixture is not silent');
  files.set('/'+path.basename(file),{file,size:bytes.length});
 }
 server=http.createServer((req,res)=>{
  const f=files.get(new URL(req.url,'http://localhost').pathname);
  if(!f){res.writeHead(404);res.end();return;}
  const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
  const start=m?Number(m[1]):0,end=m&&m[2]?Math.min(f.size-1,Number(m[2])):f.size-1;
  if(start>end){res.writeHead(416);res.end();return;}
  res.writeHead(m?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*','Connection':'close','Content-Length':end-start+1,...(m?{'Content-Range':`bytes ${start}-${end}/${f.size}`}:{})});
  if(req.method==='HEAD'){res.end();return;}
  const stream=createReadStream(f.file,{start,end});res.on('close',()=>stream.destroy());stream.pipe(res);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 for(const c of clips){
  const row={clip:c.ordinal,sha256:c.sha256,sourceFps:c.fps,width:c.width,height:c.height,duration:c.durationSeconds,samples:[]};report.clips.push(row);
  const t=performance.now();
  const created=await api('/sessions','POST',{channel:'test',sourceUrl:`http://127.0.0.1:${server.address().port}/${path.basename(c.path)}`,faceId:face.id,faceIds:[face.id],startSeconds:0,prefetch:false,prebufferSeconds:.5,navigationClass:'foreground'});
  sid=created.session.id;
  const stream=fetch(base+'/sessions/'+sid+'/stream').then(async r=>{if(!r.ok)throw Error('stream '+r.status);await pipeline(Readable.fromWeb(r.body),process.env.PONG_DISCARD_OUTPUT==='1'?new Writable({write(chunk,encoding,done){row.receivedBytes=(row.receivedBytes||0)+chunk.length;done();}}):createWriteStream(path.join(out,'clip-'+c.ordinal+'.mp4')));});stream.catch(()=>{});
  while(performance.now()-t<Math.max(60000,c.durationSeconds*3000+30000)){
   const s=(await api('/sessions/'+sid)).session;row.final=s;row.samples.push({ms:performance.now()-t,frames:s.frames,transformed:s.transformedFrames,muxed:s.muxedMediaSeconds});
   if(s.error)throw Error(s.error);if(s.complete)break;
   await api('/sessions/'+sid+'/playback','POST',{positionSeconds:s.frames/Math.max(1,s.fps),paused:false});
   await new Promise(r=>setTimeout(r,80));
  }
  if(!row.final.complete)throw Error('Render timeout');
  await stream;
  row.wallSeconds=(performance.now()-t)/1000;
  row.endToEndFps=row.final.frames/row.wallSeconds;
  row.workFps=row.final.frames/row.final.timingTotals.frameWorkSeconds;
  row.headroom=row.workFps/row.final.fps;
  row.firstTransformedMs=row.final.firstTransformedFrameAt?1000*(row.final.firstTransformedFrameAt-row.final.createdAt):null;
  row.transformedRatio=row.final.transformedFrames/Math.max(1,row.final.frames);
  await api('/sessions/'+sid+'?defer=false','DELETE');sid=null;
  console.log(JSON.stringify({clip:c.ordinal,fps:row.workFps,endToEndFps:row.endToEndFps,headroom:row.headroom,transformed:row.transformedRatio,startMs:row.firstTransformedMs}));
  await save();
 }
 report.completed=true;
}catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{
 if(sid)await api('/sessions/'+sid+'?defer=false','DELETE').catch(()=>{});
 server?.closeAllConnections();server?.close();await save();
}
