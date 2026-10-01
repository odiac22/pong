import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackFpsMetrics, summarizePlaybackFps} from './playback-fps-metrics.mjs';
const sample = () => ({clip: 1, fullPlaybackCompleted: true, rebufferCount: 0, bufferedWaitSeconds: 0,
  finalSession: {complete: true, frames: 240, transformedFrames: 200, fps: 24, sourceFps: 24, timingTotals: {frameWorkSeconds: 6}},
  frames: [{t: 0, presentedFrames: 1}, {t: 1000, presentedFrames: 25}, {t: 2000, presentedFrames: 49}]});
test('never mistakes 40 FPS capacity for 24 FPS presentation or counts callbacks as frames', () => {
  const result = playbackFpsMetrics(sample());
  assert.equal(result.renderWorkFps, 40);
  assert.equal(result.browserPresentedFps, 24);
  assert.equal(result.browserCallbackFps, 1);
  assert.equal(result.transformedFrames, 200);
  assert.equal(result.zeroBuffering, true);
});
test('an incomplete or missing measurement is not a passing clip', () => {
  for (const patch of [{fullPlaybackCompleted: false}, {error: 'failed'}, {finalSession: {}}]) {
    const result = playbackFpsMetrics({...sample(), ...patch});
    assert.equal(result.renderWorkAtLeast34, false);
    assert.equal(result.zeroBuffering, false);
  }
});
test('median never hides a slow or buffering clip', () => {
  const slow = sample(); slow.finalSession.timingTotals.frameWorkSeconds = 10;
  slow.rebufferCount = 1; slow.bufferedWaitSeconds = .1;
  const result = summarizePlaybackFps({completed: true, clips: [sample(), sample(), slow]});
  assert.equal(result.medianRenderWorkFps, 40);
  assert.equal(result.medianRenderWorkAtLeast40, true);
  assert.equal(result.targetMinimumRenderWorkFps, 34);
  assert.equal(result.targetMedianRenderWorkFps, 40);
  assert.equal(result.minimumRenderWorkFps, 24);
  assert.equal(result.allRenderWorkAtLeast34, false);
  assert.equal(result.allZeroBuffering, false);
});
test('an interrupted report cannot pass from a completed subset', () => {
  const result = summarizePlaybackFps({completed: false, clips: [sample()]});
  assert.equal(result.allComplete, false);
  assert.equal(result.medianRenderWorkAtLeast40, false);
  assert.equal(result.allRenderWorkAtLeast34, false);
  assert.equal(result.allZeroBuffering, false);
});
test('an empty stream is not buffer-free successful playback', () => {
  const row = sample(); row.finalSession.frames = 0;
  assert.equal(playbackFpsMetrics(row).zeroBuffering, false);
});
