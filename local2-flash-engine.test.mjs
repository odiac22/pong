import assert from 'node:assert/strict';
import test from 'node:test';
import { Local2FlashEngine } from './local2-flash-engine.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('transient backoff retries without consuming pages or artists', async () => {
  let discoveries = 0;
  let qualifications = 0;
  const engine = new Local2FlashEngine({
    discoverPages: async pages => {
      discoveries++;
      if (discoveries === 1) throw new Error('gateway HTML shared backoff (20ms remaining)');
      return [{ artistId: 'fixture', artistUrl: 'https://example.test/u/a/b', sourcePage: pages[0] }];
    },
    qualifyCandidate: async candidate => {
      qualifications++;
      if (qualifications === 1) throw new Error('upstream HTTP 503');
      return { accepted: true, dto: { artistId: candidate.artistId } };
    },
    targetAccepted: 1, readyMinimum: 1, pageConcurrency: 1,
    candidateConcurrency: 1, maximumPendingCandidates: 1,
    maximumPages: 1, candidateTimeoutMs: 0
  });
  await engine.start({ pages: [7] });
  for (let attempt = 0; attempt < 80 && !engine.snapshot().ready; attempt++) await sleep(25);
  const state = engine.snapshot();
  assert.equal(state.ready, true);
  assert.equal(state.pages, 1);
  assert.equal(state.discovered, 1);
  assert.equal(state.failed, 0);
  assert.equal(state.rejected, 0);
  assert.equal(state.transientRetries, 2);
  assert.equal(discoveries, 2);
  assert.equal(qualifications, 2);
  await engine.stop();
});
