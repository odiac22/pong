import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}
const context = vm.createContext({
  VIDEO_ACTIVE_NETWORK_PROGRESS_TIMEOUT_MS: 5000,
  VIDEO_NETWORK_PROGRESS_TIMEOUT_MS: 5000,
  pongCanonicalMediaUrlForWrapper: () => '',
  random40IsPcGrowingCachePlaybackUrl: () => false,
});
vm.runInContext(source('videoNetworkRequestIsMakingProgress'), context);
const wrapper = { dataset: { autoRetryCount: '12' }, classList: { contains: () => true } };
const video = { networkState: 2, readyState: 0, currentSrc: 'http://localhost/proxy?url=redacted', dataset: { lastNetworkAttemptAt: '100000' } };
const progress = context.videoNetworkRequestIsMakingProgress;
assert.equal(progress(video, wrapper, 108000), true, 'retry gets metadata grace');
assert.equal(progress(video, wrapper, 120000), true, 'large metadata survives the former 15-second cancellation');
assert.equal(progress(video, wrapper, 145001), false, 'dead request expires');
for (const route of ['video-cache/stream?url=redacted', 'video-cache/media/cache-id']) {
  video.currentSrc = `http://localhost/${route}`;
  assert.equal(progress(video, wrapper, 120000), true, 'cache metadata gets the same bounded grace');
  assert.equal(progress(video, wrapper, 145001), false, 'cache grace still expires');
}
video.networkState = 1;
assert.equal(progress(video, wrapper, 108000), false, 'idle request has no grace');
video.networkState = 2;
video.readyState = 1;
assert.equal(progress(video, wrapper, 108000), false, 'metadata grace ends after metadata');
video.dataset.lastNetworkProgressAt = '107000';
assert.equal(progress(video, wrapper, 108000), true, 'real progress preserved');
const watchdog = source('scheduleForegroundNoLoadRetry');
assert.ok(watchdog.indexOf('videoNetworkRequestIsMakingProgress(video, wrapper)') < watchdog.indexOf('rotateVideoRetrySource(wrapper, video)'), 'watchdog checks progress before replacing source');
new vm.Script(watchdog);
const stall = source('scheduleForegroundPlaybackStallRecovery');
let scheduled = null, startupWatch = 0, rotations = 0;
const testVideo = { currentTime: 0, readyState: 0, paused: true, dataset: {} };
const testWrapper = { classList: { contains: () => true }, dataset: { playIntent: 'true' } };
testVideo.closest = () => testWrapper;
const stallContext = vm.createContext({
  document: { body: { contains: () => true } },
  isPongFaceSwapManagedMedia: () => false,
  foregroundPriorityVideo: testVideo,
  getVideoBufferedAheadSeconds: () => 0,
  setTimeout: callback => { scheduled = callback; },
  pongLocal22TurboPlaybackActive: () => true,
  scheduleForegroundNoLoadRetry: () => { startupWatch++; },
  rotateVideoRetrySource: () => { rotations++; },
});
vm.runInContext(stall, stallContext);
stallContext.scheduleForegroundPlaybackStallRecovery(testVideo);
scheduled();
assert.equal(startupWatch, 1, 'metadata startup delegates to one watchdog');
assert.equal(rotations, 0, 'stall watchdog cannot cancel metadata acquisition');
assert.equal(testVideo.dataset.foregroundStallRetries, undefined);
console.log('PASS: foreground progress-lease regressions');
