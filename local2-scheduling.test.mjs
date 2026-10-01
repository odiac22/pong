import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  LOCAL2_CANDIDATES_PER_WAVE,
  LOCAL2_CANDIDATE_CONCURRENCY,
  LOCAL2_MAX_PENDING_CANDIDATES,
  LOCAL2_REQUIRED_VIDEO_POSTS,
  LOCAL2_SHALLOW_PROFILE_CONCURRENCY,
  LOCAL2_VERIFIER_CONCURRENCY,
  local2CandidatePreferenceRank,
  local2DeepHtmlPriority,
  local2HintedVideoPostCount,
  local2HighestPriorityWaiterIndex,
  local2NeedsDeeperProfilePages,
  local2PageBalancedAdmission,
  local2SampleSupportsForegroundProof,
  local2ShouldPrefetchProfileDepth,
  local2SourceHintSchedulingBoost,
  local2VerifierPriorityAfterSample
} from './local2-scheduling.mjs';

test('Local2 ranks sixty-four candidates while bounding live downstream work', () => {
  assert.equal(LOCAL2_CANDIDATES_PER_WAVE, 64);
  assert.equal(LOCAL2_CANDIDATE_CONCURRENCY, 12);
  assert.equal(LOCAL2_MAX_PENDING_CANDIDATES, 16);
  assert.equal(LOCAL2_SHALLOW_PROFILE_CONCURRENCY, 4);
  assert.equal(LOCAL2_REQUIRED_VIDEO_POSTS, 15);
  assert.equal(LOCAL2_VERIFIER_CONCURRENCY, 2);
});

test('page-balanced ranking never discards the unranked remainder', () => {
  const groups = Array.from({ length: 4 }, (_, group) =>
    Array.from({ length: 20 }, (_, index) => ({ artistId: `${group}:${index}` }))
  );
  const { rankingPool, deferred } = local2PageBalancedAdmission(groups, 16);
  assert.equal(rankingPool.length, 16);
  assert.equal(deferred.length, 64);
  assert.equal(new Set([...rankingPool, ...deferred].map(item => item.artistId)).size, 80);
  assert.deepEqual(rankingPool.slice(0, 8).map(item => item.artistId), [
    '0:0', '1:0', '2:0', '3:0', '0:1', '1:1', '2:1', '3:1'
  ]);
});

test('profile depth follows likely video evidence instead of raw post count', () => {
  assert.equal(local2NeedsDeeperProfilePages(9, 15), true);
  assert.equal(local2NeedsDeeperProfilePages(15, 15), false);
  // Thirty generic post cards must not masquerade as fifteen likely videos.
  assert.equal(local2NeedsDeeperProfilePages(0, 15), true);
});

test('exact source density prefetches depth even after a strong sample', () => {
  assert.equal(local2ShouldPrefetchProfileDepth({
    sampleHits: 4,
    likelyVideoPosts: 38,
    sourceHintDiagnostics: { exactMatches: 30, hintedVideoPosts: 10 }
  }), true);
  assert.equal(local2ShouldPrefetchProfileDepth({
    sampleHits: 4,
    likelyVideoPosts: 38,
    sourceHintDiagnostics: { exactMatches: 30, hintedVideoPosts: 16 }
  }), false);
  assert.equal(local2ShouldPrefetchProfileDepth({ sampleHits: 0, likelyVideoPosts: 8 }), true);
  assert.equal(local2ShouldPrefetchProfileDepth({ sampleHits: 4, likelyVideoPosts: 8 }), false);
});

test('a source-reordered 4/4 prefix cannot masquerade as dense foreground proof', () => {
  assert.equal(local2SampleSupportsForegroundProof({
    sampleHits: 4,
    sourceHintDiagnostics: { exactMatches: 30, hintedVideoPosts: 4 }
  }), false);
  assert.equal(local2SampleSupportsForegroundProof({
    sampleHits: 4,
    sourceHintDiagnostics: { exactMatches: 30, hintedVideoPosts: 12 }
  }), true);
  assert.equal(local2SampleSupportsForegroundProof({ sampleHits: 4 }), true);
  assert.equal(local2SampleSupportsForegroundProof({ sampleHits: 3 }), false);
});

test('exact source hints prioritize likely 15-video profiles without filtering sparse profiles', () => {
  const sparse = { sourceHintDiagnostics: { hintedVideoPosts: 14 } };
  const likelyQualified = { sourceHintDiagnostics: { hintedVideoPosts: 15 } };
  assert.equal(local2HintedVideoPostCount({}), 0);
  assert.equal(local2HintedVideoPostCount({ sourceHintDiagnostics: { hintedVideoPosts: 500 } }), 50);
  assert.equal(local2SourceHintSchedulingBoost(sparse), 280);
  assert.equal(local2SourceHintSchedulingBoost(likelyQualified), 5300);
  assert.ok(local2SourceHintSchedulingBoost(likelyQualified) > local2SourceHintSchedulingBoost(sparse));
});

test('authoritative four-post sample retains good hints and demotes stale hints', () => {
  const sourceHintBoost = 5300;
  const highHintStrong = local2VerifierPriorityAfterSample({
    startingPriority: 8000,
    sourceHintBoost,
    sampleHits: 3
  });
  const highHintStale = local2VerifierPriorityAfterSample({
    startingPriority: 8000,
    sourceHintBoost,
    sampleHits: 0
  });
  const noHintStrong = local2VerifierPriorityAfterSample({
    startingPriority: 2700,
    sampleHits: 3
  });
  assert.equal(highHintStrong, 10900);
  assert.equal(highHintStale, 2300);
  assert.equal(noHintStrong, 5600);
  assert.ok(highHintStrong > noHintStrong);
  assert.ok(noHintStrong > highHintStale);
});

