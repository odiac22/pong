import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const [source, presetText, configSource, serviceSource, serverSource] = await Promise.all([
  readFile(path.join(ROOT, 'index.html'), 'utf8'),
  readFile(path.join(ROOT, 'Pong Swap', 'presets', 'current.json'), 'utf8'),
  readFile(path.join(ROOT, 'Pong Swap', 'pong_swap_config.py'), 'utf8'),
  readFile(path.join(ROOT, 'Pong Swap', 'pong_swap_service.py'), 'utf8'),
  readFile(path.join(ROOT, 'local-ai-server.mjs'), 'utf8'),
]);

function namedFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert(match, `${name}() is missing`);
  const start = match.index;
  const paramsStart = source.indexOf('(', start);
  let depth = 0;
  let paramsEnd = -1;
  for (let i = paramsStart; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) { paramsEnd = i; break; }
  }
  const bodyStart = source.indexOf('{', paramsEnd + 1);
  depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i++; continue; }
    if (char === '/' && next === '*') { blockComment = true; i++; continue; }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name}() is unterminated`);
}

test('PC swap decoder rewrites only Android emulator aliases for local media routes', () => {
  assert.match(serviceSource, /def _engine_source_url\(raw_url: str\)/);
  assert.match(serviceSource, /\{"10\.0\.2\.2", "10\.0\.3\.2"\}/);
  assert.match(serviceSource, /path == "\/video-cache\/stream"/);
  assert.match(serviceSource, /source_url=_engine_source_url\(payload\.sourceUrl\)/);
  assert.match(serviceSource, /source_urls=\[_engine_source_url\(value\) for value in payload\.sourceUrls\]/);
});

test('dynamic quality stays disabled in both defaults and the active preset', () => {
  const preset = JSON.parse(presetText);
  assert.equal(preset.runtime.dynamicQualityEnabled, false);
  assert.match(configSource, /"dynamicQualityEnabled"\s*:\s*False/);
  assert.match(configSource, /"pipeline2Enabled"\s*:\s*True/);
});

test('all three navigation classes are sent to the swap service', () => {
  assert.match(namedFunction('createPongFaceSwapPrefetchForSource'), /navigationClass:\s*entry\.navigationClass/);
  assert.match(namedFunction('preparePongFaceSwapSeek'), /navigationClass:\s*['"]seek['"]/);
  assert.match(namedFunction('startPongFaceSwap'), /navigationClass:\s*['"]foreground['"]/);
  assert.match(serviceSource, /navigationClass:\s*str\s*=\s*"prefetch"/);
  assert.match(serviceSource, /navigation_class=payload\.navigationClass/);
});

test('seek uses the isolated control plane and parks only on same-origin fallback', () => {
  const release = namedFunction('releasePongFaceSwapAttachmentSlotsForControlPlane');
  assert.match(release, /parkPongFaceSwapPrefetchAttachment\(candidates\[0\]\)/);
  assert.doesNotMatch(release, /stopPongFaceSwapPrefetch|\bfetch\s*\(/);
  assert.match(
    namedFunction('preparePongFaceSwapSeek'),
    /ensurePongFaceSwapControlPlane\(\)[\s\S]*?if\s*\(!separateControlPlane\)\s*releasePongFaceSwapAttachmentSlotsForControlPlane\(\)[\s\S]*?pongFaceSwapControlFetch\('\/pong-swap\/sessions'/,
  );
  assert.doesNotMatch(
    namedFunction('startPongFaceSwap'),
    /releasePongFaceSwapAttachmentSlotsForControlPlane/,
  );
});

test('critical and background swap requests use independent non-media ports', () => {
  assert.match(source, /const PONG_FACE_SWAP_CONTROL_PORT\s*=\s*8793/);
  assert.match(source, /const PONG_FACE_SWAP_BACKGROUND_CONTROL_PORT\s*=\s*8795/);
  assert.match(namedFunction('pongFaceSwapControlFetch'), /ensurePongFaceSwapControlPlane\(\)/);
  assert.match(namedFunction('pongFaceSwapControlFetch'), /base\s*\?\s*`\$\{base\}\$\{path\}`\s*:\s*path/);
  assert.match(namedFunction('pongFaceSwapBackgroundFetch'), /ensurePongFaceSwapBackgroundControlPlane\(\)/);
  assert.match(serverSource, /const PONG_SWAP_CONTROL_PORT\s*=\s*Number\([^\n]*8793/);
  assert.match(serverSource, /PONG_SWAP_BACKGROUND_CONTROL_PORT[\s\S]*?8795/);
  assert.match(serverSource, /const pongSwapControlServer\s*=\s*createPongSwapControlServer\(\)/);
  assert.match(serverSource, /const pongSwapBackgroundControlServer\s*=\s*createPongSwapControlServer\(\)/);
  assert.match(serverSource, /\/stream\\\/\?\$\/\.test\(requestUrl\.pathname\)/);
  assert.match(serverSource, /Access-Control-Allow-Methods['"]?:\s*['"]GET,HEAD,POST,PUT,DELETE,OPTIONS/);
  assert.match(serverSource, /upstream\.setTimeout\(30_000/);
  assert.match(serverSource, /!\/\\\/stream\\\/\?\$\/\.test\(requestUrl\.pathname\)/);
});

test('control-plane parking closes one reader without restoring its CDN source', () => {
  const park = namedFunction('parkPongFaceSwapPrefetchAttachment');
  assert.match(park, /video\.removeAttribute\(['"]src['"]\)/);
  assert.match(park, /entry\.parked\s*=\s*true/);
  assert.doesNotMatch(park, /setPongVideoSource|original\.source|\bfetch\s*\(/);
  const attach = namedFunction('attachPongFaceSwapPrefetch');
  assert.match(attach, /entry\.parked\s*&&\s*entry\.video/);
  assert.match(attach, /source:\s*entry\.source/);
});

test('the first decoded swapped frame releases busy state and flushes a queued seek', () => {
  const start = namedFunction('startPongFaceSwap');
  assert.match(
    start,
    /const unlockPrefetchAfterPresentedFrame[\s\S]*?presentedSessionMatches[\s\S]*?delete wrapper\.dataset\.pongFaceSwapBusy[\s\S]*?replayPendingPongFaceSwapActivation\(\)[\s\S]*?flushPendingPongFaceSwapSeek\(wrapper, video\)/,
    'busy state and queued intents may be released only by a presented frame from the exact owned session',
  );
});

test('scrubbing yields old-timeline GPU work and resumes it on failed preparation', () => {
  const suspend = namedFunction('suspendPongFaceSwapForScrub');
  const preempt = namedFunction('preemptUnreadyPongFaceSwapPrefetchesForScrub');
  const schedule = namedFunction('schedulePongFaceSwapPrefetch');
  const resume = namedFunction('resumePongFaceSwapAfterScrub');
  const seek = namedFunction('seekPongVideoTo');
  const prepare = namedFunction('preparePongFaceSwapSeek');
  assert.match(suspend, /\/suspend/);
  assert.match(suspend, /preemptUnreadyPongFaceSwapPrefetchesForScrub\(\)/);
  assert.match(preempt, /safelyParked[\s\S]*?entry\?\.ready\s*===\s*true[\s\S]*?!entry\.attached[\s\S]*?entry\.browserReady\s*===\s*true[\s\S]*?stopPongFaceSwapPrefetch\(entry\)/,
    'scrub priority must also cancel a server-ready reader still decoding in WebView');
  assert.match(schedule, /scrubOwnsGpuPriority[\s\S]*?pendingSeekTarget[\s\S]*?seekEntry[\s\S]*?pongFaceSwapScrubSuspendedSessionId/,
    'metadata callbacks must not restart speculative rendering during a user seek');
  assert.match(resume, /\/resume/);
  assert.match(seek, /suspendPongFaceSwapForScrub\(wrapper\)/);
  assert.match(prepare, /resumePongFaceSwapAfterScrub\(wrapper\)/);
  assert.match(serviceSource, /@app\.post\("\/sessions\/\{session_id\}\/suspend"\)/);
  assert.match(serviceSource, /@app\.post\("\/sessions\/\{session_id\}\/resume"\)/);
});

test('browser playback position drives server production credit', () => {
  const report = namedFunction('reportPongFaceSwapPlayback');
  assert.match(report, /Number\(video\.readyState \|\| 0\) < 2/);
  assert.match(report, /Number\(video\.videoWidth \|\| 0\) <= 0/);
  assert.match(report, /positionSeconds/);
  assert.match(report, /paused/);
  assert.match(report, /\/playback/);
  assert.match(serviceSource, /class PlaybackUpdateRequest\(BaseModel\)/);
  assert.match(serviceSource, /@app\.post\("\/sessions\/\{session_id\}\/playback"\)/);
  assert.match(serviceSource, /ENGINE\.update_playback/);
  const create = namedFunction('createVideoElements');
  assert.match(create, /reportPongFaceSwapPlayback\(wrapper, video, true\)/);
  assert.match(create, /reportPongFaceSwapPlayback\(wrapper, video\)/);
});

test('session creation has one end-to-end browser deadline', () => {
  const prefetch = namedFunction('createPongFaceSwapPrefetchForSource');
  const start = namedFunction('startPongFaceSwap');
  assert.match(prefetch, /new AbortController\(\)/);
  assert.match(prefetch, /requestAbort\.abort\(\)/);
  assert.match(prefetch, /signal:\s*requestAbort\.signal/);
  assert.match(start, /new AbortController\(\)/);
  assert.match(start, /startupAbort\.abort\(\)/);
  assert.match(start, /signal:\s*startupAbort\.signal/);
});

test('adaptive scheduler expands fast navigation and contracts long dwell', () => {
  const state = { dwellEmaMs: 0, navigationSamples: 0, schedulerProfile: null };
  const context = {
    pongFaceSwapState: state,
    PONG_FACE_SWAP_PREFETCH_COUNT: 2,
    PONG_FACE_SWAP_PREFETCH_MAX_COUNT: 3,
  };
  const profile = vm.runInNewContext(`(${namedFunction('pongFaceSwapSchedulerProfile')})`, context);
  assert.deepEqual({ ...profile() }, {
    name: 'normal', count: 2, nearSeconds: 2, farSeconds: 1.25,
    dwellEmaMs: 0, samples: 0,
  });
  state.dwellEmaMs = 1200;
  state.navigationSamples = 4;
  assert.equal(profile().count, 3);
  assert.equal(profile().nearSeconds, 1.5);
  state.dwellEmaMs = 8000;
  assert.equal(profile().count, 2);
  assert.equal(profile().nearSeconds, 2.5);
});

test('explicit swap phases reject an impossible transition', () => {
  const state = { phaseEvents: [] };
  const phases = {
    ORIGINAL: 'original', PREPARING: 'preparing', READY: 'ready',
    PRESENTING: 'presenting', PLAYING: 'playing', SEEKING: 'seeking',
    STAGED: 'staged', STOPPING: 'stopping', ERROR: 'error',
  };
  const transitions = {
    original: new Set(['preparing']),
    preparing: new Set(['presenting']),
    presenting: new Set(['playing']),
    playing: new Set(['seeking', 'staged', 'stopping']),
  };
  const wrapper = { dataset: { index: '3' } };
  const context = {
    pongFaceSwapState: state,
    PONG_FACE_SWAP_PHASES: phases,
    PONG_FACE_SWAP_PHASE_TRANSITIONS: transitions,
    pongRuntimeOwnerToken: value => String(value || '').slice(0, 8),
  };
  context.pongFaceSwapPhase = vm.runInNewContext(
    `(${namedFunction('pongFaceSwapPhase')})`, context,
  );
  const setPhase = vm.runInNewContext(`(${namedFunction('setPongFaceSwapPhase')})`, context);
  assert.equal(setPhase(wrapper, 'preparing'), true);
  assert.equal(setPhase(wrapper, 'presenting'), true);
  assert.equal(setPhase(wrapper, 'playing'), true);
  assert.equal(setPhase(wrapper, 'ready'), false);
  assert.equal(wrapper.dataset.pongFaceSwapPhase, 'playing');
  assert.equal(state.phaseEvents.at(-1).accepted, false);
});
