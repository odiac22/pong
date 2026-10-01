import test from 'node:test';
import assert from 'node:assert/strict';
import {paintedCadence, trialPaintedCadence, reconcileRunCadence} from './lib/tiktok-painted-cadence.mjs';
const frames = (step = 100 / 3) => Array.from({length: Math.floor(3000 / step) + 1},
  (_, i) => ({at: i * step, mediaTime: i * step / 1000, session: 's'}));
test('steady 30 cadence counts unique media times, not metadata', () => {
  // Integer millisecond times model the ordinary 33/33/34 cadence exactly.
  const result = paintedCadence(frames().map(e => ({...e, at: Math.round(e.at)})), {startMs: 0, endMs: 3000});
  assert.equal(result.minimumRollingOneSecondFrames, 30);
  assert.equal(result.floorMet, true);
});
test('duplicate callbacks do not raise a 15 FPS source to 30', () => {
  const source = frames(200 / 3);
  const result = paintedCadence(source.flatMap(e => [e, {...e, at: e.at + 1}]), {startMs: 0, endMs: 3000});
  assert.equal(result.floorMet, false);
  assert.ok(result.minimumRollingOneSecondFrames <= 15);
});
test('one short freeze fails despite the high overall average', () => {
  const source = frames(1000 / 60).filter(e => e.at < 1200 || e.at > 1900);
  const result = paintedCadence(source, {startMs: 0, endMs: 3000});
  assert.equal(result.floorMet, false);
  assert.ok(result.maxPresentationGapMs > 700);
});
test('trailing freeze cannot disappear with the last callback', () => {
  const result = paintedCadence(frames().filter(e => e.at <= 1800), {startMs: 0, endMs: 3000});
  assert.equal(result.minimumRollingOneSecondFrames, 0);
  assert.ok(result.maxPresentationGapMs >= 1200);
});
test('short evidence never qualifies, and zero presentations fail', () => {
  assert.equal(paintedCadence([], {startMs: 0, endMs: 3000}).floorMet, false);
  assert.equal(paintedCadence(frames(), {startMs: 0, endMs: 500}).minimumRollingOneSecondFrames, null);
  assert.equal(trialPaintedCadence({firstPaintUpperMs: null}, {}, 4000).floorMet, false);
});
test('only the owning session and transformed frame range count', () => {
  const trial = {firstPaintUpperMs: 0, startedAt: 0,
    samples: [{pong: {session: 's', videoId: 'v'}, renderer: {id: 's', fps: 30, transformedFrameRanges: [[0, 90]]}}],
    paintEvidence: frames().map(e => ({...e, at: Math.round(e.at), videoId: 'v'}))};
  assert.equal(trialPaintedCadence(trial, {maxOffset: 0}, 3000).floorMet, true);
  trial.paintEvidence.forEach(e => {e.session = 'old';});
  assert.equal(trialPaintedCadence(trial, {maxOffset: 0}, 3000).floorMet, false);
});

function drainedRun({missing = false, lastDrain = 3500, stall = false} = {}) {
  const events = frames().map(e => ({...e, at: Math.round(e.at), videoId: 'v'}))
    .filter(e => !stall || e.at <= 1800);
  const sample = {pong:{session:'s',videoId:'v'},view:{postKey:'video:v'},
    renderer:{id:'s',fps:30,transformedFrameRanges:[[0,90]]}};
  const paintDrains = Array.from({length:1 + lastDrain / 500}, (_, i) => ({
    at: i * 500, observerCost:{snapshots:i + 1},
    paintEvents: events.filter(e => e.at > (i - 1) * 500 && e.at <= i * 500)}))
    .filter(d => !missing || d.at !== 2000);
  return {holdMs:3000,clockCalibration:{minOffset:0,maxOffset:0},paintDrains,
    trials:[{index:1,startedAt:0,firstPaintUpperMs:0,observedDwellMs:3000,
      beforeVideoId:'previous',samples:[sample],paintEvidence:events.filter(e => e.at <= 2500)}]};
}
test('next polling interval recovers the prior video tail without fake stalls', () => {
  const run=drainedRun();
  assert.equal(trialPaintedCadence(run.trials[0],run.clockCalibration,3000).floorMet,false);
  const corrected=reconcileRunCadence(run)[0];
  assert.equal(corrected.collectionComplete,true);
  assert.equal(corrected.floorMet,true);
});
test('dropped drain or undrained final tail is incomplete, not a playback verdict', () => {
  for (const options of [{missing:true},{lastDrain:2500}]) {
    const result=reconcileRunCadence(drainedRun(options))[0];
    assert.equal(result.collectionComplete,false);
    assert.equal(result.floorMet,false);
    assert.match(result.reason,/incomplete-event-collection/);
  }
});
test('reconciliation still fails a genuine fully observed trailing freeze', () => {
  const result=reconcileRunCadence(drainedRun({stall:true}))[0];
  assert.equal(result.collectionComplete,true);
  assert.equal(result.floorMet,false);
  assert.equal(result.minimumRollingOneSecondFrames,0);
});
test('global ledger cannot count a different video or an untransformed frame', () => {
  const run=drainedRun();
  for(const d of run.paintDrains)for(const e of d.paintEvents)e.videoId='other';
  assert.equal(reconcileRunCadence(run)[0].uniqueFrames,0);
  const second=drainedRun();
  second.trials[0].samples[0].renderer.transformedFrameRanges=[];
  assert.equal(reconcileRunCadence(second)[0].uniqueFrames,0);
});
