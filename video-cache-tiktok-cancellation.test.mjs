import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { normalizeTikTokMediaHint } from './tiktok-media-hints.mjs';
import { genericCacheRequestMayRetry } from './video-cache-startup-policy.mjs';

const source = readFileSync(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
function extract(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing source function ${start}`);
  return source.slice(first, last);
}
const functions = [
  extract('function isTikTokVideoPageUrl(', 'async function downloadTikTokVideoFile('),
  extract('function videoFileCacheRecordHasPlayableFallback(', 'function videoFileCacheRecordJson('),
  extract('function tikTokVideoFileCacheHintIdentity(', 'const VIDEO_FILE_CACHE_GENERIC_SEGMENT_MAX_ACTIVE'),
  extract('async function waitForVideoFileCacheMetadata(', 'async function writeVideoFileCacheChunk('),
  extract('function videoFileCacheTailRangeEligible(', 'async function tryOpenVideoFileCacheTailRange('),
  extract('async function tryOpenVideoFileCacheTailRange(', 'async function streamVideoFileCacheTailRange('),
  extract('async function serveVideoFileCacheMedia(', 'function videoFileCacheEndpointFromRequest(')
].join('\n');

function harness(overrides = {}) {
  const records = new Map();
  const queue = [];
  const events = [];
  const sandbox = {
    URL, Date, Number, String, Math, Error, Promise, setTimeout, genericCacheRequestMayRetry,
    videoFileCacheHealthy: true, videoFileCacheResetPromise: null,
    videoFileCacheGeneration: 1, videoFileCacheRecords: records,
    videoFileCacheQueue: queue, VIDEO_FILE_CACHE_READ_WAIT_MS: 80,
    VIDEO_FILE_CACHE_MAX_FILE_BYTES: 100, VIDEO_FILE_CACHE_ACTIVE_HOLD_MS: 5000,
    VIDEO_FILE_CACHE_TAIL_RANGE_ENABLED: true,
    VIDEO_FILE_CACHE_TAIL_RANGE_BYTES: 80,
    VIDEO_FILE_CACHE_LOCAL22_TAIL_RANGE_BYTES: 80,
    VIDEO_FILE_CACHE_TAIL_RANGE_MIN_GAP_BYTES: 10,
    videoFileCacheAvailableFile: async () => ({ size: 0 }),
    enqueueVideoFileCacheRecord: record => { events.push('enqueue'); record.status = 'queued'; queue.push(record); },
    pumpVideoFileCache: () => { events.push('pump'); },
    registerVideoFileCacheReader: () => ({ finish() {} }),
    promoteVideoFileCachePlaybackRecord: record => { record.playbackLease = true; },
    touchVideoFileCacheHeartbeat() {}, protectVideoFileCacheForegroundPlayback() {},
    currentVideoFileCachePriority: () => 0, rebalanceVideoFileCacheDownloads() {},
    videoFileCacheRecordHasPlayableFallback: undefined,
    videoFileCacheHeaders: extra => extra,
    json: (res, status, body) => { res.status = status; res.body = body; res.writableEnded = true; },
    streamGatewayResponse: async (_req, res) => { events.push('gateway'); res.writableEnded = true; },
    tryStreamParallelBunkrRange: async () => false,
    ...overrides
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${functions}\n globalThis.api = {
    isTikTokVideoPageUrl, videoFileCacheRecordHasPlayableFallback,
    tikTokVideoFileCacheHintIdentity, enqueueRequestedVideoFileCacheRecord,
    waitForVideoFileCacheMetadata, videoFileCacheTailRangeEligible,
    tryOpenVideoFileCacheTailRange,
    serveVideoFileCacheMedia
  };`, context);
  return { context, records, queue, events, api: context.api };
}
function response() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  return res;
}
const tikTok = 'https://www.tiktok.com/@fixture/video/1234567890123456789';
const mp4 = 'https://cdn.example.org/movie.mp4';

