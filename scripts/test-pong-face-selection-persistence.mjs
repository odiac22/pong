import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const begin = '// BEGIN_PONG_FACE_SELECTION_PERSISTENCE';
const end = '// END_PONG_FACE_SELECTION_PERSISTENCE';
const start = source.indexOf(begin);
const finish = source.indexOf(end, start);
assert.ok(start >= 0 && finish > start && source.indexOf(begin, start + 1) < 0,
  'Exactly one selection-persistence block must exist');
const block = source.slice(start + begin.length, finish);
const storageKey = 'pong_face_swap_selection_session_v1';

function fixture(saved) {
  const items = new Map();
  if (saved !== undefined) items.set(storageKey, saved);
  const sessionStorage = {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)
  };
  const pongFaceSwapState = {
    enabled: false, selectedFaceIds: [], selectedFaceId: '',
    pendingSavedFaceIds: [], selectionRevision: 0
  };
  let notified = 0;
  const context = {
    sessionStorage, pongFaceSwapState,
    PONG_FACE_SWAP_SELECTION_SESSION_KEY: storageKey,
    normalizePongFaceSwapFaceIds: values => {
      const result = [];
      for (const value of (Array.isArray(values) ? values : [values])) {
        for (const id of String(value || '').split(',')) {
          if (id.trim() && !result.includes(id.trim()) && result.length < 16) result.push(id.trim());
        }
      }
      return result;
    },
    pongFaceSwapSelectionKey: ids => ids.join(','),
    window: {PongModernUI: {refreshPreviews() {}}},
    notifyPongTikTokFaceSelectionChanged: () => { notified += 1; }
  };
  vm.runInNewContext(block, context);
  context.pongFaceSwapState.pendingSavedFaceIds = context.readPongFaceSwapSavedSelection();
  return {context, state: pongFaceSwapState, items, notifications: () => notified};
}

test('reload restores only approved IDs after authoritative faces response and stays off', () => {
  const f = fixture(JSON.stringify(['approvedA', 'removed', 'approvedB']));
  assert.equal(f.state.selectedFaceIds.length, 0);
  assert.equal(f.state.enabled, false);
  f.context.reconcilePongFaceSwapSavedSelection([{id: 'approvedB'}, {id: 'approvedA'}]);
  assert.deepEqual([...f.state.selectedFaceIds], ['approvedA', 'approvedB']);
  assert.equal(f.state.selectedFaceId, 'approvedA,approvedB');
  assert.equal(f.state.enabled, false);
  assert.equal(f.items.get(storageKey), JSON.stringify(['approvedA', 'approvedB']));
  assert.equal(f.notifications(), 1);
});

test('removed approvals clear stored selection without enabling swap', () => {
  const f = fixture(JSON.stringify(['removed']));
  f.context.reconcilePongFaceSwapSavedSelection([{id: 'other'}]);
  assert.deepEqual([...f.state.selectedFaceIds], []);
  assert.equal(f.items.has(storageKey), false);
  assert.equal(f.state.enabled, false);
});

test('transient failure retains pending IDs for a later successful faces request', () => {
  const f = fixture(JSON.stringify(['approved']));
  assert.deepEqual([...f.state.pendingSavedFaceIds], ['approved']);
  assert.equal(f.items.get(storageKey), JSON.stringify(['approved']));
  f.context.reconcilePongFaceSwapSavedSelection([{id: 'approved'}]);
  assert.deepEqual([...f.state.selectedFaceIds], ['approved']);
});

test('explicit deselection and new user choice outrank a late restore', () => {
  for (const replacement of [[], ['newChoice']]) {
    const f = fixture(JSON.stringify(['staleChoice']));
    f.context.setPongFaceSwapSelection(replacement);
    f.context.reconcilePongFaceSwapSavedSelection([{id: 'staleChoice'}, {id: 'newChoice'}]);
    assert.deepEqual([...f.state.selectedFaceIds], replacement);
    assert.equal(f.items.get(storageKey) ?? null,
      replacement.length ? JSON.stringify(replacement) : null);
  }
});

test('malformed or oversized saved storage never restores unvalidated IDs', () => {
  for (const raw of ['{broken', 'x'.repeat(2049)]) {
    const f = fixture(raw);
    assert.deepEqual([...f.state.pendingSavedFaceIds], []);
    f.context.reconcilePongFaceSwapSavedSelection([{id: 'x'}]);
    assert.deepEqual([...f.state.selectedFaceIds], []);
  }
});

test('production wiring validates on /faces success and never auto-enables', () => {
  assert.match(source, /cachePongFaceSwapFaces\(faces\);\s*reconcilePongFaceSwapSavedSelection\(faces\)/);
  assert.match(source, /if \(pongFaceSwapState\.pendingSavedFaceIds\.length\) \{\s*setTimeout\(\(\) => \{\s*void fetchPongFaceSwapFaces\(\)/);
  assert.doesNotMatch(block, /setPongFaceSwapPersistentEnabled\(true\)/);
});
