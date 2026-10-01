// Emulator-only alternative to repeated short seeks during a warm handoff.
// No pixels, source identity, reveal tolerance, or renderer settings change.
export function warmChaseTrial(source) {
  const threshold='const seekThreshold=s.visible?1.25:.45;';
  const seek='if(Math.abs(delta)>seekThreshold&&contains&&';
  const rate='const rate=delta>.12&&end-o.currentTime>.15?';
  for(const needle of [threshold,seek,rate]) if(source.split(needle).length!==2)
    throw Error('Synchronizer changed; warm chase trial was not installed');
  return source.replace(threshold,threshold+`
    // A 500ms retry can seek again immediately after the previous decode
    // finishes, perpetually chasing a moving original. Keep decoding a modest
    // positive lag instead. Rewinds, paused frames, large jumps and cold starts
    // still use the existing exact seek. Reveal still needs an aligned rVFC.
    const warmChase=!s.visible&&!v.paused&&s.transport?.warm===true&&
      s.transport.adoptedAt>0&&o.readyState>=2&&delta>.12&&delta<=1.25&&
      end-o.currentTime>.15;
    if(warmChase){
      s.transport.warmChaseTrial??={startedAt:clock,initialLag:delta,ticks:0};
      s.transport.warmChaseTrial.ticks++;
    }
  `).replace(seek,'if(!warmChase&&Math.abs(delta)>seekThreshold&&contains&&')
    .replace(rate,'const rate=warmChase?Math.min(3,base+2):delta>.12&&end-o.currentTime>.15?');
}
