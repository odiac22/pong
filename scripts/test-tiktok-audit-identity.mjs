import test from 'node:test';
import assert from 'node:assert/strict';
import {incomingVideoForTrial,firstQualifiedPaint,firstOriginalPaint,auditPostReady,countedVideoVisit,countDistinctVideoVisit,navigationAndTimingSatisfied,sameTrialVisualEvidence,confirmedPhotoPost} from './lib/tiktok-audit-identity.mjs';

test('a repeated video never inflates the distinct-video benchmark corpus',()=>{
 const seen=new Set(),trial={advanced:true,beforeVideoId:'111'};
 assert.equal(countDistinctVideoVisit(trial,{postKey:'video:222'},{videoId:'222'},seen),true);
 assert.equal(countDistinctVideoVisit(trial,{postKey:'video:222'},{videoId:'222'},seen),false);
 assert.equal(countDistinctVideoVisit({...trial,photoPost:true},{postKey:'photo:333'},{videoId:'333'},seen),false);
 assert.equal(countDistinctVideoVisit(trial,{postKey:'video:444'},{videoId:'555'},seen),false);
 assert.equal(countDistinctVideoVisit(trial,{postKey:'video:666'},{videoId:'666'},seen),true);
 assert.equal(countDistinctVideoVisit({advanced:false},undefined,undefined,seen),false);
 assert.deepEqual([...seen],['222','666']);
});

test('confirmed ads and photos must navigate but never count toward the 40 videos',()=>{
 for(const kind of ['adPost','photoPost']){
  const t={advanced:true,navigationAdvanced:true,[kind]:true,underOneSecond:false};
  assert.equal(countedVideoVisit(t),false);assert.equal(navigationAndTimingSatisfied(t),true);
  assert.equal(navigationAndTimingSatisfied({...t,navigationAdvanced:false}),false);
 }
 const failed={advanced:true,navigationAdvanced:true,photoPost:false,adPost:false,underOneSecond:false};
 assert.equal(countedVideoVisit(failed),true);assert.equal(navigationAndTimingSatisfied(failed),false);
 assert.equal(navigationAndTimingSatisfied({...failed,underOneSecond:true}),false,'legacy swipe timing is not face timing');
 assert.equal(navigationAndTimingSatisfied({...failed,faceTiming:{pass:true}}),true);
 assert.equal(navigationAndTimingSatisfied({...failed,faceTiming:{status:'unreviewed'}}),false);
});

