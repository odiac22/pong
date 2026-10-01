import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../local-ai-server.mjs', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers.reduce((found, marker) => {
    const index = source.indexOf(marker);
    return index >= 0 && (found < 0 || index < found) ? index : found;
  }, -1);
  assert.notEqual(start, -1, `Missing ${name}`);
  const signatureTail = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureTail, `Missing body for ${name}`);
  const open = start + signatureTail.index + signatureTail[0].lastIndexOf('{');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
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
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${name}`);
}

test('TikTok entries are ordered by public popularity metrics, not extractor recency', () => {
  const context = vm.createContext({
    URL,
    Number,
    String,
    Map,
    isTikTokVideoPageUrl: value => /tiktok\.com\/@[^/]+\/video\/\d+/i.test(value)
  });
  for (const name of ['tiktokMetricNumber', 'tiktokVideoEntry', 'sortTikTokVideoEntries']) {
    vm.runInContext(extractFunction(server, name), context);
  }
  const result = JSON.parse(vm.runInContext(`JSON.stringify(sortTikTokVideoEntries([
    { url: 'https://www.tiktok.com/@artist/video/7000000000000000003', viewCount: 120, likeCount: 20, timestamp: 30 },
    { url: 'https://www.tiktok.com/@artist/video/7000000000000000002', viewCount: 900, likeCount: 10, timestamp: 20 },
    { url: 'https://www.tiktok.com/@artist/video/7000000000000000001', viewCount: 900, likeCount: 50, timestamp: 10 }
  ]))`, context));
  assert.deepEqual(result.map(entry => entry.id), [
    '7000000000000000001',
    '7000000000000000002',
    '7000000000000000003'
  ]);
});

test('TikTok extractor retains engagement fields used by popular-first ordering', () => {
  const extractor = extractFunction(server, 'extractTikTokVideoEntries');
  assert.match(extractor, /%\(view_count\)s/);
  assert.match(extractor, /%\(like_count\)s/);
  assert.match(extractor, /sortTikTokVideoEntries\(entries\)/);
  const route = server.slice(server.indexOf("url.pathname === '/tiktok/profile'"));
  assert.match(route, /sort:\s*'popular'/);
  assert.match(route, /const videos = videoEntries\.map\(entry => entry\.url\)/);
});

test('metadata-only 8 percent video remains eligible for first-frame recovery', () => {
  const watchdog = extractFunction(html, 'scheduleForegroundNoLoadRetry');
  assert.match(watchdog, /video\.readyState\s*>=\s*2/);
  assert.doesNotMatch(watchdog, /video\.readyState\s*>=\s*1\s*\|\|/);

  const renderStart = html.indexOf('function createVideoElements(');
  const renderEnd = html.indexOf('\nfunction ', renderStart + 1);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const bindings = html.slice(renderStart, renderEnd);
  assert.match(
    bindings,
    /addEventListener\('loadedmetadata',[\s\S]*?isPongActiveVideo\(video\)[\s\S]*?scheduleForegroundNoLoadRetry\(video\)/
  );
});

test('Paperclip deck creation reaches activation and retry setup', () => {
  // This function contains nested template/regex syntax that the lightweight
  // brace counter above does not parse; use the next top-level declaration as
  // its exact boundary rather than silently truncating the activation tail.
  const start = html.indexOf('function createVideoElements(');
  const end = html.indexOf('\nfunction setupVisibilityObserver(', start);
  assert.ok(start >= 0 && end > start);
  const render = html.slice(start, end);
  assert.doesNotMatch(render, /schedulePongAutoSkipVideo\(target,\s*video\)/);
  assert.match(render, /if \(appendOnly\) \{[\s\S]*?schedulePongFaceSwapPrefetch\(0\);\s*return;\s*\}/);
  assert.match(
    render,
    /updateNextBatchButton\(\);[\s\S]*?setupVisibilityObserver\(\);\s*warmCurrentBatchVideos\(\);\s*startVisibleBatchAutoRetry\(\);/
  );
});

test('purple TikTok navigation explicitly authorizes the hidden side deck', () => {
  const enter = extractFunction(html, 'enterSimpCityTikTokSideDeck');
  const display = extractFunction(html, 'displayPasteEventAtIndex');
  const setRange = extractFunction(html, 'setActivePlaybackRangeForPasteEvent');

  assert.match(enter, /allowTikTokSideDeck:\s*true/);
  assert.match(display, /authorizedTikTokSideDeck/);
  assert.match(display, /allowTikTokSideDeck:\s*authorizedTikTokSideDeck/);
  assert.match(setRange, /allowTikTokSideDeck/);
  assert.match(setRange, /hasPlayablePasteEventMedia\(target\)/);
});

test('direct Recall gateway normalizes generic MP4 and MOV MIME types for Android', () => {
  const gateway = extractFunction(server, 'streamGatewayResponse');
  assert.match(gateway, /mp4\|m4v\|mov/);
  assert.match(gateway, /application\\\/octet-stream/);
  assert.match(gateway, /headers\['content-type'\]\s*=\s*'video\/mp4'/);
});
