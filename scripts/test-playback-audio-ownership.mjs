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
  pongVideoSourceGeneration: v => Number(v?.dataset?.sourceGeneration || 0),
  silencePongFaceSwapAudioCompanion: () => {},
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

// A face-swap stream is intentionally video-only. Verify that the active
// original-media companion owns audible playback while the visible stream
// remains muted, and that the persisted preference controls both paths.
let companion = null;
const audioButton = { innerHTML: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
const swapClasses = new Set(['deck-active']);
const swapWrapper = {
  dataset: { pongFaceSwapActive: 'true', playIntent: 'true' },
  classList: { contains: key => swapClasses.has(key), remove: key => swapClasses.delete(key) },
  querySelector(selector) {
    if (selector === '.pong-face-swap-audio') return companion;
    if (selector === '.audio-toggle-button') return audioButton;
    return null;
  },
  appendChild(value) { companion = value; value.parentNode = this; }
};
const swapVideo = {
  tagName: 'VIDEO',
  isConnected: true,
  muted: false,
  defaultMuted: false,
  volume: 1,
  paused: false,
  playbackRate: 1,
  currentTime: 2,
  __pongSwapOriginal: { source: 'https://example.test/original.mp4', startSeconds: 5 },
  closest: () => swapWrapper,
  pause() { this.paused = true; }
};
function fakeAudio() {
  return {
    tagName: 'AUDIO', classList: { contains: () => false },
    className: '', style: {}, dataset: {}, readyState: 1, duration: 60, currentTime: 0,
    muted: true, defaultMuted: true, volume: 0, paused: true, playbackRate: 1,
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, load() {},
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }, remove() { companion = null; }
  };
}
let visibleFrame = true, activeSwapVideo = true;
const leakedRetainedVideo = {
  tagName: 'VIDEO', muted: false, defaultMuted: false, volume: 1, paused: false,
  classList: { contains: () => false }
};
const swapContext = vm.createContext({
  window: { pongUserWantsAudio: true },
  navigator: { userAgent: 'Android' },
  document: {
    createElement: tag => { const media = fakeAudio(); media.tagName = tag.toUpperCase(); return media; },
    querySelectorAll: () => [swapVideo, leakedRetainedVideo, ...(companion ? [companion] : [])]
  },
  releasePongHlsController: () => {},
  setPongVideoSource: (media, source) => { media.src = source; },
  pongFaceSwapAbsoluteTime: () => 7,
  pongVideoHasVisibleFrame: () => visibleFrame,
  isPongActiveVideo: () => activeSwapVideo,
  silencePongVideo: () => {},
  localStorage: { setItem() {} },
  Math, Number, String, Boolean, Promise
});
for (const name of [
  'pongFaceSwapAudioNeedsVideoElement', 'pongFaceSwapAudioCompanion', 'alignPongFaceSwapAudioCompanion',
  'silenceAllPongAudioExcept',
  'syncPongFaceSwapAudioCompanion', 'silencePongFaceSwapAudioCompanion',
  'destroyPongFaceSwapAudioCompanion', 'unmuteSafely', 'updatePlayerAudioButton',
  'rememberPlayerAudioPreference', 'applyPlayerAudioPreference'
]) vm.runInContext(source(name), swapContext);

swapContext.window.pongUserWantsAudio = false;
for (let i = 0; i < 20; i++) swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo);
assert.equal(companion, null, 'muted swap must not create or fetch an unused audio reader');
swapContext.window.pongUserWantsAudio = true;
swapVideo.paused = true;
swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo);
assert.equal(companion, null, 'paused swap must not fetch an audio source before playback');
swapVideo.paused = false;
visibleFrame = false;
swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo);
assert.equal(companion, null, 'unpresented swap must not fetch audio');
visibleFrame = true;
swapContext.applyPlayerAudioPreference(swapVideo, swapWrapper, true);
assert.equal(swapVideo.muted, true, 'video-only transformed stream must remain muted');
assert.ok(companion, 'original-audio companion should be created');
assert.equal(companion.src, 'https://example.test/original.mp4');
assert.equal(companion.currentTime, 7, 'companion should align to absolute playback time');
assert.equal(companion.muted, false);
assert.equal(companion.paused, false);
assert.equal(audioButton.attributes['data-muted'], 'false');

visibleFrame = false;
swapContext.applyPlayerAudioPreference(swapVideo, swapWrapper, true);
assert.equal(companion.muted, true, 'audio must be muted when the transformed video has no presented frame');
assert.equal(companion.paused, true, 'audio must stop instead of bleeding through a black loading screen');

