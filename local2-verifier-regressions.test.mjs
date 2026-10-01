import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const serverSource = readFileSync(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');

function functionSource(name, nextDeclaration) {
  const start = serverSource.indexOf(`async function ${name}`);
  const end = serverSource.indexOf(`\n${nextDeclaration}`, start);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must end before ${nextDeclaration}`);
  return serverSource.slice(start, end);
}

function compileServerFunction(source, globals) {
  const context = vm.createContext({
    AbortController,
    DOMException,
    URL,
    Date,
    Error,
    Map,
    Math,
    Number,
    Set,
    String,
    ...globals
  });
  return vm.runInContext(`(${source})`, context);
}

function synchronousFunctionSource(name, nextDeclaration) {
  const start = serverSource.indexOf(`function ${name}`);
  const end = serverSource.indexOf(`\n${nextDeclaration}`, start);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must end before ${nextDeclaration}`);
  return serverSource.slice(start, end);
}

test('verification timeout with no response is a marked transient error, never a TypeError', async () => {
  const fetchVideoEntriesForVerification = compileServerFunction(
    functionSource('fetchVideoEntriesForVerification', 'function mirrorVideoPostUrl'),
    {
      GATEWAY_TIMEOUT_MS: 16_000,
      VIDEO_VERIFY_CACHE_MAX: 100,
      VIDEO_VERIFY_CACHE_TTL_MS: 60_000,
      clearTimeout() {},
      gatewayH2Fetch: async () => { throw new Error('deterministic H2 transport failure'); },
      gatewayHttp1BufferFetch: async () => {
        throw new Error('HTTP/1 fallback must not start after the deadline abort');
      },
      gatewayHtmlTransientStatus: status => status === 408 || status === 425 || status >= 500,
      gatewayTargetUrl: rawUrl => new URL(rawUrl),
      scheduleVideoVerifyFetch: async (_host, _groupId, worker) => worker({
        backoffUntil: 0,
        completed: 0,
        rateLimits: 0,
        sourceTotalMs: 0
      }),
      // Fire the verifier's deadline deterministically without waiting 16 seconds.
      setTimeout(callback) {
        callback();
        return 1;
      },
      videoVerifyCache: new Map()
    }
  );

  await assert.rejects(
    fetchVideoEntriesForVerification(
      'https://coomerfans.com/p/creator/service/123',
      {},
      null,
      'timeout-fixture'
    ),
    error => {
      assert.notEqual(error?.name, 'TypeError');
      assert.equal(error?.pongTransient, true);
      assert.match(String(error?.message || error), /timed out/i);
      return true;
    }
  );
});

test('a successful alternate mirror clears the canonical group transient failure', async () => {
  const original = 'https://coomerfans.com/p/creator/service/123';
  const mirror = 'https://onlyfaphouse.com/post/creator/service/123/example';
  const calls = [];
  const context = {
    balanceVideoPostGroups: () => [{ key: 'creator:service:123', urls: [original, mirror] }],
    canonicalVideoEntryKeys: entry => entry?.videoUrl ? [`media:${entry.videoUrl}`] : [],
    canonicalVideoPostKey: () => 'creator:service:123',
    fetchVideoEntriesForVerification: async postUrl => {
      calls.push(postUrl);
      if (postUrl === original) {
        const error = new Error('video post request timed out');
        error.pongTransient = true;
        throw error;
      }
      // A 200 response with no media is still a successful canonical response.
      return [];
    },
    gatewayTargetUrl: rawUrl => new URL(rawUrl),
    videoPlaybackProbeCache: new Map(),
    videoVerifyCache: new Map(),
    videoVerifyGroupSequence: 0,
    videoVerifyStateForHost: () => ({ active: 0, queue: [] })
  };
  const verifyVideoPostBatch = compileServerFunction(
    functionSource('verifyVideoPostBatch', 'async function probePlayableMediaUrl'),
    context
  );

  const result = await verifyVideoPostBatch({
    postUrls: [original],
    stopAt: 1,
    perArtistConcurrency: 2,
    artistInfo: {}
  }, new AbortController().signal);

  assert.deepEqual(calls, [original, mirror]);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 0);
  assert.equal(result.checked, 1);
});

test('Local2 collects and submits all six images required by its unchanged hard-safe gate', () => {
  assert.match(serverSource, /context\?\.variant === 'local2-fast'\s*\? LOCAL2_CLEAN_MAX_IMAGES/);
  assert.match(serverSource, /twoRuleMode \? requiredDecisionImages : LOCAL2_CLEAN_MAX_IMAGES/);
  assert.match(serverSource, /const requiredDecisionImages = twoRuleMode \? 4 : 6/);
  assert.match(serverSource, /if \(!testAiMode && !twoRuleMode && examined < 6\)/);
  assert.match(serverSource, /distinctPostImages\.map\(entry => entry\.imageUrl\)/);
});

test('Local2 deterministically rejects explicit trans labels without matching unrelated trans words', () => {
  const explicitLabelReason = compileServerFunction(
    synchronousFunctionSource('local2ExplicitCreatorTextHardReason', 'function local2SourceHintApiPosts'),
    {}
  );

  for (const fixture of [
    { artistName: 'example', pageText: 'Trans creator | official profile' },
    { artistName: 'example', pageText: 'transgender model' },
    { artistName: 'example', pageText: 'MTF creator' },
    { artistName: 'example', pageText: 't-girl videos' },
    { artistName: 'translatina69' },
    { artistName: 'example', artistUrl: 'https://coomerfans.com/u/onlyfans/1/trans-girl-example' }
  ]) {
    assert.match(explicitLabelReason(fixture), /explicit trans creator label/);
  }

  for (const artistName of [
    'transformation_artist',
    'translatewithme',
    'transportqueen',
    'transitionstudio'
  ]) {
    assert.equal(explicitLabelReason({ artistName }), '');
  }

  const qualifier = functionSource(
    'local22TurboQualifyCandidateInner',
    'async function local22TurboQualifyCandidate'
  );
  const guardAt = qualifier.indexOf("qualificationVariant === 'local2-fast'");
  const classifyAt = qualifier.indexOf('const classifyPreparedProfile = async');
  assert.ok(guardAt >= 0 && guardAt < classifyAt, 'Local2 label guard must run before AI inference');
  assert.match(qualifier, /category:\s*'policy',[\s\S]*reason:\s*explicitCreatorReason/);
});

test('the Local2 button engine is wired to the strict AI-first qualifier', () => {
  const engineStart = serverSource.indexOf('const local2FlashEngine = new Local2FlashEngine({');
  const engineEnd = serverSource.indexOf('const local22TurboEngine = new Local2FlashEngine({', engineStart);
  const engine = serverSource.slice(engineStart, engineEnd);
  assert.match(engine, /qualifyCandidate: local2FlashQualifyCandidate/);
  assert.doesNotMatch(engine, /qualifyCandidate: local22TurboQualifyCandidate/);
});
