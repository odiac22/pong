import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('./scripts/preference_ai_service.py', import.meta.url), 'utf8');
const browser = fs.readFileSync(new URL('./scripts/firefox_scraper_service.py', import.meta.url), 'utf8');
const player = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('Local2.2 uses the new history-only pipeline behind the existing route', () => {
  assert.match(server, /const LOCAL22_BLANK_MIN_VIDEOS = 10/);
  assert.match(server, /discoverPages: local22BlankDiscoverPages/);
  assert.match(server, /qualifyCandidate: local22BlankQualifyCandidate/);
  assert.match(server, /preferencePolicy: 'local22-history-only'/);
  assert.match(server, /candidateConcurrency: LOCAL22_BLANK_CANDIDATE_CONCURRENCY/);
});

test('Local2.2 has exactly one history decision and no secondary AI', () => {
  assert.match(service, /history_only = preference_policy == "local22-history-only"/);
  assert.match(service, /cached_history_only_head/);
  assert.match(service, /features, labels, _ = feature_records\(variant\)/);
  assert.match(service, /include_semantics=False/);
  assert.match(service, /"history_only": True/);
  const qualifyStart = server.indexOf('async function local22BlankQualifyCandidate');
  const qualifyEnd = server.indexOf('async function local22TurboQualifyCandidateInner', qualifyStart);
  const qualify = server.slice(qualifyStart, qualifyEnd);
  assert.doesNotMatch(qualify, /Qwen|hard-confirmation|local22TwoRuleDecision/);
});

test('Local2.2 verifies ten real URLs and prepares only the first five', () => {
  assert.match(server, /extractVideoUrlsFromHtml\(html, postUrl\)/);
  assert.match(server, /actualMediaSourceVerified: true/);
  assert.match(server, /verifiedMedia\.slice\(0, 5\)/);
  assert.match(server, /\.\.\.verifiedMedia\.slice\(5\)/);
  assert.match(player, /const RANDOM40_LOCAL22_MIN_VIDEOS_PER_ARTIST = 10/);
  assert.match(player, /endpointPath === '\/local22-turbo'[\s\S]{0,120}RANDOM40_LOCAL22_MIN_VIDEOS_PER_ARTIST/);
});

test('private Firefox transport is headless, muted, and batches twenty requests', () => {
  assert.match(browser, /options\.add_argument\("-headless"\)/);
  assert.match(browser, /media\.volume_scale", "0\.0"/);
  assert.match(browser, /request_url\.path != "\/fetch-batch"/);
  assert.match(browser, /\[:20\]/);
  assert.match(browser, /queue\.PriorityQueue\(\)/);
  assert.match(server, /local22BlankFetchBatch\(pending, context\.signal, \{ priority: 100 \}\)/);
  assert.match(server, /local22BlankFetchBatch/);
});

test('Local2.2 uses private Firefox first and keeps VPS/direct recovery without changing rules', () => {
  assert.match(server, /output = await local22BlankFirefoxFetchBatch\(urls, signal, \{ priority \}\)/);
  assert.match(server, /let stillMissing = urls\.filter\(url => !output\.has\(url\)\)/);
  assert.match(server, /const vpsRecovery = await fetchVpsBatch\(stillMissing\)/);
  assert.match(server, /testAiFetchHtml\(url, signal, 8000\)/);
  assert.match(server, /Local2\.2 source transports returned no pages/);
  assert.match(server, /error\.pongTransient = true/);
  assert.match(server, /local22BlankSourceBackoffUntil/);
  assert.match(server, /sourceBackoffRemainingMs/);
});

test('Local2 uses the same authoritative private batch proof after AI acceptance', () => {
  const verifyStart = server.indexOf('async function local2FlashVerifyProfile(');
  const verifyEnd = server.indexOf('async function artistLookupGatewayProfileVideos', verifyStart);
  const verify = server.slice(verifyStart, verifyEnd);
  assert.match(verify, /context\?\.variant === 'local2-fast'/);
  assert.match(verify, /local22BlankFetchBatch\(targets, context\.signal, \{ priority: 100 \}\)/);
  assert.match(verify, /extractVideoUrlsFromHtml\(html, postUrl\)/);
  assert.match(verify, /entries\.length >= stopAt/);
});

test('Local2.2 ranks likely ten-video artists first but preserves the full listing', () => {
  assert.match(server, /local22BlankApplyVideoDensityHints\(candidates, context\.signal\)/);
  assert.match(server, /right\.likelyVideoCount \|\| 0\) >= LOCAL22_BLANK_MIN_VIDEOS/);
  const discoverStart = server.indexOf('async function local22BlankDiscoverPages');
  const discoverEnd = server.indexOf('function local22BlankProfileFromPages', discoverStart);
  const discover = server.slice(discoverStart, discoverEnd);
  assert.match(discover, /return candidates/);
  assert.doesNotMatch(discover, /\.filter\([^)]*likelyVideoCount/);
});

test('Local2.2 uses bulk video hints only to order the unchanged clone proof set', () => {
  const start = server.indexOf('async function local22BlankVerifyMedia');
  const end = server.indexOf('async function local22BlankQualifyCandidate', start);
  const verify = server.slice(start, end);
  assert.match(verify, /local2SourceHintPostsForArtist/);
  assert.match(verify, /orderLocal2ClonePostsWithSourceHints/);
  assert.match(verify, /targetVideos: LOCAL22_BLANK_MIN_VIDEOS/);
  assert.match(verify, /deepestLoadedPage < targetListingDepth/);
  assert.match(verify, /await profileState\.fetchPages\(depthPages\)/);
  assert.match(verify, /extractVideoUrlsFromHtml\(html, postUrl\)/);
});

test('Local2.2 short-circuits only a complete sub-ten inventory and otherwise keeps clone fallback', () => {
  const start = server.indexOf('async function local22BlankQualifyCandidate');
  const end = server.indexOf('async function local22TurboQualifyCandidateInner', start);
  const qualify = server.slice(start, end);
  assert.match(qualify, /testAiStructuredVideoInventory/);
  assert.match(qualify, /inventory\.complete === true/);
  assert.match(qualify, /inventory\.posts\.length > 0/);
  assert.match(qualify, /inventory\.videoCount < LOCAL22_BLANK_MIN_VIDEOS/);
  assert.match(qualify, /profileState\.sourceHintPosts = inventory\.posts/);
  assert.match(qualify, /Exact clone proof below remains authoritative/);
});
