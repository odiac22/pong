import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = html.indexOf(`function ${start}(`);
  const to = html.indexOf(`function ${end}(`, from + 1);
  assert.ok(from >= 0 && to > from, `${start} source bounds`);
  return html.slice(from, to);
};

function fixture(external) {
  const calls = [];
  const video = {
    dataset: {}, preload: 'none', readyState: 0, networkState: 0,
    currentSrc: '', src: '', paused: true, load() { calls.push('load'); },
    closest() { return wrapper; }
  };
  const wrapper = {
    dataset: external
      ? { pongExternalPlaybackAuthority: 'true', networkSuspended: 'true' }
      : {},
    classList: { contains(name) { return name === 'deck-active'; } },
    querySelector() { return video; }
  };
  const context = {
    document: {
      body: { contains() { return true; } },
      querySelectorAll() { return [wrapper]; }
    },
    foregroundPriorityVideo: null,
    DECK_MODE_ENABLED: true,
    VIDEO_FOREGROUND_NO_LOAD_RETRY_MS: 1000,
    VIDEO_FOREGROUND_NO_LOAD_MAX_RETRIES: 3,
    VIDEO_LOAD_RETRY_POLL_MS: 1000,
    visibleBatchRetryToken: 1,
    isPongFaceSwapManagedMedia: () => false,
    getDeckNetworkWarmIndexes: () => new Set([0]),
    getDeckIndex: () => 0,
    pongGenericRecallCaptureActive: () => false,
    pongLocal2FastPlaybackActive: () => false,
    random40ProtectLocal2FastPlayback: () => calls.push('protect'),
    random40PromoteWrapperToServerCache: () => calls.push('promote'),
    restoreDeckVideoNetwork: () => { calls.push('restore'); return false; },
    isPongServerCachedPlaybackActive: () => false,
    refreshForegroundVideoPriority: () => calls.push('refresh'),
    scheduleForegroundNoLoadRetry: () => calls.push('retry'),
    suspendDeckVideoNetwork: () => calls.push('suspend'),
    setTimeout: () => { calls.push('timer'); return 1; },
    Date, Math
  };
  return { video, wrapper, calls, context };
}

test('TikTok descriptor retains foreground identity without generic network work', () => {
  const { video, calls, context } = fixture(true);
  vm.runInNewContext(between('transferForegroundVideoPriority', 'suspendDeckVideoNetwork'), context);
  context.transferForegroundVideoPriority(video);
  assert.equal(context.foregroundPriorityVideo, video);
  assert.equal(video.dataset.foregroundPriority, 'true');
  assert.equal(video.preload, 'none');
  assert.deepEqual(calls, []);
});

test('ordinary Recall foreground still promotes, restores, loads and retries', () => {
  const { video, calls, context } = fixture(false);
  vm.runInNewContext(between('transferForegroundVideoPriority', 'suspendDeckVideoNetwork'), context);
  context.transferForegroundVideoPriority(video);
  assert.equal(video.preload, 'auto');
  assert.deepEqual(calls, ['protect', 'promote', 'restore', 'load', 'refresh', 'retry']);
});

test('preload tuner leaves TikTok descriptors untouched but warms ordinary Recall', () => {
  const external = fixture(true);
  vm.runInNewContext(between('tuneVideoPreloadAround', 'prepareVideoForPlayback'), external.context);
  external.context.tuneVideoPreloadAround(external.wrapper);
  assert.equal(external.video.preload, 'none');
  assert.deepEqual(external.calls, []);

  const recall = fixture(false);
  vm.runInNewContext(between('tuneVideoPreloadAround', 'prepareVideoForPlayback'), recall.context);
  recall.context.tuneVideoPreloadAround(recall.wrapper);
  assert.equal(recall.video.preload, 'auto');
  assert.deepEqual(recall.calls, ['restore', 'load']);
});

test('foreground no-load watchdog is not armed for TikTok descriptors', () => {
  const external = fixture(true);
  vm.runInNewContext(between('scheduleForegroundNoLoadRetry', 'transferForegroundVideoPriority'), external.context);
  external.context.scheduleForegroundNoLoadRetry(external.video);
  assert.deepEqual(external.calls, []);
  assert.equal(external.video.dataset.foregroundLoadWatch, undefined);

  const recall = fixture(false);
  vm.runInNewContext(between('scheduleForegroundNoLoadRetry', 'transferForegroundVideoPriority'), recall.context);
  recall.context.scheduleForegroundNoLoadRetry(recall.video);
  assert.deepEqual(recall.calls, ['timer']);
  assert.ok(recall.video.dataset.foregroundLoadWatch);
});

test('an already scheduled watchdog cannot retry a descriptor that became external', () => {
  const recall = fixture(false);
  let scheduled;
  recall.context.setTimeout = callback => { scheduled = callback; return 1; };
  recall.context.foregroundPriorityVideo = recall.video;
  vm.runInNewContext(between('scheduleForegroundNoLoadRetry', 'transferForegroundVideoPriority'), recall.context);
  recall.context.scheduleForegroundNoLoadRetry(recall.video);
  assert.equal(typeof scheduled, 'function');
  recall.wrapper.dataset.pongExternalPlaybackAuthority = 'true';
  scheduled();
  assert.deepEqual(recall.calls, []);
  assert.equal(recall.video.dataset.foregroundNoLoadRetries, undefined);
});

test('batch retry skips external descriptors even if suspension marker is missing', () => {
  const external = fixture(true);
  delete external.wrapper.dataset.networkSuspended;
  vm.runInNewContext(between('retryVisibleBatchVideoLoads', 'startVisibleBatchAutoRetry'), external.context);
  external.context.retryVisibleBatchVideoLoads(1);
  assert.deepEqual(external.calls, []);
  assert.equal(external.video.dataset.lastLoadKick, undefined);
});
