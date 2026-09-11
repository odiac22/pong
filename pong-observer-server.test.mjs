import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';

const port = 18799;
const base = `http://127.0.0.1:${port}`;
const admin = 'observer-admin-test';
const ingest = 'observer-ingest-test';
const isolated = 'observer-isolated-test';
let child;

before(async () => {
  child = spawn(process.execPath, ['pong-observer-server.mjs'], {
    env: {
      ...process.env,
      PONG_OBSERVER_PORT: String(port),
      PONG_OBSERVER_ADMIN_TOKEN: admin,
      PONG_OBSERVER_INGEST_TOKEN: ingest,
      PONG_OBSERVER_TEST_TOKEN: isolated
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('observer test server did not start');
});

after(() => child?.kill());

const auth = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const state = (instanceId, sessionId, extra = {}) => ({
  instanceId,
  sessionId,
  sentAt: new Date().toISOString(),
  page: { topFrame: true, bridge: false },
  client: { native: false },
  playback: { artist: sessionId },
  ...extra
});

test('status always requires admin authentication', async () => {
  assert.equal((await fetch(`${base}/instances`)).status, 401);
  assert.equal((await fetch(`${base}/instances`, { headers: auth(admin) })).status, 200);
});

test('sessions do not overwrite one another and native is preferred', async () => {
  for (const payload of [
    state('pong1', 'desktop'),
    state('pong1', 'native', { client: { native: true } })
  ]) {
    const response = await fetch(`${base}/ingest`, { method: 'POST', headers: auth(ingest), body: JSON.stringify({ state: payload, events: [] }) });
    assert.equal(response.status, 200);
  }
  const result = await fetch(`${base}/instances/pong1`, { headers: auth(admin) }).then(response => response.json());
  assert.equal(result.instance.sessionId, 'native');
  assert.equal(result.sessions.length, 2);
});

test('bridge frames are rejected', async () => {
  const response = await fetch(`${base}/ingest`, {
    method: 'POST', headers: auth(ingest),
    body: JSON.stringify({ state: state('pong2', 'iframe', { page: { topFrame: false, bridge: true } }), events: [] })
  });
  assert.equal(response.status, 400);
});

test('test ingest is isolated from production', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
  const response = await fetch(`${base}/test/ingest`, {
    method: 'POST', headers: auth(isolated), body: JSON.stringify({
      state: state('pong2', 'qa'), events: [],
      frame: { capturedAt: new Date().toISOString(), width: 360, height: 640, jpegBase64: jpeg.toString('base64') }
    })
  });
  assert.equal(response.status, 200);
  const production = await fetch(`${base}/instances/pong2`, { headers: auth(admin) });
  assert.equal(production.status, 404);
  const qa = await fetch(`${base}/test/instances/pong2`, { headers: auth(admin) }).then(response => response.json());
  assert.equal(qa.instance.sessionId, 'qa');
  assert.equal((await fetch(`${base}/test/screenshots/pong2`)).status, 401);
  const screenshot = await fetch(`${base}/test/screenshots/pong2`, { headers: auth(admin) });
  assert.equal(screenshot.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), jpeg);
});