test('a visible photo can start navigation testing without claiming a video played',()=>{
 assert.equal(auditPostReady({postKind:'photo',postKey:'photo:1234567890123456789'}),true);
 assert.equal(auditPostReady({postKind:'photo',postKey:''}),false);
 assert.equal(auditPostReady({postKind:'photo',postKey:'photo:abcd'}),false);
 assert.equal(auditPostReady({original:{ready:1,paused:false}}),false);
 assert.equal(auditPostReady({original:{ready:4,paused:false}}),true);
 assert.equal(auditPostReady({challenge:true,postKind:'photo',postKey:'photo:1234567890123456789'}),false);
 assert.equal(confirmedPhotoPost({postKind:'photo',postKey:'photo:1234567890123456789'}),true);
 assert.equal(confirmedPhotoPost({postKind:'photo',postKey:'photo:abcd'}),false);
 assert.equal(confirmedPhotoPost({postKind:'video',postKey:'video:222',path:'/@fixture/photo/111'}),false);
 assert.equal(confirmedPhotoPost({postKind:'unknown',postKey:'',path:'/@fixture/photo/111'}),false);
});
test('a lagging Pong receipt cannot give the next swipe credit for the outgoing post',()=>{
 const trial={beforeVideoId:'111',beforePostKey:'video:222',beforePath:'/@fixture/video/222'};
 assert.equal(incomingVideoForTrial(trial,{postKey:'video:222'},{videoId:'222'}),false);
 assert.equal(incomingVideoForTrial(trial,{postKey:'video:333'},{videoId:'333'}),true);
});
test('route-ahead transition is already in flight before the next gesture',()=>{
 const trial={beforeVideoId:'111',beforePostKey:'video:111',beforePath:'/@fixture/video/222'};
 assert.equal(incomingVideoForTrial(trial,{postKey:'video:222'},{videoId:'222'}),false);
});
test('physical page and Pong receipt must agree; photo posts are not video swaps',()=>{
 const trial={beforeVideoId:'111',beforePostKey:'video:111'};
 assert.equal(incomingVideoForTrial(trial,{postKey:'video:222'},{videoId:'111'}),false);
 assert.equal(incomingVideoForTrial(trial,{postKey:'photo:222'},{videoId:'222'}),false);
});
test('native screenshot identity must be the incoming video throughout its bounded capture',()=>{
 const trial={beforeVideoId:'111',beforePostKey:'video:111',beforePath:'/@fixture/video/111'};
 const view={postKind:'video',postKey:'video:222'},pong={videoId:'222'};
 assert.equal(sameTrialVisualEvidence(trial,view,pong,'video:222',2000,2300,4000),true);
 assert.equal(sameTrialVisualEvidence(trial,view,pong,'video:111',2000,2300,4000),false);
 assert.equal(sameTrialVisualEvidence(trial,view,{videoId:'111'},'video:222',2000,2300,4000),false);
 assert.equal(sameTrialVisualEvidence(trial,{...view,postKind:'photo'},pong,'video:222',2000,2300,4000),false);
 assert.equal(sameTrialVisualEvidence(trial,view,pong,'video:222',2000,4000,4000),false);
 assert.equal(sameTrialVisualEvidence(trial,view,pong,'video:222',2300,2000,4000),false);
});
test('a delayed receipt validates retained paint time, never the polling time',()=>{
 const trial={beforeVideoId:'111',beforePostKey:'video:111',startedAt:1000,
  paintEvidence:[{session:'b',videoId:'222',mediaTime:.2,at:1600}]};
 const view={postKey:'video:222'},backend={id:'b',fps:30,transformedFrameRanges:[[0,20]]};
 const clock={minOffset:0,maxOffset:5};
 assert.equal(firstQualifiedPaint(trial,view,{videoId:'111',session:'a'},backend,clock,4000),null);
 assert.deepEqual(firstQualifiedPaint(trial,view,{videoId:'222',session:'b'},backend,clock,4000),{minMs:600,maxMs:605});
 trial.beforePostKey='video:222';
 assert.equal(firstQualifiedPaint(trial,view,{videoId:'222',session:'b'},backend,clock,4000),null);
});
test('frame evidence excludes unswapped frames and times outside the exact visit',()=>{
 const trial={beforeVideoId:'111',startedAt:1000,paintEvidence:[{session:'b',videoId:'222',mediaTime:.2,at:5000}]};
 const view={postKey:'video:222'},pong={videoId:'222',session:'b'},backend={id:'b',fps:30,transformedFrameRanges:[[0,20]]},clock={minOffset:0,maxOffset:0};
 assert.equal(firstQualifiedPaint(trial,view,pong,backend,clock,4000),null);
 trial.paintEvidence[0].at=999;assert.equal(firstQualifiedPaint(trial,view,pong,backend,clock,4000),null);
 trial.paintEvidence[0].at=1500;backend.transformedFrameRanges=[[10,20]];
 assert.equal(firstQualifiedPaint(trial,view,pong,backend,clock,4000),null);
});
test('original paint timing does not inherit delayed Pong receipt or outgoing/photo frames',()=>{
 const trial={beforeVideoId:'111',beforePostKey:'video:111',startedAt:1000,
  originalPaintEvidence:[{videoId:'111',at:1100},{videoId:'222',at:1450},{videoId:'222',at:5000}]};
 const clock={minOffset:1,maxOffset:3};
 assert.deepEqual(firstOriginalPaint(trial,{postKey:'video:222'},clock,4000),{minMs:451,maxMs:453});
 assert.equal(firstOriginalPaint(trial,{postKey:'photo:abcd'},clock,4000),null);
 trial.beforePath='/@fixture/video/222';
 assert.equal(firstOriginalPaint(trial,{postKey:'video:222'},clock,4000),null);
});
test('a paused poster receipt is not evidence that incoming playback started',()=>{
 const trial={beforeVideoId:'111',startedAt:1000,originalPaintEvidence:[
  {videoId:'222',at:1100,paused:true},{videoId:'222',at:1400,paused:false}]};
 assert.deepEqual(firstOriginalPaint(trial,{postKey:'video:222'},
  {minOffset:0,maxOffset:0},4000),{minMs:400,maxMs:400});
});
