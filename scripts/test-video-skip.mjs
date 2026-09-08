import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sync = fs.readFileSync(new URL('../pong-sync.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `Missing ${name}`);
  const signatureTail = html.slice(start).match(/\)\s*\{/);
  assert.ok(signatureTail, `Missing body for ${name}`);
  const open = start + signatureTail.index + signatureTail[0].lastIndexOf('{');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${name}`);
}

function makeContext(extra = {}) {
  const context = vm.createContext({
    URL,
    window: { location: { href: 'https://odiac22.github.io/pong/' } },
    location: { href: 'https://odiac22.github.io/pong/' },
    ...extra
  });
  for (const name of [
    'eromeMediaDescriptor',
    'eromeMediaKey',
    'pongCanonicalPlayedValue',
    'pongVideoSkipKeys',
    'isPongVideoSessionSkipped'
  ]) vm.runInContext(extractFunction(name), context);
  return context;
}

test('a proxied URL and its direct source share a stable skip key', () => {
  const direct = 'https://cdn.example/video/clip.mp4?token=first';
  const proxy = `http://127.0.0.1:8787/video-cache/stream?url=${encodeURIComponent(direct)}&profile=bunkr`;
  const context = makeContext({ sessionSkippedVideoKeys: new Set() });
  const directKeys = vm.runInContext(`pongVideoSkipKeys(${JSON.stringify(direct)})`, context);
  const proxyKeys = vm.runInContext(`pongVideoSkipKeys(${JSON.stringify(proxy)})`, context);
  assert.ok(directKeys.some(key => proxyKeys.includes(key)));

  directKeys.forEach(key => context.sessionSkippedVideoKeys.add(key));
  assert.equal(vm.runInContext(`isPongVideoSessionSkipped(${JSON.stringify(proxy)})`, context), true);
});

test('removing one video keeps bundle counts and following starts aligned', () => {
  const context = makeContext({
    allVideoUrls: ['a', 'b', 'c', 'd', 'e'],
    allVideoMetadata: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
    pasteEvents: [
      { startIndex: 0, count: 3, name: 'first' },
      { startIndex: 3, count: 2, name: 'second' }
    ],
    currentPasteIndex: 0,
    activePlaybackRange: { start: 0, end: 3 },
    random40PlaybackUrlOverrides: new Map(),
    random40ServerVideoCacheTracked: new Map()
  });
  vm.runInContext(extractFunction('removePongVideoRecord'), context);
  vm.runInContext('removePongVideoRecord(1)', context);
  assert.deepEqual([...context.allVideoUrls], ['a', 'c', 'd', 'e']);
  assert.deepEqual(context.pasteEvents.map(event => [event.startIndex, event.count]), [[0, 2], [2, 2]]);
  assert.deepEqual({ ...context.activePlaybackRange }, { start: 0, end: 2 });
});

test('the Sync panel exposes the video skip control immediately after Sync', () => {
  const syncIndex = sync.indexOf("panel.appendChild(tokenBtn);");
  const skipIndex = sync.indexOf("panel.appendChild(skipVideoBtn);");
  assert.ok(syncIndex >= 0 && skipIndex > syncIndex);
  assert.match(sync, /id = 'skip-current-video-button'/);
  assert.match(html, /window\.PongSkipCurrentVideo = skipCurrentPongVideo/);
});
