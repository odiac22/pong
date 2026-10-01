import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const [source, html, syncSource, serverSource] = await Promise.all([
  readFile(new URL('pong-collections.js', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('pong-sync.js', root), 'utf8'),
  readFile(new URL('local-ai-server.mjs', root), 'utf8')
]);

function fakeElement(id = '') {
  const listeners = new Map();
  return {
    id,
    hidden: id === 'pong-collection-panel' || id === 'pong-collection-editor',
    value: '',
    textContent: '',
    style: {},
    dataset: {},
    children: [],
    className: '',
    classList: {
      toggle() {},
      add() {},
      remove() {}
    },
    setAttribute() {},
    focus() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    click() { listeners.get('click')?.({ preventDefault() {} }); }
  };
}

function loadCollectionRuntime() {
  const ids = [
    'pong-collection-save-button', 'pong-collection-panel', 'pong-collection-close',
    'pong-collection-edit', 'pong-collection-editor', 'pong-collection-name',
    'pong-collection-add', 'pong-collection-list', 'pong-collection-save-links',
    'pong-collection-load', 'pong-collection-remove', 'pong-collection-status'
  ];
  const elements = new Map(ids.map(id => [id, fakeElement(id)]));
  const scopes = ['all', 'current'].map(scope => {
    const element = fakeElement(`scope-${scope}`);
    element.dataset.collectionScope = scope;
    return element;
  });
  const storage = new Map();
  const context = {
    console,
    URL,
    Math,
    Date,
    Uint32Array,
    crypto: globalThis.crypto,
    location: new URL('http://127.0.0.1:8787/pong?pongInstance=1'),
    requestAnimationFrame(callback) { callback(); },
    fetch: async () => ({ ok: false }),
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    document: {
      getElementById(id) { return elements.get(id) || null; },
      querySelectorAll(selector) { return selector === '[data-collection-scope]' ? scopes : []; },
      createElement(tag) { return fakeElement(tag); }
    },
    allVideoUrls: [
      'https://cdn.example/a1.mp4',
      'https://cdn.example/a2.mp4',
      'https://cdn.example/b1.mp4',
      'https://cdn.example/b2.mp4'
    ],
    allVideoMetadata: [
      { source: 'erome', bundleKey: 'album-a', artistName: 'A' },
      { source: 'erome', bundleKey: 'album-a', artistName: 'A' },
      { source: 'bunkr', bundleKey: 'album-b', artistName: 'B' },
      { source: 'bunkr', bundleKey: 'album-b', artistName: 'B' }
    ],
    videoUrls: [],
    videoMetadata: [],
    pasteEvents: [
      { startIndex: 0, count: 2, source: 'erome', bundleKey: 'album-a', artistName: 'A' },
      { startIndex: 2, count: 2, source: 'bunkr', bundleKey: 'album-b', artistName: 'B' }
    ],
    currentPasteIndex: 1,
    syncCurrentPasteIndexFromVisibleVideo() { return 1; },
    pongCanonicalRawMediaUrl(url) { return url; }
  };
  context.window = context;
  context.globalThis = context;
  context.window.addEventListener = () => {};
  vm.runInNewContext(source, context, { filename: 'pong-collections.js' });
  return context.window.PongNamedCollections;
}

test('Save collection UI and shared persistence are wired into Pong 27.69', () => {
  assert.match(html, /id="pong-collection-save-button"/);
  assert.match(html, /id="pong-collection-panel"/);
  assert.match(html, /data-collection-scope="all"/);
  assert.match(html, /data-collection-scope="current"/);
  assert.match(html, /id="pong-collection-remove"/);
  assert.match(syncSource, /BEGIN bundled named-link collections v1/);
  assert.ok(syncSource.includes(source.trim()), 'bundled collection runtime must match its tested standalone source');
  assert.doesNotMatch(html, /pong-collections\.js\?v=1/);
  assert.match(html, />27\.69</);
  assert.match(serverSource, /savedCollections/);
  assert.match(serverSource, /collections:\s*Object\.keys\(data\.savedCollections\)\.length/);
  assert.match(syncSource, /loadNamedCollection\(/);
  assert.match(syncSource, /'savedCollection'/);
  assert.match(source, /removeButton\?\.addEventListener\('click'/);
});

test('saved-list and named-collection navigation retain an explicitly selected face', () => {
  assert.match(
    html,
    /resetPongFaceSwapForFreshLoad\?\.\(\{[\s\S]*?preserveSelection:\s*String\(reason\s*\|\|\s*['"]{2}\)\.startsWith\(['"]saved-['"]\)/,
  );
  assert.match(
    html,
    /function resetPongFaceSwapForFreshLoad\(\{\s*preserveSelection\s*=\s*false\s*\}[\s\S]*?if\s*\(!preserveSelection\)[\s\S]*?selectedFaceId\s*=\s*['"]{2}/,
  );
  assert.match(syncSource, /PongInvalidateDatasetOwnership\(`saved-\$\{mode\s*\|\|\s*['"]normal['"]\}`\)/);
});

test('startup saved-state consumers share one bounded PC request', () => {
  assert.match(html, /function pongFetchPcSavedLinksState\(/);
  assert.match(html, /broker\.endpoint === normalizedEndpoint && broker\.inFlight/);
  assert.match(html, /PONG_SAVED_LINKS_STATE_CACHE_MS\s*=\s*5000/);
  assert.match(
    html,
    /function pongSyncSavedLinksWithPc[\s\S]*?payload\s*=\s*await pongFetchPcSavedLinksState\(endpoint\)/,
  );
  assert.match(
    html,
    /async function restoreSavedEromeMenuFromDb[\s\S]*?await pongFetchPcSavedLinksState\(endpoint\)/,
  );
  assert.match(syncSource, /await window\.PongFetchPcSavedLinksState\(endpoint\)/);
  assert.match(syncSource, /window\.PongRememberPcSavedLinksState\?\.\(payload, endpoint\)/);
});

test('current paperclip captures the entire active bundle in source order', () => {
  const api = loadCollectionRuntime();
  const bundles = api.captureCurrentBundle();
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].bundleKey, 'album-b');
  assert.deepEqual(
    Array.from(bundles[0].videos, video => video.url),
    ['https://cdn.example/b1.mp4', 'https://cdn.example/b2.mp4']
  );
});

test('all-video capture retains bundle boundaries and video order', () => {
  const api = loadCollectionRuntime();
  const bundles = api.captureAllBundles();
  assert.equal(bundles.length, 2);
  assert.deepEqual(
    Array.from(bundles[0].videos, video => video.url),
    ['https://cdn.example/a1.mp4', 'https://cdn.example/a2.mp4']
  );
  assert.deepEqual(
    Array.from(bundles[1].videos, video => video.url),
    ['https://cdn.example/b1.mp4', 'https://cdn.example/b2.mp4']
  );
});

test('collection merge appends new links without duplicating or reordering a bundle', () => {
  const api = loadCollectionRuntime();
  const [bundle] = api.captureCurrentBundle();
  const incoming = structuredClone(bundle);
  incoming.videos = [
    incoming.videos[0],
    { url: 'https://cdn.example/b3.mp4', mediaKey: 'https://cdn.example/b3.mp4', meta: {} }
  ];
  const merged = api.mergeCollections(
    { lau: { id: 'lau', name: 'lau', bundles: [bundle] } },
    { lau: { id: 'lau', name: 'lau', bundles: [incoming] } }
  );
  assert.deepEqual(
    Array.from(merged.lau.bundles[0].videos, video => video.url),
    [
      'https://cdn.example/b1.mp4',
      'https://cdn.example/b2.mp4',
      'https://cdn.example/b3.mp4'
    ]
  );
});

test('newer removal tombstone wins without touching other collections', () => {
  const api = loadCollectionRuntime();
  const active = {
    'collection-lau': {
      id: 'collection-lau', name: 'lau', updatedAt: '2026-09-17T10:00:00.000Z',
      bundles: [{ id: 'bundle-a', label: 'A', videos: [{ url: 'https://cdn.example/a.mp4' }] }]
    },
    'collection-keep': {
      id: 'collection-keep', name: 'keep', updatedAt: '2026-09-17T10:00:00.000Z', bundles: []
    }
  };
  const removedAt = '2026-09-17T11:00:00.000Z';
  const merged = api.mergeCollections(active, {
    'collection-lau': {
      id: 'collection-lau', name: 'lau', updatedAt: removedAt, deletedAt: removedAt, bundles: []
    }
  });
  assert.equal(merged['collection-lau'].deletedAt, removedAt);
  assert.equal(merged['collection-lau'].bundles.length, 0);
  assert.equal(merged['collection-keep'].name, 'keep');
});
