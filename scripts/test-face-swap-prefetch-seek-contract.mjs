import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(SCRIPT_DIR, '..', 'index.html');
const SYNC_PATH = path.resolve(SCRIPT_DIR, '..', 'pong-sync.js');
const [source, syncSource] = await Promise.all([
  readFile(INDEX_PATH, 'utf8'),
  readFile(SYNC_PATH, 'utf8'),
]);

function namedFunction(name, input = source) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(input);
  assert(match, `${name}() is missing from index.html`);
  const start = match.index;
  const parametersStart = input.indexOf('(', start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < input.length; index++) {
    if (input[index] === '(') parameterDepth++;
    if (input[index] === ')' && --parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const bodyStart = input.indexOf('{', parametersEnd + 1);
  assert.notEqual(bodyStart, -1, `${name}() has no body`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return input.slice(start, index + 1);
  }
  assert.fail(`${name}() body is unterminated`);
}

test('only the immediate next swap owns a bounded Android reader', () => {
  assert.match(
    source,
    /\bconst\s+PONG_FACE_SWAP_ATTACHMENT_COUNT\s*=\s*1\s*;/,
    'exactly one prepared destination may consume an Android decoder or HTTP slot',
  );
  const schedule = namedFunction('schedulePongFaceSwapPrefetch');
  assert.match(
    schedule,
    /const\s+withinDeckBudget\s*=\s*paperclipPredictions\.length[\s\S]*?PONG_FACE_SWAP_PREFETCH_COUNT\s*-\s*1[\s\S]*?:\s*PONG_FACE_SWAP_PREFETCH_COUNT/,
    'the next swipe and the predicted Paperclip destination must share the bounded preparation budget',
  );
  assert.match(
    schedule,
    /\.filter\([\s\S]*?wrapper\.dataset\.viewed\s*!==\s*['"]true['"][\s\S]*?\.slice\(0,\s*withinDeckBudget\)/,
    'only the remaining within-deck budget may enter speculative preparation',
  );
  assert.match(
    schedule,
    /const\s+attachRequested\s*=\s*jobIndex\s*===\s*0/,
    'only the immediate next card may attach a prepared media element',
  );
  assert.match(
    schedule,
    /if\s*\(preparedJobs\[0\]\)\s*await\s+createPreparedJob\(preparedJobs\[0\],\s*0\)/,
    'the immediate next card must enter the speculative GPU lane before farther cards',
  );
  const attach = namedFunction('attachPongFaceSwapPrefetch');
  assert.doesNotMatch(
    attach,
    /video\.style\.cssText\s*=\s*['"][^'"]*display\s*:\s*none/i,
    'the sole hidden reader must stay laid out off-screen so Android is allowed to decode it',
  );
  assert.match(
    attach,
    /left:\s*-10000px[\s\S]*?top:\s*-10000px/,
    'the laid-out warm reader must remain fully outside the visible viewport',
  );
  assert.match(
    namedFunction('claimPongFaceSwapAttachedVideo'),
    /entry\.ready\s*!==\s*true[\s\S]*?entry\.browserReady\s*!==\s*true[\s\S]*?pongFaceSwapHeld\s*!==\s*['"]true['"]/,
    'an undecoded Paperclip reader must stay isolated instead of poisoning the new visible media element',
  );
  assert.match(schedule, /desiredAttachmentKeys\.add\(job\.key\)/);
  assert.match(
    schedule,
    /desiredAttachmentKeys\.has\(key\)[\s\S]*?!entry\.attached[\s\S]*?attachPongFaceSwapPrefetch\(entry/,
    'the next card must claim the decoder after the prior attachment is released',
  );
});

test('prepared swap identity survives Pong transport upgrades', () => {
  const context = {
    URL,
    document: { documentElement: { classList: { contains: () => false } } },
    location: { href: 'http://192.168.1.124:8787/pong' },
    window: { location: { href: 'http://192.168.1.124:8787/pong' } },
  };
  const sourceKey = vm.runInNewContext(
    `${namedFunction('pongCanonicalRawMediaUrl')}\n${namedFunction('pongFaceSwapRestorationProfile')}\n${namedFunction('pongFaceSwapSourceKey')}\npongFaceSwapSourceKey`,
    context,
  );
  const direct = 'https://cdn.example/video.mp4?token=abc&exp=123';
  const variants = [
    direct,
    `/proxy?url=${encodeURIComponent(direct)}`,
    `/video-cache/stream?url=${encodeURIComponent(direct)}`,
    `/erome.mp4?u=${encodeURIComponent(direct)}`,
  ];
  const keys = variants.map(value => sourceKey('approved-face', value, 0));
  assert.equal(new Set(keys).size, 1, 'all Pong transports must adopt the same prepared swap');
});

test('swap sessions can race one verified direct-media route against Pong cache', () => {
  const alternatives = namedFunction('pongFaceSwapAlternateSources');
  const prefetch = namedFunction('createPongFaceSwapPrefetchForSource');
  const start = namedFunction('startPongFaceSwap');
  assert.match(alternatives, /mp4\|m4v\|mov\|webm\|mkv\|m3u8\|ts/);
  assert.match(prefetch, /sourceUrls:\s*Array\.isArray\(sourceUrls\)/);
  assert.match(start, /sourceUrls:\s*playable\.sourceUrls/);
});

test('a recycled Paperclip video cannot report its old CDN source as swap-ready', () => {
  const attach = namedFunction('attachPongFaceSwapPrefetch');
  assert.match(
    attach,
    /const\s+ownsAttachedStream\s*=\s*\(\)\s*=>/,
    'attachment readiness must identify the stream actually selected by the decoder',
  );
  assert.match(
    attach,
    /entry\.browserReady\s*=\s*ownsAttachedStream\(\)\s*&&\s*Number\(video\.readyState/,
    'readyState from the prior CDN resource must not make the held swap adoptable',
  );
  assert.doesNotMatch(
    attach,
    /video\.src\s*=\s*attachedStreamHref;\s*if\s*\(video\.readyState/,
    'src replacement must wait for a new-resource event instead of reading stale readiness synchronously',
  );
});

test('persistent swipe activates the prepared target before retiring the old reader', () => {
  const start = namedFunction('startPongFaceSwap');
  assert.match(start, /prefetchedEntry/, 'startPongFaceSwap must accept an explicitly prepared entry');
  assert.match(start, /preserveCurrentUntilActivation/, 'replacement activation must support keeping the visible reader alive');
  assert.match(
    start,
    /if\s*\(\s*!preopened\s*\)\s*\{[\s\S]*?video\.src\s*=/,
    'src assignment must be confined to the non-preopened fallback',
  );
  assert.match(
    start,
    /if\s*\(\s*!preopened\s*\)\s*\{[\s\S]*?video\.src\s*=[\s\S]*?video\.load\s*\(/,
    'a foreground miss must explicitly start WebView media selection',
  );
  assert.match(
    start,
    /let\s+preopened\s*=\s*Boolean[\s\S]*?activateResponse\.status\s*===\s*404[\s\S]*?preopened\s*=\s*false[\s\S]*?payload\s*=\s*await\s+createForegroundSession\(\)/,
    'an expired attached prefetch must rebind WebView to its replacement foreground session',
  );

  const stage = namedFunction('stagePongFaceSwapOutgoingWrapper');
  assert.match(stage, /video\.pause\(\)/, 'the outgoing reader must stop local playback immediately');
  assert.match(stage, /video\.muted\s*=\s*true/, 'the outgoing reader must be locally silenced');
  assert.match(stage, /outgoingWrappers\.add\(wrapper\)/, 'the outgoing reader must remain tracked until commit');
  assert.doesNotMatch(stage, /fetch\s*\(/, 'navigation staging must not issue DELETE before target activation');
  assert.doesNotMatch(stage, /removeAttribute\s*\(\s*['"]src['"]/, 'navigation staging must not detach src before activation');
  assert.doesNotMatch(stage, /\.load\s*\(/, 'navigation staging must not reload the old reader before activation');
  assert.doesNotMatch(stage, /stopPongFaceSwapForWrapper/, 'navigation staging must not enter destructive stop logic');

  const deck = namedFunction('setDeckActiveIndex');
  assert.match(
    deck,
    /pongFaceSwapState\.enabled\)\s*stagePongFaceSwapOutgoingWrapper\(oldWrapper\)/,
    'persistent deck navigation must stage, not stop, the old swap',
  );
  assert.doesNotMatch(
    deck,
    /stopPongFaceSwapForWrapper\(oldWrapper,\s*\{\s*restore:\s*!pongFaceSwapState\.enabled/,
    'persistent deck navigation must not tear down the old stream before target activation',
  );

  assert.match(
    start,
    /presentedSessionMatches[\s\S]*?setTimeout\(\(\)\s*=>\s*retirePongFaceSwapOutgoingWrappers/,
    'old readers may be detached only after the target session has presented a frame',
  );
  const stop = namedFunction('stopPongFaceSwapForWrapper');
  assert.match(
    stop,
    /else\s+if\s*\(\s*!restore\s*&&\s*detachMedia\s*\)[\s\S]*?removeAttribute\(['"]src['"]\)[\s\S]*?video\.load\(\)/,
    'committed retirement must release the old WebView streaming connection',
  );
  assert.match(
    stop,
    /if\s*\(sessionId\s*&&\s*!skipServerStop\)/,
    'post-activation local retirement must be able to skip a redundant server DELETE',
  );
  assert.match(
    stop,
    /const\s+stopUrl\s*=\s*`[^`]*\$\{restore\s*\?\s*''\s*:\s*'\?defer=1'\}/,
    'a swiped-away session must defer native teardown so its DELETE cannot block the next /activate',
  );

  const toggle = namedFunction('setPongFaceSwapPersistentEnabled');
  assert.match(toggle, /exceptWrapper:\s*pongFaceSwapCurrentWrapper\(\)/,
    'explicit face-off must leave the foreground reader for the restore:true handler');
  assert.match(namedFunction('renderPongFaceSwapMenu'), /restore:\s*true,\s*announce:\s*true/);
  assert.match(namedFunction('renderPongFaceSwapPicker'), /restore:\s*true,\s*announce:\s*true/);
});

test('outgoing swap staging is a local pause/mute operation with no network or source mutation', () => {
  const video = {
    paused: false,
    muted: false,
    defaultMuted: false,
    volume: 1,
    pauseCalls: 0,
    pause() { this.paused = true; this.pauseCalls++; },
  };
  const removedClasses = [];
  const wrapper = {
    dataset: { pongFaceSwapActive: 'true', playIntent: 'true' },
    querySelector: selector => selector === 'video' ? video : null,
    classList: { remove: value => removedClasses.push(value) },
  };
  const state = { enabled: true, selectedFaceId: 'face-1', outgoingWrappers: new Set() };
  let companionSilenceCalls = 0;
  const context = {
    pongFaceSwapState: state,
    capturePongFaceSwapNavigationPlaybackIntent: vm.runInNewContext(
      `(${namedFunction('capturePongFaceSwapNavigationPlaybackIntent')})`,
      { pongFaceSwapState: state },
    ),
    silencePongFaceSwapAudioCompanion: target => {
      assert.equal(target, wrapper);
      companionSilenceCalls++;
    },
    window: { currentlyPlayingVideo: video },
  };
  const stage = vm.runInNewContext(`(${namedFunction('stagePongFaceSwapOutgoingWrapper')})`, context);

  assert.equal(stage(wrapper), true);
  assert.equal(video.pauseCalls, 1);
  assert.equal(video.muted, true);
  assert.equal(video.defaultMuted, true);
  assert.equal(video.volume, 0);
  assert.equal(companionSilenceCalls, 1);
  assert.equal(wrapper.dataset.playIntent, undefined);
  assert.equal(wrapper.dataset.pongFaceSwapRetirePending, 'true');
  assert.equal(state.outgoingWrappers.has(wrapper), true);
  assert.equal(state.navigationShouldPlay, true);
  assert.equal(context.window.currentlyPlayingVideo, null);
  assert.deepEqual(removedClasses, ['video-playing']);
});

test('navigation playback intent follows the current card and explicit pause state', () => {
  const state = { enabled: true, selectedFaceId: 'face-1', navigationShouldPlay: false };
  const video = { paused: false, ended: false };
  const wrapper = {
    dataset: {},
    querySelector: selector => selector === 'video' ? video : null,
  };
  const capture = vm.runInNewContext(
    `(${namedFunction('capturePongFaceSwapNavigationPlaybackIntent')})`,
    { pongFaceSwapState: state },
  );

  assert.equal(capture(wrapper), true);
  assert.equal(state.navigationShouldPlay, true);

  wrapper.dataset.userPaused = 'true';
  assert.equal(capture(wrapper), false);
  assert.equal(state.navigationShouldPlay, false);

  delete wrapper.dataset.userPaused;
  video.paused = true;
  wrapper.dataset.playIntent = 'true';
  assert.equal(capture(wrapper), true);

  state.enabled = false;
  assert.equal(capture(wrapper), false);
  assert.equal(state.navigationShouldPlay, false);
});

test('committed outgoing retirement performs local detach without a redundant DELETE', () => {
  const calls = [];
  const oldWrapper = {
    dataset: { pongFaceSwapRetirePending: 'true' },
    querySelector: selector => selector === 'video' ? {} : null,
  };
  const newlyOutgoingTarget = {
    dataset: { pongFaceSwapRetirePending: 'true' },
    querySelector: selector => selector === 'video' ? {} : null,
  };
  const state = { outgoingWrappers: new Set([oldWrapper, newlyOutgoingTarget]) };
  const context = {
    pongFaceSwapState: state,
    pongFaceSwapCurrentWrapper: () => null,
    stopPongFaceSwapForWrapper: (wrapper, options) => {
      calls.push({ wrapper, options });
      return true;
    },
  };
  const retire = vm.runInNewContext(`(${namedFunction('retirePongFaceSwapOutgoingWrappers')})`, context);

  retire({ exceptWrapper: newlyOutgoingTarget, serverAlreadyRetired: true });
  assert.equal(state.outgoingWrappers.size, 1);
  assert.equal(state.outgoingWrappers.has(newlyOutgoingTarget), true,
    'a target swiped again before deferred cleanup must remain staged for the next activation');
  assert.equal(oldWrapper.dataset.pongFaceSwapRetirePending, undefined);
  assert.equal(newlyOutgoingTarget.dataset.pongFaceSwapRetirePending, 'true');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wrapper, oldWrapper);
  assert.equal(calls[0].options.restore, false);
  assert.equal(calls[0].options.skipServerStop, true);
});

test('deferred retirement can never detach a card reclaimed by a fast back-swipe', () => {
  const calls = [];
  const current = {
    dataset: { pongFaceSwapRetirePending: 'true' },
    querySelector: selector => selector === 'video' ? {} : null,
  };
  const stale = {
    dataset: { pongFaceSwapRetirePending: 'true' },
    querySelector: selector => selector === 'video' ? {} : null,
  };
  const state = { outgoingWrappers: new Set([current, stale]) };
  const context = {
    pongFaceSwapState: state,
    pongFaceSwapCurrentWrapper: () => current,
    stopPongFaceSwapForWrapper: (wrapper, options) => {
      calls.push({ wrapper, options });
      return true;
    },
  };
  const retire = vm.runInNewContext(`(${namedFunction('retirePongFaceSwapOutgoingWrappers')})`, context);

  retire({ exceptWrapper: null, serverAlreadyRetired: true });
  assert.equal(current.dataset.pongFaceSwapRetirePending, undefined);
  assert.equal(state.outgoingWrappers.has(current), false);
  assert.equal(calls.some(call => call.wrapper === current), false,
    'the live card must not be detached by a delayed prior-card commit');
  assert.equal(calls.some(call => call.wrapper === stale), true);
});

test('stale activation releases only the busy generation it owns', () => {
  let updates = 0;
  const wrapper = {
    dataset: {
      pongFaceSwapGeneration: 'old-generation',
      pongFaceSwapBusy: 'true',
      pongFaceSwapAutoPending: 'true',
    },
  };
  const context = {
    setPongFaceSwapPhase() {},
    PONG_FACE_SWAP_PHASES: { ORIGINAL: 'original' },
    updatePongFaceSwapButton() { updates++; },
    replayPendingPongFaceSwapActivation() {},
  };
  const release = vm.runInNewContext(`(${namedFunction('releasePongFaceSwapBusyGeneration')})`, context);
  assert.equal(release(wrapper, 'new-generation'), false);
  assert.equal(wrapper.dataset.pongFaceSwapBusy, 'true');
  assert.equal(release(wrapper, 'old-generation'), true);
  assert.equal(wrapper.dataset.pongFaceSwapBusy, undefined);
  assert.equal(wrapper.dataset.pongFaceSwapAutoPending, undefined);
  assert.equal(updates, 1);
});

test('priming completion retries the card selected while the initial request was pending', () => {
  const prime = namedFunction('primePongFaceSwap');
  assert.match(
    prime,
    /finally\s*\{[\s\S]*?priming\s*=\s*false[\s\S]*?pongFaceSwapCurrentWrapper\(\)[\s\S]*?destination\s*!==\s*active[\s\S]*?rememberPendingPongFaceSwapActivation\([\s\S]*?replayPendingPongFaceSwapActivation\(\)/,
  );
});

test('pending activation is latest-wins and replays the exact visible face/card', () => {
  const first = { isConnected: true, dataset: {} };
  const latest = { isConnected: true, dataset: {} };
  let current = latest;
  const applied = [];
  const state = {
    pendingActivationIntent: null,
    enabled: true,
    selectedFaceId: 'face-latest',
    priming: false,
  };
  const context = {
    pongFaceSwapState: state,
    pongFaceSwapCurrentWrapper: () => current,
    maybeApplyPersistentPongFaceSwap: wrapper => applied.push(wrapper),
    queueMicrotask: callback => callback(),
    Date,
  };
  const api = vm.runInNewContext(`(() => {
    ${namedFunction('rememberPendingPongFaceSwapActivation')}
    ${namedFunction('replayPendingPongFaceSwapActivation')}
    return { rememberPendingPongFaceSwapActivation, replayPendingPongFaceSwapActivation };
  })()`, context);

  api.rememberPendingPongFaceSwapActivation(first, 'face-old');
  api.rememberPendingPongFaceSwapActivation(latest, 'face-latest');
  assert.equal(state.pendingActivationIntent.wrapper, latest);
  assert.equal(state.pendingActivationIntent.faceId, 'face-latest');
  assert.equal(api.replayPendingPongFaceSwapActivation(), true);
  assert.deepEqual(applied, [latest]);
  assert.equal(state.pendingActivationIntent, null);

  current = first;
  state.selectedFaceId = 'face-old';
  api.rememberPendingPongFaceSwapActivation(latest, 'face-latest');
  assert.equal(api.replayPendingPongFaceSwapActivation(), false);
  assert.equal(state.pendingActivationIntent, null, 'an off-screen stale card must not replay');
});

test('duplicate observer notifications do not queue a second activation for the in-flight card', () => {
  const wrapper = {
    isConnected: true,
    dataset: {
      originalVideoUrl: 'https://media.example/video.mp4',
      pongFaceSwapBusy: 'true',
      pongFaceSwapRequestedFaceId: 'face-a',
    },
  };
  const state = { pendingActivationIntent: null, recoverySequence: 5 };
  const context = {
    pongFaceSwapState: state,
    pongFaceSwapCurrentWrapper: () => wrapper,
    Date,
  };
  const remember = vm.runInNewContext(
    `(${namedFunction('rememberPendingPongFaceSwapActivation')})`,
    context,
  );

  assert.equal(remember(wrapper, 'face-a'), false);
  assert.equal(state.pendingActivationIntent, null);
  assert.equal(state.recoverySequence, 5);
  assert.equal(remember(wrapper, 'face-b'), true, 'a genuinely newer face selection must still queue');
  assert.equal(state.pendingActivationIntent.faceId, 'face-b');
});

test('a stale playback 404 cannot terminate its replacement session', async () => {
  let resolveFetch;
  const terminalCalls = [];
  const wrapper = {
    dataset: {
      pongFaceSwapSessionId: 'session-a',
      pongFaceSwapGeneration: 'generation-a',
      pongFaceSwapActive: 'true',
    },
  };
  const video = {
    paused: false,
    ended: false,
    currentTime: 1,
    readyState: 4,
    videoWidth: 854,
    videoHeight: 480,
  };
  const context = {
    Date,
    JSON,
    document: { hidden: false },
    encodeURIComponent,
    isPongFaceSwapManagedMedia: () => true,
    pongFaceSwapBackgroundFetch: () => new Promise(resolve => { resolveFetch = resolve; }),
    handlePongFaceSwapTerminalFailure: (...args) => terminalCalls.push(args),
  };
  const report = vm.runInNewContext(`(${namedFunction('reportPongFaceSwapPlayback')})`, context);
  report(wrapper, video, true);
  wrapper.dataset.pongFaceSwapSessionId = 'session-b';
  wrapper.dataset.pongFaceSwapGeneration = 'generation-b';
  resolveFetch({ status: 404 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminalCalls.length, 0);
});

test('stale activation errors retire only the stale session and never stop the replacement', () => {
  const start = namedFunction('startPongFaceSwap');
  const catchBody = start.slice(start.lastIndexOf('} catch (error)'));
  assert.match(
    catchBody,
    /catch\s*\(error\)[\s\S]*?!pongFaceSwapOwnsActivation[\s\S]*?retireStalePongFaceSwapSession\(activationSessionId\)[\s\S]*?releasePongFaceSwapBusyGeneration\(wrapper, generation\)[\s\S]*?return false/,
  );
  const staleBranch = catchBody.match(
    /if\s*\(!pongFaceSwapOwnsActivation\([^)]*\)\)\s*\{([\s\S]*?reason:\s*'superseded-after-error'[\s\S]*?return false;?)\s*\}/,
  )?.[1] || '';
  assert.notEqual(staleBranch, '', 'the superseded-error branch must remain explicit');
  assert.doesNotMatch(
    staleBranch,
    /stopPongFaceSwapForWrapper\(wrapper/,
    'a superseded activation catch must not stop the replacement now attached to the wrapper',
  );
});

test('persistent back-swipe reclaims staged ownership and replaces the retired channel', () => {
  const apply = namedFunction('maybeApplyPersistentPongFaceSwap');
  assert.match(apply, /returningFromStagedSwap[\s\S]*?outgoingWrappers\.delete\(wrapper\)/);
  assert.match(apply, /preserveCurrentUntilActivation:\s*returningFromStagedSwap/);
  assert.match(apply, /keepOriginalVisible:\s*true/);
});

test('direct foreground playback overlaps production with Android stream attachment', () => {
  const start = namedFunction('startPongFaceSwap');
  assert.match(start, /prebufferSeconds:\s*PONG_FACE_SWAP_FOREGROUND_PREBUFFER_SECONDS/);
  assert.doesNotMatch(start, /const\s+leadReady\s*=\s*await\s+waitForPongFaceSwapServerLead\(/,
    'foreground activation must not serialize server buffering before WebView demux');
  assert.match(start, /video\.src\s*=\s*foregroundStreamUrl\(payload\.streamUrl\)/,
    'the growing transformed stream must be attached immediately with the activation fence');
  assert.match(start, /createPongFaceSwapTransitionOverlay\(/,
    'the prior frame remains visible while the immediate stream attachment decodes');
  assert.match(
    start,
    /wrapper\.dataset\.pongExternalPlaybackAuthority\s*!==\s*['"]true['"]\s*&&\s*preopened/,
    'only a held attach=1 reader should wait for a separate activation request',
  );
  assert.match(
    start,
    /foregroundStreamUrl\(prefetched\.streamUrl\)/,
    'a server-only or in-flight prefetch should promote atomically through its first media GET',
  );
  assert.match(
    start,
    /searchParams\.set\(['"]clientEpoch['"][\s\S]*?searchParams\.set\(['"]activationSequence['"]/, 
    'media-GET promotion must carry the same stale-activation ownership fence',
  );
});

test('the foreground safety-lead deadline aborts a stalled status request', () => {
  const waitForLead = namedFunction('waitForPongFaceSwapServerLead');
  assert.match(waitForLead, /new\s+AbortController\s*\(/,
    'each status poll must own an abortable request');
  assert.match(waitForLead, /Math\.min\(1200,\s*remainingMs\)/,
    'a single status request must not outlive the overall activation deadline');
  assert.match(waitForLead, /signal:\s*requestController\.signal/,
    'the bounded request signal must reach fetch');
  assert.match(waitForLead, /pongFaceSwapOwnsActivation[\s\S]*?catch\s*\(error\)[\s\S]*?pongFaceSwapOwnsActivation/,
    'ownership must be checked before and after a stalled request');
});

test('failed or superseded promotion evicts the exact prepared reader before replay', () => {
  const entry = { key: 'face|0|source', sessionId: 'session-stale' };
  const stopped = [];
  const state = { prefetches: new Map([[entry.key, entry], ['alias', entry]]) };
  const invalidate = vm.runInNewContext(
    `(${namedFunction('invalidatePongFaceSwapPrefetchEntry')})`,
    {
      pongFaceSwapState: state,
      stopPongFaceSwapPrefetch(candidate) {
        candidate.deleted = true;
        stopped.push(candidate.sessionId);
      },
      retireStalePongFaceSwapSession() {
        assert.fail('a live entry must be stopped through its ownership path');
      },
    },
  );
  assert.equal(invalidate(entry), true);
  assert.equal(state.prefetches.size, 0);
  assert.deepEqual(stopped, ['session-stale']);

  const start = namedFunction('startPongFaceSwap');
  assert.ok(
    (start.match(/invalidatePongFaceSwapPrefetchEntry\(prefetched\)/g) || []).length >= 4,
    'every stale/error path after promotion must evict the exact prepared owner',
  );
});

test('decode timeout enters persistent generation-safe face-swap recovery', () => {
  const start = namedFunction('startPongFaceSwap');
  assert.match(
    start,
    /handlePongFaceSwapTerminalFailure\([\s\S]*?Face swap stream timed out[\s\S]*?STARTUP_TIMEOUT/,
    'decode timeout must use the same owned automatic recovery path as stream errors',
  );
});

test('Android background suspension preserves play intent without inventing a user pause', () => {
  const prepareSource = namedFunction('PongPrepareForAppBackground');
  const resumeSource = namedFunction('PongResumeFromAppBackground');
  const played = [];
  const activeVideo = { paused: false, ended: false };
  const activeWrapper = {
    dataset: { playIntent: 'true' },
    querySelector: selector => selector === 'video' ? activeVideo : null,
  };
  const pausedVideo = { paused: true, ended: false };
  const pausedWrapper = {
    dataset: { userPaused: 'true' },
    querySelector: selector => selector === 'video' ? pausedVideo : null,
  };
  const wrappers = [activeWrapper, pausedWrapper];
  const context = {
    window: {},
    Date,
    document: {
      hidden: false,
      visibilityState: 'visible',
      querySelectorAll(selector) {
        return selector === '.video-wrapper' ? wrappers : [];
      },
    },
    silencePongVideo(video) {
      video.paused = true;
      const wrapper = wrappers.find(item => item.querySelector('video') === video);
      if (wrapper) delete wrapper.dataset.playIntent;
    },
    isPongActiveVideo: video => video === activeVideo,
    isPongFaceSwapManagedMedia: () => false,
    validatePongFaceSwapSessionOnResume: () => assert.fail('ordinary media must not validate a swap session'),
    isVideoReadyForInitialPlayback: () => true,
    playVideoCleanly: video => { played.push(video); },
    prepareVideoForPlayback: () => assert.fail('ready video should not need prepare'),
    updateVideoReadyLoader: () => assert.fail('ready video should not need loader'),
  };
  const bridge = vm.runInNewContext(`
    window.PongPrepareForAppBackground = ${prepareSource};
    window.PongResumeFromAppBackground = ${resumeSource};
    window
  `, context);

  bridge.PongPrepareForAppBackground();
  // Android onPause and visibilitychange can both fire. The second call must
  // not overwrite the saved resume intent after the first call paused media.
  bridge.PongPrepareForAppBackground();
  assert.equal(activeWrapper.dataset.backgroundResumeIntent, 'true');
  assert.notEqual(activeWrapper.dataset.userPaused, 'true');
  assert.equal(pausedWrapper.dataset.backgroundResumeIntent, 'false');
  assert.equal(pausedWrapper.dataset.userPaused, 'true');

  context.document.hidden = true;
  context.document.visibilityState = 'hidden';
  assert.equal(bridge.PongResumeFromAppBackground(), false);
  assert.equal(activeWrapper.dataset.backgroundResumeIntent, 'true',
    'an early native onResume must not consume the browser visibility lease');
  context.document.hidden = false;
  context.document.visibilityState = 'visible';
  assert.equal(bridge.PongResumeFromAppBackground(), true);
  assert.equal(activeWrapper.dataset.playIntent, 'true');
  assert.notEqual(activeWrapper.dataset.userPaused, 'true');
  assert.equal(played.length, 1);
  assert.equal(played[0], activeVideo);
  assert.equal(pausedWrapper.dataset.userPaused, 'true');
  assert.equal(played.includes(pausedVideo), false);
});

test('Android resume validates a retained swap session before replaying it', () => {
  const validate = namedFunction('validatePongFaceSwapSessionOnResume');
  const resume = namedFunction('PongResumeFromAppBackground');
  assert.match(validate, /response\.status === 404[\s\S]*?handlePongFaceSwapTerminalFailure/);
  assert.match(validate, /\/resume[\s\S]*?reportPongFaceSwapPlayback/);
  assert.match(
    resume,
    /isPongFaceSwapManagedMedia\(wrapper, video\)[\s\S]*?validatePongFaceSwapSessionOnResume/,
    'a stale stream URL must not be trusted merely because Android retained it'
  );
});

test('hidden or lifecycle-suspended media cannot reacquire playback or audio ownership', () => {
  const wrapper = {
    dataset: { backgroundSuspended: 'true' },
    classList: { contains: () => true },
  };
  const video = {
    isConnected: true,
    closest: () => wrapper,
  };
  const documentState = { hidden: true, visibilityState: 'hidden' };
  const isActive = vm.runInNewContext(
    `(${namedFunction('isPongActiveVideo')})`,
    { document: documentState, DECK_MODE_ENABLED: true },
  );
  assert.equal(isActive(video), false, 'hidden media cannot be an active playback owner');
  documentState.hidden = false;
  documentState.visibilityState = 'visible';
  assert.equal(isActive(video), false, 'resume must explicitly clear lifecycle suspension first');
  delete wrapper.dataset.backgroundSuspended;
  assert.equal(isActive(video), true);
  assert.match(
    namedFunction('syncPongFaceSwapAudioCompanion'),
    /isPongActiveVideo\(video\)/,
    'the original-audio companion must use the same lifecycle ownership gate',
  );
});

test('delayed swap recovery is invalidated by newer activation and seek intents', () => {
  const owns = namedFunction('pongFaceSwapRecoveryOwns');
  assert.match(
    owns,
    /recoverySequence\s*\|\|\s*0\)\s*!==\s*recovery\.recoverySequence/,
    'a delayed recovery must carry an explicit ownership token',
  );
  assert.match(owns, /__pongFaceSwapRecoveryToken\s*!==\s*recovery\.token/);
  assert.match(
    namedFunction('startPongFaceSwap'),
    /recoverySequence\s*=\s*Number\(pongFaceSwapState\.recoverySequence\s*\|\|\s*0\)\s*\+\s*1/,
  );
  assert.match(
    namedFunction('seekPongVideoTo'),
    /recoverySequence\s*=\s*Number\(pongFaceSwapState\.recoverySequence\s*\|\|\s*0\)\s*\+\s*1/,
  );
});

test('owned activation failures retire an unattached producer exactly through its known ID', () => {
  const start = namedFunction('startPongFaceSwap');
  const catchBody = start.slice(start.lastIndexOf('} catch (error)'));
  assert.match(
    catchBody,
    /if\s*\(activationSessionId\)[\s\S]*?invalidatePongFaceSwapPrefetchEntry\(prefetched\)[\s\S]*?retireStalePongFaceSwapSession\(activationSessionId\)[\s\S]*?activationSessionId\s*=\s*''/,
    'lead failure before wrapper attachment must not leak its GPU producer',
  );
});

test('diagnostics correlate reused card indices with bounded opaque owner tokens', () => {
  const token = vm.runInNewContext(`(${namedFunction('pongRuntimeOwnerToken')})`);
  assert.equal(token('session-a'), token('session-a'));
  assert.notEqual(token('session-a'), token('session-b'));
  assert.match(token('generation-a'), /^[0-9a-f]{8}$/);
  const phase = namedFunction('setPongFaceSwapPhase');
  assert.match(phase, /sessionToken:\s*pongRuntimeOwnerToken/);
  assert.match(phase, /generationToken:\s*pongRuntimeOwnerToken/);
  assert.match(source, /snapshot\(\)[\s\S]*?generationToken:\s*pongRuntimeOwnerToken/);
});

test('exact-preview diagnostic booleans and unknown transformation survive privacy sanitization', () => {
  const start=source.indexOf('const PONG_RUNTIME_DIAGNOSTIC_FIELDS =');
  const fields=source.slice(start,source.indexOf('const pongRuntimeDiagnostics =',start));
  const record=vm.runInNewContext(`(()=>{${fields}const pongRuntimeDiagnostics=[];let pongRuntimeDiagnosticSequence=0;${namedFunction('recordPongRuntimeDiagnostic')}return recordPongRuntimeDiagnostic;})()`,{
    window:{dispatchEvent(){}},CustomEvent:class {constructor(){}},Date,PONG_RUNTIME_DIAGNOSTIC_LIMIT:160,
  });
  const event=record('swap.startup-preview-frame',{
    timelineExact:true,transformed:null,sessionToken:'abc123',mediaUrl:'private-source',
  });
  assert.equal(event.detail.timelineExact,true);
  assert.equal(event.detail.transformed,null);
  assert.equal(event.detail.sessionToken,'abc123');
  assert.equal(event.detail.mediaUrl,undefined);
  assert.equal(record('swap.preview-transform',{transformed:false}).detail.transformed,false);
});

test('speculative and seek cleanup use the nonblocking retirement route', () => {
  assert.match(
    namedFunction('stopPongFaceSwapPrefetch'),
    /sessions\/\$\{encodeURIComponent\(entry\.sessionId\)\}\?defer=1/,
  );
  assert.match(
    namedFunction('retirePongFaceSwapSeekEntry'),
    /sessions\/\$\{encodeURIComponent\(entry\.sessionId\)\}\?defer=1/,
  );
});

test('first-click stream keeps its exact click timeline without waiting for a speculative fragment', () => {
  const create = namedFunction('createPongFaceSwapPrefetchForSource');
  assert.match(
    create,
    /\{[\s\S]*?attachRequested\s*=\s*false,[\s\S]*?allowHidden\s*=\s*false,[\s\S]*?startSeconds\s*=\s*0,[\s\S]*?prebufferSeconds\s*=\s*PONG_FACE_SWAP_PREBUFFER_SECONDS[\s\S]*?\}/,
    'the shared prefetch creator must accept an explicit source-timeline offset',
  );
  assert.match(
    create,
    /pongFaceSwapSourceKey\(faceId,\s*source,\s*normalizedStartSeconds\)/,
    'a nonzero foreground prime must have a distinct reusable map key',
  );
  assert.match(
    create,
    /startSeconds:\s*normalizedStartSeconds/,
    'the prepared server session must begin at the captured click timeline',
  );
  assert.match(
    namedFunction('attachPongFaceSwapPrefetch'),
    /startSeconds:\s*Math\.max\(0,\s*Number\(entry\.startSeconds\s*\|\|\s*0\)\)/,
    'a prepared reader must keep the same absolute zero point even while the original continues playing',
  );

  const prime = namedFunction('primePongFaceSwap');
  assert.match(
    prime,
    /const\s+primeStartSeconds\s*=\s*Math\.max\(0,\s*Number\(playable\.startSeconds\s*\|\|\s*0\)\)/,
    'the foreground timeline must be captured before waiting for GPU preparation',
  );
  assert.match(
    prime,
    /startPongFaceSwap\(faceId,\s*\{[\s\S]*?startSeconds:\s*primeStartSeconds,[\s\S]*?keepOriginalVisible:\s*true[\s\S]*?\}\)/,
    'the first click must open the foreground stream immediately at that captured timeline',
  );
  assert.doesNotMatch(
    prime,
    /createPongFaceSwapPrefetchForSource\(/,
    'the foreground click must not wait for a complete speculative lead fragment',
  );
  assert.doesNotMatch(
    prime,
    /pongFaceSwapState\.priming\s*=\s*false;[\s\S]*?const\s+deadline/,
    'background scheduling must remain gated until the selected session is adopted or retired',
  );

  const start = namedFunction('startPongFaceSwap');
  assert.match(
    start,
    /const\s+adoptedPrefetchKey\s*=\s*prefetched\.key\s*\|\|\s*prefetchKey/,
    'nonzero explicit prefetches must be removed from the map by their own key after adoption',
  );
});

test('a reused in-flight prefetch survives a newer scheduler generation', () => {
  const create = namedFunction('createPongFaceSwapPrefetchForSource');
  assert.match(
    create,
    /A newer scheduler generation alone does not make it stale/,
    'the in-flight session must remain owned when the next scheduler pass reuses its map entry',
  );
  assert.match(
    create,
    /if\s*\(\s*!pongFaceSwapState\.enabled\s*\|\|\s*pongFaceSwapState\.prefetches\.get\(key\)\s*!==\s*entry\s*\)\s*\{[\s\S]*?method:\s*['"]DELETE['"]/,
    'late registration may be retired only after its exact map entry is no longer desired',
  );
  assert.doesNotMatch(
    create,
    /if\s*\(\s*generation\s*!==\s*pongFaceSwapState\.prefetchGeneration\s*\|\|\s*!pongFaceSwapState\.enabled[\s\S]*?method:\s*['"]DELETE['"]/,
    'a scheduler-generation bump must not delete a session still referenced by the prefetch map',
  );
});

test('a speculative client entry is refreshed before the server lease expires', () => {
  const create = namedFunction('createPongFaceSwapPrefetchForSource');
  assert.match(source, /PONG_FACE_SWAP_PREFETCH_REFRESH_MS\s*=\s*45_000/,
    'the client refresh must stay safely below the service 60-second prune age');
  assert.match(
    create,
    /existingAgeMs[\s\S]*?>=\s*PONG_FACE_SWAP_PREFETCH_REFRESH_MS[\s\S]*?prefetches\.delete\(key\)[\s\S]*?stopPongFaceSwapPrefetch\(existing\)[\s\S]*?existing\s*=\s*null/,
    'an expired map entry must be retired and replaced instead of promoted into a 404',
  );
});

test('first-click behavior opens one foreground stream without losing the click timestamp', async () => {
  const activeVideo = { paused: false, ended: false };
  const active = {
    dataset: { index: '7' },
    isConnected: true,
    querySelector: selector => selector === 'video' ? activeVideo : null,
    classList: { contains: value => value === 'deck-active' },
  };
  const faceId = 'approved-face';
  const sourceUrl = 'https://media.example/video.mp4';
  const state = {
    priming: false,
    prefetchTimer: null,
    prefetchGeneration: 4,
    prefetches: new Map(),
    enabled: true,
    selectedFaceId: faceId,
  };
  const calls = { create: [], start: [] };
  const keyFor = (face, mediaSource, startSeconds = 0) => (
    `${face}|${Math.max(0, Number(startSeconds || 0)).toFixed(2)}|${mediaSource || ''}`
  );
  let playableReadCount = 0;

  const context = {
    pongRemoteMode: false,
    pongFaceSwapState: state,
    pongFaceSwapCurrentWrapper: () => active,
    pongFaceSwapPlayableSource: () => ({
      source: sourceUrl,
      // Prove that a later playback read cannot replace the click timestamp.
      startSeconds: playableReadCount++ === 0 ? 12.34 : 13.91,
    }),
    pongFaceSwapSourceKey: keyFor,
    createPongFaceSwapPrefetchForSource: async (...args) => {
      calls.create.push(args);
      const startSeconds = args[5]?.startSeconds;
      const entry = {
        key: keyFor(faceId, sourceUrl, startSeconds),
        faceId,
        source: sourceUrl,
        startSeconds,
        sessionId: 'prepared-session',
        streamUrl: '/pong-swap/sessions/prepared-session/stream',
        ready: true,
        adopted: false,
      };
      state.prefetches.set(entry.key, entry);
      return entry;
    },
    startPongFaceSwap: async (...args) => {
      calls.start.push(args);
      return true;
    },
    stopPongFaceSwapPrefetch: () => {},
    updatePongFaceSwapLoading: () => {},
    hidePongFaceSwapLoading: () => {},
    schedulePongFaceSwapPrefetch: () => {},
    rememberPendingPongFaceSwapActivation: () => false,
    replayPendingPongFaceSwapActivation: () => false,
    clearTimeout: () => {},
    setTimeout,
    Date,
    Math,
    PONG_FACE_SWAP_PRIME_DEADLINE_MS: 30_000,
  };
  const prime = vm.runInNewContext(`(${namedFunction('primePongFaceSwap')})`, context);
  const result = await prime(faceId);

  assert.equal(result, true);
  assert.equal(calls.create.length, 0, 'one click must not wait for a speculative foreground session');
  assert.equal(calls.start.length, 1, 'the foreground session must be opened exactly once');
  assert.equal(calls.start[0][1].startSeconds, 12.34, 'activation must not replace click time with the later playback time');
  assert.equal(calls.start[0][1].keepOriginalVisible, true, 'the original must cover the immediate stream handoff');
  assert.equal(state.priming, false, 'the scheduling gate must be released after adoption');
});

test('immediate foreground selection does not weaken background or seek headroom', () => {
  const prime = namedFunction('primePongFaceSwap');
  assert.doesNotMatch(prime, /prebufferSeconds/);
  const start = namedFunction('startPongFaceSwap');
  assert.match(start, /keepOriginalVisible[\s\S]*?createPongFaceSwapTransitionOverlay/);
  assert.match(start, /clearPongFaceSwapTransitionOverlay/);
  const overlay = namedFunction('createPongFaceSwapTransitionOverlay');
  assert.match(overlay, /clone\.muted\s*=\s*true/);
  assert.match(overlay, /snapshot\.getContext[\s\S]*?drawImage/);
  assert.match(overlay, /freezeFrameOnly[\s\S]*?return overlay/);
  const create = namedFunction('createPongFaceSwapPrefetchForSource');
  assert.match(create, /prebufferSeconds\s*=\s*PONG_FACE_SWAP_PREBUFFER_SECONDS/);
  assert.match(create, /prebufferSeconds:\s*normalizedPrebufferSeconds/);
  const seek = namedFunction('preparePongFaceSwapSeek');
  assert.match(seek, /prebufferSeconds:\s*PONG_FACE_SWAP_PREBUFFER_SECONDS/);
});

test('background prefetch stays locked until the selected swap frame is presented', () => {
  const schedule = namedFunction('schedulePongFaceSwapPrefetch');
  assert.match(
    schedule,
    /prefetchReadyFaceId\s*!==\s*pongFaceSwapState\.selectedFaceId/,
    'a decoded-but-unpainted foreground stream must retain exclusive GPU priority',
  );
  assert.match(schedule, /foregroundAlreadyPresented/);
  assert.match(schedule, /pongFaceSwapPhase\s*===\s*PONG_FACE_SWAP_PHASES\.PLAYING/);
  const prime = namedFunction('primePongFaceSwap');
  assert.doesNotMatch(
    prime,
    /finally\s*\{[\s\S]*?schedulePongFaceSwapPrefetch/,
    'prime cleanup must not race speculative producers against first paint',
  );
  const start = namedFunction('startPongFaceSwap');
  assert.match(start, /requestVideoFrameCallback/);
  assert.match(start, /setTimeout[\s\S]*?requestAnimationFrame[\s\S]*?requestAnimationFrame/);
  assert.match(start, /pongFaceSwapState\.prefetchReadyFaceId\s*=\s*faceId/);
});

test('both face pickers warm the engine before fetching or rendering choices', () => {
  const menu = namedFunction('togglePongFaceSwapMenu');
  const picker = namedFunction('openPongFaceSwapPicker');
  assert.match(menu, /warmPongFaceSwapEngine\(\)/);
  assert.match(picker, /warmPongFaceSwapEngine\(\)/);
  const warm = namedFunction('warmPongFaceSwapEngine');
  assert.match(warm, /const endpoint = '\/pong-swap\/warm' \+/);
  assert.match(warm, /pongFaceSwapControlFetch\(endpoint,/);
  assert.match(warm, /selectedProfile === 'default' \? '' : '\?profile=' \+ encodeURIComponent\(selectedProfile\)/);
});

test('first-click prime preserves pending play intent without overriding an explicit pause', () => {
  const prime = namedFunction('primePongFaceSwap');
  assert.match(
    prime,
    /active\.dataset\.userPaused\s*===\s*['"]true['"]\s*\?\s*false/,
    'an explicit pause must remain paused while the selected face is prepared',
  );
  assert.match(
    prime,
    /!activeVideo\.paused[\s\S]*?active\.dataset\.playIntent\s*===\s*['"]true['"][\s\S]*?window\.autoplayEnabled/,
    'actual playback, pending play intent, and autoplay must all request playback after activation',
  );
  assert.match(
    prime,
    /forcePlaying,\s*startSeconds:/,
    'the tri-state playback decision must be passed to the prepared-session activation',
  );
});

test('an explicit pause wins every swap playback race', () => {
  const start = namedFunction('startPongFaceSwap');
  assert.match(
    start,
    /wrapper\.dataset\.userPaused\s*!==\s*['"]true['"]\s*&&[\s\S]*?wasPlaying\s*\|\|\s*wrapper\.dataset\.playIntent/,
    'a late swap canplay event must not resume after the user pauses',
  );

  const play = namedFunction('playVideoCleanly');
  assert.match(
    play,
    /wrapper\?\.dataset\?\.userPaused\s*===\s*['"]true['"][\s\S]*?video\.pause\(\)/,
    'all async play requests must fail closed while an explicit pause is active',
  );

  const toggle = namedFunction('toggleVideoPlaybackFromIntent');
  assert.match(toggle, /pausePongFaceSwapTransitionPlayback\(wrapper\)/);
  assert.match(toggle, /silencePongFaceSwapAudioCompanion\(wrapper\)/);
  assert.match(toggle, /reportPongFaceSwapPlayback\(wrapper,\s*video,\s*true\)/);

  assert.match(
    source,
    /video\.addEventListener\(['"]playing['"],[\s\S]*?wrapper\.dataset\.userPaused\s*===\s*['"]true['"][\s\S]*?video\.pause\(\)[\s\S]*?return;/,
    'a delayed WebView playing event must preserve rather than clear the user pause',
  );
});

test('an undecoded held reader never adds the 30-second prime deadline', () => {
  const apply = namedFunction('maybeApplyPersistentPongFaceSwap');
  assert.doesNotMatch(
    apply,
    /createPongFaceSwapPrefetchForSource\(/,
    'a visible card must start foreground work directly instead of creating a headroom-limited prefetch',
  );
  assert.doesNotMatch(
    apply,
    /entry\s*&&\s*!entry\.ready\s*&&\s*Date\.now\(\)\s*<\s*deadline/,
    'a visible foreground card must promote immediately rather than wait for speculative readiness',
  );
  assert.doesNotMatch(
    apply,
    /!entry\.browserReady/,
    'browserReady is only an optimization; startPongFaceSwap owns the immediate normal-stream fallback',
  );
});

test('foreground activation promotes a valid in-flight prefetch instead of restarting it cold', () => {
  const start = namedFunction('startPongFaceSwap');
  assert.match(
    start,
    /prefetchCandidate\.sessionId\s*&&\s*prefetchCandidate\.streamUrl/,
    'an existing speculative producer should be promoted with its completed source/GPU work intact',
  );
  assert.doesNotMatch(
    start,
    /prefetchCandidate\.streamUrl\s*&&\s*prefetchCandidate\.ready\s*===\s*true|prefetchCandidate\.browserReady\s*===\s*true|Number\(prefetchCandidate\.frames\s*\|\|\s*0\)\s*>\s*0/,
    'foreground promotion must not wait for the speculative safety lead or browser decode flag',
  );
  assert.match(
    start,
    /prefetchCandidate\s*&&\s*!prefetched[\s\S]*?stopPongFaceSwapPrefetch\(prefetchCandidate\)/,
    'a deleted or incomplete-control-plane entry must still be retired before direct foreground startup',
  );
});

test('pre-opened readiness requests playback only once', () => {
  const start = namedFunction('startPongFaceSwap');
  assert.match(start, /let readyHandled\s*=\s*false/);
  assert.match(
    start,
    /const ready\s*=\s*\(\)\s*=>\s*\{[\s\S]*?if\s*\(readyHandled\)\s*return;[\s\S]*?readyHandled\s*=\s*true/,
    'the explicit readyState fast path and canplay event must share one playback gate',
  );
});

test('persistent prepared cards inherit playback unless the user explicitly paused', () => {
  const apply = namedFunction('maybeApplyPersistentPongFaceSwap');
  assert.match(
    apply,
    /wrapper\.dataset\.userPaused\s*===\s*['"]true['"]\s*\?\s*false/,
    'a deliberate per-card pause must remain authoritative',
  );
  assert.match(
    apply,
    /window\.autoplayEnabled\s*\|\|\s*wrapper\.dataset\.playIntent\s*===\s*['"]true['"]/,
    'positive global or per-card playback intent must be preserved',
  );
  assert.match(
    apply,
    /\?\s*true\s*:\s*undefined/,
    'no explicit intent must defer to startPongFaceSwap prepared-card detection instead of forcing pause',
  );
  assert.doesNotMatch(
    apply,
    /forcePlaying\s*:\s*Boolean\s*\(\s*window\.autoplayEnabled\s*\)/,
    'global autoplay off must not forcibly pause a prepared foreground reader',
  );
});

test('persistent swap survives an individual video startup or stream failure', () => {
  const apply = namedFunction('maybeApplyPersistentPongFaceSwap');
  assert.match(
    apply,
    /Preparing next video[\s\S]*?Face swap stays on/,
    'navigation must immediately replace the prior card green state with preparation for the new card',
  );

  const startup = namedFunction('startPongFaceSwap');
  assert.doesNotMatch(
    startup,
    /setPongFaceSwapPersistentEnabled\(false\)/,
    'a failure on one video must not globally disable the selected face',
  );

  const terminal = namedFunction('handlePongFaceSwapTerminalFailure');
  assert.doesNotMatch(
    terminal,
    /setPongFaceSwapPersistentEnabled\(false\)/,
    'a terminal stream failure must restore only that video and retain persistent swap',
  );
  assert.match(
    terminal,
    /schedulePongFaceSwapRecovery\(wrapper,[\s\S]*?faceId:\s*retryFaceId[\s\S]*?startSeconds:\s*retryStartSeconds/,
    'all terminal failures must retry the same visible card and selected face',
  );
  const recovery = namedFunction('schedulePongFaceSwapRecovery');
  assert.match(
    recovery,
    /Math\.min\(5_000,[\s\S]*?pongFaceSwapRecoveryOwns\(wrapper,\s*recovery\)/,
    'automatic retries must continue with capped backoff while ownership is current',
  );
  assert.match(
    terminal,
    /errorCode\s*===\s*['"]GPU_OOM['"]\)\s*clearPongFaceSwapPrefetches\(\)/,
    'GPU recovery must retire optional work before retrying the same visible card',
  );
  assert.match(
    recovery,
    /startPongFaceSwap\(normalizedFaceId,[\s\S]*?startSeconds:\s*liveStartSeconds[\s\S]*?absoluteSourceTimeline:\s*true/,
    'a failed visible session must reacquire the selected face at the current absolute timeline',
  );
});

test('a fresh Paperclip bundle always starts at its first video', () => {
  const display = namedFunction('displayPasteEventAtIndex');
  const captureIndex = display.indexOf('capturePongFaceSwapNavigationPlaybackIntent()');
  const rangeIndex = display.indexOf('setActivePlaybackRangeForPasteEvent');
  const replacementIndex = display.indexOf('replacePongVideoContainerHtml');
  assert(captureIndex >= 0, 'Paperclip navigation must capture outgoing playback intent');
  assert(captureIndex < rangeIndex, 'playback intent must be captured before the active range changes');
  assert(captureIndex < replacementIndex, 'playback intent must be captured before the old deck is replaced');
  assert.match(
    display,
    /const\s+hasSavedResumeOffset[\s\S]*?const\s+requestedResumeOffset\s*=\s*hasSavedResumeOffset[\s\S]*?:\s*0\s*;/,
    'only an explicit saved resume offset may advance a newly opened Paperclip bundle',
  );
  assert.doesNotMatch(
    display,
    /getBestCachedResumeOffsetForEvent/,
    'cache warmth must never choose a later logical video for a fresh Paperclip open',
  );
});

test('Paperclip prediction and navigation share one destination resolver', () => {
  namedFunction('resolveNextPaperclipEventIndex');
  const schedule = namedFunction('schedulePongFaceSwapPrefetch');
  assert.match(
    namedFunction('getPongFaceSwapNextPaperclipSources'),
    /resolveNextPaperclipEventIndex\s*\(/,
    'face-swap prediction must use the Paperclip resolver',
  );
  assert.match(
    namedFunction('navigateToNextPasteEvent'),
    /resolveNextPaperclipEventIndex\s*\(/,
    'Paperclip navigation must use the same resolver as prediction',
  );
  assert.match(
    schedule,
    /getPongFaceSwapNextPaperclipSources\s*\([\s\S]*?PONG_FACE_SWAP_PAPERCLIP_PREFETCH_COUNT[\s\S]*?createPongFaceSwapPrefetchForSource\s*\(/,
    'the scheduler must actually prepare the shared Paperclip prediction',
  );
  assert.match(
    schedule,
    /PONG_FACE_SWAP_PREFETCH_COUNT\s*-\s*preparedJobs\.length/,
    'Paperclip prediction must share the same bounded two-session budget as swipe prediction',
  );
  assert.match(
    schedule,
    /allowHidden:\s*job\.attachRequested/,
    'the first Paperclip destination may own the sole hidden decoded reader when no swipe destination needs it',
  );
});

test('Paperclip promotion keeps the claimed foreground reader attached', () => {
  const schedule = namedFunction('schedulePongFaceSwapPrefetch');
  assert.match(
    schedule,
    /const\s+activeOwnsAttachment\s*=\s*Boolean\s*\(/,
    'the scheduler must identify an attached preload already claimed by the active card',
  );
  assert.match(
    schedule,
    /active\.dataset\.pongFaceSwapPreloadSessionId\s*===\s*entry\.sessionId/,
    'ownership must match the exact prepared session rather than only the wrapper',
  );
  assert.match(
    schedule,
    /entry\.attachRequested\s*=\s*desiredAttachmentKeys\.has\(key\)\s*\|\|\s*activeOwnsAttachment/,
    'a foreground promotion must remain attached even though it is no longer a future-card slot',
  );

  const start = namedFunction('startPongFaceSwap');
  assert.match(
    start,
    /:\s*preloadedOriginal[\s\S]*?preloadedOriginal\.wasPlaying[\s\S]*?!video\.paused[\s\S]*?wrapper\.dataset\.playIntent[\s\S]*?deck-active[\s\S]*?:\s*previous\s*\?/,
    'a claimed hidden reader must inherit the visible card playback intent instead of remaining paused at zero',
  );
  assert.match(
    start,
    /if\s*\(!preopened\)[\s\S]*?advancePongVideoSourceGeneration\(video\)[\s\S]*?video\.src\s*=/,
    'a non-preopened swap must retire a pending play request from the replaced source before assigning its stream',
  );

  const attach = namedFunction('attachPongFaceSwapPrefetch');
  assert.match(
    attach,
    /advancePongVideoSourceGeneration\(video\)[\s\S]*?video\.src\s*=\s*attachedStreamHref/,
    'a prepared reader attachment must own a fresh source generation',
  );
});

test('persistent swap keeps the logical next-video order', () => {
  const next = namedFunction('getNextDeckIndex');
  const orderedReturn = next.indexOf('return unseen[0] ?? null;');
  const readinessSort = next.indexOf('unseen.sort(');
  assert(orderedReturn >= 0, 'navigation must select the first unseen logical card');
  assert.equal(readinessSort, -1, 'transport readiness must never reorder logical playback identity');
});

test('face choice dispatches the critical stream before deferred thumbnail cleanup', () => {
  const setThumbnail = namedFunction('setPongFaceSwapThumbnail');
  const renderMenu = namedFunction('renderPongFaceSwapMenu');
  const renderPicker = namedFunction('renderPongFaceSwapPicker');
  const closeMenu = namedFunction('closePongFaceSwapMenu');
  const closePicker = namedFunction('closePongFaceSwapPicker');
  const toggleMenu = namedFunction('togglePongFaceSwapMenu');

  assert.match(
    source,
    /const PONG_FACE_SWAP_FACES_CACHE_KEY\s*=\s*['"]pong_face_swap_faces_cache_v2['"]/,
    'the inline-thumbnail inventory must not hydrate the old URL-only session cache',
  );
  assert.match(setThumbnail, /face\?\.thumbnailDataUrl/, 'picker must prefer the inline thumbnail payload');
  assert.match(
    setThumbnail,
    /image\.src\s*=\s*inlineSource\s*\|\|\s*fallbackSource/,
    'inline data must avoid one HTTP request per approved face',
  );
  assert.match(
    setThumbnail,
    /usedUrlFallback[\s\S]*?image\.src\s*=\s*fallbackSource/,
    'the immutable thumbnail endpoint must remain an image-decode fallback',
  );
  assert.match(renderMenu, /image\.loading\s*=\s*['"]lazy['"]/, 'menu thumbnails must remain lazy');
  assert.match(renderMenu, /image\.fetchPriority\s*=\s*['"]low['"]/, 'menu thumbnails must not outrank playback');
  assert.match(renderMenu, /setPongFaceSwapThumbnail\(image,\s*face\)/,
    'compact menu must use the one-response thumbnail source');
  assert.match(renderPicker, /setPongFaceSwapThumbnail\(image,\s*face\)/,
    'full picker must use the one-response thumbnail source');
  assert.match(
    renderMenu,
    /setPongFaceSwapPersistentEnabled\(true\);[\s\S]*?primePongFaceSwap\(face\.id\);[\s\S]*?setTimeout\(\(\)\s*=>\s*closePongFaceSwapMenu\(menu\),\s*0\)/,
    'selection must dispatch the isolated critical request before cosmetic DOM cleanup',
  );
  assert.match(closeMenu, /image\.removeAttribute\(['"]src['"]\)/, 'close must cancel in-flight image requests');
  assert.match(closeMenu, /menu\.replaceChildren\(\)/, 'closed menu must not retain hidden image decoders');
  assert.match(closePicker, /image\.removeAttribute\(['"]src['"]\)/, 'full picker close must cancel in-flight images too');
  assert.match(closePicker, /list\.replaceChildren\(\)/, 'hidden picker must not retain image decoders');
  assert.match(toggleMenu, /closePongFaceSwapMenu\(menu\)/, 'manual close must use the same cleanup path');
});

test('swapped seeks are prepare-first and keep only the latest intent', () => {
  assert.match(source, /\bseekGeneration\s*:/, 'face-swap state must track seek generations');
  assert.match(source, /\bpendingSeekTarget\s*:/, 'face-swap state must retain the latest target');
  assert.match(source, /\bseekEntry\s*:/, 'face-swap state must retain the prepared replacement');

  const seek = namedFunction('seekPongVideoTo');
  const prepare = namedFunction('preparePongFaceSwapSeek');
  assert.match(seek, /\+\+pongFaceSwapState\.seekGeneration|pongFaceSwapState\.seekGeneration\s*\+\s*1/,
    'each seek must advance the replacement generation');
  assert.match(seek, /pendingSeekTarget\s*=/, 'each gesture must overwrite the pending target');
  assert.match(seek, /preparePongFaceSwapSeek\s*\(/, 'seekPongVideoTo must delegate preparation without stopping the active stream');
  assert.match(prepare, /prefetchedEntry/, 'the prepared replacement must be handed to startPongFaceSwap');
  assert.match(prepare, /preserveCurrentUntilActivation\s*:\s*true/,
    'seek activation must preserve the current swapped stream until replacement is ready');
});

test('rapid seeks never suspend a starting producer and retain only the latest playback intent', async () => {
  const suspend=vm.runInNewContext(`(${namedFunction('suspendPongFaceSwapForScrub')})`,{});
  assert.equal(suspend({dataset:{pongFaceSwapSessionId:'starting',pongFaceSwapActive:'true',pongFaceSwapBusy:'true'}}),false,
    'pointer-down must not suspend a busy producer either');
  for (const shouldPlay of [true, false]) {
    const wrapper={dataset:{pongFaceSwapActive:'true',pongFaceSwapBusy:'true',pongFaceSwapFaceId:'face'}};
    const video={paused:true,ended:false};
    const state={seekGeneration:1,seekEntry:{wrapper,adopted:true,shouldPlay},pendingSeekTarget:null};
    let suspends=0,prepares=0;
    const context={pongFaceSwapState:state,pongFaceSwapFullDuration:()=>85,
      suspendPongFaceSwapForScrub:()=>suspends++,retirePongFaceSwapSeekEntry:()=>{},
      setPongFaceSwapPhase:()=>{},updatePongFaceSwapProgress:()=>{},
      PONG_FACE_SWAP_PHASES:{SEEKING:'seeking'},preparePongFaceSwapSeek:()=>{prepares++;return true;}};
    const seek=vm.runInNewContext(`(${namedFunction('seekPongVideoTo')})`,context);
    await seek(wrapper,video,28);await seek(wrapper,video,52);
    assert.equal(suspends,0,'busy producer must finish instead of being suspended');
    assert.equal(prepares,0,'one current producer, one latest queued intent');
    assert.equal(state.pendingSeekTarget.target,52);
    assert.equal(state.pendingSeekTarget.shouldPlay,shouldPlay);
    delete wrapper.dataset.pongFaceSwapBusy;
    const flush=vm.runInNewContext(`(${namedFunction('flushPendingPongFaceSwapSeek')})`,context);
    assert.equal(flush(wrapper,video),true);assert.equal(flush(wrapper,video),false);
    assert.equal(prepares,1);
  }
});

test('buffered swapped seeks reuse exact frames; gaps and fragment edges regenerate', async () => {
  for (const [target, expectedPrepare] of [[104,0],[109.8,1],[120,1]]) {
    const wrapper={dataset:{pongFaceSwapActive:'true',pongFaceSwapFaceId:'face'}};
    const ranges={length:1,start:()=>0,end:()=>10};
    const video={currentSrc:'blob:owned-swap',paused:true,ended:false,readyState:4,currentTime:2,
      __pongSwapOriginal:{startSeconds:100},buffered:ranges,seekable:ranges};
    let prepares=0,resumes=0;
    const context={pongFaceSwapState:{seekGeneration:0},pongFaceSwapFullDuration:()=>200,
      suspendPongFaceSwapForScrub:()=>{},resumePongFaceSwapAfterScrub:()=>resumes++,
      retirePongFaceSwapSeekEntry:()=>{},setPongFaceSwapPhase:()=>{},
      updatePongFaceSwapProgress:()=>{},PONG_FACE_SWAP_PHASES:{SEEKING:'seeking'},
      preparePongFaceSwapSeek:()=>{prepares++;return true;}};
    const seek=vm.runInNewContext(`(${namedFunction('seekPongVideoTo')})`,context);
    assert.equal(await seek(wrapper,video,target),true);
    assert.equal(prepares,expectedPrepare);
    assert.equal(resumes,expectedPrepare?0:1);
    if(!expectedPrepare)assert.equal(video.currentTime,4);
    assert.equal(video.paused,true,'local seek preserves explicit pause');
  }
});

test('scrubbing paints the exact swapped target before Android finishes fMP4 startup', () => {
  const start = namedFunction('startPongFaceSwap');
  const present = namedFunction('presentPongFaceSwapSeekFrame');
  assert.match(
    start,
    /wrapper\.dataset\.pongFaceSwapSessionId = payload\.session\.id;[\s\S]*?presentPongFaceSwapSeekFrame\(wrapper, prefetched, prefetched\.seekGeneration\)/,
    'the exact-frame request starts only after its prepared session owns the wrapper',
  );
  assert.match(
    present,
    /\/first-frame\?waitMs=6000[\s\S]*?new Image\(\)[\s\S]*?image\.src\s*=\s*imageUrl[\s\S]*?overlay\.replaceChildren\(image\)/,
    'the exact-timeline WebP seek frame must replace the frozen old-timeline overlay',
  );
  assert.match(present, /swap\.seek-preview-frame/, 'seek preview latency must be measurable');
  assert.doesNotMatch(present, /response\.blob\(\)|createImageBitmap|createObjectURL|image\.decode\(\)/,
    'the one-frame handoff must stay in Chromium native loading without JavaScript image copies');
});

test('a seek superseded between image decode and animation-frame paint never commits stale pixels', async () => {
  let paint, replacements=0,removed=0;
  const overlay={isConnected:true,dataset:{},appendChild(){},replaceChildren(){replacements++;}};
  const wrapper={dataset:{pongFaceSwapSessionId:'seek'},__pongFaceSwapTransitionOverlay:overlay};
  const state={seekGeneration:1};
  class Image {constructor(){this.style={};this.naturalWidth=1920;this.naturalHeight=1080;}setAttribute(){}remove(){removed++;}set src(v){queueMicrotask(()=>this.onload());}}
  const present=vm.runInNewContext(`(${namedFunction('presentPongFaceSwapSeekFrame')})`,{
    Image,pongFaceSwapState:state,pongFaceSwapCurrentWrapper:()=>wrapper,
    ensurePongFaceSwapBackgroundControlPlane:async()=>'',performance,setTimeout,clearTimeout,AbortController,
    pongFaceSwapBackgroundFetch:async()=>({ok:false}),
    requestAnimationFrame:cb=>{paint=cb;},recordPongRuntimeDiagnostic:()=>{},pongRuntimeOwnerToken:()=>''});
  const pending=present(wrapper,{sessionId:'seek'},1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof paint,'function');
  state.seekGeneration=2;paint();
  assert.equal(await pending,false);assert.equal(replacements,0);assert.equal(removed,1);
});

for (const boundary of ['none', 'decode', 'paint', 'identity']) {
  test(`startup exact preview preserves playback ownership across ${boundary} boundary`, async () => {
    let image, paint, replacements=0, removed=0, owns=true;
    const diagnostics=[],captured=[],reconciled=[];
    const overlay={isConnected:true,dataset:{},appendChild(){},replaceChildren(){replacements++;},contains(node){return node===image&&replacements>0;}};
    const wrapper={dataset:{pongFaceSwapSessionId:'startup',pongFaceSwapBusy:'true'},__pongFaceSwapTransitionOverlay:overlay};
    class Image {
      constructor(){image=this;this.style={};this.naturalWidth=1920;this.naturalHeight=1080;}
      setAttribute(){} remove(){removed++;} set src(v){this.url=v;}
    }
    const present=vm.runInNewContext(`(${namedFunction('presentPongFaceSwapSeekFrame')})`,{
      Image,pongFaceSwapState:{seekGeneration:1},pongFaceSwapCurrentWrapper:()=>wrapper,
      pongFaceSwapOwnsActivation:()=>owns,
      ensurePongFaceSwapBackgroundControlPlane:async()=>'',performance,setTimeout,clearTimeout,AbortController,
      pongFaceSwapBackgroundFetch:async()=>({ok:true,json:async()=>({session:{id:'startup',firstRenderedFrameReady:true,firstRenderedFrameTransformed:false}})}),
      requestAnimationFrame:cb=>{paint=cb;},recordPongRuntimeDiagnostic:(...args)=>diagnostics.push(args),
      pongRuntimeOwnerToken:()=>'',window:{PongModernUI:{capturePreview(...args){captured.push(args);},reconcileSessionPreview(...args){reconciled.push(args);}}},
    });
    const pending=present(wrapper,{sessionId:'startup',previewKind:'startup',activationStartedAt:performance.now()},1);
    await new Promise(resolve=>setImmediate(resolve));
    assert(image);
    assert.equal(image.crossOrigin,'anonymous','native first-frame images must send Origin to the separate control port');
    if(boundary==='decode')wrapper.dataset.pongFaceSwapBusy='false';
    if(boundary==='identity')owns=false;
    image.onload();
    await new Promise(resolve=>setImmediate(resolve));
    if(boundary==='paint')wrapper.dataset.pongFaceSwapBusy='false';
    if(paint)paint();
    assert.equal(await pending,boundary==='none');
    assert.equal(replacements,boundary==='none'?1:0);
    assert.equal(removed,boundary==='none'?0:1);
    if(boundary==='none') {
      assert.equal(wrapper.dataset.pongFaceSwapBusy,'true','a still preview must not release playback readiness');
      assert.equal(diagnostics[0][0],'swap.startup-preview-frame');
      assert(diagnostics[0][1].activationMs>=0);
      assert.equal(diagnostics[0][1].transformed,null,'paint cannot claim face transformation');
      assert.equal(captured[0][2],null,'poster starts with unknown transformation state');
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(reconciled[0][2],false,'metadata may confirm an original passthrough');
      assert.equal(overlay.dataset.pongTransformed,'false');
    } else {
      assert.equal(captured.length,0,'superseded preview must never enter the poster cache');
      assert.equal(reconciled.length,0);
    }
  });
}

test('exact preview paints before bounded metadata and ignores a late reply for a superseded session', async () => {
  let image,paint,resolveStatus,metadataSignal,reconciliations=0;
  const overlay={isConnected:true,dataset:{},appendChild(){},replaceChildren(){},contains(node){return node===image;}};
  const wrapper={dataset:{pongFaceSwapSessionId:'first'},__pongFaceSwapTransitionOverlay:overlay};
  class Image {
    constructor(){image=this;this.style={};this.naturalWidth=640;this.naturalHeight=360;}
    setAttribute(){} remove(){} set src(_){queueMicrotask(()=>this.onload());}
  }
  const present=vm.runInNewContext(`(${namedFunction('presentPongFaceSwapSeekFrame')})`,{
    Image,pongFaceSwapState:{seekGeneration:1},pongFaceSwapCurrentWrapper:()=>wrapper,
    ensurePongFaceSwapBackgroundControlPlane:async()=>'',performance,
    setTimeout:(callback,delay)=>delay===2500 ? queueMicrotask(callback) : setTimeout(callback,delay),
    clearTimeout,AbortController,
    requestAnimationFrame:cb=>{paint=cb;},recordPongRuntimeDiagnostic:()=>{},pongRuntimeOwnerToken:()=>'',
    pongFaceSwapBackgroundFetch:(_path,options)=>{metadataSignal=options.signal;return new Promise(resolve=>{resolveStatus=resolve;});},
    window:{PongModernUI:{capturePreview(){},reconcileSessionPreview(){reconciliations++;}}},
  });
  const pending=present(wrapper,{sessionId:'first'},1);
  await new Promise(resolve=>setImmediate(resolve));
  paint();
  assert.equal(await pending,true,'status must not block the preview image');
  assert.equal(typeof resolveStatus,'function');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(metadataSignal.aborted,true,'optional metadata request has a deadline');
  wrapper.dataset.pongFaceSwapSessionId='second';
  resolveStatus({ok:true,json:async()=>({session:{id:'first',firstRenderedFrameReady:true,firstRenderedFrameTransformed:true}})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reconciliations,0);
  assert.equal(overlay.dataset.pongTransformed,undefined);
});

test('menu source preparation is limited to current original video and never blocks selection', async () => {
  const requests=[];
  const wrapper={querySelector:()=>({})};
  let managed=false,source='https://media.example/original.mp4',throws=false;
  const prepare=vm.runInNewContext(`(${namedFunction('preparePongFaceSwapVisibleSource')})`,{
    pongFaceSwapCurrentWrapper:()=>wrapper,isPongFaceSwapManagedMedia:()=>managed,
    pongFaceSwapPlayableSource:()=>({source}),performance,AbortController,setTimeout,clearTimeout,
    pongFaceSwapBackgroundFetch:async (route,options)=>{requests.push({route,body:JSON.parse(options.body)});if(throws)throw Error('offline');return{ok:true,json:async()=>({queued:true})};},
  });
  assert.equal((await prepare()).queued,true);
  assert.equal(requests[0].body.sourceUrl,source);
  assert.equal(await prepare(),null);
  assert.equal(requests.length,1,'duplicate menu open does not open another source');
  source='file:///private.mp4';assert.equal(await prepare(),null);
  source='https://media.example/second.mp4';managed=true;assert.equal(await prepare(),null);
  managed=false;throws=true;assert.equal(await prepare(),null,'optional preparation failures must not affect face choice');
  assert.equal(requests.length,2);
  assert.match(namedFunction('togglePongFaceSwapMenu'),/void preparePongFaceSwapVisibleSource\(\)/);
});

test('latest queued seek retains the last visible frame instead of capturing an obsolete intermediate timestamp', () => {
  const retained={isConnected:true,dataset:{pongRetainedSeekFrame:'true'}};
  const wrapper={__pongFaceSwapTransitionOverlay:retained};
  const create=vm.runInNewContext(`(${namedFunction('createPongFaceSwapTransitionOverlay')})`,{});
  assert.equal(create(wrapper,{},'source.mp4',52,{freezeFrameOnly:true}),retained);
  assert.equal(retained.dataset.pongRetainedSeekFrame,undefined);
  assert.match(namedFunction('startPongFaceSwap'),/keepSeekFrame[\s\S]*?pongRetainedSeekFrame = 'true'[\s\S]*?else if[\s\S]*?clearPongFaceSwapTransitionOverlay/);
});

test('only an exact current manual-target seek can bypass the speculative prefetch rejection', () => {
  const state={seekGeneration:7};
  const match=vm.runInNewContext(`(${namedFunction('pongFaceSwapPreparedSeekMatches')})`,{pongFaceSwapState:state});
  const wrapper={},target={x:.4,y:.5,identityEmbedding:[1,2,3]},playable={source:'fixture.mp4',startSeconds:12};
  const entry={seek:true,wrapper,seekGeneration:7,faceId:'approved',source:playable.source,startSeconds:12,manualTargetKey:JSON.stringify(target)};
  assert.equal(match(entry,wrapper,playable,'approved',target),true);
  for(const change of [{seek:false},{wrapper:{}},{seekGeneration:6},{faceId:'other'},{source:'other.mp4'},{startSeconds:13},{manualTargetKey:'null'}]){
    assert.equal(match({...entry,...change},wrapper,playable,'approved',target),false);
  }
  assert.equal(match(entry,wrapper,playable,'approved',{...target,identityEmbedding:[4,5,6]}),false);
});

test('prepared readers retain the original source duration for scrubbing', () => {
  const create = namedFunction('createPongFaceSwapPrefetchForSource');
  const attach = namedFunction('attachPongFaceSwapPrefetch');
  const start = namedFunction('startPongFaceSwap');
  const monitor = namedFunction('monitorPongFaceSwapEncoding');
  const duration = namedFunction('pongFaceSwapFullDuration');
  assert.match(create, /statusPayload\?\.session\?\.duration/,
    'prefetch polling must capture the source duration reported by the engine');
  assert.match(create, /entry\.original\.fullDuration\s*=\s*sourceDuration/,
    'a reader attached before probing completes must receive the later duration');
  assert.match(attach, /entry\.fullDuration/,
    'hidden and suspended readers must retain the probed duration when attached');
  assert.match(start, /options\.prefetchedEntry\?\.fullDuration/,
    'activation must prefer the original duration over the one-second fMP4 lead');
  assert.match(monitor, /pongRememberSourceDuration\s*\(/,
    'a direct foreground session must adopt the probed source duration before its first frame');
  assert.match(duration, /isPongFaceSwapManagedMedia\s*\(wrapper,\s*video\)[\s\S]*?return\s+0/,
    'a managed swap must never expose its growing fragment duration as the full timeline');
  assert.match(source, /!managedSwap[\s\S]*?pongRememberSourceDuration\s*\(/,
    'ordinary source metadata must be cached before the video element becomes a swap reader');
});

test('the one bounded prepared swap reader always decodes ahead of navigation', () => {
  const attach = namedFunction('attachPongFaceSwapPrefetch');
  assert.match(
    attach,
    /video\.preload\s*=\s*['"]auto['"]/,
    'the dedicated one-reader swap preloader must decode instead of stopping at metadata',
  );
  assert.doesNotMatch(
    attach,
    /pongGenericRecallCaptureActive\(\)|recallMetadataOnly/,
    'ordinary Recall deck throttling must not disable the explicitly bounded swap reader',
  );
});

test('known capture duration is rendered before media metadata arrives', () => {
  const create = namedFunction('createVideoElements');
  assert.match(
    create,
    /videoMetadata\[index\]\?\.duration[\s\S]*?videoMetadata\[index\]\?\.durationSeconds[\s\S]*?durationText\.textContent\s*=\s*formatTime\(knownDuration\)/,
    'a stalled relay must still display the duration already reported by the source page',
  );
  const recycle = namedFunction('recycleNextEromeVideoIntoWrapper');
  assert.match(
    recycle,
    /nextMetadata\?\.duration[\s\S]*?nextMetadata\?\.durationSeconds[\s\S]*?durationText\.textContent\s*=\s*formatTime\(knownDuration\)/,
    'recycled cards must preserve their known logical duration before loading',
  );
  const compact = namedFunction('compactSessionVideoMetadata');
  assert.match(compact, /duration:\s*Math\.max\(0,\s*Number\(meta\.duration\s*\|\|\s*meta\.durationSeconds/);
  assert.match(compact, /videoSources:\s*Array\.isArray\(meta\.videoSources\)/);
});

test('mobile sync scrubbing preserves the managed swap timeline', () => {
  const managed = namedFunction('pongSyncIsManagedSwapMedia', syncSource);
  const duration = namedFunction('pongSyncPlaybackDuration', syncSource);
  const currentTime = namedFunction('pongSyncPlaybackCurrentTime', syncSource);
  const seek = namedFunction('pongSyncSeekPlayback', syncSource);
  const gestures = namedFunction('attachSmoothScrubToTapArea', syncSource);

  assert.match(managed, /isPongFaceSwapManagedMedia\s*\(/,
    'the mobile gesture bridge must use the canonical managed-media predicate');
  assert.match(duration, /pongFaceSwapFullDuration\s*\(/,
    'managed scrubbing must use the original source duration, not the short growing fragment');
  assert.match(currentTime, /pongFaceSwapAbsoluteTime\s*\(/,
    'managed scrubbing must begin at the absolute source timeline');
  assert.match(seek, /seekPongVideoTo\s*\(wrapper,\s*video,\s*target\)/,
    'managed scrub and double-tap seeks must use prepare-first swap replacement');
  assert.match(seek, /video\.currentTime\s*=\s*target/,
    'ordinary media and missing-helper fallback must retain a direct native seek');

  assert.match(gestures, /state\.startTime\s*=\s*pongSyncPlaybackCurrentTime\s*\(/,
    'touch scrubbing must capture the managed absolute start time');
  assert.ok(
    (gestures.match(/pongSyncSeekPlayback\s*\(/g) || []).length >= 3,
    'scrub completion and both double-tap directions must share the guarded seek bridge',
  );
  assert.doesNotMatch(gestures, /video\.currentTime\s*=/,
    'gesture handlers must never assign the short managed stream timeline directly');

  const calls = { seek: [], direct: [] };
  let isManaged = true;
  let nativeTime = 1.25;
  const wrapper = {};
  const video = { duration: 2.1 };
  Object.defineProperty(video, 'currentTime', {
    get: () => nativeTime,
    set: value => {
      nativeTime = Number(value);
      calls.direct.push(nativeTime);
    },
  });
  const context = {
    window: {
      isPongFaceSwapManagedMedia: () => isManaged,
      pongFaceSwapFullDuration: () => 90,
      pongFaceSwapAbsoluteTime: () => 31.5,
      seekPongVideoTo: (...args) => calls.seek.push(args),
    },
  };
  const bridge = vm.runInNewContext(`
    ${managed}
    ${duration}
    ${currentTime}
    ${seek}
    ({ pongSyncPlaybackDuration, pongSyncPlaybackCurrentTime, pongSyncSeekPlayback })
  `, context);

  assert.equal(bridge.pongSyncPlaybackDuration(wrapper, video), 90);
  assert.equal(bridge.pongSyncPlaybackCurrentTime(wrapper, video), 31.5);
  bridge.pongSyncSeekPlayback(wrapper, video, 42);
  assert.equal(calls.seek.length, 1, 'managed media must delegate exactly one replacement seek');
  assert.equal(calls.seek[0][2], 42);
  assert.deepEqual(calls.direct, [], 'managed media must not mutate the growing fragment timeline');

  isManaged = false;
  assert.equal(bridge.pongSyncPlaybackDuration(wrapper, video), 2.1);
  assert.equal(bridge.pongSyncPlaybackCurrentTime(wrapper, video), 1.25);
  bridge.pongSyncSeekPlayback(wrapper, video, 1.75);
  assert.deepEqual(calls.direct, [1.75], 'ordinary media must retain its native seek behavior');
});

test('generic UI and cache paths cannot mutate a managed swap stream', () => {
  const preview = namedFunction('previewScrubTo');
  assert.match(
    preview,
    /!isPongFaceSwapManagedMedia\s*\(wrapper,\s*video\)[\s\S]*?video\.currentTime\s*=\s*target/,
    'progress preview must mutate currentTime only for ordinary media',
  );
  assert.doesNotMatch(
    preview,
    /pongFaceSwapActive\s*!==\s*['"]true['"]/,
    'progress preview must also protect busy and prepared readers, not only active ones',
  );

  const cacheTimers = namedFunction('random40StartServerVideoCacheTimers');
  const managedGuard = cacheTimers.indexOf('isPongFaceSwapManagedMedia(wrapper, video)');
  const sourceWrite = cacheTimers.indexOf('video.src = streamUrl');
  const loadCall = cacheTimers.indexOf('video.load()');
  assert.ok(managedGuard >= 0, 'server-cache timer must recognize managed swap media');
  assert.ok(sourceWrite > managedGuard && loadCall > managedGuard,
    'server-cache src/load mutations must occur only after the managed-media guard');
});

test('ended playback uses swap replacement while ordinary playback seeks natively', () => {
  const restart = namedFunction('restartPongVideoFromBeginning');
  assert.match(restart, /isPongFaceSwapManagedMedia\s*\(wrapper,\s*video\)/);
  assert.match(restart, /seekPongVideoTo\s*\(wrapper,\s*video,\s*0\)/);

  let managed = true;
  let nativeTime = 7;
  const calls = { seek: [], direct: [] };
  const video = { ended: true };
  Object.defineProperty(video, 'currentTime', {
    get: () => nativeTime,
    set: value => {
      nativeTime = Number(value);
      calls.direct.push(nativeTime);
    },
  });
  const context = {
    isPongFaceSwapManagedMedia: () => managed,
    seekPongVideoTo: (...args) => calls.seek.push(args),
  };
  const restartVideo = vm.runInNewContext(`(${restart})`, context);
  const wrapper = { dataset: { pongFaceSwapActive: 'true' } };

  assert.equal(restartVideo(wrapper, video), 'swap');
  assert.equal(calls.seek.length, 1);
  assert.equal(calls.seek[0][2], 0);
  assert.deepEqual(calls.direct, [], 'active swap replay must not write its fragment currentTime');

  managed = false;
  wrapper.dataset.pongFaceSwapActive = 'false';
  assert.equal(restartVideo(wrapper, video), 'native');
  assert.deepEqual(calls.direct, [0], 'ordinary ended media must retain native replay');

  const toggle = namedFunction('toggleVideoPlaybackFromIntent');
  assert.match(toggle, /restartMode\s*===\s*['"]swap['"]\)\s*return/,
    'toggle must not call play() on the ended fragment while replacement is pending');
});

test('a late TikTok blob request loses ownership when face swap takes the video', () => {
  const owns = namedFunction('pongPendingSourceRequestOwnsVideo');
  const setSource = namedFunction('setPongVideoSource');
  let managed = false;
  let connected = true;
  const wrapper = {};
  const video = {
    dataset: { pongBlobRequestId: 'request-1' },
    closest: () => wrapper,
  };
  const context = {
    document: { body: { contains: () => connected } },
    isPongFaceSwapManagedMedia: () => managed,
  };
  const ownsRequest = vm.runInNewContext(`(${owns})`, context);

  assert.equal(ownsRequest(video, 'request-1'), true);
  managed = true;
  assert.equal(ownsRequest(video, 'request-1'), false,
    'a request begun before swap must lose permission to assign src/load');
  managed = false;
  connected = false;
  assert.equal(ownsRequest(video, 'request-1'), false);
  connected = true;
  assert.equal(ownsRequest(video, 'stale-request'), false);
  assert.ok(
    (setSource.match(/pongPendingSourceRequestOwnsVideo\s*\(video,\s*requestId\)/g) || []).length >= 2,
    'both late success and failure callbacks must revalidate media ownership',
  );
});

test('ordinary resume logic cannot seek a short prepared swap fragment', () => {
  const restore = namedFunction('restoreVideoPlaybackPosition');
  assert.match(restore, /pongFaceSwapPreloadSessionId/,
    'prepared swap readers must be excluded from normal saved-position restore');
  assert.match(restore, /__pongSwapPreloadedOriginal/,
    'a claimed prepared reader must stay excluded while its wrapper is rebound');
  assert.match(restore, /__pongSwapOriginal/,
    'active swap readers must seek through the swap replacement workflow');
});

test('generic retry and recovery paths never rebind managed face-swap media', () => {
  const managed = namedFunction('isPongFaceSwapManagedMedia');
  for (const marker of [
    'pongFaceSwapPreloadSessionId',
    'pongFaceSwapSessionId',
    '__pongSwapPreloadedOriginal',
    '__pongSwapOriginal',
  ]) {
    assert.match(managed, new RegExp(marker), `managed-media predicate must retain ${marker}`);
  }

  for (const name of [
    'suspendDeckVideoNetwork',
    'restoreDeckVideoNetwork',
    'rotateVideoRetrySource',
    'retryVisibleBatchVideoLoads',
    'random40SwapRenderedVideoSource',
    'random40PromoteWrapperToServerCache',
  ]) {
    assert.match(
      namedFunction(name),
      /isPongFaceSwapManagedMedia\s*\(/,
      `${name}() must reject managed swap media before changing its network source`,
    );
  }

  const noLoadRecovery = namedFunction('scheduleForegroundNoLoadRetry');
  assert.ok(
    (noLoadRecovery.match(/isPongFaceSwapManagedMedia\s*\(/g) || []).length >= 2,
    'no-load recovery must recheck ownership after its timer fires',
  );
  const stallRecovery = namedFunction('scheduleForegroundPlaybackStallRecovery');
  assert.ok(
    (stallRecovery.match(/isPongFaceSwapManagedMedia\s*\(/g) || []).length >= 3,
    'stall recovery must recheck ownership in both delayed mutation paths',
  );

  const playerBindings = namedFunction('createVideoElements');
  assert.ok(
    (playerBindings.match(/isPongFaceSwapManagedMedia\s*\(/g) || []).length >= 4,
    'waiting, stalled, error, and delayed error retries must leave managed swap streams to their owner',
  );
  assert.match(
    namedFunction('attachExpiredMediaHintsToVideo', syncSource),
    /isPongFaceSwapManagedMedia\s*\(/,
    'signed-URL repair must not replace a managed swap stream',
  );
});