function retryHarness() {
  const records = new Map();
  const queue = [];
  const context = vm.createContext({
    URL, Date, Number, String, Math, JSON, genericCacheRequestMayRetry,
    videoFileCacheHealthy: true, videoFileCacheResetPromise: null,
    videoFileCacheRecords: records, videoFileCacheQueue: queue,
    videoFileCacheGeneration: 1, videoFileCacheOrder: 0,
    videoFileCachePriorityEpoch: 1,
    VIDEO_FILE_CACHE_ACTIVE_HOLD_MS: 5000,
    VIDEO_FILE_CACHE_ENTRY_HOLD_MS: 5000,
    VIDEO_FILE_CACHE_CURRENT_HOLD_MS: 5000,
    VIDEO_FILE_CACHE_TIKTOK_FAILURE_COOLDOWN_MS: 30000,
    videoFileCacheCanonical: raw => ({ id: new URL(raw).pathname, targetUrl: raw }),
    currentVideoFileCachePriority: record => record.priority ?? 2,
    normalizeTikTokMediaHint
  });
  vm.runInContext([
    extract('function isTikTokVideoPageUrl(', 'async function downloadTikTokVideoFile('),
    extract('function enqueueVideoFileCacheRecord(', 'function trimVideoFileCacheQueue('),
    extract('function tikTokVideoFileCacheHintIdentity(', 'const VIDEO_FILE_CACHE_GENERIC_SEGMENT_MAX_ACTIVE'),
    extract('function queueVideoFileCacheUrl(', 'function beginVideoFileCachePriorityEpoch('),
    'globalThis.retryApi = { queueVideoFileCacheUrl, enqueueRequestedVideoFileCacheRecord };'
  ].join('\n'), context);
  return { records, queue, api: context.retryApi };
}

test('unchanged TikTok warms preserve backoff and exhausted cooldown; TTL permits one restart', () => {
  const h = retryHarness();
  const record = h.api.queueVideoFileCacheUrl(tikTok, 1, { playbackProfile: 'tiktok' });
  h.queue.length = 0;
  record.status = 'error';
  record.retries = 1;
  record.retryNotBefore = Date.now() + 1000;
  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok' });
  assert.equal(record.status, 'error');
  assert.equal(record.retries, 1);
  assert.equal(h.queue.length, 0);

  record.retries = 2;
  record.retryNotBefore = Date.now() + 30000;
  for (let i = 0; i < 5; i++) h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok' });
  assert.equal(record.status, 'error');
  assert.equal(record.retries, 2);
  assert.equal(h.queue.length, 0);

  record.retryNotBefore = Date.now() - 1;
  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok' });
  assert.equal(record.status, 'queued');
  assert.equal(record.retries, 0);
  assert.equal(h.queue.length, 1);
  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok' });
  assert.equal(h.queue.length, 1);
});

test('only a changed validated TikTok hint overrides cooldown; a new watch ID gets its own record', () => {
  const h = retryHarness();
  const firstHint = { videoId: '1234567890123456789', urls: ['https://v1.tiktokcdn.com/video/first'],
    width: 1280, height: 720, size: 10000, codec: 'h264', receivedAt: 1 };
  const record = h.api.queueVideoFileCacheUrl(tikTok, 1,
    { playbackProfile: 'tiktok', tiktokMediaHint: firstHint });
  h.queue.length = 0;
  record.status = 'error';
  record.retries = 2;
  record.retryNotBefore = Date.now() + 30000;
  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok',
    tiktokMediaHint: { ...firstHint, receivedAt: 2 } });
  assert.equal(record.status, 'error');
  assert.equal(h.queue.length, 0);

  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok',
    tiktokMediaHint: { ...firstHint, urls: [`${firstHint.urls[0]}?token=rotated`] } });
  assert.equal(record.status, 'error');
  assert.equal(h.queue.length, 0);

  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok',
    tiktokMediaHint: { ...firstHint, videoId: '9999999999999999999' } });
  assert.equal(record.status, 'error');
  assert.equal(h.queue.length, 0);

  const secondHint = { ...firstHint, urls: ['https://v2.tiktokcdn.com/video/second'] };
  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok', tiktokMediaHint: secondHint });
  assert.equal(record.status, 'queued');
  assert.equal(record.retries, 0);
  assert.equal(h.queue.length, 1);
  h.queue.length = 0;
  Object.assign(record, { status: 'error', retries: 2, retryNotBefore: Date.now() + 30000 });
  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok',
    tiktokMediaHint: { ...secondHint, urls: ['https://v3.tiktokcdn.com/video/third'] } });
  assert.equal(record.status, 'error');
  assert.equal(h.queue.length, 0);
  const other = h.api.queueVideoFileCacheUrl(
    'https://www.tiktok.com/@fixture/video/9999999999999999999', 1,
    { playbackProfile: 'tiktok' });
  assert.notEqual(other, record);
});