test('deep HTML taste ordering never outranks page-one admission', () => {
  assert.equal(local2CandidatePreferenceRank({ preferenceRank: 2 }), 1);
  assert.equal(local2CandidatePreferenceRank({ preferenceRank: -1 }), 0);
  assert.equal(local2DeepHtmlPriority({ preferenceRank: 1 }, 100, 100), 88);
  assert.ok(local2DeepHtmlPriority({ preferenceRank: 1 }, 100, 100) < 100);
  assert.ok(
    local2DeepHtmlPriority({ preferenceRank: 0.9 }, 5, 10) >
      local2DeepHtmlPriority({ preferenceRank: 0.1 }, 5, 10)
  );
});

test('shallow admission selects rank priority and preserves FIFO ties', () => {
  const waiters = [
    { priority: 0.4, sequence: 1 },
    { priority: 0.9, sequence: 3 },
    { priority: 0.9, sequence: 2 }
  ];
  assert.equal(local2HighestPriorityWaiterIndex(waiters), 2);
  assert.equal(local2HighestPriorityWaiterIndex([]), -1);
});

test('live flow runs primary AI before focused progressive 15-video proof', () => {
  const source = readFileSync(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
  const prepareStart = source.indexOf('async function local2FlashPrepareProfile');
  const prepareEnd = source.indexOf('\nasync function local2FlashCompleteProfileMedia', prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.ok(prepare.indexOf('context?.onShallowProfileReady?.();') >= 0);
  assert.ok(
    prepare.indexOf('context?.onShallowProfileReady?.();') <
      prepare.indexOf('while (')
  );
  const depthStart = source.indexOf('async function local2FlashFetchProfileDepthBatch');
  const depthEnd = source.indexOf('\nasync function local2FlashPrepareProfile', depthStart);
  const depth = source.slice(depthStart, depthEnd);
  assert.match(depth, /const pageNumbers = \[state\.nextPage\]/);
  assert.doesNotMatch(depth, /state\.nextPage \+ 1/);
  const innerStart = source.indexOf('async function local22TurboQualifyCandidateInner');
  const innerEnd = source.indexOf('\nasync function local22TurboQualifyCandidate(', innerStart);
  const inner = source.slice(innerStart, innerEnd);
  assert.ok(inner.indexOf('decisionResult = await classifyPreparedProfile()') >= 0);
  assert.ok(
    inner.indexOf('decisionResult = await classifyPreparedProfile()') <
      inner.indexOf('await local2FlashSampleProfile(profile, branchContext)')
  );
  // The four-post sample must itself enter the prioritized proof lane, but its
  // slot is released before the progressive bounded-depth loop.
  const sampleStart = inner.indexOf('const releaseSampleProof = await local2AcquireMediaProofSlot');
  const progressiveCall = inner.indexOf('verifiedMedia = await local2FlashVerifyProfileProgressively');
  assert.ok(sampleStart >= 0 && sampleStart < progressiveCall);
  assert.ok(inner.indexOf('releaseSampleProof();', sampleStart) < progressiveCall);
  assert.match(inner, /sampleEntries: combinedSampleEntries/);
  assert.match(inner, /samplePostUrls: combinedSamplePosts/);

  const progressiveStart = source.indexOf('async function local2FlashVerifyProfileProgressively');
  const progressiveEnd = source.indexOf('\nfunction local2FlashSelectConfirmationImages', progressiveStart);
  const progressive = source.slice(progressiveStart, progressiveEnd);
  assert.match(progressive, /const quantumLimit = foregroundDense/);
  assert.match(progressive, /Math\.max\(LOCAL2_MEDIA_PROOF_POST_QUANTUM, 15 - verifiedMedia\.length\)/);
  assert.match(progressive, /refreshProofSchedulingEvidence\(\)/);
  assert.match(progressive, /nextHintBoost = local2SourceHintSchedulingBoost\(profile\)/);
  assert.match(progressive, /local2AcquireMediaProofSlot/);
  assert.match(progressive, /finally \{\s*releaseMediaProof\(\);\s*\}/);
  assert.match(progressive, /canonicalVideoEntryKeys\(entry\)/);
  assert.match(progressive, /verifiedMediaKeys\.has\(key\)/);
  assert.match(progressive, /Array\.isArray\(sampleEntries\)/);
  assert.match(progressive, /Array\.isArray\(samplePostUrls\)/);
  assert.match(progressive, /if \(verifiedMedia\.length >= 15\) return verifiedMedia\.slice\(0, 15\)/);
  assert.match(progressive, /local2FlashFetchProfileDepthBatch/);
  assert.ok(
    progressive.indexOf('releaseMediaProof();') <
      progressive.indexOf('local2FlashFetchProfileDepthBatch(profile, state, context)',
        progressive.indexOf('releaseMediaProof();'))
  );
  assert.doesNotMatch(progressive, /allVideoPostUrls\.length < 15/);
});

test('Local2.2 engine preserves density-first discovery ordering', () => {
  const source = readFileSync(new URL('./local2-flash-engine.mjs', import.meta.url), 'utf8');
  assert.match(source, /this\.variant === 'local22-turbo'/);
  assert.match(source, /Number\(Number\(b\.likelyVideoCount \|\| 0\) >= 10\)/);
  assert.match(source, /Number\(b\.preferenceRank \|\| 0\)/);
});
