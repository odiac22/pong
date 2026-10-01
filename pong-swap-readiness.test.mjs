import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');

test('Pong Swap gateway coalesces readiness before probing health', () => {
  const body = source.slice(
    source.indexOf('async function ensurePongSwapService'),
    source.indexOf('async function proxyPongSwapRequest'),
  );
  assert.ok(body.includes('if (pongSwapStartPromise) return pongSwapStartPromise;'));
  assert.ok(body.includes('Date.now() < pongSwapReadyLeaseUntil'));
  assert.ok(body.includes('return markPongSwapReady(health);'));
  assert.ok(
    body.indexOf('if (pongSwapStartPromise)') < body.indexOf('await pongSwapHealth()'),
    'the shared warm/start promise must be consulted before another health probe',
  );
});

test('Pong Swap readiness lease is invalidated on process and proxy failure', () => {
  assert.match(source, /pongSwapProcess\.once\('exit',[\s\S]*?invalidatePongSwapReadiness\(\)/);
  assert.match(source, /upstream\.once\('error',[\s\S]*?invalidatePongSwapReadiness\(\)/);
});
