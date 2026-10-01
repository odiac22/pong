// Summarize preserved QA artifacts without rewriting their raw evidence.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.argv[2]||'E:/Pong Benchmarks/v3003-profile-controls';
const read=async name=>JSON.parse(await readFile(path.join(root,name,'report.json'),'utf8'));
const quantile=(values,p)=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!v.length)return null;const t=(v.length-1)*p,i=Math.floor(t);return v[i]+(v[Math.ceil(t)]-v[i])*(t-i);};
const stats=v=>({count:v.filter(Number.isFinite).length,median:quantile(v,.5),p90:quantile(v,.9),min:quantile(v,0),max:quantile(v,1)});
const summary={scope:'Silent headless local Recall 2 fixtures; not physical-phone or public-CDN timings',interactionRuns:{},profileRuns:{}};
for(const name of ['recall2-controls-before','recall2-controls-resume-fix','seek-before-verified','seek-after-verified']){
 try{
  const r=await read(name),actions=r.clips.flatMap(c=>c.interactions||[]);
  summary.interactionRuns[name]={completed:r.completed,acceptance:r.acceptance,
   seekDisplayedMs:stats(actions.filter(a=>a.action==='seek'&&a.success&&a.owned===true&&Math.abs(a.after.time-a.target)<.15).map(a=>a.presentedMs)),
   playStateMs:stats(actions.filter(a=>a.action.startsWith('play')).map(a=>a.stateMs)),
   playSucceeded:actions.filter(a=>a.action.startsWith('play')&&!a.paused).length,
   playAttempts:actions.filter(a=>a.action.startsWith('play')).length,
   previewMs:stats(r.clips.flatMap(c=>(c.diagnostics||[]).filter(e=>e.type==='swap.seek-preview-frame').map(e=>e.detail.elapsedMs))),
   clips:r.clips.map(c=>({clip:c.clip,pass:c.interactionPass,recallMs:c.recallFirstFrameMs,swapMs:c.swapFirstPlayableMs,
    seekDisplayedMs:stats((c.interactions||[]).filter(a=>a.action==='seek'&&a.owned&&Math.abs(a.after.time-a.target)<.15).map(a=>a.presentedMs))}))};
 }catch(e){summary.interactionRuns[name]={unavailable:String(e)};}
}
const metrics=['attachmentPoseAccelerationP95','motionFidelityErrorP95','featureRelationChangeP95','temporalResidualMaeP95','boundaryFlickerMaeP95','sharpnessMedian','headAngleBestLagFrames'];
for(const name of ['profile-baseline','profile-candidate','profile-candidate-r2']){
 const r=await read(name);summary.profileRuns[name]={summary:r.summary,clips:r.clips.map(c=>({clip:c.clip,eligible:c.eligibility.eligible,passed:c.passed,fps:c.timing.processingFps,identityGain:c.transformation.medianIdentityGain,quality:Object.fromEntries(metrics.map(k=>[k,c.temporalQuality[k]]))}))};
}
await writeFile(path.join(root,'comparison.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary.interactionRuns,null,2));
