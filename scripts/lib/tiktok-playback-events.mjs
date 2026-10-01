// Buffering is independent of face eligibility. Photos have no playback.
// "stalled" alone is a network event, not proof playback actually stopped.
export function summarizePlaybackEvents(run) {
  const all=(run.paintDrains||[]).flatMap(d=>d.mediaEvents||[]).sort((a,b)=>a.at-b.at);
  return run.trials.map(trial=>{
    const clock=run.clockCalibration, end=Math.min(run.holdMs,trial.observedDwellMs??run.holdMs);
    const postIds=new Set((trial.samples||[]).filter(s=>s.view?.postKey&&
      s.view.postKey!==trial.beforePostKey).map(s=>s.view.postKey.split(':')[1]));
    const events=all.filter(e=>postIds.has(e.videoId)&&
      e.at+clock.minOffset>=trial.startedAt&&e.at+clock.maxOffset<trial.startedAt+end);
    const pending=new Map(),waits=[],errors=[];let networkStalls=0,hiddenWaitingEvents=0;
    const finish=(state,at,endedBy)=>{
      if(!state?.visibleStart)return;
      const start=state.visibleStart;state.visibleStart=null;
      waits.push({role:start.role,startMs:start.at+clock.maxOffset-trial.startedAt,
        durationMs:Math.max(0,at-start.at),endedBy});
    };
    for(const e of events){
      const key=`${e.videoId}:${e.role}:${e.session}`;
      if(e.type==='stalled')networkStalls++;
      if(e.type==='error')errors.push({role:e.role,atMs:e.at+clock.maxOffset-trial.startedAt});
      if(e.type==='waiting'&&!e.visible)hiddenWaitingEvents++;
      if(e.type==='waiting'&&!e.paused&&!e.seeking&&!pending.has(key))
        pending.set(key,{visibleStart:e.visible?e:null});
      const state=pending.get(key);
      if(state){
        if(!e.visible)finish(state,e.at,'hidden');
        else if(!state.visibleStart&&e.type==='visibility'&&!e.paused&&!e.seeking)state.visibleStart=e;
      }
      if(['playing','pause','seeking','ended','error'].includes(e.type)&&pending.has(key)){
        finish(pending.get(key),e.at,e.type);pending.delete(key);
      }
    }
    for(const state of pending.values())finish(state,trial.startedAt+end-clock.maxOffset,'view-ended');
    return {index:trial.index,waitingIntervals:waits,waitingMs:waits.reduce((n,w)=>n+w.durationMs,0),
      networkStalledEvents:networkStalls,hiddenWaitingEvents,errors,
      note:'Visible HTML media waits; source waits behind a swapped overlay remain separate. Visibility changes observed at sync/snapshot. No-events alone does not prove zero visual glitches.'};
  });
}
