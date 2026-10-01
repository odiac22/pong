import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeVisibleFrameSeries} from './lib/visible-frame-series-summary.mjs';
test('offscreen work is distinct from UI and source frames',()=>{
  const value=summarizeVisibleFrameSeries({totalMs:1000,records:[
    {transformed:false,totalMs:200,nativeBinaryRoundtripMs:150},
    {transformed:true,totalMs:300,nativeBinaryRoundtripMs:250}],
    rafIntervalsMs:[10,10,10,10],decodedFrames:30,droppedFrames:1});
  assert.equal(value.completedOffscreenFramesPerSecond,2);
  assert.equal(value.transformedOffscreenFramesPerSecond,1);
  assert.equal(value.sampledUiRafPerSecond,100);
  assert.equal(value.firstTransformedMs,500);
  assert.equal(value.visibleBenchmarkQualified,false);
});
test('empty and failed measurements do not report FPS or a pass',()=>{
  const value=summarizeVisibleFrameSeries({ok:false,totalMs:0,records:[]});
  assert.equal(value.firstTransformedMs,null);
  assert.equal(value.completedOffscreenFramesPerSecond,null);
  assert.equal(value.sampledUiRafPerSecond,null);
  assert.equal(value.visibleBenchmarkQualified,false);
});
