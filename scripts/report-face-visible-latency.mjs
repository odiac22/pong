// Preserve every qualified repetition, including slow starts; never substitute
// swipe time or detector success for independently reviewed face visibility.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.argv[2]);
const load=label=>readFile(path.join(root,label,'report.json'),'utf8').then(JSON.parse);
const median=values=>{
  const sorted=values.slice().sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length?(sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2):null;
};
const groups={
  control:['tiktok-activation-matched-control-r1','tiktok-activation-matched-control-r2'],
  eventDriven:['tiktok-activation-matched-events-r1','tiktok-activation-matched-events-r2'],
  bufferedSeek:['tiktok-activation-buffered-seek-r1']
};
const report={schema:1,scope:'One reviewed TikTok video; controlled activation repetitions in Pong2 emulator. Not a feed-swipe, cold-source or physical-phone qualification.',
  metric:'Visible face to first browser-presented transformed video frame; already-visible paused faces start at activation.',
  acceptance:'Under 1000ms on every eligible visit AND no buffering/glitches. Not achieved.',
  exclusions:'Ads and photos excluded from swap latency only; no-face time is not swap processing time. Unreviewed originals are not passed or exempted.',
  variants:{},defaultExperimentsEnabled:false};
for(const [name,labels] of Object.entries(groups)){
  const rows=[];
  for(const label of labels){
    const run=await load(label);
    for(const scored of run.faceVisibleTiming.trials){
      const playback=run.playback.find(p=>p.index===scored.index);
      const trial=run.trials.find(t=>t.index===scored.index);
      const paints=trial.paintEvidence.filter(p=>p.presentationKind==='video-rVFC').sort((a,b)=>a.at-b.at);
      const gaps=paints.slice(1).map((p,i)=>p.session===paints[i].session?p.at-paints[i].at:null).filter(Number.isFinite);
      rows.push({run:label,trial:scored.index,status:scored.status,pass:scored.pass,
        lowerMs:scored.episodes[0]?.firstSwapAfterFaceLowerMs??null,
        upperMs:scored.episodes[0]?.firstSwapAfterFaceUpperMs??null,
        visibleMediaWaitingMs:playback.waitingMs,
        maxVisibleMediaWaitMs:Math.max(0,...playback.waitingIntervals.map(w=>w.durationMs)),
        maxSwapPresentationGapMs:Math.max(0,...gaps),
        note:'Media events and rVFC gaps are diagnostic signals, not a complete visual-glitch audit.'});
    }
  }
  const times=rows.map(r=>r.upperMs).filter(Number.isFinite);
  report.variants[name]={rows,medianUpperMs:median(times),maxUpperMs:Math.max(...times),
    measured:rows.length,underOneSecond:rows.filter(r=>r.pass===true).length,
    uncertain:rows.filter(r=>r.pass===null).length};
}
const additional=await load('tiktok-activation-event-reveal-r2');
report.additionalSlowStart={run:'tiktok-activation-event-reveal-r2',
  upperMs:additional.faceVisibleTiming.trials[0].episodes[0].firstSwapAfterFaceUpperMs,
  note:'Retained ~4-second failure with a visible face. Model residency was not recorded in this earlier run; do not relabel it as warm or remove it.'};
report.medianChangePercent=100*(report.variants.control.medianUpperMs-report.variants.eventDriven.medianUpperMs)/report.variants.control.medianUpperMs;
report.promotionDecision='No global TikTok rollout of these experiments: small same-video sample still has >1-second starts and short waits. No model or resolution changes.';
const file=path.join(root,'face-visible-latency-summary.json');
await writeFile(file,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({file,variants:Object.fromEntries(Object.entries(report.variants).map(([k,v])=>[k,{medianUpperMs:v.medianUpperMs,maxUpperMs:v.maxUpperMs,underOneSecond:v.underOneSecond,measured:v.measured}])),additionalSlowStartMs:report.additionalSlowStart.upperMs}));
