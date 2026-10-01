import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const java = readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/MainActivity.java', import.meta.url), 'utf8');
const photoBranch = java.slice(
  java.indexOf('if (supplied.has("activeVideo")'),
  java.indexOf('LinkedHashSet<String> validated')
);
const stream = readFileSync(new URL('../android-app/app/src/main/assets/tiktok-stream.js', import.meta.url), 'utf8');
const clearCode = stream.slice(
  stream.indexOf('window.__pongDomSwapClear='),
  stream.indexOf('window.__pongDomSwapWarmClear=')
);
const oldPage = 'https://www.tiktok.com/@fixture/video/1234567890123456789';
const nextPage = 'https://www.tiktok.com/@fixture/video/1234567890123456790';

function clearWith(activePage, expectedSession, activeSession = 'session1', preservePage = '') {
  const disposed = [];
  const hidden = [];
  const active = { pageUrl: activePage, sessionId: activeSession };
  const context = vm.createContext({
    window: { __pongDomSwap: active, PongTikTokSwap: { hidden: id => hidden.push(id) } },
    dispose: owner => disposed.push(owner),
    document: { documentElement: { classList: { remove() {} } } }
  });
  vm.runInContext(clearCode, context);
  const cleared = context.window.__pongDomSwapClear(preservePage, expectedSession);
  return { cleared, disposed, hidden, active: context.window.__pongDomSwap };
}

test('native inactive branch clears its current owner and forwards the bounded queue', () => {
  assert.ok(photoBranch.length > 0);
  assert.match(photoBranch, /upcoming\.size\(\)<8/);
  assert.match(photoBranch, /isTikTokPageUrl\(page\)/);
  assert.match(photoBranch, /currentTikTokUrl="";nearbyTikTokUrls\.clear\(\);clearTikTokIntegratedSwap\(\)/);
  assert.match(photoBranch, /nearbyTikTokUrls\.addAll\(upcoming\)/);
  assert.match(photoBranch, /forwardTikTokFeedToPong\(inactive\)/);
  assert.match(java, /window\.__pongDomSwapClear&&window\.__pongDomSwapClear\(" \+ JSONObject\.quote\(preservePreparedPage\)/);
  assert.match(java, /\(tiktokVisible && tiktokSwapEnabled\) \? "," \+ JSONObject\.quote\(priorSession\)/);
});

test('existing expected-session guard spares a newly adopted next reader', () => {
  const adoptedNext = clearWith(nextPage, 'outgoing', 'next-session');
  assert.equal(adoptedNext.cleared, false);
  assert.equal(adoptedNext.active.pageUrl, nextPage);
  assert.equal(adoptedNext.disposed.length, 0);
  assert.equal(adoptedNext.hidden.length, 0);

  const outgoing = clearWith(oldPage, 'session1');
  assert.equal(outgoing.cleared, true);
  assert.equal(outgoing.active, null);
  assert.equal(outgoing.disposed.length, 1);
  assert.deepEqual(outgoing.hidden, ['session1']);

  const unknownOwner = clearWith(nextPage, '');
  assert.equal(unknownOwner.cleared, false);
  assert.equal(unknownOwner.active.pageUrl, nextPage);
});

test('undefined owner clears unless exact preserve page matches', () => {
  const unguarded = clearWith(nextPage, undefined, 'next-session');
  assert.equal(unguarded.cleared, true);
  assert.equal(unguarded.active, null);

  const preserved = clearWith(nextPage, undefined, 'next-session', nextPage);
  assert.equal(preserved.cleared, false);
  assert.equal(preserved.active.pageUrl, nextPage);
  const wrongPage = clearWith(oldPage, 'session1', 'session1', nextPage);
  assert.equal(wrongPage.cleared, true);
});

test('current owner clears even if it is the upcoming page without exact preserve', () => {
  const sameOwner = clearWith(nextPage, 'next-session', 'next-session');
  assert.equal(sameOwner.cleared, true);
  assert.equal(sameOwner.active, null);
});

test('explicit Exit/off clear paths remain unconditional', () => {
  const beforePhoto = java.slice(0, java.indexOf('if (supplied.has("activeVideo")'));
  assert.match(beforePhoto, /clearTikTokIntegratedSwap\(\);/);
  assert.match(beforePhoto, /private void clearTikTokIntegratedSwap\(\)\s*\{\s*clearTikTokIntegratedSwap\(""\)/);
});