test('failed published TikTok prefix cannot be retried into a live reader', () => {
  const h = retryHarness();
  const record = h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok' });
  h.queue.length = 0;
  Object.assign(record, { status: 'error', retries: 2, retryNotBefore: 0,
    segmentedPrefixFailed: true, activeReaders: 1 });
  h.api.queueVideoFileCacheUrl(tikTok, 0, { playbackProfile: 'tiktok' });
  assert.equal(record.status, 'error');
  assert.equal(h.queue.length, 0);
});

test('direct MP4 exhausted retries cool down across repeated foreground requests', () => {
  const h = retryHarness();
  const record = h.api.queueVideoFileCacheUrl(mp4, 1);
  h.queue.length = 0;
  Object.assign(record, { status: 'error', retries: 2, retryNotBefore: Date.now() + 30000 });
  h.api.queueVideoFileCacheUrl(mp4, 0);
  assert.equal(record.status, 'error');
  assert.equal(record.retries, 2);
  assert.equal(h.queue.length, 0);
  record.retryNotBefore = Date.now() - 1;
  h.api.queueVideoFileCacheUrl(mp4, 0);
  assert.equal(record.status, 'queued');
  assert.equal(record.retries, 0);
  assert.equal(h.queue.length, 1);
});

test('idle foreground metadata reader requeues and pumps immediately', async () => {
  const h = harness();
  const record = { id: 'one', status: 'idle', totalBytes: 0, downloadPromise: null,
    deferWhenIdle: true, activeReaders: 1 };
  h.records.set(record.id, record);
  h.context.pumpVideoFileCache = () => { h.events.push('pump'); record.totalBytes = 64; };
  const size = await h.api.waitForVideoFileCacheMetadata(record, 1, response());
  assert.equal(size, 64);
  assert.deepEqual(h.events, ['enqueue', 'pump']);
  assert.equal(record.deferWhenIdle, false);
});

test('aborted writer cannot leak stale length before cleanup and retry', async () => {
  const h = harness();
  const record = { id: 'one', status: 'downloading', totalBytes: 999,
    controller: { signal: { aborted: true } }, downloadPromise: Promise.resolve(),
    deferWhenIdle: true, activeReaders: 1 };
  h.records.set(record.id, record);
  h.context.pumpVideoFileCache = () => { h.events.push('pump'); record.totalBytes = 72; };
  setTimeout(() => { record.status = 'idle'; record.totalBytes = 0; record.downloadPromise = null; }, 10);
  assert.equal(await h.api.waitForVideoFileCacheMetadata(record, 1, response()), 72);
  assert.deepEqual(h.events, ['enqueue', 'pump']);
});

