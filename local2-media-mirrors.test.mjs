import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  local2BestMediaProbe,
  local2MediaCdnMirrorUrl,
  local2MediaPlaybackCandidates,
  selectLocal2PlaybackMediaMirrors
} from './local2-media-mirrors.mjs';

const original = 'https://img1.onlyfaphouse.com/storage/7/aa/bb/clip.mp4?e=123&hash=signed';
const mirror = 'https://img1.coomerfans.com/storage/7/aa/bb/clip.mp4?e=123&hash=signed';

test('CDN counterpart preserves img shard, signed path, and query exactly', () => {
  assert.equal(local2MediaCdnMirrorUrl(original), mirror);
  assert.equal(local2MediaCdnMirrorUrl(mirror), original);
  assert.equal(
    local2MediaCdnMirrorUrl('https://img12.coomerfans.com/a/b/file.m4v?x=1#part'),
    'https://img12.onlyfaphouse.com/a/b/file.m4v?x=1#part'
  );
  assert.equal(local2MediaCdnMirrorUrl('https://coomerfans.com/storage/file.mp4'), '');
  assert.equal(local2MediaCdnMirrorUrl('https://evil.example/storage/file.mp4'), '');
});

test('candidate list retains existing fallbacks and adds each exact counterpart once', () => {
  const extra = 'https://img2.onlyfaphouse.com/storage/other.webm?token=x';
  assert.deepEqual(local2MediaPlaybackCandidates({
    videoUrl: original,
    alternateVideoUrls: [mirror, extra, original]
  }), [
    original,
    mirror,
    extra,
    'https://img2.coomerfans.com/storage/other.webm?token=x'
  ]);
});

test('probe ranking prefers fast start, then responsive latency', () => {
  assert.equal(local2BestMediaProbe([
    { url: 'https://a.example/a.mp4', playable: true, fastStart: false, probeLatencyMs: 10 },
    { url: 'https://a.example/b.mp4', playable: true, fastStart: true, probeLatencyMs: 900 },
    { url: 'https://a.example/c.mp4', playable: true, fastStart: true, probeLatencyMs: 200 }
  ])?.url, 'https://a.example/c.mp4');
});

test('selector promotes a proven fast mirror and retains the original as fallback', async () => {
  const result = await selectLocal2PlaybackMediaMirrors([{
    videoUrl: original,
    postUrl: 'https://onlyfaphouse.com/post/1/2/onlyfans/example',
    alternateVideoUrls: [],
    verified: true
  }], {
    concurrency: 1,
    probe: async url => url === mirror
      ? { playable: true, fastStart: true, probeLatencyMs: 40, probeBytesPerSecond: 2_000_000 }
      : new Promise(resolve => setTimeout(() => resolve({ playable: false }), 100))
  });
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].videoUrl, mirror);
  assert.deepEqual(result.media[0].alternateVideoUrls, [original]);
  assert.equal(result.media[0].verified, true);
  assert.equal(result.media[0].fastStart, true);
  assert.equal(result.media[0].playbackMirrorSelected, true);
  assert.equal(result.diagnostics.selectedMirrors, 1);
  assert.equal(result.diagnostics.failedOpenEntries, 0);
});

test('all probe failures fail open without removing or changing proof entries', async () => {
  const entries = Array.from({ length: 15 }, (_, index) => ({
    videoUrl: index === 0
      ? original
      : `https://cdn.example/video-${index}.mp4`,
    postUrl: `post-${index + 1}`,
    postIndex: index,
    verified: true
  }));
  const result = await selectLocal2PlaybackMediaMirrors(entries, {
    probe: async () => ({ playable: false }),
    concurrency: 2
  });
  assert.equal(result.media.length, entries.length);
  assert.equal(result.media[0].videoUrl, original);
  assert.deepEqual(result.media[0].alternateVideoUrls, [mirror]);
  assert.equal(result.media[1].videoUrl, entries[1].videoUrl);
  assert.deepEqual(result.media[1].alternateVideoUrls, []);
  assert.deepEqual(result.media.map(entry => entry.postUrl), entries.map(entry => entry.postUrl));
  assert.deepEqual(result.media.map(entry => entry.postIndex), entries.map(entry => entry.postIndex));
  assert.ok(result.media.every(entry => entry.verified === true));
  assert.equal(result.diagnostics.failedOpenEntries, 15);
});

