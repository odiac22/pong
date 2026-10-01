import {readFileSync} from 'node:fs';
const run=JSON.parse(readFileSync(process.argv[2],'utf8'));
const rows=run.trials.map((t,i)=>{
 const own=t.samples.filter(s=>s.view.session&&s.view.session===s.pong.session&&s.pong.videoId&&s.pong.videoId!==t.beforeVideoId);
 const first=own[0],last=own.at(-1),transport=last?.view.transport||{};
 const relative=time=>Number.isFinite(time)?Math.round(time+run.clockCalibration.maxOffset-t.startedAt):null;
 const event=(s,key)=>s?.renderer[key]>0?Math.round((s.renderer[key]-s.renderer.createdAt)*1000):null;
 return {i:i+1,photo:t.photoPost,paintMs:t.firstPaintUpperMs===null?null:Math.round(t.firstPaintUpperMs),
  navMs:Math.round(t.navigationObservedMs),ownerObservedMs:first?.at,
  transport:Object.fromEntries(['createdAt','adoptedAt','requestAt','headersAt','firstChunkAt','sourceOpenAt','firstAppendAt','loadedmetadata','loadeddata','canplay','playing'].map(k=>[k,relative(transport[k])])),
  server:{modelsMs:event(last,'modelsReadyAt'),sourceMs:event(last,'sourceOpenedAt'),frameMs:event(last,'firstSourceFrameAt'),byteMs:event(last,'firstByteAt'),transformedMs:event(last,'firstTransformedFrameAt'),frames:last?.renderer.frames,swapped:last?.renderer.transformedFrames,reason:last?.renderer.decisionReason},
  lastSync:last?.view.sync,longTasksMs:t.samples.flatMap(s=>s.view.longTasks).reduce((a,t)=>a+(t?.ms||0),0)};
});
console.log(JSON.stringify({file:process.argv[2],rows},null,2));
