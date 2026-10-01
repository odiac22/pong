export const videoIdFromPath=value=>String(value||'').match(/\/video\/(\d+)/)?.[1]||'';
export const confirmedPhotoPost=view=>!!view&&view.postKind==='photo'&&/^photo:\d{15,22}$/.test(view.postKey||'');
export const countedVideoVisit=trial=>!!trial.advanced&&!trial.photoPost&&!trial.adPost;
// A looping feed must not satisfy the requested corpus by repeating one post.
// All visits still retain their timing/navigation results, including repeats.
export function countDistinctVideoVisit(trial, view, pong, seen) {
 if(!countedVideoVisit(trial)||!incomingVideoForTrial(trial,view,pong))return false;
 const id=pong.videoId;
 if(seen.has(id))return false;
 seen.add(id);return true;
}
export const navigationAndTimingSatisfied=trial=>!!trial.navigationAdvanced&&
 (trial.photoPost===true||trial.adPost===true||trial.faceTiming?.status==='excluded'||trial.faceTiming?.pass===true);
export function incomingVideoForTrial(trial,view,pong){
 const previous=new Set([trial.beforeVideoId,
  String(trial.beforePostKey||'').startsWith('video:')?trial.beforePostKey.slice(6):'',
  videoIdFromPath(trial.beforePath)]);
 const observed=String(view.postKey||'').startsWith('video:')?view.postKey.slice(6):'';
 return !!pong.videoId&&pong.videoId===observed&&!previous.has(pong.videoId);
}
export function sameTrialVisualEvidence(trial,view,pong,afterKey,startedAt,finishedAt,holdMs){
 return view?.postKind==='video'&&incomingVideoForTrial(trial,view,pong)&&
  !!view.postKey&&afterKey===view.postKey&&Number.isFinite(startedAt)&&startedAt>=0&&
  Number.isFinite(finishedAt)&&finishedAt>=startedAt&&finishedAt<holdMs;
}
export function firstQualifiedPaint(trial,view,pong,backend,calibration,holdMs){
 if(!incomingVideoForTrial(trial,view,pong))return null;
 let first=null;
 for(const paint of trial.paintEvidence||[]){
  if(paint.session!==backend.id||paint.session!==pong.session||paint.videoId!==pong.videoId)continue;
  const frame=Math.round(paint.mediaTime*Number(backend.fps||0));
  if(!(backend.transformedFrameRanges||[]).some(([a,z])=>frame>=a&&frame<=z))continue;
  const minMs=paint.at+calibration.minOffset-trial.startedAt;
  const maxMs=paint.at+calibration.maxOffset-trial.startedAt;
  if(minMs<0||maxMs>=holdMs)continue;
  if(!first||maxMs<first.maxMs)first={minMs,maxMs};
 }
 return first;
}
export function auditPostReady(view) {
  if(view?.challenge)return false;
  // A genuine visible photo post can be the first For You item. It permits
  // starting navigation measurement, never a video/swap timing exemption.
  if(confirmedPhotoPost(view))return true;
  return !!view?.original&&view.original.ready>=2&&!view.original.paused;
}

export function firstOriginalPaint(trial,view,calibration,holdMs){
 const id=String(view.postKey||'').startsWith('video:')?view.postKey.slice(6):'';
 if(!incomingVideoForTrial(trial,view,{videoId:id}))return null;
 let first=null;
 for(const paint of trial.originalPaintEvidence||[]){
  if(paint.videoId!==id||paint.paused===true)continue;
  const minMs=paint.at+calibration.minOffset-trial.startedAt,maxMs=paint.at+calibration.maxOffset-trial.startedAt;
  if(minMs<0||maxMs>=holdMs)continue;
  if(!first||maxMs<first.maxMs)first={minMs,maxMs};
 }
 return first;
}
