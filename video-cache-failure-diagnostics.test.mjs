import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
function extract(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return source.slice(from, to);
}
const diagnostics = extract('function videoFileCacheFailureCategory(', 'function videoFileCacheSnapshot(');

function sandbox(overrides = {}) {
  const context = vm.createContext({
    Date, Number, String, Math, URL,
    currentVideoFileCachePriority: record => record.priority || 0,
    videoFileCacheRecordHasPlayableFallback: () => false,
    ...overrides
  });
  vm.runInContext(`${diagnostics}\nglobalThis.api={videoFileCacheFailureCategory,noteVideoFileCacheFailure,videoFileCacheShouldRetryAfterFailure,videoFileCacheRecordJson};`, context);
  return context;
}

test('fixed failure categories never echo URLs, credentials, or extractor stderr', () => {
  const { api } = sandbox();
  const cases = [
    ['ERROR: [TikTok] private video at https://signed.example/video?token=SECRET', 'source_unavailable'],
    ['ERROR: HTTP Error 403: https://signed.example/video?token=SECRET', 'upstream_http'],
    ['TikTok downloader exited 1: https://signed.example/video?token=SECRET', 'extractor'],
    ['ERROR: [TikTok] opaque-id: Your IP address is blocked from accessing this post', 'access_blocked'],
    ['request timed out for https://signed.example/video?token=SECRET', 'timeout'],
    ['unrecognized message https://signed.example/video?token=SECRET', 'unknown']
  ];
  for (const [message, category] of cases) {
    const result = api.videoFileCacheFailureCategory(new Error(message));
    assert.equal(result, category);
    assert.doesNotMatch(result, /https|SECRET|token/i);
  }
  assert.equal(api.videoFileCacheFailureCategory(Object.assign(new Error('disk full'), { code: 'ENOSPC' })), 'storage');
  assert.equal(api.videoFileCacheFailureCategory(Object.assign(new Error('unknown'), { code: 'ECONNRESET' })), 'network');
});

test('exact site access block stops zero-byte TikTok retries but retains cooldown recovery', async () => {
  const queue = [];
  const context = sandbox({
    AbortController, Set, Promise,
    VIDEO_FILE_CACHE_DIR: 'fixture', VIDEO_FILE_CACHE_MAX_FILE_BYTES: 100,
    VIDEO_FILE_CACHE_TIKTOK_FAILURE_COOLDOWN_MS: 30000,
    videoFileCacheGeneration: 1, videoFileCacheControllers: new Set(),
    videoFileCacheQueue: queue, videoFileCacheOrder: 0,
    videoFileCachePathFor: (_id, ext) => `fixture${ext}`,
    videoFileCacheCanUseGenericSegments: () => false,
    isTikTokVideoPageUrl: raw => new URL(raw).hostname === 'www.tiktok.com',
    refreshBunkrCdnSignedUrl: async url => url,
    downloadTikTokVideoFile: async () => {
      throw new Error('ERROR: [TikTok] opaque-id: Your IP address is blocked from accessing this post');
    },
    fs: { mkdir: async () => {}, rm: async () => {} },
    enqueueVideoFileCacheRecord: record => { record.status = 'queued'; queue.push(record); },
    rebalanceVideoFileCacheDownloads: () => {}
  });
  vm.runInContext(extract('async function downloadVideoFileCacheRecord(', 'function pumpVideoFileCache('), context);
  const record={id:'opaque-id',cacheGeneration:1,
    sourceUrl:'https://www.tiktok.com/@fixture/video/1234567890123456789',
    status:'queued',bytes:0,retries:0,aliases:new Set()};
  await context.downloadVideoFileCacheRecord(record,1);
  assert.equal(record.status,'error');
  assert.equal(record.failureCategory,'access_blocked');
  assert.equal(record.failureAttempts,1);
  assert.equal(record.retries,2);
  assert.equal(queue.length,0);
  assert.ok(record.retryNotBefore>Date.now());
  const status=context.api.videoFileCacheRecordJson(record);
  assert.equal(status.failure.category,'access_blocked');
  assert.doesNotMatch(JSON.stringify(status),/Your IP|https:\/\/www\.tiktok\.com|opaque-id: Your/);
});

