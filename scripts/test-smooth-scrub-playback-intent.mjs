import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sync = readFileSync(new URL('../pong-sync.js', import.meta.url), 'utf8');
const start = sync.indexOf('  function attachSmoothScrubToTapArea(');
const end = sync.indexOf('  function attachSmoothScrubToAllTapAreas(', start);
assert.ok(start >= 0 && end > start);
const attachment = sync.slice(start, end);
const definitions = ['hasVideoPlayableData', 'canResumePongFaceSwapPlayback',
  'restartPongVideoFromBeginning', 'toggleVideoPlaybackFromIntent', 'playVideoCleanly']
  .map(name => html.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0]).join('\n');

function fixture({ readyState = 4, swap = true, legacy = false } = {}) {
  const calls = { plays: 0, delegates: 0, prepares: 0, pausedReports: 0, seeks: [] };
  const listeners = new Map(); let clock = 1000;
  const wrapper = {
    dataset: { userPaused: 'true', playIntent: 'false', pongFaceSwapActive: String(swap), pongFaceSwapSessionId: 'owned' },
    offsetWidth: 400, classList: { remove() {} }, appendChild() {},
    querySelector(selector) {
      if (selector === 'video') return video;
      if (selector === '.video-progress-bar' || selector === '.video-progress-fill') return { style: {}, appendChild() {} };
      return null;
    }
  };
  const video = {
    paused: true, ended: false, muted: true, error: null, readyState, dataset: {},
    currentSrc: swap ? 'http://localhost/pong-swap/sessions/owned/stream' : 'http://fixture.invalid/video.mp4',
    closest: () => wrapper,
    play() { calls.plays++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
  const area = {
    dataset: {}, closest: () => wrapper,
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  const context = vm.createContext({
    window: {}, Date: { now: () => clock }, Promise, Math, Number, String, Boolean, encodeURIComponent,
    setTimeout: () => 0, isNaN, parseFloat,
    document: { createElement: () => ({style:{},classList:{remove(){}}}) }, formatTime: String,
    SCRUB_PIXELS_PER_SECOND: 4,
    pongSyncPlaybackCurrentTime: () => 0, pongSyncPlaybackDuration: () => 60,
    pongSyncSeekPlayback: (_w, _v, time) => calls.seeks.push(time), showSeekFlash() {},
    getVideoBufferedAheadSeconds: () => readyState >= 3 ? 0.4 : 0,
    isVideoReadyForInitialPlayback: () => !swap && readyState >= 3,
    isPongFaceSwapManagedMedia: () => swap,
    seekPongVideoTo: (_w, _v, time) => calls.seeks.push(time),
    markVideoPlayIntent: w => { w.dataset.playIntent = 'true'; },
    isPongActiveVideo: () => true, pongVideoSourceGeneration: () => 1,
    prepareVideoForPlayback() { calls.prepares++; }, applyPlayerAudioPreference() {},
    pausePongFaceSwapTransitionPlayback() {}, silencePongFaceSwapAudioCompanion() {},
    reportPongFaceSwapPlayback(_w, _v, paused) { if (paused) calls.pausedReports++; },
    updateVideoReadyLoader() {}, foregroundPriorityVideo: null,
    SCRUB_START_PX: 34, SCRUB_DOMINANCE_RATIO: 2, VERTICAL_START_PX: 12, VERTICAL_DOMINANCE_RATIO: 1.2
  });
  vm.runInContext(definitions + '\n' + attachment, context);
  context.window.playVideoCleanly = context.playVideoCleanly;
  if (!legacy) context.window.toggleVideoPlaybackFromIntent = (w, v) => {
    calls.delegates++;
    return context.toggleVideoPlaybackFromIntent(w, v);
  };
  context.attachSmoothScrubToTapArea(area);
  const event = x => ({ touches: [{clientX: x, clientY: 100}], changedTouches: [{clientX: x, clientY: 100}],
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const tap = (delay = 600, x = 200) => {
    clock += delay;
    listeners.get('touchstart')(event(x));
    listeners.get('touchend')(event(x));
  };
  return { wrapper, video, calls, context, tap, listeners, event };
}

test('actual smooth-touch handler resumes a user-paused swap below startup reserve', () => {
  const f = fixture(); f.tap();
  assert.equal(f.calls.delegates, 1);
  assert.equal(f.calls.plays, 1);
  assert.equal(f.video.paused, false);
  assert.equal(f.wrapper.dataset.userPaused, undefined);
  assert.equal(f.wrapper.dataset.playIntent, 'true');
});

test('touch pause records intent and the next tap can resume again', async () => {
  const f = fixture(); f.tap(); await Promise.resolve(); await Promise.resolve();
  f.tap();
  assert.equal(f.video.paused, true);
  assert.equal(f.wrapper.dataset.userPaused, 'true');
  assert.equal(f.wrapper.dataset.playIntent, 'false');
  assert.equal(f.calls.pausedReports, 1);
  f.tap();
  assert.equal(f.video.paused, false);
  assert.equal(f.calls.plays, 2);
});

test('settings-style explicit pause remains authoritative until a user tap', async () => {
  const f = fixture();
  await f.context.playVideoCleanly(f.video);
  assert.equal(f.calls.plays, 0);
  f.tap();
  assert.equal(f.calls.plays, 1);
});

test('metadata-only seek waits with play intent and does not force undecoded playback', () => {
  const f = fixture({readyState: 1}); f.tap();
  assert.equal(f.calls.plays, 0);
  assert.equal(f.calls.prepares, 1);
  assert.equal(f.wrapper.dataset.playIntent, 'true');
  assert.equal(f.wrapper.dataset.userPaused, undefined);
  f.tap();
  assert.equal(f.wrapper.dataset.userPaused, 'true');
  assert.equal(f.wrapper.dataset.playIntent, 'false');
});

test('ended swap delegates to the owned-stream restart instead of playing its old fragment', () => {
  const f = fixture(); f.video.ended = true; f.tap();
  assert.deepEqual(f.calls.seeks, [0]);
  assert.equal(f.calls.plays, 0);
  assert.equal(f.wrapper.dataset.playIntent, 'true');
});

test('compatibility touch path clears stale pause on older pages', () => {
  const f = fixture({legacy: true}); f.tap();
  assert.equal(f.calls.plays, 1);
  assert.equal(f.wrapper.dataset.userPaused, undefined);
  f.tap();
  assert.equal(f.wrapper.dataset.userPaused, 'true');
});

test('ordinary video uses the same play intent transition', () => {
  const f = fixture({swap: false}); f.tap();
  assert.equal(f.calls.delegates, 1); assert.equal(f.calls.plays, 1);
});

test('synthetic post-touch click cannot toggle playback a second time', () => {
  const f = fixture(); f.tap(); const click = f.event(200);
  f.listeners.get('click')(click);
  assert.equal(click.prevented, true); assert.equal(click.stopped, true);
  assert.equal(f.calls.delegates, 1);
});

test('double tap retains the seek gesture without a second play/pause transition', () => {
  const f = fixture(); f.tap(600, 350); f.tap(100, 350);
  assert.equal(f.calls.delegates, 1); assert.deepEqual(f.calls.seeks, [10]);
});

test('upper video surface still scrubs in one contact without toggling playback',()=>{
 for(const swap of [false,true]){
  const f=fixture({swap});
  f.listeners.get('touchstart')(f.event(100));
  f.listeners.get('touchmove')(f.event(180));
  assert.equal(f.wrapper.dataset.pendingTime,20);
  f.listeners.get('touchend')(f.event(180));
  assert.deepEqual(f.calls.seeks,[20]);assert.equal(f.calls.delegates,0);
  assert.equal(f.video.currentTime,undefined);assert.equal(f.wrapper.dataset.pendingTime,undefined);
 }
});