test('selector enforces bounded entry concurrency', async () => {
  let active = 0;
  let maximumActive = 0;
  const entries = Array.from({ length: 6 }, (_, index) => ({
    videoUrl: `https://cdn.example/${index}.mp4`,
    verified: true
  }));
  await selectLocal2PlaybackMediaMirrors(entries, {
    concurrency: 2,
    probe: async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { playable: true, fastStart: false };
    }
  });
  assert.equal(maximumActive, 2);
});

test('all live Local2-derived engines prepare playback mirrors before DTO creation', async () => {
  const server = await readFile(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
  const start = server.indexOf('async function local22TurboQualifyCandidateInner');
  const end = server.indexOf('async function local22TurboQualifyCandidate(', start);
  const sharedFlow = server.slice(start, end);
  const proofAt = sharedFlow.indexOf('verifiedMedia = await local2FlashVerifyProfileProgressively');
  const mirrorsAt = sharedFlow.indexOf('await local2PreparePlaybackMediaMirrors(verifiedMedia');
  const prebufferAt = sharedFlow.indexOf('await local22TurboPrebufferFirstMedia(media');
  const dtoAt = sharedFlow.indexOf('local2FlashAcceptedDto(profile, media');
  assert.ok(proofAt >= 0);
  assert.ok(mirrorsAt > proofAt);
  assert.ok(prebufferAt > mirrorsAt);
  assert.ok(dtoAt > mirrorsAt);
  assert.equal(
    (server.match(/qualifyCandidate:\s*local22TurboQualifyCandidate/g) || []).length,
    1
  );
  assert.equal(
    (server.match(/qualifyCandidate:\s*local2FlashQualifyCandidate/g) || []).length,
    1
  );
  const strictStart = server.indexOf('async function local2FlashQualifyCandidate');
  const strictEnd = server.indexOf('let local22TurboQualificationActive', strictStart);
  const strictFlow = server.slice(strictStart, strictEnd);
  assert.match(strictFlow, /await local2PreparePlaybackMediaMirrors\(verifiedMedia/);
  assert.ok(
    strictFlow.indexOf('await local2PreparePlaybackMediaMirrors(verifiedMedia') <
      strictFlow.indexOf('local2FlashAcceptedDto(profile, media')
  );
  const blankStart = server.indexOf('async function local22BlankQualifyCandidate');
  const blankEnd = server.indexOf('async function local22TurboQualifyCandidateInner', blankStart);
  const blankFlow = server.slice(blankStart, blankEnd);
  assert.match(blankFlow, /await local2PreparePlaybackMediaMirrors\(/);
  assert.ok(
    blankFlow.indexOf('await local2PreparePlaybackMediaMirrors(') <
      blankFlow.indexOf('local2FlashAcceptedDto(profile, media')
  );
});

test('playback preparation probes only five while retaining the complete verified bundle', async () => {
  const server = await readFile(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
  const start = server.indexOf('async function local2PreparePlaybackMediaMirrors');
  const end = server.indexOf('async function local2FlashPrioritizePlayableMedia', start);
  const flow = server.slice(start, end);
  assert.match(flow, /const foreground = source\.slice\(0, 5\)/);
  assert.match(flow, /const retainedTail = source\.slice\(5\)/);
  assert.match(flow, /media: \[\.\.\.prepared, \.\.\.tail\]/);
  assert.match(flow, /retainedEntries: source\.length/);
  assert.match(flow, /deferredPlaybackEntries: tail\.length/);
});
