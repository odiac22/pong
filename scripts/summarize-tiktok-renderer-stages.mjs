// Summarize cumulative per-session samples once, not once per polling tick.
// Stage instrumentation changes scheduling/readback: never an FPS qualification.
import {readFileSync,writeFileSync} from 'node:fs';
const input=process.argv[2];
if(!input)throw Error('Expected a repeated-pages diagnostic JSON path');
const data=JSON.parse(readFileSync(input,'utf8'));
const stats=values=>{
  const rows=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!rows.length)return null;
  return {count:rows.length,meanMs:rows.reduce((a,b)=>a+b,0)/rows.length,
    medianMs:rows[Math.floor(rows.length*.5)],p95Ms:rows[Math.min(rows.length-1,Math.floor(rows.length*.95))]};
};
const result={diagnosticOnly:true,performanceQualified:false,source:input,variant:data.variant,
  note:'Existing restorer correction reuse can make restoration spans bimodal. GPEN512Frames counts model choices, not inference executions. Stage timers add overhead.',cases:[]};
for(const entry of data.cases||[]){
  const sessions=new Map();
  for(const sample of entry.samples||[])if(sample.renderer?.id)sessions.set(sample.renderer.id,sample);
  result.cases.push({videoId:entry.videoId,firstPaintWithinFourSeconds:entry.firstPaintUpperMs??null,
    sessions:[...sessions.values()].map(({at,renderer:r})=>({id:r.id,lastSampleAtMs:at,
      frames:r.frames,transformedFrames:r.transformedFrames,adaptive:r.adaptive,
      firstTransformedMs:r.firstTransformedFrameAt?(r.firstTransformedFrameAt-r.createdAt)*1000:null,
      firstByteMs:r.firstByteAt?(r.firstByteAt-r.createdAt)*1000:null,
      timingTotals:r.timingTotals,stages:Object.fromEntries(Object.entries(r.frameDiagnostics||{}).map(([key,values])=>[key,stats(values)]))
    }))});
}
const output=input.replace(/\.json$/,'-stages.json');
if(output===input)throw Error('Expected .json input; refusing to overwrite it');
writeFileSync(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({output,...result}));
