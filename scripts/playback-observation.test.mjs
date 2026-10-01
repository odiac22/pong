import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPlaybackObservation} from './playback-observation.mjs';
const row = {ended:false,durationSeconds:30,currentTimeSeconds:10.1,
  mediaAdvanceSeconds:10,muted:true,maxProgressGapMs:200,wallMs:11000,
  startupMs:900,presentedFrames:250,presentedMediaAdvanceSeconds:10,
  waitingAfterFirstFrame:0,maxPresentedGapMs:50,playbackWallMs:10020};
test('complete observation passes independently of source end',()=>{
  assert.equal(classifyPlaybackObservation(row,10).passed,true);
});
test('natural 9.64-second end is not a stall or a ten-second pass',()=>{
  const result=classifyPlaybackObservation({...row,ended:true,durationSeconds:9.641667,
    currentTimeSeconds:9.641667,mediaAdvanceSeconds:9.576},10);
  assert.equal(result.completedSource,true);
  assert.equal(result.observationWindowComplete,false);
  assert.equal(result.passed,false);
  assert.match(result.error,/source ended/);
});
test('an ended flag without reaching duration cannot excuse a stalled track',()=>{
  assert.equal(classifyPlaybackObservation({...row,ended:true,currentTimeSeconds:5,mediaAdvanceSeconds:4},10).completedSource,false);
});
test('audible, excessive-gap and slow tracks fail even with enough media advancement',()=>{
  for(const change of [{muted:false},{maxPresentedGapMs:251},{playbackWallMs:10501},
    {startupMs:1500},{startupMs:null},{waitingAfterFirstFrame:1},
    {presentedFrames:0},{presentedMediaAdvanceSeconds:9.8}])
    assert.equal(classifyPlaybackObservation({...row,...change},10).passed,false);
});
test('legacy clock-only observations cannot claim a presentation pass',()=>{
  const legacy={ended:false,durationSeconds:30,currentTimeSeconds:10.1,
    mediaAdvanceSeconds:10,muted:true,maxProgressGapMs:100,wallMs:10500};
  assert.equal(classifyPlaybackObservation(legacy,10).passed,false);
});
