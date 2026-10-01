// Local2 shares one source clock between listing HTML, profile HTML, and video
// proof. Rank sixteen thumbnails at a time, but admit two rank batches. The
// sixteen-candidate live trace could spend 150+ seconds exhausting a media-
// sparse cohort before the next likely winner entered. Ranking a page-balanced
// 64-profile window takes only a few seconds on the warmed GPU, while the four
// shallow lanes and priority schedulers continue to bound every real I/O path.
export const LOCAL2_CANDIDATES_PER_WAVE = 64;
// Keep the broad 64-profile ranking window, but do not turn every ranked
// profile into a live promise at once. Each candidate can enqueue shallow,
// AI, deep-page, and media-proof work; admitting all 64 produced a 90-item
// scheduler backlog and made both first-result latency and phone polling worse.
// Twelve candidates keep four AI lanes and two proof lanes busy while avoiding
// the 23-artist proof backlog observed in the real Pong run. Sixteen admitted
// promises retain broad ranking diversity without burying likely winners.
export const LOCAL2_CANDIDATE_CONCURRENCY = 12;
export const LOCAL2_MAX_PENDING_CANDIDATES = 16;
export const LOCAL2_SHALLOW_PROFILE_CONCURRENCY = 4;
export const LOCAL2_REQUIRED_VIDEO_POSTS = 15;
// All Local2 clone requests share one 650 ms launch clock across both public
// hostnames. Two verifier workers are sufficient to keep that clock occupied;
// a larger per-artist fan-out only reserves future launch slots ahead of other
// candidates' page-one admission and four-post samples.
export const LOCAL2_VERIFIER_CONCURRENCY = 2;

export function local2PageBalancedAdmission(groups = [], rankingLimit = LOCAL2_CANDIDATES_PER_WAVE) {
  const source = Array.isArray(groups) ? groups.map(group => Array.isArray(group) ? group : []) : [];
  const limit = Math.max(1, Math.floor(Number(rankingLimit || LOCAL2_CANDIDATES_PER_WAVE)));
  const rankingPool = [];
  const deferred = [];
  const seen = new Set();
  const maximumGroupLength = Math.max(0, ...source.map(group => group.length));
  for (let offset = 0; offset < maximumGroupLength; offset++) {
    for (const group of source) {
      const candidate = group[offset];
      const identity = String(candidate?.artistId || '').trim();
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      if (rankingPool.length < limit) rankingPool.push(candidate);
      else deferred.push(candidate);
    }
  }
  return { rankingPool, deferred };
}

export function local2NeedsDeeperProfilePages(likelyVideoPosts, requiredVideos = LOCAL2_REQUIRED_VIDEO_POSTS) {
  const likely = Math.max(0, Math.floor(Number(likelyVideoPosts || 0)));
  const required = Math.max(1, Math.floor(Number(requiredVideos || LOCAL2_REQUIRED_VIDEO_POSTS)));
  return likely < required;
}

export function local2ShouldPrefetchProfileDepth({
  sampleHits = 0,
  likelyVideoPosts = 0,
  sourceHintDiagnostics = null,
  requiredVideos = LOCAL2_REQUIRED_VIDEO_POSTS
} = {}) {
  const exactMatches = Math.max(0, Number(sourceHintDiagnostics?.exactMatches || 0));
  const hintedVideos = Math.max(0, Number(sourceHintDiagnostics?.hintedVideoPosts || 0));
  // Exact timestamp matches describe the currently scanned clone pages. When
  // they account for fewer than the required videos, fetch the next small page
  // batch even if the first four posts were dense. Otherwise a 4/4 sample can
  // still force twenty known image-only checks before reaching page two.
  if (exactMatches > 0) return hintedVideos < Math.max(1, Number(requiredVideos || 15));
  return Number(sampleHits || 0) < 3 &&
    local2NeedsDeeperProfilePages(likelyVideoPosts, requiredVideos);
}

