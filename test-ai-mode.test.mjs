import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
const watchdog = await readFile(new URL('./scripts/run-pong-server-watchdog.ps1', import.meta.url), 'utf8');

test('Test AI button is adjacent to Local2.2 and starts its isolated lane', () => {
  assert.match(html, /id="random-40-local"[^>]*>R40 Local 2\.2<\/button>\s*<button id="test-ai">Test AI<\/button>/);
  assert.match(html, /playbackProfile:\s*'testai',\s*testAi:\s*true/);
  assert.match(html, /endpointPath:\s*'\/test-ai'/);
  assert.match(server, /url\.pathname === '\/test-ai\/start'/);
});

test('Test AI delivery is gated only by fifteen verified videos', () => {
  assert.match(server, /const testAiMode = context\?\.variant === 'test-ai'/);
  assert.match(server, /const requiredDecisionImages = twoRuleMode \? 4 : 6/);
  assert.match(server, /if \(!testAiMode && profile\.candidateImageUrls\.length < requiredDecisionImages\)/);
  assert.match(server, /if \(!testAiMode && !twoRuleMode && examined < 6\)/);
  assert.match(server, /if \(!testAiMode && !twoRuleMode && clearBody < LOCAL2_FLASH_CONFIRMATION_CLEAR_BODY_IMAGES\)/);
  assert.match(server, /if \(verifiedMedia\.length < 15\)/);
  assert.match(server, /testAi:\s*true,[\s\S]*aiWouldAccept,[\s\S]*aiVerdict:/);
});

test('Test AI delivers at fifteen before starting background AI evaluation', () => {
  assert.match(server, /if \(testAiMode\) \{\s*return local22TestAiQualifyMediaFirst/);
  assert.match(server, /Delivery never waits for the model or CDN mirror ranking/);
  assert.match(server, /scheduleTestAiEvaluation\(candidate, context\.revision\)/);
  assert.match(server, /await ensureAiWorkersReady\(LOCAL2_QWEN_MODEL\)/);
  assert.match(server, /aiVerdict:\s*'pending'/);
});

test('Test AI uses the benchmarked structured prefilter and five-video first delivery', () => {
  assert.match(server, /local22TestAiFastScrapeCandidate/);
  assert.match(server, /testAiStructuredVideoCount/);
  assert.match(server, /qualified\.length < target/);
  assert.match(server, /seenPosts\.size < 15/);
  assert.match(server, /offset \+= 5/);
  assert.match(server, /random40ReservoirVideoPostUrls/);
  assert.match(server, /extractVideoUrlsFromHtml/);
  assert.match(server, /structured-prefilter-five-first/);
  assert.match(server, /const playbackEntries = entries\.map/);
  assert.match(server, /testAiSourceFetchLimit = createSimpCityLimiter\(20\)/);
  assert.match(server, /testAiSourceNextStartAt = startAt \+ 450/);
  assert.match(server, /prefilterDeadline = Date\.now\(\) \+ 8_000/);
  assert.match(server, /async function testAiDirectFetchHtml/);
  assert.match(server, /candidateConcurrency:\s*2/);
  assert.match(server, /maximumTransientRetries:\s*0/);
  assert.match(server, /discoverPages:\s*testAiDiscoverPages/);
  assert.match(server, /VPS_SCRAPER_CONFIG\.url/);
  assert.match(server, /async function ensureTestAiFirefoxScraper/);
  assert.match(server, /windowsHide:\s*true/);
  assert.match(server, /TEST_AI_FIREFOX_SCRAPER_URL\}\/fetch/);
  assert.match(server, /Promise\.allSettled\(pages\.map/);
  assert.match(server, /if \(!groups\.length\)/);
  assert.match(server, /local2MediaCdnMirrorUrl\(entry\.videoUrl\)/);
  assert.match(server, /gatewayHtmlIsTransientInterstitial\(html\)/);
  assert.match(server, /Test AI source transport incomplete/);
  assert.match(html, /testAiAvailableVideoCount >= RANDOM40_MIN_VIDEOS_PER_ARTIST[\s\S]*\? 5[\s\S]*: RANDOM40_MIN_VIDEOS_PER_ARTIST/);
  assert.match(html, /playbackProfile === 'testai'\) return ''/);
  assert.match(watchdog, /Start-VpsScraperTunnelIfNeeded/);
  assert.match(server, /if \(context\?\.variant === 'test-ai'\) \{\s*return local22TestAiFastScrapeCandidate/);
});

test('horizontal Test AI swipes use the requested labels and colors', () => {
  assert.match(html, /dx < 0 \? 'rgb\(34,197,94\)' : dx > 0 \? 'rgb\(239,68,68\)'/);
  assert.match(html, /recordTestAiArtistChoice\(dx < 0 \? 'accept' : 'reject'\)/);
  assert.match(html, /workflow:\s*'test-ai'/);
  assert.match(html, /aiLabel,[\s\S]*agreed:\s*label === aiLabel/);
});

test('Local and Test AI stage five videos while collecting a five-artist backlog', () => {
  assert.match(html, /Math\.min\(5, Number\(count \|\| 5\)\)/);
  assert.match(html, /initialEntries\.push\(\.\.\.entries\.slice\(0, 5\)\)/);
  assert.match(html, /random40AppendDeferredEntriesWhileViewed/);
  assert.match(html, /pending\.splice\(0, 5\)/);
  assert.match(html, /if \(wasCurrent\) return/);
  assert.match(html, /requireActiveArtist:\s*true/);
  assert.match(html, /if \(random40ArtistIdentity\(currentEvent\?\.artistUrl \|\| ''\) !== artistIdentity\) artistController\.abort\(\)/);
});
