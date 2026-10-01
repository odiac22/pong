import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../universal-video-scraper.user.js', import.meta.url), 'utf8');
const start = source.indexOf('  function startTargetRebindRetries(');
const end = source.indexOf('\n  function targetElementVisible(', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
function clock() {
  let id = 0;
  const pending = new Map(), delays = [];
  return {
    pending, delays,
    schedule(fn, ms) { delays.push(ms); pending.set(++id, fn); return id; },
    cancel(key) { pending.delete(key); },
    tick() { const entry = pending.entries().next().value; if (entry) { pending.delete(entry[0]); entry[1](); } },
  };
}

test('late visible player is rebound and retries stop once mapped', () => {
  const c = clock(); let missing = true, calls = 0;
  context.startTargetRebindRetries(() => missing, () => { if (++calls === 3) missing = false; }, c.schedule, c.cancel);
  while (c.pending.size) c.tick();
  assert.equal(calls, 3);
  assert.deepEqual(c.delays, [250, 500, 1000]);
});
test('a permanently absent player cannot poll indefinitely', () => {
  const c = clock(); let calls = 0;
  context.startTargetRebindRetries(() => true, () => calls++, c.schedule, c.cancel);
  while (c.pending.size) c.tick();
  assert.equal(calls, 6);
  assert.equal(c.delays.reduce((a, b) => a + b, 0), 11750);
});
test('closing preview cancels outstanding rebind work', () => {
  const c = clock(); let calls = 0;
  const stop = context.startTargetRebindRetries(() => true, () => calls++, c.schedule, c.cancel);
  stop(); c.tick(); stop();
  assert.equal(calls, 0); assert.equal(c.pending.size, 0);
});
test('sending or a resolved target does not start a retry', () => {
  const c = clock();
  context.startTargetRebindRetries(() => false, () => assert.fail('unexpected rebind'), c.schedule, c.cancel);
  assert.equal(c.pending.size, 0);
});
test('visibility rebinding avoids repeated HTML copies and cleans up listeners', () => {
  assert.match(source, /if \(refreshDocument\) \{\s*document\.__uvsRawHtml/);
  assert.match(source, /startTargetRebindRetries\(needsRebind, \(\) => rescan\(false\)\)/);
  for (const event of ['transitionend', 'animationend']) {
    assert.ok(source.includes(`document.addEventListener('${event}', onVisibilityEnd, true)`));
    assert.ok(source.includes(`document.removeEventListener('${event}', onVisibilityEnd, true)`));
  }
});