export function local2SampleSupportsForegroundProof({
  sampleHits = 0,
  sourceHintDiagnostics = null,
  requiredVideos = LOCAL2_REQUIRED_VIDEO_POSTS
} = {}) {
  const hits = Math.max(0, Number(sampleHits || 0));
  if (hits < 4) return false;
  const exactMatches = Math.max(0, Number(sourceHintDiagnostics?.exactMatches || 0));
  const hintedVideos = Math.max(0, Number(sourceHintDiagnostics?.hintedVideoPosts || 0));
  // Source hints are intentionally ordered ahead of non-video posts. A 4/4
  // sample drawn from that reordered prefix is therefore not a representative
  // density measurement. Only pause competing profile HTML when the exact
  // source cohort itself already contains enough likely videos to satisfy the
  // unchanged 15-video proof. With no exact metadata, retain the authoritative
  // 4/4 behavior.
  const required = Math.max(1, Number(requiredVideos || 15));
  // Twelve exact known videos plus a real 4/4 source sample is already within
  // three posts of the unchanged gate. Giving that near-complete cohort one
  // bounded focused burst costs at most the same fifteen checks and avoids an
  // extra round-robin cycle; anything sparser continues to yield normally.
  const nearComplete = Math.max(4, required - 3);
  return exactMatches === 0 || hintedVideos >= nearComplete;
}

function finiteRank(value) {
  const rank = Number(value);
  return Number.isFinite(rank) ? Math.max(0, Math.min(1, rank)) : 0;
}

export function local2CandidatePreferenceRank(candidate) {
  return finiteRank(candidate?.preferenceRank);
}

export function local2HintedVideoPostCount(profile) {
  const count = Number(profile?.sourceHintDiagnostics?.hintedVideoPosts);
  return Number.isFinite(count) ? Math.max(0, Math.min(50, Math.floor(count))) : 0;
}

export function local2SourceHintSchedulingBoost(profile) {
  const hintedVideoPosts = local2HintedVideoPostCount(profile);
  // Fifteen exact timestamp-matched source posts can satisfy the unchanged
  // fifteen-video floor, so let that cohort jump media-sparse candidates. The
  // four-post authoritative sample can still demote a stale hint afterward.
  return (hintedVideoPosts >= LOCAL2_REQUIRED_VIDEO_POSTS ? 5000 : 0) +
    hintedVideoPosts * 20;
}

export function local2VerifierPriorityAfterSample({
  startingPriority = 0,
  sourceHintBoost = 0,
  sampleHits = 0,
  sampleSize = 4
} = {}) {
  const safeHintBoost = Math.max(0, Number(sourceHintBoost || 0));
  const basePriority = Number(startingPriority || 0) - safeHintBoost;
  const size = Math.max(1, Math.floor(Number(sampleSize || 4)));
  const hits = Math.max(0, Math.min(size, Math.floor(Number(sampleHits || 0))));
  const retainedHintBoost = hits >= 3 ? safeHintBoost : 0;
  return basePriority + retainedHintBoost + hits * 1000 - (size - hits) * 100;
}

export function local2DeepHtmlPriority(candidate, likelyVideoPosts = 0, allVideoPosts = 0) {
  const density = Math.min(
    60,
    Math.max(0, Number(likelyVideoPosts || 0)) * 4 +
      Math.max(0, Number(allVideoPosts || 0))
  );
  const preferenceBoost = Math.round(local2CandidatePreferenceRank(candidate) * 18);
  // Page-one profile work is priority 100 and listing discovery is 200. Deep
  // work must stay below both so a sparse profile can never block admission.
  return Math.min(89, 10 + density + preferenceBoost);
}

export function local2HighestPriorityWaiterIndex(waiters) {
  const values = Array.isArray(waiters) ? waiters : [];
  let selected = -1;
  for (let index = 0; index < values.length; index++) {
    const candidate = values[index] || {};
    const current = selected >= 0 ? values[selected] || {} : null;
    if (
      selected < 0 ||
      Number(candidate.priority || 0) > Number(current.priority || 0) ||
      (
        Number(candidate.priority || 0) === Number(current.priority || 0) &&
        Number(candidate.sequence || 0) < Number(current.sequence || 0)
      )
    ) selected = index;
  }
  return selected;
}
