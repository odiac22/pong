import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('./local-ai-server.mjs', import.meta.url), 'utf8');
const sync = await readFile(new URL('./pong-sync.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${name}`);
}

test('Artist Lookup uses the dark control treatment', () => {
  assert.match(html, /#artist-lookup-open\s*\{[^}]*background:\s*linear-gradient\([^}]*rgba\(15,23,42/si);
});

test('video and artist saves use one PC-authoritative store without startup resurrection', () => {
  assert.match(html, /function pongSyncSavedLinksWithPc[\s\S]*\/saved-links\/save/);
  assert.match(html, /async function saveCurrentVideoLink[\s\S]*pongSyncSavedLinksWithPc\(\{ push: true \}\)/);
  assert.match(html, /async function saveCurrentArtistVideos[\s\S]*pongSyncSavedLinksWithPc\(\{ push: true \}\)/);
  assert.match(html, /DOMContentLoaded[\s\S]*pongSyncSavedLinksWithPc\(\)/);
  assert.match(html, /Port 8787 is the single authority/);
  assert.doesNotMatch(html, /Startup reconciliation is two-way/);
  assert.match(server, /PC_SAVED_LINKS_PATH[\s\S]*shared-saved-links-v1\.json/);
  assert.match(server, /\/saved-links\/state/);
  assert.match(server, /\/saved-links\/save/);
});

test('server canonicalization collapses wrapped video aliases and artist aliases', () => {
  const context = vm.createContext({ URL, PORT: 8787 });
  const start = server.indexOf('function emptyPcSavedLinks');
  const end = server.indexOf('function mergePcSavedLinks', start);
  vm.runInContext(server.slice(start, end), context);
  const direct = 'https://cdn.example/storage/media/a/video.mp4?token=one';
  const wrapped = `http://127.0.0.1:8787/video-cache/stream?url=${encodeURIComponent(direct)}`;
  context.input = {
    savedVideos: {
      old: { url: wrapped, savedAt: 'first' },
      newer: { url: direct, updatedAt: 'second' }
    },
    savedArtists: {
      first: { artistKey: 'first', artistUrl: 'https://coomerfans.com/u/onlyfans/1/name/', videos: [wrapped] },
      second: { artistKey: 'second', artistUrl: 'https://coomerfans.com/u/onlyfans/1/name', videos: [direct] }
    }
  };
  const normalized = vm.runInContext('normalizePcSavedLinks(input)', context);
  assert.equal(Object.keys(normalized.savedVideos).length, 1);
  assert.equal(Object.keys(normalized.savedArtists).length, 1);
  assert.equal(Object.values(normalized.savedArtists)[0].videos.length, 1);
});

test('saved playback starts immediately from a bounded five-artist window', () => {
  assert.match(sync, /const SAVED_ARTIST_INITIAL_BACKLOG = 5/);
  assert.match(sync, /const SAVED_ARTIST_PLAYBACK_VIDEO_LIMIT = 15/);
  const start = sync.indexOf('playSavedArtistsRandomized = async function playSavedArtistsRandomizedFast');
  const end = sync.indexOf('\n  function getVisibleCurrentVideoWrapperOverride', start);
  const source = sync.slice(start, end);
  assert.match(source, /artistLimit:\s*SAVED_ARTIST_INITIAL_BACKLOG/);
  assert.doesNotMatch(source, /await buildFreshSavedArtistsPlaybackSource/);
});

test('artist identity comes from the active bundle before a CDN URL', () => {
  assert.match(html, /function getCurrentArtistSaveContext/);
  assert.match(html, /event\.artistKey[\s\S]*event\.bundleKey[\s\S]*metadata\.artistKey[\s\S]*extractArtistKeyFromUrl\(currentUrl\)/);
});

test('saved records persist canonical source URLs instead of temporary Pong wrappers', () => {
  assert.match(sync, /function canonicalSavedMediaUrl/);
  assert.match(sync, /video-cache\\\/stream\|proxy/);
  assert.match(sync, /const canonicalUrl = canonicalSavedMediaUrl\(rawUrl/);
  assert.match(server, /function canonicalPersistentMediaUrl/);
  assert.match(server, /const videosByKey = new Map\(\)/);
  assert.match(server, /canonicalPersistentMediaKey\(url\)/);
});

test('saved artists render from local playback cache before any network refresh', () => {
  const start = sync.indexOf('playSavedArtistsRandomized = async function playSavedArtistsRandomizedFast');
  const end = sync.indexOf('\n  function getVisibleCurrentVideoWrapperOverride', start);
  assert.ok(start >= 0 && end > start);
  const source = sync.slice(start, end);
  const cacheIndex = source.indexOf("loadSavedPlaybackSource('artists')");
  const networkIndex = source.indexOf('fetchSharedDataFromGitHub()');
  assert.ok(cacheIndex >= 0 && networkIndex > cacheIndex);
  assert.match(source, /refreshSavedPlaybackCacheInBackground\('saved artists'\)/);
});

test('failed Saved media moves to the queue tail and launches silent source repair', () => {
  assert.match(sync, /function deferFailedSavedMedia/);
  assert.match(sync, /allVideoUrls\.splice\(insertIndex, 0, url\)/);
  assert.match(sync, /function scheduleAutomaticSavedRepair/);
  assert.match(sync, /directRepairScrapeItem\(item\)/);
});

test('saved Erome playback removes every obsolete nested proxy wrapper', () => {
  const context = vm.createContext({ URL, window: { location: { href: 'http://127.0.0.1:8787/pong' } } });
  vm.runInContext(extractFunction(html, 'rawEromeUrlFromPlayableUrl'), context);
  const direct = 'https://v100.erome.com/8216/album/video_720p.mp4';
  const oldProxy = `https://old-worker.example/erome.mp4?u=${encodeURIComponent(direct)}`;
  const nested = `https://current-worker.example/erome.mp4?u=${encodeURIComponent(oldProxy)}`;
  context.nested = nested;
  assert.equal(vm.runInContext('rawEromeUrlFromPlayableUrl(nested)', context), direct);
});
