import assert from 'node:assert/strict';
import test from 'node:test';

const BASE = process.env.PONG_TEST_URL || 'http://127.0.0.1:8787';
// Live GPU tests must never fetch an implicit third-party fixture or overlap
// another render when included in an otherwise offline node --test run.
const SOURCE = process.env.PONG_LICENSED_TEST_SOURCE;
test('live preload lifecycle (explicit licensed fixture only)', { skip: !SOURCE }, async () => {
const sessionsPayload = await fetch(`${BASE}/pong-swap/sessions`).then(response => response.json());
assert(!sessionsPayload.sessions?.some(session => !session.complete), 'another swap session exists; run this test in isolation');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withTimeout(promise, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const facesPayload = await fetch(`${BASE}/pong-swap/faces`).then(response => response.json());
const faceId = facesPayload.faces?.[0]?.id;
assert(faceId, 'approved face missing');

const createdResponse = await fetch(`${BASE}/pong-swap/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    channel: 'test-preload-lifecycle',
    sourceUrl: SOURCE,
    faceId,
    startSeconds: 0,
    prefetch: true,
    prebufferSeconds: 0.75,
  }),
});
const created = await createdResponse.json();
assert.equal(createdResponse.ok, true, created.detail || 'session create failed');
const sessionId = created.session.id;
const streamUrl = new URL(created.streamUrl, BASE).href;

try {
  const sizes = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    withTimeout(async signal => {
      const response = await fetch(`${streamUrl}?preload=1&attempt=${index}`, { signal });
      assert.equal(response.ok, true, `preload ${index} failed`);
      return (await response.arrayBuffer()).byteLength;
    }, 30_000, `preload ${index}`)
  ));
  assert(sizes.every(size => size > 1_000), `preload response was empty: ${sizes.join(',')}`);

  let status;
  for (let attempt = 0; attempt < 30; attempt++) {
    status = await fetch(`${BASE}/pong-swap/sessions/${sessionId}?t=${Date.now()}`).then(response => response.json());
    if (status.session?.subscribers === 0) break;
    await delay(100);
  }
  assert.equal(status.session?.subscribers, 0, 'preload subscribers did not disconnect');
  assert.equal(status.session?.streamRequests, 4, 'unexpected preload request count');

  const facesDuringPrefetch = await withTimeout(
    signal => fetch(`${BASE}/pong-swap/faces?t=${Date.now()}`, { signal }).then(response => response.json()),
    2_000,
    'face list during paused prefetch',
  );
  assert.equal(facesDuringPrefetch.faces?.length, facesPayload.faces.length);
  console.log(JSON.stringify({ ok: true, sessionId, sizes, subscribers: status.session.subscribers }, null, 2));
} finally {
  await fetch(`${BASE}/pong-swap/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => null);
}
});
