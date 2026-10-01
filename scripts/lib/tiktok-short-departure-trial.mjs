// Trial only: yielding a departed owner is bounded to one second server-side.
// A no-op navigation returns the lease earlier; it never exempts the incoming owner.
export function installShortDepartureTrial() {
  const w=window,original=w.__pongDomSwapDepart;
  if(typeof original!=='function'||w.__pongUndoShortDeparture)throw Error('Departure trial is not idle');
  let sequence=0,closed=false;
  const timers=new Set();
  const emit=row=>{if(!closed)w.__pongAuditDeparture(JSON.stringify(row));};
  const wrapped=function(...args){
    const owner=w.__pongDomSwap,page=w.__pongTikTokObservedVideo?.pageUrl||owner?.pageUrl;
    const value=original.apply(this,args);
    if(!owner?.sessionId||w.__pongDomSwap||!page)return value;
    const requestId=++sequence;
    emit({kind:'depart',requestId,sessionId:owner.sessionId,at:performance.now()});
    const timer=setTimeout(()=>{
      timers.delete(timer);
      const current=w.__pongTikTokObservedVideo?.pageUrl;
      if(current===page)emit({kind:'return',requestId,sessionId:owner.sessionId,
        reason:'no-observed-navigation',at:performance.now()});
    },750);
    timers.add(timer);
    return value;
  };
  w.__pongDomSwapDepart=wrapped;
  w.__pongUndoShortDeparture=()=>{
    closed=true;for(const timer of timers)clearTimeout(timer);timers.clear();
    if(w.__pongDomSwapDepart===wrapped)w.__pongDomSwapDepart=original;
    delete w.__pongUndoShortDeparture;
  };
  return true;
}
