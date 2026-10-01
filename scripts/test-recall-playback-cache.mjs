import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../local-ai-server.mjs', import.meta.url), 'utf8');

function extractFunction(name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers.reduce((found, marker) => {
    const index = html.indexOf(marker);
    return index >= 0 && (found < 0 || index < found) ? index : found;
  }, -1);
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

test('every inline Pong script is syntactically valid', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1]))
    .map(match => match[2]);
  assert.ok(scripts.length >= 2);
  scripts.forEach((source, index) => new vm.Script(source, { filename: `index-inline-${index}.js` }));
});

test('progressive Recall captures use the bounded cache while HLS and authenticated relays retain their transports', () => {
  const route=vm.runInNewContext(`(${extractFunction('genericRecallPlaybackUrl')})`,{
    pongGenericRangeCacheAvailable:true,
    random40IsGenericHlsMediaUrl:value=>/\.m3u8(?:[?#]|$)/i.test(value),
  });
  const signed='https://cdn.example/video-1080.mp4?token=abc&expires=123';
  assert.equal(route(signed),'/video-cache/stream?url='+encodeURIComponent(signed));
  assert.equal(route('https://cdn.example/master.m3u8'),'/generic-media/hls?url='+encodeURIComponent('https://cdn.example/master.m3u8'));
  assert.equal(route('/media-browser-relay/stream/test-123'),'/media-browser-relay/stream/test-123');
  assert.equal(route('https://cdn.example/opaque-player'),'/proxy?url='+encodeURIComponent('https://cdn.example/opaque-player'));
  assert.match(extractFunction('genericRecallVideoRecord'),/genericRecallPlaybackUrl\(originalUrl\)/);
});

test('old or unknown helpers retain proxy transport until bounded ranges are advertised', () => {
  const context = vm.createContext({pongGenericRangeCacheAvailable:false,
    random40IsGenericHlsMediaUrl:value=>/\.m3u8(?:[?#]|$)/i.test(value)});
  vm.runInContext(extractFunction('genericRecallPlaybackUrl'),context);
  vm.runInContext(extractFunction('updatePongMediaTransportCapabilities'),context);
  const url='https://cdn.example/original.mp4?token=unchanged';
  const route=()=>context.genericRecallPlaybackUrl(url);
  assert.equal(route(),'/proxy?url='+encodeURIComponent(url));
  context.updatePongMediaTransportCapabilities({mediaTransport:{boundedRanges:true}});
  assert.equal(route(),'/video-cache/stream?url='+encodeURIComponent(url));
  for (const payload of [{},null,{mediaTransport:{boundedRanges:'true'}}]) {
    context.updatePongMediaTransportCapabilities(payload);
    assert.equal(route(),'/proxy?url='+encodeURIComponent(url));
  }
  assert.match(extractFunction('fetchSharedSimpCityRecall'),/updatePongMediaTransportCapabilities\(data\)/);
  const start=server.indexOf("if (req.method === 'GET' && url.pathname === '/simpcity/recall')");
  const end=server.indexOf("if (req.method === 'POST' && url.pathname === '/simpcity/recall/begin')",start);
  assert.match(server.slice(start,end),/mediaTransport:\s*\{ boundedRanges: true \}/);
});

test('only the visible card owns the growing cache foreground lane', () => {
  const foreground = extractFunction('random40ForegroundPlaybackUrl');
  const restore = extractFunction('restoreDeckVideoNetwork');
  const timers = extractFunction('random40StartServerVideoCacheTimers');
  const warmIndexes = extractFunction('getDeckNetworkWarmIndexes');

  assert.match(
    foreground,
    /random40PcFileCacheStreamUrl\(key\)[\s\S]*?random40PcPlaybackGatewayUrl\(key\)/,
    'the visible card should consume an already-growing local prefix before the raw proxy'
  );
  assert.match(restore, /const isForeground =[\s\S]*?isForeground\s*\?\s*random40ForegroundPlaybackUrl/);
  assert.match(timers, /const isForeground =[\s\S]*?isForeground\s*\?\s*random40ForegroundPlaybackUrl[\s\S]*?: random40PlaybackUrl/);
  assert.match(
    warmIndexes,
    /random40IsPcGrowingCachePlaybackUrl[\s\S]*?return warmIndexes/,
    'a starved growing-cache reader must not compete with an escape proxy reader'
  );
  const renderStart = html.indexOf('function createVideoElements(');
  const renderEnd = html.indexOf('\nfunction ', renderStart + 1);
  const render = html.slice(renderStart, renderEnd);
  assert.match(
    render,
    /shouldAttachInitially[\s\S]*?const playbackUrl = random40ForegroundPlaybackUrl\(url\)/,
    'the first Recall/Paperclip card must receive the same foreground route as a later swipe'
  );
  assert.match(
    render,
    /!shouldAttachInitially[\s\S]*?suspendedVideoSrc = random40PlaybackUrl\(url\)/,
    'hidden cards must never reserve the foreground growing-cache route'
  );
});

test('a stuck old cache generation cannot leave every new video unavailable', () => {
  const start = server.indexOf('async function resetVideoFileCache(');
  const end = server.indexOf('\nfunction touchVideoFileCacheHeartbeat', start);
  assert.ok(start >= 0 && end > start);
  const reset = server.slice(start, end);
  assert.match(server, /function videoFileCachePathFor\(id, suffix = '\.cache', generation = videoFileCacheGeneration\)/);
  assert.match(reset, /videoFileCacheGeneration\+\+/);
  assert.match(reset, /videoFileCacheRecords\.clear\(\)/);
  assert.match(reset, /videoFileCacheHealthy = true/);
  assert.match(reset, /void waitForVideoFileCacheIo\(readers, downloads\)/);
  assert.ok(
    reset.indexOf('videoFileCacheHealthy = true') < reset.indexOf('void waitForVideoFileCacheIo(readers, downloads)'),
    'the new cache generation must become healthy before stale native I/O cleanup'
  );
  assert.doesNotMatch(reset, /await waitForVideoFileCacheIo/);
});

test('cache status reports only records with a real direct fallback as playable', () => {
  const start = server.indexOf('function videoFileCacheRecordHasPlayableFallback(');
  const end = server.indexOf('\nfunction videoFileCacheRecordJson(', start);
  assert.ok(start >= 0 && end > start);
  const fallback = server.slice(start, end);
  const recordJsonStart = server.indexOf('function videoFileCacheRecordJson(');
  const recordJsonEnd = server.indexOf('\nfunction videoFileCacheSnapshot(', recordJsonStart);
  const recordJson = server.slice(recordJsonStart, recordJsonEnd);

  assert.match(fallback, /record\.playbackProfile === 'bunkr'/);
  assert.match(fallback, /record\.status === 'error' && bytes <= 0/);
  assert.match(fallback, /totalBytes > VIDEO_FILE_CACHE_MAX_FILE_BYTES/);
  assert.doesNotMatch(fallback, /record\.status === 'error'\s*;?\s*$/m);
  assert.match(recordJson, /videoFileCacheRecordHasPlayableFallback\(record\)/);
});

test('foreground Bunkr delivery stitches bounded ranges without changing media bytes', () => {
  assert.match(server, /const BUNKR_FOREGROUND_RANGE_BYTES =[^;]+1024 \* 1024/);
  assert.match(server, /const BUNKR_FOREGROUND_RANGE_CONCURRENCY =[^;]+\|\| 4/);
  const start = server.indexOf('async function tryStreamParallelBunkrRange(');
  const end = server.indexOf('\nasync function streamGenericHlsResponse(', start);
  assert.ok(start >= 0 && end > start);
  const parallel = server.slice(start, end);
  assert.match(parallel, /hostname === 'cdn\.cr' \|\| hostname\.endsWith\('\.cdn\.cr'\)/);
  assert.match(parallel, /requestedRange\.end === null\) return false/);
  assert.match(parallel, /res\.writeHead\(requestedRange\.requested \? 206 : 200, headers\)/);
  assert.match(parallel, /let pending = launchWave\(\)/);
  assert.match(parallel, /for await \(const chunk of firstResponse\)/);
  assert.match(parallel, /await Promise\.all\(pending\)/);
  assert.match(parallel, /writeVideoFileCacheChunk\(res, chunk\)/);
  assert.match(parallel, /writeVideoFileCacheChunk\(res, buffer\)/);

  const mediaStart = server.indexOf('async function serveVideoFileCacheMedia(');
  const mediaEnd = server.indexOf('\nasync function ', mediaStart + 1);
  const media = server.slice(mediaStart, mediaEnd);
  assert.match(media, /recallOriginStream[\s\S]*tryStreamParallelBunkrRange\(req, res, record\.sourceUrl\)/);
  assert.match(media, /knownOversized[\s\S]*tryStreamParallelBunkrRange\(req, res, record\.sourceUrl\)/);
});

test('cache canonicalization unwraps Pong transports but preserves signed source URLs', () => {
  const context = vm.createContext({
    URL,
    window: { location: { href: 'https://odiac22.github.io/pong/' } }
  });
  vm.runInContext(extractFunction('pongCanonicalRawMediaUrl'), context);
  const canonicalize = value => vm.runInContext(
    `pongCanonicalRawMediaUrl(${JSON.stringify(value)})`,
    context
  );
  const raw = 'https://cdn.example/video/clip.mp4?token=a%2Bb&expires=123';
  const worker = `https://pong-erome-proxy.example/bunkr.mp4?u=${encodeURIComponent(raw)}`;
  const localStream = `http://127.0.0.1:8787/video-cache/stream?url=${encodeURIComponent(worker)}&profile=bunkr`;

  assert.equal(canonicalize(raw), raw);
  assert.equal(canonicalize(worker), raw);
  assert.equal(canonicalize(localStream), raw);
  assert.equal(canonicalize(`http://127.0.0.1:8787/proxy?url=${encodeURIComponent(raw)}`), raw);
  assert.equal(canonicalize('http://127.0.0.1:8787/video-cache/media/deadbeef'), '');
  assert.equal(canonicalize('https://localhost:8787/video-cache/media/deadbeef'), '');
});

test('Recall cards retain distinct browser playback and canonical source URLs', () => {
  const importSource = extractFunction('buildEromeCardImportPayload');
  assert.match(importSource, /videoUrl:\s*proxiedUrl/);
  assert.match(importSource, /originalVideoUrl:\s*mediaUrl/);
  assert.match(importSource, /canonicalMediaUrl:\s*mediaUrl/);
  const renderStart = html.indexOf('function createVideoElements(');
  const renderEnd = html.indexOf('\nfunction ', renderStart + 1);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSource = html.slice(renderStart, renderEnd);
  assert.match(renderSource, /wrapper\.dataset\.originalVideoUrl\s*=\s*url/);
  assert.match(renderSource, /wrapper\.dataset\.canonicalMediaUrl\s*=\s*pongCanonicalRawMediaUrl/);
});

test('video-cache warm posts canonical sources and never a Pong wrapper', async () => {
  let postedBody = null;
  const endpoint = 'http://127.0.0.1:8787';
  const context = vm.createContext({
    URL,
    window: { location: { href: 'http://127.0.0.1:8787/' } },
    Date,
    AbortController,
    setTimeout: () => 1,
    clearTimeout: () => {},
    random40ServerVideoCacheEndpoint: () => endpoint,
    RANDOM40_BENCHMARK_NO_MEDIA: false,
    random40ServerVideoCacheManifestSignature: '',
    random40ServerVideoCacheManifestInFlightSignature: '',
    random40ServerVideoCacheLastWarmAt: 0,
    RANDOM40_SERVER_VIDEO_CACHE_WARM_MIN_MS: 900,
    RANDOM40_SERVER_VIDEO_CACHE_BATCH: 60,
    pongLocal22PlaybackActive: () => false,
    random40StartServerVideoCacheTimers: () => {},
    trackPongWorkloadController: () => () => {},
    random40ApplyServerVideoCacheRecords: () => {},
    fetch: async (_url, options) => {
      postedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ records: [] }) };
    }
  });
  vm.runInContext(extractFunction('pongCanonicalRawMediaUrl'), context);
  vm.runInContext(extractFunction('random40WarmServerVideoCache'), context);

  const raw = 'https://cdn.example/video/clip.mp4?token=keep-me';
  const worker = `https://pong-erome-proxy.example/erome.mp4?u=${encodeURIComponent(raw)}`;
  const localStream = `${endpoint}/video-cache/stream?url=${encodeURIComponent(worker)}`;
  context.inputItems = [{ url: worker, artistKey: 'artist-one' }];
  context.inputOptions = {
    activeUrl: localStream,
    deferredUrl: `${endpoint}/proxy?url=${encodeURIComponent(raw)}`,
    entryUrls: [worker],
    currentUrls: [localStream],
    playbackProfile: 'bunkr',
    urgent: true
  };
  const result = await vm.runInContext(
    'random40WarmServerVideoCache(inputItems, inputOptions)',
    context
  );

  assert.equal(result, true);
  assert.ok(postedBody);
  assert.equal(postedBody.activeUrl, raw);
  assert.equal(postedBody.deferredUrl, raw);
  assert.deepEqual(postedBody.entryUrls, [raw]);
  assert.deepEqual(postedBody.currentUrls, [raw]);
  assert.deepEqual(postedBody.items, [{
    url: raw,
    artistKey: 'artist-one',
    segmentConcurrency: 0
  }]);
  assert.doesNotMatch(JSON.stringify(postedBody), /localhost|127\.0\.0\.1|\/video-cache\/stream|\/proxy\?url=/);
});

test('Recall backlog warms two videos while the selected artist promotes its full preview', () => {
  assert.match(
    html,
    /groups[\s\S]{0,400}\.flatMap\(group\s*=>\s*group\.videos\.slice\(0,\s*SIMPCITY_BACKGROUND_WARM_VIDEO_COUNT\)/
  );
  assert.match(html, /const SIMPCITY_BACKGROUND_WARM_VIDEO_COUNT = 2/);
  assert.match(html, /entryUrls:\s*previewEntryUrls/);
  const transition = extractFunction('prewarmRecallPasteEventForTransition');
  assert.match(transition, /activeUrl,/);
  assert.match(transition, /currentUrls:/);
  assert.match(transition, /entryUrls,/);
  assert.match(transition, /SIMPCITY_PREVIEW_VIDEO_COUNT/);
  assert.match(transition, /urgent:\s*true/);
  const activeWarm = extractFunction('random40WarmServerVideoCacheForActiveWrapper');
  assert.match(activeWarm, /pongRecallMediaPlaybackProfile\(originalUrl, event\?\.simpCityMediaKind\)/);
  assert.match(activeWarm, /random40WarmServerVideoCache\(currentUrls,[\s\S]*playbackProfile,/);
});

test('Recall routes mixed hosted media by the actual media host', () => {
  const profile = extractFunction('pongRecallMediaPlaybackProfile');
  assert.match(profile, /cdn\.cr/);
  assert.match(profile, /return ['"]bunkr['"]/);
  assert.match(profile, /return ['"]current['"]/);

  const payload = extractFunction('buildEromeCardImportPayload');
  assert.match(payload, /pongCanonicalRawMediaUrl\(candidateUrl\)/);
  assert.match(payload, /pongRecallMediaPlaybackProfile\(candidate, group\.mediaKind\)/);
  assert.match(payload, /pongHostedMediaReliabilityRank\(candidate\) <= 2/);
  assert.match(payload, /\/video-cache\/stream\?url=\$\{encodeURIComponent\(candidate\)\}&profile=\$\{profile\}/);
});

test('TikTok is side-deck only and never becomes a Paperclip bundle', () => {
  const visibility = extractFunction('isPasteEventViewableForPaperclip');
  assert.match(visibility, /isSimpCityTikTokEvent\(event\)[\s\S]*return false/);
  assert.match(html, /paperclipHidden:\s*group\.paperclipHidden === true \|\| group\.mediaKind === 'tiktok'/);
  assert.match(html, /function getSimpCityTikTokContext/);
  assert.match(html, /function toggleSimpCityTikTokSideDeck/);
});

test('artist transition detaches audio, HLS, blob, and native source ownership', () => {
  const revoked = [];
  const context = vm.createContext({
    URL: { revokeObjectURL: value => revoked.push(value) },
    window: {},
    queueMicrotask: callback => callback(),
    armPongVideoPresentedFrameTracker: () => {},
    silencePongFaceSwapAudioCompanion: () => {},
    isPongActiveVideo: () => false,
    silenceAllPongAudioExcept: () => {}
  });
  vm.runInContext(extractFunction('silencePongVideo'), context);
  vm.runInContext(extractFunction('markPongVideoVisualFrameUnavailable'), context);
  vm.runInContext(extractFunction('pongVideoSourceGeneration'), context);
  vm.runInContext(extractFunction('advancePongVideoSourceGeneration'), context);
  vm.runInContext(extractFunction('detachPongVideoForTransition'), context);
  let destroyed = 0;
  const wrapper = {
    dataset: { playIntent: 'true' },
    classList: { remove() {} }
  };
  const sources = [
    {
      src: 'https://cdn.example/one.mp4',
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    },
    {
      src: 'https://cdn.example/two.mp4',
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    }
  ];
  const video = {
    muted: false,
    defaultMuted: false,
    volume: 1,
    paused: false,
    autoplay: true,
    preload: 'auto',
    dataset: { pongBlobRequestId: '4' },
    src: 'https://cdn.example/video.mp4',
    srcObject: { active: true },
    __pongHls: { destroy: () => { destroyed++; } },
    __pongBlobUrl: 'blob:old-card',
    closest: () => wrapper,
    querySelectorAll: selector => selector === 'source' ? sources : [],
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() { this.loaded = true; }
  };
  context.videoUnderTest = video;
  assert.equal(vm.runInContext('detachPongVideoForTransition(videoUnderTest)', context), true);
  assert.equal(video.muted, true);
  assert.equal(video.defaultMuted, true);
  assert.equal(video.volume, 0);
  assert.equal(video.paused, true);
  assert.equal(video.autoplay, false);
  assert.equal(video.preload, 'none');
  assert.equal(video.dataset.pongBlobRequestId, '5');
  assert.match(video.dataset.foregroundLoadWatch, /^detached-/);
  assert.equal(video.__pongHls, null);
  assert.equal(video.__pongBlobUrl, '');
  assert.equal(video.src, '');
  assert.equal(video.srcObject, null);
  assert.deepEqual(sources.map(source => source.src), ['', '']);
  assert.equal(destroyed, 1);
  assert.deepEqual(revoked, ['blob:old-card']);
  assert.equal(wrapper.dataset.playIntent, undefined);
  assert.equal(video.loaded, true);
});

test('recycled video ignores prior-source swap listeners and play finalizers', async () => {
  const listeners = new Map();
  const classes = new Set(['deck-active']);
  const wrapper = {
    dataset: { playIntent: 'true' },
    classList: {
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: (...names) => names.forEach(name => classes.delete(name))
    },
    querySelector: selector => selector === 'video' ? video : null
  };
  let sourceUrl = 'https://cdn.example/original.mp4';
  const playResolvers = [];
  const video = {
    muted: false,
    defaultMuted: false,
    volume: 0.8,
    paused: false,
    ended: false,
    autoplay: true,
    preload: 'auto',
    currentTime: 7,
    duration: 30,
    currentSrc: sourceUrl,
    isConnected: true,
    dataset: {},
    __pongHls: null,
    __pongBlobUrl: '',
    get src() { return sourceUrl; },
    set src(value) { sourceUrl = value; this.currentSrc = value; },
    closest: () => wrapper,
    querySelectorAll: () => [],
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    pause() { this.paused = true; },
    play() {
      this.paused = false;
      return new Promise(resolve => playResolvers.push(resolve));
    },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 })
  };
  let staleResumeCalls = 0;
  const context = vm.createContext({
    URL,
    location: { href: 'http://127.0.0.1:8787/' },
    window: {},
    queueMicrotask: callback => callback(),
    armPongVideoPresentedFrameTracker: () => {},
    document: { body: { contains: () => true } },
    silencePongFaceSwapAudioCompanion: () => {},
    foregroundPriorityVideo: null,
    prepareVideoForPlayback: () => {},
    applyPlayerAudioPreference: value => {
      value.muted = false;
      value.volume = 0.6;
    },
    isPongActiveVideo: () => classes.has('deck-active'),
    silenceAllPongAudioExcept: () => {},
    playVideoCleanly: () => { staleResumeCalls++; }
  });
  for (const name of [
    'silencePongVideo',
    'markPongVideoVisualFrameUnavailable',
    'pongVideoSourceGeneration',
    'advancePongVideoSourceGeneration',
    'detachPongVideoForTransition',
    'isPongFaceSwapManagedMedia',
    'random40PlaybackUrlsMatch',
    'random40SwapRenderedVideoSource'
  ]) vm.runInContext(extractFunction(name), context);
  context.wrapperUnderTest = wrapper;
  context.videoUnderTest = video;

  const cacheUrl = 'http://127.0.0.1:8787/video-cache/media/abc123';
  context.cacheUrl = cacheUrl;
  assert.equal(
    vm.runInContext('random40SwapRenderedVideoSource(wrapperUnderTest, cacheUrl, { forceActive: true })', context),
    true
  );
  const swapGeneration = video.dataset.pongSourceGeneration;
  assert.ok(swapGeneration);

  vm.runInContext('detachPongVideoForTransition(videoUnderTest)', context);
  assert.notEqual(video.dataset.pongSourceGeneration, swapGeneration);
  // Reuse the node with the same URL so the generation guard, rather than only
  // URL comparison, must reject callbacks installed by the prior source owner.
  video.src = cacheUrl;
  video.currentTime = 0;
  video.muted = true;
  video.volume = 0;
  for (const listener of listeners.get('loadedmetadata') || []) listener();
  for (const listener of listeners.get('canplay') || []) listener();
  assert.equal(video.currentTime, 0);
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0);
  assert.equal(staleResumeCalls, 0);

  // Install the real guarded player after exercising the stale swap listener.
  vm.runInContext(extractFunction('playVideoCleanly'), context);
  const first = vm.runInContext('playVideoCleanly(videoUnderTest)', context);
  const firstToken = video.dataset.playRequestToken;
  assert.equal(video.dataset.playRequestPending, 'true');
  vm.runInContext('detachPongVideoForTransition(videoUnderTest)', context);
  video.src = 'https://cdn.example/recycled.mp4';
  classes.add('deck-active');
  const second = vm.runInContext('playVideoCleanly(videoUnderTest)', context);
  const secondToken = video.dataset.playRequestToken;
  assert.notEqual(secondToken, firstToken);
  assert.equal(video.dataset.playRequestPending, 'true');

  playResolvers[0]();
  await first;
  assert.equal(video.dataset.playRequestPending, 'true');
  assert.equal(video.dataset.playRequestToken, secondToken);
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.6);

  playResolvers[1]();
  await second;
  assert.equal(video.dataset.playRequestPending, 'false');
  assert.equal(video.dataset.playRequestToken, undefined);
});

test('every deck replacement detaches all media before the DOM removal is observable', () => {
  const revoked = [];
  const context = vm.createContext({
    URL: { revokeObjectURL: value => revoked.push(value) },
    window: {},
    queueMicrotask: callback => callback(),
    armPongVideoPresentedFrameTracker: () => {},
    silencePongFaceSwapAudioCompanion: () => {},
    isPongActiveVideo: () => false,
    silenceAllPongAudioExcept: () => {}
  });
  for (const name of [
    'silencePongVideo',
    'markPongVideoVisualFrameUnavailable',
    'pongVideoSourceGeneration',
    'advancePongVideoSourceGeneration',
    'detachPongVideoForTransition',
    'detachPongVideosIn',
    'replacePongVideoContainerHtml'
  ]) vm.runInContext(extractFunction(name), context);

  const makeVideo = index => {
    const source = {
      src: `https://cdn.example/source-${index}.mp4`,
      removeAttribute(name) { if (name === 'src') this.src = ''; }
    };
    const wrapper = {
      dataset: { playIntent: 'true' },
      classList: { remove() {} }
    };
    return {
      muted: false,
      defaultMuted: false,
      volume: 1,
      paused: false,
      autoplay: true,
      preload: 'auto',
      src: `https://cdn.example/video-${index}.mp4`,
      srcObject: { active: true },
      dataset: {},
      __pongHls: { destroy() { this.destroyed = true; } },
      __pongBlobUrl: `blob:video-${index}`,
      source,
      wrapper,
      matches: () => false,
      closest: () => wrapper,
      querySelectorAll: selector => selector === 'source' ? [source] : [],
      pause() { this.paused = true; },
      removeAttribute(name) { if (name === 'src') this.src = ''; },
      load() { this.loaded = true; }
    };
  };
  const videos = [makeVideo(1), makeVideo(2)];
  context.window.currentlyPlayingVideo = videos[0];
  let replacement = '';
  const container = {
    matches: () => false,
    querySelectorAll: selector => selector === 'video' ? videos : []
  };
  Object.defineProperty(container, 'innerHTML', {
    set(value) {
      for (const video of videos) {
        assert.equal(video.paused, true, 'removed video must already be paused');
        assert.equal(video.muted, true, 'removed video must already be muted');
        assert.equal(video.volume, 0, 'removed video volume must already be zero');
        assert.equal(video.src, '', 'removed video src must already be cleared');
        assert.equal(video.source.src, '', 'nested source src must already be cleared');
        assert.equal(video.srcObject, null, 'stream ownership must already be cleared');
        assert.equal(video.__pongHls, null, 'HLS ownership must already be released');
        assert.equal(video.__pongBlobUrl, '', 'blob ownership must already be released');
      }
      replacement = value;
    }
  });
  context.videoContainer = container;
  vm.runInContext(`replacePongVideoContainerHtml('<div>next</div>')`, context);

  assert.equal(replacement, '<div>next</div>');
  assert.deepEqual(revoked.sort(), ['blob:video-1', 'blob:video-2']);
  assert.equal(context.window.currentlyPlayingVideo, null);
});

test('video deck DOM writes stay behind the safe replacement boundary', () => {
  assert.equal((html.match(/videoContainer\.innerHTML\s*=/g) || []).length, 1);
  assert.doesNotMatch(html, /videoContainer\.(?:replaceChildren|textContent)\s*=/);
  const dispose = extractFunction('random40DisposePreloadRecord');
  assert.match(dispose, /detachPongVideoForTransition\(video\)[\s\S]*video\.remove\(\)/);
});
