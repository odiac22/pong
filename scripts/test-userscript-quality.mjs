import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../universal-video-scraper.user.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start + 2);
  const next = tail.search(/\n  (?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next);
}
const page = 'https://fixture.invalid/watch/one';
const entry = (id, extra = {}) => ({ videoUrl: `https://media.invalid/assets/one/${id}.mp4`, durationSeconds: 45, ...extra });
function harness(metadata = {}, failed = []) {
  const probes = [], reads = [];
  const ctx = vm.createContext({ URL, location: { href: page },
    probeCapturedDuration: async () => 45,
    probeCapturedMetadata: async url => { reads.push(url); return metadata[url] || {}; },
    probeCapturedMediaUrl: async url => { probes.push(url); return !failed.includes(url); },
  });
  vm.runInContext(['diagnosticNumber', 'renditionQualitySummary', 'compareRenditionQuality', 'firstVerifiedRecallEntry'].map(fn).join('\n'), ctx);
  return { run: entries => ctx.firstVerifiedRecallEntry(entries, page), probes, reads };
}
test('opaque 1080p rendition beats first reachable 360p and current 720p', async () => {
  const low = entry('a'), high = entry('b'), live = entry('c', { width: 1280, height: 720, qualityEvidence: 'live_decoder', browserCurrent: true });
  const h = harness({ [low.videoUrl]: { width: 640, height: 360, durationSeconds: 45 }, [high.videoUrl]: { width: 1920, height: 1080, durationSeconds: 45 } });
  const result = await h.run([low, live, high]);
  assert.equal(result.videoUrl, high.videoUrl);
  assert.deepEqual(h.probes, [high.videoUrl]);
  assert.equal(h.reads.includes(live.videoUrl), false);
  assert.equal(result.qualitySelection.browser.height, 720);
  assert.equal(result.qualitySelection.selected.height, 1080);
});
test('decoder measurements override misleading labels', async () => {
  const a = entry('a', { height: 2160, qualityEvidence: 'player_label' }), b = entry('b', { height: 360 });
  const h = harness({ [a.videoUrl]: { width: 640, height: 360 }, [b.videoUrl]: { width: 1920, height: 1080 } });
  assert.equal((await h.run([a, b])).videoUrl, b.videoUrl);
});
test('unavailable best source has explicit fallback to reachable 720p', async () => {
  const a = entry('a', { height: 1080 }), b = entry('b', { height: 720 });
  const h = harness({}, [a.videoUrl]);
  const result = await h.run([b, a]);
  assert.equal(result.videoUrl, b.videoUrl);
  assert.equal(result.qualitySelection.fallback, true);
  assert.equal(result.qualitySelection.failedHigherRankedCount, 1);
});
test('higher-resolution short preview is rejected by measured duration', async () => {
  const a = entry('a'), b = entry('b');
  const h = harness({ [a.videoUrl]: { width: 3840, height: 2160, durationSeconds: 5 }, [b.videoUrl]: { width: 1280, height: 720, durationSeconds: 45 } });
  const result = await h.run([a, b]);
  assert.equal(result.videoUrl, b.videoUrl);
  assert.equal(result.qualitySelection.rejectedDurationCount, 1);
});
test('failed metadata preserves labels, reports unknown dimensions honestly', async () => {
  const h = harness();
  const result = await h.run([entry('a'), entry('b', { height: 720, qualityEvidence: 'player_label' })]);
  assert.equal(result.height, 720);
  assert.equal(result.qualitySelection.unresolvedQualityCount, 1);
  assert.equal(result.qualitySelection.selected.evidence, 'player_label');
});
test('pixel area handles portrait vs landscape; equal area uses FPS then bitrate', async () => {
  const h = harness();
  const portrait = entry('p', { width: 1080, height: 1920, fps: 30 }), landscape = entry('l', { width: 1920, height: 1080, fps: 60 });
  assert.equal((await h.run([portrait, landscape])).videoUrl, landscape.videoUrl);
  landscape.fps = 30; portrait.bitrate = 8e6; landscape.bitrate = 4e6;
  assert.equal((await h.run([landscape, portrait])).videoUrl, portrait.videoUrl);
});
test('known single stream avoids additional metadata requests', async () => {
  const h = harness();
  assert.ok(await h.run([entry('one', { height: 720 })]));
  assert.equal(h.reads.length, 0);
});
test('adaptive manifests retain existing path and explicitly flag scope', async () => {
  const h = harness();
  const result = await h.run([entry('a', { height: 720 }), { videoUrl: 'https://media.invalid/master.m3u8', durationSeconds: 45, height: 1080, qualityEvidence: 'resolver' }]);
  assert.equal(result.qualitySelection.adaptiveManifest, true);
  assert.equal(h.reads.some(url => url.endsWith('.m3u8')), false);
});
test('quality diagnostics contain no URL, title, cookie or query secret', async () => {
  const h = harness();
  const result = await h.run([entry('a', { title: 'SECRET', cookie: 'SECRET' }), entry('b', { height: 1080 })]);
  assert.doesNotMatch(JSON.stringify(result.qualitySelection), /SECRET|https:|fixture|media\.invalid|title|cookie/);
});
test('known lower-resolution manifest does not outrank a higher-resolution progressive source', async () => {
  const h = harness();
  const high = entry('high', { width: 1920, height: 1080 });
  const result = await h.run([{ videoUrl: 'https://media.invalid/low.m3u8', durationSeconds: 45, height: 720 }, high]);
  assert.equal(result.videoUrl, high.videoUrl);
});
test('cancelled metadata work never reaches media verification or delivery', async () => {
  const h = harness();
  // An aborted signal is checked before each metadata task and before ranking.
  const ctx = vm.createContext({ location: { href: page }, probeCapturedDuration: async () => 45,
    probeCapturedMetadata: () => assert.fail('metadata after abort'), probeCapturedMediaUrl: () => assert.fail('verification after abort') });
  vm.runInContext(['diagnosticNumber','renditionQualitySummary','compareRenditionQuality','firstVerifiedRecallEntry'].map(fn).join('\n'), ctx);
  assert.equal(await ctx.firstVerifiedRecallEntry([entry('a'), entry('b')], page, 45, 30, [], { aborted: true }), null);
});
test('every unavailable source returns no verified entry', async () => {
  const a = entry('a'), b = entry('b');
  assert.equal(await harness({}, [a.videoUrl, b.videoUrl]).run([a, b]), null);
});
test('metadata probe is detached, muted, never plays and cleans up source', async () => {
  let cleaned = false, played = false;
  const video = { videoWidth: 1920, videoHeight: 1080, duration: 45, readyState: 1,
    removeAttribute() { cleaned = true; }, load() {}, play() { played = true; throw Error('Forbidden'); },
    set src(value) { assert.equal(this.muted, true); assert.equal(this.volume, 0); queueMicrotask(() => this.onloadedmetadata()); } };
  const ctx = vm.createContext({ setTimeout, clearTimeout, document: { createElement: () => video },
    diagnosticRequest: () => ({}), finishDiagnosticRequest() {} });
  vm.runInContext(fn('diagnosticNumber') + fn('probeCapturedMetadata'), ctx);
  const result = await ctx.probeCapturedMetadata('https://media.invalid/one.mp4');
  assert.equal(result.height, 1080); assert.ok(cleaned); assert.equal(played, false);
  assert.equal(video.onloadedmetadata, null);
});
