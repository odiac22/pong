// Preserve TikTok's layout/timeline; hide only an original already replaced
// by its aligned visible decoder. Disposable experiment, not production.
(() => {
  window.__pongUndoOriginalVisibility?.();
  const sync=window.__pongDomSwapSync,clear=window.__pongDomSwapClear;
  if(typeof sync!=='function'||typeof clear!=='function')throw Error('Swap compositor unavailable');
  const hidden=new Map(),stats={hides:0,restores:0};
  function restore(video){
    const old=hidden.get(video);if(!old)return;
    if(old.value)video.style.setProperty('visibility',old.value,old.priority);
    else video.style.removeProperty('visibility');
    hidden.delete(video);stats.restores++;
  }
  function reconcile(){
    const state=window.__pongDomSwap;
    const keep=state?.visible&&state.original?.isConnected&&!state.overlay?.error?state.original:null;
    for(const video of hidden.keys())if(video!==keep)restore(video);
    if(keep&&!hidden.has(keep)){
      hidden.set(keep,{value:keep.style.getPropertyValue('visibility'),priority:keep.style.getPropertyPriority('visibility')});
      keep.style.setProperty('visibility','hidden','important');stats.hides++;
    }
  }
  const wrappedSync=function(...args){try{return sync.apply(this,args)}finally{reconcile()}};
  wrappedSync.pongFrameSync=sync.pongFrameSync;
  const wrappedClear=function(...args){try{return clear.apply(this,args)}finally{reconcile()}};
  window.__pongDomSwapSync=wrappedSync;window.__pongDomSwapClear=wrappedClear;
  window.__pongOriginalVisibilityStats=stats;
  window.__pongUndoOriginalVisibility=()=>{
    if(window.__pongDomSwapSync===wrappedSync)window.__pongDomSwapSync=sync;
    if(window.__pongDomSwapClear===wrappedClear)window.__pongDomSwapClear=clear;
    for(const video of hidden.keys())restore(video);
    delete window.__pongUndoOriginalVisibility;
  };
  reconcile();return true;
})()
