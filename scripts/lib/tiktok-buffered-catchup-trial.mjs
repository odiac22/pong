// Build an isolated test synchronizer, preserving all reveal/identity guards.
// This is deliberately not bundled or enabled in the released APK.
export function bufferedCatchupTrial(source){
  const threshold='const seekThreshold=s.visible?1.25:.45;';
  const seek='if(Math.abs(delta)>seekThreshold&&contains&&';
  const rate='const rate=delta>.12&&end-o.currentTime>.15?';
  for(const text of [threshold,seek,rate])if(source.split(text).length!==2)
    throw Error('Frame synchronizer changed; cannot install catch-up experiment');
  return source.replace(threshold,threshold+`
    // An already-buffered adopted stream may lose ~2s to its first seek.
    // Give only that narrow case 350ms to close a <=1.5s gap without flushing.
    const eligibleWarmCatchup=!s.visible&&!v.paused&&s.transport?.warm===true&&
      s.transport.adoptedAt>0&&o.readyState>=2&&contains&&delta>.45&&delta<=1.5&&
      s.lastAlignmentSeekAt==null&&clock-s.createdAt<=1200;
    if(eligibleWarmCatchup&&s.bufferedCatchupUntil==null){
      s.bufferedCatchupUntil=clock+350;
      s.transport.bufferedCatchupTrial={startedAt:clock,initialLag:delta};
    }
    const bufferedCatchup=eligibleWarmCatchup&&clock<s.bufferedCatchupUntil;
  `).replace(seek,'if(!bufferedCatchup&&Math.abs(delta)>seekThreshold&&contains&&')
    .replace(rate,'const rate=bufferedCatchup?Math.min(3,base+2):delta>.12&&end-o.currentTime>.15?');
}
