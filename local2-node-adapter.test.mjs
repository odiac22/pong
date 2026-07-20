import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocal2NodeAdapter } from './local2-node-adapter.mjs';

function decision() {
  return {
    verdict: 'accept',
    confidence: 0.99,
    model: 'synthetic-local2',
    hardFilters: {
      photograph: true,
      femalePresentingAdult: true,
      malePresent: false,
      attachedAnatomy: false,
      feetDominant: false,
      bodyMismatch: false,
      over60: false,
      adultSafetyRisk: false,
      ambiguous: false
    },
    evidence: { examinedImages: 8, clearBodyViews: 4 }
  };
}

function media(artistId) {
  return Array.from({ length: 15 }, (_, index) => ({
    videoUrl: `https://media.invalid/${artistId}/${index}.mp4`,
    postUrl: `https://source.invalid/${artistId}/${index}`,
    verified: true,
    fastStart: index < 10
  }));
}

function syntheticWorkers() {
  return {
    profile: async candidate => ({ ...candidate, artistName: candidate.artistId }),
    triage: async () => ({ verdict: 'uncertain', confidence: 0.5 }),
    verify: async profile => media(profile.artistId),
    classify: async () => decision()
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('synthetic adapter timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('health is inert and candidates lazily create workers and producer', async () => {
  let workersCreated = 0;
  let producerStarted = 0;
  const adapter = createLocal2NodeAdapter({
    initialRevision: 'local2-r1',
    createWorkers: async context => {
      workersCreated++;
      assert.equal(context.storage, 'memory-only');
      return syntheticWorkers();
    },
    producer: async ({ submit }) => {
      producerStarted++;
      submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/101/one', sourcePage: 4 });
    },
    pipelineOptions: { targetAccepted: 15, readyMinimum: 1 }
  });

  const health = await adapter.dispatch({ method: 'GET', pathname: '/local2/health' });
  assert.equal(health.body.schema, 'pong.local2.node-adapter.v1');
  assert.equal(health.body.active, false);
  assert.equal(workersCreated, 0);
  assert.equal(producerStarted, 0);

  await adapter.dispatch({ method: 'GET', pathname: '/local2/candidates', query: { count: 1 } });
  await waitFor(() => adapter.snapshot().accepted === 1);
  assert.equal(workersCreated, 1);
  assert.equal(producerStarted, 1);
  assert.equal(adapter.snapshot().pipelineSchema, 'pong.local2.pipeline.v1');
  await adapter.stop();
});

test('candidate endpoint leases minimal DTO and ack accepts artist URL', async () => {
  const adapter = createLocal2NodeAdapter({
    workers: syntheticWorkers(),
    initialRevision: 'local2-r1',
    producer: async ({ submit }) => {
      submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/102/two', sourcePage: 8 });
    },
    pipelineOptions: { targetAccepted: 15, readyMinimum: 1 }
  });
  await adapter.ensureStarted();
  await waitFor(() => adapter.snapshot().accepted === 1);
  const response = await adapter.dispatch({ method: 'GET', pathname: '/local2/candidates', query: { count: 1 } });
  assert.equal(response.status, 200);
  assert.equal(response.body.candidates.length, 1);
  const candidate = response.body.candidates[0];
  assert.equal(candidate.storage, 'memory-only');
  assert.equal(candidate.media.length, 15);
  assert.equal('html' in candidate, false);
  assert.equal('pageText' in candidate, false);
  const ack = await adapter.dispatch({
    method: 'POST',
    pathname: '/local2/candidates/ack',
    body: { artistUrls: ['https://coomerfans.com/u/onlyfans/102/two'] }
  });
  assert.equal(ack.body.consumed, 1);
  await adapter.stop();
});

test('learning sanitizes URL-only input and rotates only the Local2 revision', async () => {
  let learnedPayload = null;
  const adapter = createLocal2NodeAdapter({
    workers: syntheticWorkers(),
    initialRevision: 'local2-r1',
    learn: async payload => {
      learnedPayload = payload;
      return { ok: true, learned: true, local2_revision: 'local2-r2' };
    },
    pipelineOptions: { targetAccepted: 15, readyMinimum: 1 }
  });
  const learned = await adapter.dispatch({
    method: 'POST',
    pathname: '/local2/learn',
    body: {
      label: 'reject',
      artist: {
        artistUrl: 'https://coomerfans.com/u/onlyfans/103/three',
        artistName: 'three'
      },
      imageUrls: [
        'https://image.invalid/one.jpg',
        'data:image/jpeg;base64,not-allowed',
        'https://image.invalid/one.jpg'
      ],
      rejectReasonLabel: 'Body'
    }
  });
  assert.equal(learned.status, 200);
  assert.equal(learned.body.revision, 'local2-r2');
  assert.deepEqual(learnedPayload.imageUrls, ['https://image.invalid/one.jpg']);
  assert.equal(learnedPayload.mode, 'local2');
  assert.equal(adapter.snapshot().cache.learningRevision, 'local2-r2');
  await adapter.stop();
});

test('non-Local2 paths are untouched and unknown Local2 paths are scoped 404s', async () => {
  const adapter = createLocal2NodeAdapter({ workers: syntheticWorkers() });
  assert.deepEqual(await adapter.dispatch({ method: 'GET', pathname: '/health' }), { handled: false });
  const missing = await adapter.dispatch({ method: 'GET', pathname: '/local2/missing' });
  assert.equal(missing.handled, true);
  assert.equal(missing.status, 404);
  assert.equal(adapter.snapshot().active, false);
});

test('stop aborts a lazy producer and allows a clean restart generation', async () => {
  let starts = 0;
  let aborts = 0;
  const adapter = createLocal2NodeAdapter({
    workers: syntheticWorkers(),
    producer: ({ signal }) => new Promise(resolve => {
      starts++;
      signal.addEventListener('abort', () => {
        aborts++;
        resolve();
      }, { once: true });
    })
  });
  await adapter.ensureStarted();
  assert.equal(starts, 1);
  await adapter.stop();
  assert.equal(aborts, 1);
  await adapter.ensureStarted();
  assert.equal(starts, 2);
  await adapter.stop();
});

test('Node request wrapper handles Local2 routes without opening a socket', async () => {
  const adapter = createLocal2NodeAdapter({ workers: syntheticWorkers() });
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = '/local2/health';
  const response = {
    headersSent: false,
    writableEnded: false,
    status: 0,
    headers: null,
    payload: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(payload) {
      this.payload = String(payload || '');
      this.writableEnded = true;
    }
  };
  assert.equal(await adapter.handleNodeRequest(req, response), true);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.payload).active, false);

  const unrelated = Readable.from([]);
  unrelated.method = 'GET';
  unrelated.url = '/health';
  assert.equal(await adapter.handleNodeRequest(unrelated, response), false);
});
