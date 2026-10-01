import {readFileSync} from 'node:fs';
const run=JSON.parse(readFileSync(process.argv[2],'utf8'));
const percentile=(a,p)=>{const sorted=a.filter(Number.isFinite).sort((x,y)=>x-y);return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]:null};
const times=run.trials.map(t=>t.firstPaintUpperMs).filter(Number.isFinite);
const pollTimes=run.trials.map(t=>t.firstSwapMs).filter(Number.isFinite);
const raf=run.trials.flatMap(t=>t.samples.flatMap(s=>s.view.rafIntervals));
const samples=run.trials.flatMap(t=>t.samples);
const distinct=new Map(samples.filter(s=>s.renderer.id).map(s=>[s.renderer.id,s.renderer]));
const elapsed=(s,end)=>s[end]>0&&s.createdAt>0?(s[end]-s.createdAt)*1000:null;
console.log(JSON.stringify({file:process.argv[2],variant:run.variant,sampleMs:run.sampleMs,measurementSchema:run.measurementSchema,receiver:run.receiver,trials:run.trials.length,videoVisits:run.videoVisits,
  advanced:run.trials.filter(t=>t.advanced).length,underOneSecond:run.trials.filter(t=>t.underOneSecond).length,
  navigationAdvanced:run.trials.filter(t=>t.navigationAdvanced).length,
  photoPosts:run.trials.filter(t=>t.photoPost).length,
  adPosts:run.trials.filter(t=>t.adPost).length,
  paintedTransformedWithinWindow:times.length,polledTransformedWithinWindow:pollTimes.length,
  needsFaceCoverageReview:run.trials.filter(t=>t.requiresFaceReview).length,
  firstPaintUpperMs:{min:percentile(times,0),median:percentile(times,.5),p95:percentile(times,.95),max:percentile(times,1),
    note:run.directDecoderTrial?'Experimental canvas draw/rAF timestamp; NOT rVFC or physical presentation proof':'Calibrated requestVideoFrameCallback upper bound; not delayed diagnostic polling time'},
  originalFirstPaintMedianMs:percentile(run.trials.map(t=>t.firstOriginalPaintUpperMs),.5),
  originalObservedMedianMs:percentile(run.trials.map(t=>t.firstOriginalObservedMs),.5),
  observerCost:samples.at(-1)?.view.observerCost||null,
  uiSchedulingProxy:{medianIntervalMs:percentile(raf,.5),p95IntervalMs:percentile(raf,.95),maxIntervalMs:percentile(raf,1),
    note:'requestAnimationFrame scheduling only; not physical display FPS qualification'},
  sourceOpenMedianMs:percentile([...distinct.values()].map(s=>elapsed(s,'sourceOpenedAt')),.5),
  firstByteMedianMs:percentile([...distinct.values()].map(s=>elapsed(s,'firstByteAt')),.5),
  androidFrameStats:run.androidFrameStats,
  errors:[...new Set(samples.map(s=>s.renderer.error).filter(Boolean))],pass:run.pass},null,2));