test('access-block shortcut is exact, TikTok-only, and zero-byte-only',()=>{
  const {api}=sandbox({isTikTokVideoPageUrl:raw=>new URL(raw).hostname==='www.tiktok.com'});
  const blocked={sourceUrl:'https://www.tiktok.com/@fixture/video/1234567890123456789',
    retries:0,bytes:0,failureCategory:'access_blocked'};
  const error=new Error('Your IP address is blocked from accessing this post');
  assert.equal(api.videoFileCacheShouldRetryAfterFailure(blocked,error),false);
  assert.equal(api.videoFileCacheShouldRetryAfterFailure({...blocked,bytes:1024},error),true);
  assert.equal(api.videoFileCacheShouldRetryAfterFailure({...blocked,sourceUrl:'https://cdn.example/video.mp4'},error),true);
  assert.equal(api.videoFileCacheShouldRetryAfterFailure({...blocked,failureCategory:'network'},error),true);
  assert.equal(api.videoFileCacheShouldRetryAfterFailure({...blocked,failureCategory:'extractor'},error),true);
  assert.equal(api.videoFileCacheShouldRetryAfterFailure(blocked,new Error('TikTok cache download aborted')),true);
});

test('record status reports bounded attempt count and ISO failure time, not raw error', () => {
  const { api } = sandbox();
  const record = { id: 'opaque-id', status: 'error', aliases: new Set(), priority: 0,
    error: 'signed https://signed.example/video?token=SECRET' };
  api.noteVideoFileCacheFailure(record, new Error(record.error));
  api.noteVideoFileCacheFailure(record, new Error(record.error));
  const status = api.videoFileCacheRecordJson(record);
  assert.deepEqual(JSON.parse(JSON.stringify(status.failure)), {
    category: 'unknown', attempts: 2, lastAt: new Date(record.lastFailureAt).toISOString()
  });
  assert.doesNotMatch(JSON.stringify(status), /SECRET|signed\.example|token=/);
  record.failureAttempts = 255;
  api.noteVideoFileCacheFailure(record, new Error('another error'));
  assert.equal(record.failureAttempts, 255);
  record.segmentedPrefixFailed = true;
  api.noteVideoFileCacheFailure(record, new Error('TikTok cache download aborted'));
  assert.equal(record.failureCategory, 'media_integrity');
});

test('three actual no-byte TikTok downloader failures increment diagnostics without altering retry count', async () => {
  const queue = [], controllers = new Set();
  const context = sandbox({
    AbortController, Set, Promise,
    VIDEO_FILE_CACHE_DIR: 'fixture', VIDEO_FILE_CACHE_MAX_FILE_BYTES: 100,
    VIDEO_FILE_CACHE_TIKTOK_FAILURE_COOLDOWN_MS: 30000,
    videoFileCacheGeneration: 1, videoFileCacheControllers: controllers,
    videoFileCacheQueue: queue, videoFileCacheOrder: 0,
    videoFileCachePathFor: (_id, ext) => `fixture${ext}`,
    videoFileCacheCanUseGenericSegments: () => false,
    isTikTokVideoPageUrl: () => true,
    refreshBunkrCdnSignedUrl: async url => url,
    downloadTikTokVideoFile: async () => { throw new Error('ERROR: [TikTok] Unable to extract media at https://signed.example/video?token=SECRET'); },
    fs: { mkdir: async () => {}, rm: async () => {} },
    enqueueVideoFileCacheRecord: record => { record.status = 'queued'; queue.push(record); },
    rebalanceVideoFileCacheDownloads: () => {}
  });
  vm.runInContext(extract('async function downloadVideoFileCacheRecord(', 'function pumpVideoFileCache('), context);
  const record = { id: 'opaque-id', cacheGeneration: 1,
    sourceUrl: 'https://www.tiktok.com/@fixture/video/1234567890123456789',
    status: 'queued', bytes: 0, retries: 0, aliases: new Set() };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await context.downloadVideoFileCacheRecord(record, 1);
    assert.equal(record.retries, Math.min(attempt, 2));
    assert.equal(record.failureAttempts, attempt);
    assert.equal(record.failureCategory, 'source_unavailable');
    assert.equal(record.bytes, 0);
    queue.length = 0;
    if (attempt < 3) record.status = 'queued';
  }
  assert.equal(record.status, 'error');
  assert.ok(record.retryNotBefore > Date.now());
  const status = context.api.videoFileCacheRecordJson(record);
  assert.equal(status.failure.attempts, 3);
  assert.doesNotMatch(JSON.stringify(status.failure), /SECRET|signed\.example|token=/);
});

test('reader-facing terminal errors never include stored extractor stderr', () => {
  const wait = extract('async function waitForVideoFileCacheMetadata(', 'async function writeVideoFileCacheChunk(');
  const growing = extract('async function streamGrowingVideoFileCacheRange(', 'async function streamCompletedVideoFileCacheRange(');
  assert.doesNotMatch(wait, /new Error\(record\.error/);
  assert.doesNotMatch(growing, /new Error\(record\.error/);
});
