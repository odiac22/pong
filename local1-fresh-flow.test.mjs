import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const index = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
const watchdog = await readFile(new URL('./scripts/run-pong-server-watchdog.ps1', import.meta.url), 'utf8');
const activity = await readFile(new URL('./android-app/app/src/main/java/com/odiac22/pong/MainActivity.java', import.meta.url), 'utf8');

test('disabled pre-approved reservoir falls through to a fresh Local1 scan', () => {
  assert.match(index, /enabled:\s*payload\?\.enabled\s*!==\s*false/);
  assert.match(index, /if \(warmBatch\.enabled === false \|\| eligibilityWaitExpired\)[\s\S]{0,700}Fresh Local1 scan/);
  assert.doesNotMatch(
    index.match(/if \(warmBatch\.enabled === false \|\| eligibilityWaitExpired\)[\s\S]{0,900}/)?.[0] || '',
    /await sleep\(1000\);\s*continue;/
  );
});

test('fresh Local1 overlaps AI work and finishes only two candidates at a time', () => {
  assert.match(index, /fetch\(`\$\{localEndpoint\}\/local1\/wake`/);
  assert.match(index, /random40State\?\.mode === 'local' \? 2 : RANDOM40_LOCAL_CONCURRENCY/);
  assert.match(index, /random40LocalOverlappedDecision/);
  assert.match(index, /overlappedHardVerificationPromise/);
});

test('Local1 thumbnail scoring changes ordering only, never acceptance', () => {
  assert.match(index, /Ranking is ordering-only/);
  assert.match(index, /local1\/rank-thumbnails/);
  assert.match(index, /payload\?\.ranking_only !== true/);
  assert.match(server, /preferenceAiRequest\('\/local2-clean\/rank-thumbnails'/);
});

test('media proof preserves the rate-safe 650 ms start floor with latency overlap', () => {
  assert.match(server, /PONG_VIDEO_VERIFY_FETCH_CONCURRENCY\s*\|\|\s*\n\s*2/);
  assert.match(server, /PONG_VIDEO_VERIFY_START_GAP_MS \|\| 650/);
  assert.match(server, /PONG_VIDEO_VERIFY_ACTIVE_PER_ARTIST_HOST \|\| 2/);
  assert.match(server, /PONG_GATEWAY_SHARED_SOURCE_GAP_MS \|\| 650/);
});

test('Local1 warm queue proves eligibility but never pre-approves an artist', () => {
  assert.match(server, /RANDOM40_ACCEPTED_PREAPPROVAL_ENABLED/);
  assert.match(server, /eligibilityOnly:\s*true/);
  assert.match(server, /preapproved:\s*false/);
  assert.match(index, /const eligibilityValid = eligibilityOnly/);
  assert.match(index, /eligibilityWaitExpired[\s\S]{0,220}12000/);
  assert.match(watchdog, /PONG_RANDOM40_ACCEPTED_PREAPPROVAL_ENABLED = '0'/);
  assert.match(server, /const shallowCandidateLimit = Math\.max\(8, Math\.min\(16, RANDOM40_RESERVOIR_TARGET\)\)/);
  assert.match(server, /if \(RANDOM40_ACCEPTED_PREAPPROVAL_ENABLED\) random40Reservoir\.splice\(0\)/);
});

test('Android lifecycle avoids oversized WebView state and recovers a dead renderer', () => {
  assert.doesNotMatch(activity, /\.saveState\s*\(/);
  assert.doesNotMatch(activity, /\.restoreState\s*\(/);
  assert.match(activity, /onRenderProcessGone/);
  // Release diagnostics are intentionally available only through an already
  // authorized USB/wireless ADB connection. Keep the WebView inspectable for
  // live Pong 1/Pong 2 QA without exposing an in-page Java bridge.
  assert.match(activity, /WebView\.setWebContentsDebuggingEnabled\(true\)/);
  assert.doesNotMatch(activity, /addJavascriptInterface\s*\(/);
});
