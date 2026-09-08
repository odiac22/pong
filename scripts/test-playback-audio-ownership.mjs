import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return html.slice(start, html.indexOf('\nfunction ', start + 1));
}
const videos = [];
const context = vm.createContext({
  DECK_MODE_ENABLED: true,
  window: {},
  document: { querySelectorAll: () => videos },
  Promise,
  applyPlayerAudioPreference: v => { v.muted = false; v.volume = 1; }
});
for (const name of ['isPongActiveVideo', 'silencePongVideo', 'pauseOtherVideos']) {
  vm.runInContext(source(name), context);
}
// Use the production playback function without the following window exports.
vm.runInContext(source('playVideoCleanly').split('\nwindow.getAdaptiveScrubTime')[0], context);
context.prepareVideoForPlayback = v => { context.pauseOtherVideos(v); context.window.currentlyPlayingVideo = v; };
function video(active) {
  const classes = new Set(active ? ['deck-active'] : []);
  const wrapper = { dataset: { playIntent: 'true' }, classList: { contains: k => classes.has(k), remove: k => classes.delete(k) } };
  const v = { isConnected: true, muted: false, volume: 1, paused: false, dataset: {}, closest: () => wrapper, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  videos.push(v);
  return { v, classes, wrapper };
}
const old = video(true), next = video(false);
let resolvePlay;
old.v.play = () => new Promise(resolve => { resolvePlay = resolve; });
const pending = context.playVideoCleanly(old.v);
old.classes.delete('deck-active');
next.classes.add('deck-active');
context.pauseOtherVideos(next.v);
assert.equal(old.v.muted, true);
assert.equal(old.v.volume, 0);
assert.equal(old.v.paused, true);
assert.equal(old.wrapper.dataset.playIntent, undefined);
old.v.paused = false; // Simulate a late native play completion after navigation.
resolvePlay();
await pending;
assert.equal(old.v.paused, true);
assert.equal(old.v.muted, true);
await context.playVideoCleanly(old.v);
assert.equal(old.v.paused, true);
await context.playVideoCleanly(next.v);
assert.equal(next.v.paused, false);
assert.equal(next.v.muted, false);
next.v.isConnected = false;
await context.playVideoCleanly(next.v);
assert.equal(next.v.paused, true);
assert.equal(next.v.muted, true);
console.log('PASS: outgoing audio silenced; delayed play cancelled; inactive/detached playback blocked; active playback preserved.');
