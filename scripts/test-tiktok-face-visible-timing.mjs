import test from 'node:test';
import assert from 'node:assert/strict';
import {faceVisibleTiming,validateFaceReview,reconcileFaceVisibleTiming} from './lib/tiktok-face-visible-timing.mjs';
function fixture({faceStart=3,swapAt=4750,swapTime=3.3}={}) {
  const review={reviewed:true,method:'manual-original',evidence:['original-frames-reviewed'],
    reviewedRanges:[[0,6]],eligibleFaceRanges:[[faceStart,6]],boundaryUncertaintyMs:34};
  const samples=[{view:{postKind:'video',postKey:'video:222',session:'b',sourceStart:0},pong:{videoId:'222',session:'b'},
    renderer:{id:'b',fps:30,transformedFrameRanges:[[Math.round(swapTime*30),150]]}}];
  const trial={index:1,beforeVideoId:'111',startedAt:0,observedDwellMs:5000,samples,
    originalPaintEvidence:[{videoId:'222',at:1500,mediaTime:0},{videoId:'222',at:4500,mediaTime:3},{videoId:'222',at:4800,mediaTime:3.3}],
    paintEvidence:swapAt===null?[]:[{videoId:'222',session:'b',at:swapAt,mediaTime:swapTime}]};
  const run={holdMs:5000,clockCalibration:{minOffset:0,maxOffset:0},trials:[trial]};
  return {review,trial,run};
}
test('late face appearance measures 250ms, not the 4750ms since swipe',()=>{
  const {review,trial,run}=fixture();const result=faceVisibleTiming(trial,run,{'222':review});
  assert.equal(result.pass,true);assert.equal(result.episodes[0].firstSwapAfterFaceUpperMs,284);
});
test('unknown face visibility never turns no swap into failure or exemption',()=>{
  const {trial,run}=fixture({swapAt:null});
  assert.equal(faceVisibleTiming(trial,run).status,'unreviewed');
  assert.equal(reconcileFaceVisibleTiming(run).pass,null);
});
test('known visible face without transformation fails after its own one-second window',()=>{
  const {review,trial,run}=fixture({faceStart:0,swapAt:null});
  assert.equal(faceVisibleTiming(trial,run,{'222':review}).pass,false);
});
test('face appearing just before swipe has insufficient exposure, not false failure',()=>{
  const {review,trial,run}=fixture({swapAt:null});
  const result=faceVisibleTiming(trial,run,{'222':review});
  assert.equal(result.pass,null);assert.equal(result.episodes[0].status,'face-visible-too-briefly-to-score');
});
test('ads, photos, and reviewed no-face video are excluded from swap timing',()=>{
  const {review,trial,run}=fixture();
  for(const key of ['adPost','photoPost'])assert.equal(faceVisibleTiming({...trial,[key]:true},run).status,'excluded');
  review.eligibleFaceRanges=[];
  assert.equal(faceVisibleTiming(trial,run,{'222':review}).reason,'reviewed-no-eligible-face-in-view');
});
test('only original review is ground truth; detection success is not a start clock',()=>{
  const {review}=fixture();assert.equal(validateFaceReview(review),true);
  assert.equal(validateFaceReview({...review,method:'swap-detector'}),false);
  assert.equal(validateFaceReview({...review,evidence:[]}),false);
});
test('a transformed frame from an earlier scene cannot satisfy a later visible face',()=>{
  const {review,trial,run}=fixture({swapTime:1});
  assert.equal(faceVisibleTiming(trial,run,{'222':review}).episodes[0].firstSwapAfterFaceUpperMs,null);
});
test('late-session receipt can validate retained actual paint, not polling time',()=>{
  const {review,trial,run}=fixture();
  run.paintDrains=[{paintEvents:trial.paintEvidence,originalPaintEvents:trial.originalPaintEvidence}];
  trial.paintEvidence=[];trial.originalPaintEvidence=[];
  assert.equal(faceVisibleTiming(trial,run,{'222':review}).episodes[0].firstSwapAfterFaceUpperMs,284);
});
test('outside reviewed media cannot pass from a partially annotated clip',()=>{
  const {review,trial,run}=fixture();review.reviewedRanges=[[0,3.2]];review.eligibleFaceRanges=[[3,3.2]];
  assert.equal(faceVisibleTiming(trial,run,{'222':review}).status,'unreviewed');
});
test('face already visible at activation does not wait for a delayed play callback',()=>{
  const {review,trial,run}=fixture({faceStart:0,swapAt:1700,swapTime:0});
  trial.startedAt=1000;trial.kind='current-video-activation';
  trial.preActivationOriginalPaint={videoId:'222',at:950,mediaTime:0,paused:true};
  const result=faceVisibleTiming(trial,run,{'222':review});
  assert.equal(result.episodes[0].firstSwapAfterFaceUpperMs,700);
  assert.equal(result.episodes[0].clockStartsAt,'swap-activation-face-already-presented');
});
test('stale, future, missing, playing or wrong-video activation receipts cannot erase waiting time',()=>{
 const {review,trial,run}=fixture({faceStart:0,swapAt:2700,swapTime:0});
 trial.startedAt=2000;trial.kind='current-video-activation';
 for(const receipt of [null,{videoId:'222',at:800,paused:true,mediaTime:0},
   {videoId:'222',at:2100,paused:true,mediaTime:0},
   {videoId:'222',at:1900,paused:false,mediaTime:0},
   {videoId:'111',at:1900,paused:true,mediaTime:0}]){
  trial.preActivationOriginalPaint=receipt;
  assert.equal(faceVisibleTiming(trial,run,{'222':review}).reason,'missing-valid-pre-activation-presentation');
 }
});
test('invalid clock interval cannot produce a latency pass',()=>{
 const {review,trial,run}=fixture();run.clockCalibration={minOffset:20,maxOffset:10};
 assert.equal(faceVisibleTiming(trial,run,{'222':review}).status,'unreviewed');
});