visibleFrame = true;
swapContext.applyPlayerAudioPreference(swapVideo, swapWrapper, true);
assert.equal(companion.muted, false, 'audio may resume only after a visible frame is presented');
assert.equal(companion.paused, false);

// A queued play intent is not playback ownership. The transformed video can
// remain paused while a stream is being adopted, buffering, or after a failed
// play request; its original-media companion must never run by itself.
swapVideo.paused = true;
swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo, { play: true, force: true });
assert.equal(companion.muted, true, 'paused transformed video must keep companion audio muted');
assert.equal(companion.paused, true, 'play intent must not leak audio while the video is paused');
assert.equal(leakedRetainedVideo.muted, true, 'pausing the active swap must mute every retained video');
assert.equal(leakedRetainedVideo.volume, 0, 'retained videos cannot keep audible volume');
swapVideo.paused = false;
swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo, { play: true, force: true });
assert.equal(companion.muted, false, 'companion audio may resume after actual video playback resumes');
assert.equal(companion.paused, false);

activeSwapVideo = false;
leakedRetainedVideo.muted = false;
leakedRetainedVideo.volume = 1;
swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo, { force: true });
assert.equal(companion.paused, true, 'inactive card silences only its own companion');
assert.equal(leakedRetainedVideo.muted, false, 'inactive seek/timeupdate must not mute the new foreground owner');
assert.equal(leakedRetainedVideo.volume, 1);
activeSwapVideo = true;
swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo, { force: true });
assert.equal(companion.paused, false);

// Repeated ownership/playing notifications must not seek an aligned decoder.
let alignmentTime = companion.currentTime, alignmentWrites = 0;
Object.defineProperty(companion, 'currentTime', {
  configurable: true,
  get: () => alignmentTime,
  set: value => { alignmentTime = value; alignmentWrites++; }
});
for (let i = 0; i < 10; i++) {
  swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo, { force: true });
}
assert.equal(alignmentWrites, 0, 'forced ownership refresh must not restart an aligned decoder');
alignmentTime = 6;
swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo, { force: true });
assert.equal(alignmentWrites, 1, 'a real timeline change must still seek');
assert.equal(alignmentTime, 7);

swapContext.window.pongUserWantsAudio = false;
swapContext.applyPlayerAudioPreference(swapVideo, swapWrapper, false);
assert.equal(companion.muted, true);
assert.equal(companion.paused, true);
assert.equal(audioButton.attributes['data-muted'], 'true');
alignmentTime = 1;
alignmentWrites = 0;
for (let i = 0; i < 20; i++) swapContext.syncPongFaceSwapAudioCompanion(swapWrapper, swapVideo, { force: true });
assert.equal(alignmentWrites, 0, 'muted timeupdates must not seek the retained audio decoder');
assert.equal(companion.paused, true);

// Android's native HLS stack requires a video element for muxed A/V HLS.
// Verify that the companion is rebuilt with the compatible tag while direct
// MP4 sources continue to use the cheaper audio element.
companion = null;
swapVideo.__pongSwapOriginal.source = 'https://example.test/generic-media/hls?url=manifest';
swapContext.window.pongUserWantsAudio = true;
swapContext.applyPlayerAudioPreference(swapVideo, swapWrapper, true);
assert.equal(companion.tagName, 'VIDEO', 'muxed HLS companion must use Android-compatible video pipeline');
assert.equal(companion.muted, false);
assert.equal(companion.paused, false);

console.log('PASS: outgoing audio ownership, delayed-play cancellation, and synchronized face-swap audio preference verified.');

// A direct play gesture on a cold Recall video must persist audio intent
// before readiness; otherwise first playback starts muted and needs a second
// tap after the source becomes playable.
let rememberedAudio = false, unmutedCold = false;
const coldWrapper = {
  dataset: {},
  querySelector: () => ({ textContent: '', setAttribute() {} })
};
const coldContext = vm.createContext({
  Date,
  rememberPlayerAudioPreference: value => { rememberedAudio = value; },
  isVideoReadyForInitialPlayback: () => false,
  unmuteSafely: () => { unmutedCold = true; }
});
vm.runInContext(source('markVideoPlayIntent'), coldContext);
coldContext.markVideoPlayIntent(coldWrapper, { muted: true });
assert.equal(rememberedAudio, true, 'cold direct play must persist audio intent immediately');
assert.equal(unmutedCold, false, 'cold media stays silent until a real frame is playable');
assert.equal(coldWrapper.dataset.userAudioIntent, 'true');
