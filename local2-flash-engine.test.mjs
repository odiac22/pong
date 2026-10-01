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

test('candidate settlement aborts speculative helpers after an early rejection', async () => {
  let observedSignal = null;
  let helperSettled;
  const helperWasAborted = new Promise(resolve => { helperSettled = resolve; });
  const engine = new Local2FlashEngine({
    discoverPages: async pages => [{
      artistId: 'settlement-fixture',
      artistUrl: 'https://example.test/u/a/settlement-fixture',
      sourcePage: pages[0]
    }],
    qualifyCandidate: async (_candidate, { signal }) => {
      observedSignal = signal;
      signal.addEventListener('abort', () => helperSettled(signal.reason), { once: true });
      return { accepted: false, category: 'policy', reason: 'fixture rejection' };
    },
    targetAccepted: 1,
    readyMinimum: 1,
    pageConcurrency: 1,
    candidateConcurrency: 1,
    maximumPendingCandidates: 1,
    maximumPages: 1,
    candidateTimeoutMs: 0,
    variant: 'settlement-test'
  });

  await engine.start({ pages: [11] });
  const abortReason = await Promise.race([
    helperWasAborted,
    sleep(500).then(() => { throw new Error('speculative helper was not aborted'); })
  ]);

  assert.equal(observedSignal?.aborted, true);
  assert.match(String(abortReason?.message || abortReason), /candidate settled/i);
  const state = engine.snapshot();
  assert.equal(state.completed, 1);
  assert.equal(state.rejected, 1);
  assert.equal(state.failed, 0);
  await engine.stop();
});

test('an unacknowledged Android delivery lease becomes available again', async () => {
  let now = 1000;
  const engine = new Local2FlashEngine({
    discoverPages: async pages => [{
      artistId: 'lease-fixture',
      artistUrl: 'https://example.test/u/a/lease-fixture',
      sourcePage: pages[0]
    }],
    qualifyCandidate: async candidate => ({
      accepted: true,
      dto: { artist: { id: candidate.artistId, url: candidate.artistUrl } }
    }),
    targetAccepted: 1,
    readyMinimum: 1,
    pageConcurrency: 1,
    candidateConcurrency: 1,
    maximumPendingCandidates: 1,
    maximumPages: 1,
    candidateTimeoutMs: 0,
    now: () => now
  });

  await engine.start({ pages: [1] });
  for (let attempt = 0; attempt < 40 && !engine.snapshot().ready; attempt++) await sleep(5);
  assert.equal(engine.lease(1).length, 1);
  assert.equal(engine.lease(1).length, 0);
  now += 15001;
  assert.equal(engine.lease(1).length, 1);
  assert.equal(engine.acknowledge(['lease-fixture']), 1);
  await engine.stop();
});
