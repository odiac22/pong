import {readFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));
const safe=r=>r?{id:r.id,state:r.state,frames:r.frames,transformedFrames:r.transformedFrames,
  decision:r.decisionReason,error:r.error,errorDetail:String(r.errorDetail||'').replace(/https?:\/\/[^\s'"]+/g,'[source]'),
  createToSourceMs:(r.sourceOpenedAt-r.createdAt)*1000,createToModelsMs:(r.modelsReadyAt-r.createdAt)*1000,
  createToFirstByteMs:(r.firstByteAt-r.createdAt)*1000,adaptive:r.adaptive}:null;
for(const t of data.trials){
 if(t.photoPost)continue;
 const samples=t.samples||[],last=samples.at(-1);
 console.log(JSON.stringify({trial:t.index??t.trial,videoId:last?.view.original?.videoId,
   paint:t.firstPaintUpperMs,
   states:[...new Set(samples.map(s=>s.renderer?.state).filter(Boolean))],
   reasons:[...new Set(samples.map(s=>s.renderer?.decisionReason).filter(Boolean))],
   error:[...new Set(samples.filter(s=>s.renderer?.error).map(s=>safe(s.renderer).errorDetail))],
   lastRenderer:safe(last?.renderer),lastTransport:last?.view.transport,lastSync:last?.view.sync}));
}