test('metadata wait stops on closed reader, changed generation, or terminal error', async () => {
  const closed = harness();
  const r1 = { id: 'closed', status: 'downloading', totalBytes: 0,
    downloadPromise: Promise.resolve(), activeReaders: 1 };
  closed.records.set(r1.id, r1);
  const res = response();
  setTimeout(() => { res.destroyed = true; }, 10);
  await assert.rejects(closed.api.waitForVideoFileCacheMetadata(r1, 1, res), /reader closed/);

  const reset = harness();
  const r2 = { id: 'reset', status: 'downloading', totalBytes: 0,
    downloadPromise: Promise.resolve(), activeReaders: 1 };
  reset.records.set(r2.id, r2);
  setTimeout(() => { reset.context.videoFileCacheGeneration = 2; }, 10);
  await assert.rejects(reset.api.waitForVideoFileCacheMetadata(r2, 1, response()), /reset/);

  const replaced = harness();
  const oldRecord = { id: 'replaced', status: 'downloading', totalBytes: 0,
    downloadPromise: Promise.resolve(), activeReaders: 1 };
  replaced.records.set(oldRecord.id, oldRecord);
  setTimeout(() => { replaced.records.set(oldRecord.id, { ...oldRecord }); }, 10);
  await assert.rejects(replaced.api.waitForVideoFileCacheMetadata(oldRecord, 1, response()), /reset/);

  const failed = harness();
  const r3 = { id: 'failed', status: 'error', totalBytes: 0,
    error: 'origin failed https://signed.example/video?token=SECRET',
    downloadPromise: null, activeReaders: 1 };
  failed.records.set(r3.id, r3);
  await assert.rejects(failed.api.waitForVideoFileCacheMetadata(r3, 1, response()), error => {
    assert.equal(error.message, 'video cache download failed');
    return true;
  });

  const timed = harness({ VIDEO_FILE_CACHE_READ_WAIT_MS: 5 });
  const r4 = { id: 'timed', status: 'downloading', totalBytes: 0,
    downloadPromise: Promise.resolve(), activeReaders: 1 };
  timed.records.set(r4.id, r4);
  await assert.rejects(timed.api.waitForVideoFileCacheMetadata(r4, 1, response()), /timed out/);
});

test('idle retry requires a registered foreground reader', async () => {
  const h = harness();
  const record = { id: 'one', status: 'idle', totalBytes: 0, downloadPromise: null,
    activeReaders: 0 };
  h.records.set(record.id, record);
  await assert.rejects(h.api.waitForVideoFileCacheMetadata(record, 1, response()), /reader closed/);
  assert.deepEqual(h.events, []);
});

test('ready-file size is rejected if the cache generation changes during stat', async () => {
  const h = harness();
  const record = { id: 'one', status: 'ready', totalBytes: 0, activeReaders: 1 };
  h.records.set(record.id, record);
  h.context.videoFileCacheAvailableFile = async () => {
    h.context.videoFileCacheGeneration = 2;
    return { size: 90 };
  };
  await assert.rejects(h.api.waitForVideoFileCacheMetadata(record, 1, response()), /reset/);
});

test('TikTok watch pages have no gateway or tail-range fallback; MP4 retains both', async () => {
  const h = harness();
  assert.equal(h.api.videoFileCacheRecordHasPlayableFallback({ sourceUrl: tikTok, status: 'error', bytes: 0 }), false);
  assert.equal(h.api.videoFileCacheRecordHasPlayableFallback({ sourceUrl: tikTok, status: 'error', bytes: 200 }), false);
  assert.equal(h.api.videoFileCacheRecordHasPlayableFallback({ sourceUrl: mp4, status: 'error', bytes: 0 }), true);
  const range = { status: 206, start: 950, end: 999 };
  const ready = { status: 'downloading', downloadPromise: Promise.resolve(), playbackProfile: 'tiktok' };
  assert.equal(h.api.videoFileCacheTailRangeEligible({ ...ready, sourceUrl: tikTok }, range, 1000, 100), false);
  assert.equal(h.api.videoFileCacheTailRangeEligible({ ...ready, sourceUrl: mp4 }, range, 1000, 100), true);
  assert.equal(await h.api.tryOpenVideoFileCacheTailRange({}, response(), { sourceUrl: tikTok }, 950, 999, 1000), null);
});

test('failed TikTok stays explicit while failed MP4 keeps direct gateway recovery', async () => {
  for (const [sourceUrl, expectedGateway] of [[tikTok, false], [mp4, true]]) {
    const h = harness();
    const record = { id: 'ab12', sourceUrl, status: 'error', bytes: 0, totalBytes: 0,
      activeReaders: 0, playbackProfile: 'tiktok', retries: 2,
      retryNotBefore: Date.now() + 30000 };
    h.records.set(record.id, record);
    const res = response();
    await h.api.serveVideoFileCacheMedia({ headers: {} }, res, record.id);
    assert.equal(h.events.includes('gateway'), expectedGateway);
    if (!expectedGateway) assert.equal(res.status, 502);
    assert.equal(record.playbackLease, false);
    assert.equal(record.activeReaders, 0);
  }
});

test('a media reader may restart exhausted TikTok only after cooldown', async () => {
  const h = harness();
  const record = { id: 'ab12', sourceUrl: tikTok, status: 'error', bytes: 0,
    totalBytes: 0, activeReaders: 0, retries: 2,
    retryNotBefore: Date.now() - 1, playbackProfile: 'tiktok' };
  h.records.set(record.id, record);
  h.context.waitForVideoFileCacheMetadata = async () => { throw new Error('test stop'); };
  await h.api.serveVideoFileCacheMedia({ headers: {} }, response(), record.id);
  assert.equal(record.status, 'queued');
  assert.equal(record.retries, 0);
  assert.ok(h.events.includes('pump'));
  assert.equal(h.events.includes('gateway'), false);
});

test('serve pumps a newly queued record before waiting for metadata', async () => {
  const h = harness();
  const record = { id: 'ab12', sourceUrl: tikTok, status: 'idle', bytes: 0, totalBytes: 0,
    activeReaders: 0, playbackProfile: 'tiktok' };
  h.records.set(record.id, record);
  h.context.waitForVideoFileCacheMetadata = async () => { h.events.push('metadata'); throw new Error('test stop'); };
  await h.api.serveVideoFileCacheMedia({ headers: {} }, response(), record.id);
  assert.deepEqual(h.events.slice(0, 3), ['enqueue', 'pump', 'metadata']);
});

test('oversized TikTok never goes to gateway, including size learned during wait', async () => {
  for (const initiallyKnown of [true, false]) {
    const h = harness();
    const record = { id: 'ab12', sourceUrl: tikTok, status: 'downloading', bytes: 0,
      totalBytes: initiallyKnown ? 101 : 0, activeReaders: 0, playbackProfile: 'tiktok' };
    h.records.set(record.id, record);
    h.context.waitForVideoFileCacheMetadata = async () => 101;
    const res = response();
    await h.api.serveVideoFileCacheMedia({ headers: {} }, res, record.id);
    assert.equal(res.status, 502);
    assert.equal(h.events.includes('gateway'), false);
  }
});

test('serve does not trust oversized metadata from an aborted writer', async () => {
  const h = harness();
  const record = { id: 'ab12', sourceUrl: tikTok, status: 'downloading', bytes: 0,
    totalBytes: 101, activeReaders: 0, playbackProfile: 'tiktok',
    controller: { signal: { aborted: true }, abort() {} },
    downloadPromise: Promise.resolve(), deferWhenIdle: true };
  h.records.set(record.id, record);
  h.context.waitForVideoFileCacheMetadata = async () => {
    h.events.push('metadata');
    throw new Error('test stop');
  };
  await h.api.serveVideoFileCacheMedia({ headers: {} }, response(), record.id);
  assert.ok(h.events.includes('metadata'));
  assert.equal(h.events.includes('gateway'), false);
});

test('TikTok page classification overrides an incorrect Bunkr playback profile', async () => {
  const h = harness();
  const record = { id: 'ab12', sourceUrl: tikTok, status: 'downloading', bytes: 0,
    totalBytes: 0, activeReaders: 0, playbackProfile: 'bunkr' };
  h.records.set(record.id, record);
  h.context.waitForVideoFileCacheMetadata = async () => {
    h.events.push('metadata');
    throw new Error('test stop');
  };
  await h.api.serveVideoFileCacheMedia({ headers: {} }, response(), record.id);
  assert.ok(h.events.includes('metadata'));
  assert.equal(h.events.includes('gateway'), false);
});
