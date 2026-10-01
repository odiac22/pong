import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/MainActivity.java', import.meta.url), 'utf8');
const webSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const playerLayout = readFileSync(new URL('../android-app/app/src/main/res/layout/pong_tiktok_swap_player.xml', import.meta.url), 'utf8');
const stream = readFileSync('android-app/app/src/main/assets/tiktok-stream.js','utf8');
const frameSync = readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8');

test('embedded TikTok uses the full desktop web client without discarding cookies', () => {
  assert.match(source, /Windows NT 10\.0; Win64; x64/);
  assert.match(source, /Chrome\/" \+ chromeVersion/);
  assert.match(source, /CookieManager\.getInstance\(\)\.setAcceptCookie\(true\)/);
  assert.match(source, /CookieManager\.getInstance\(\)\.flush\(\)/);
  assert.doesNotMatch(source, /removeAllCookie|removeSessionCookie|deleteAllData/);
});

test('desktop TikTok is locked to the phone viewport without zoom or horizontal panning', () => {
  assert.match(source, /setUseWideViewPort\(false\)/);
  assert.match(source, /setSupportZoom\(false\)/);
  assert.match(source, /setBuiltInZoomControls\(false\)/);
  assert.match(source, /user-scalable=no,viewport-fit=cover/);
  assert.match(source, /overflow-x:hidden!important/);
  assert.match(source, /touch-action','none'/);
  assert.match(source, /SideNavPlaceholder/);
  assert.match(source, /DivSideNavContainer/);
  assert.match(source, /display:none!important;width:0!important/);
  assert.match(source, /#column-list-container,main/);
  assert.match(source, /SectionActionBarContainer/);
  assert.match(source, /position:absolute!important;right:7px!important/);
  assert.match(source, /flex:0 0 100vw!important/);
});

test('desktop feed cards expose canonical TikTok video URLs to Pong', () => {
  assert.match(source, /recommend-list-item-container/);
  assert.match(source, /const reactItem=el=>/);
  assert.match(source, /item\.author/);
  assert.match(source, /PongTikTokFeed\.report\(payload\)/);
  assert.match(source, /ordered\.slice\(currentPosition\+1\)/);
  assert.match(source, /ordered\.slice\(0,currentPosition\)\.reverse\(\)/);
});

test('TikTok swap stays in one WebView compositor and keeps original audio playing', () => {
  assert.match(source, /private String tiktokDomSwapSupportScript\(\)/);
  assert.match(stream, /video:not\(\.pong-tiktok-swap-stream\)/);
  assert.match(stream, /overlay\.muted=true;overlay\.defaultMuted=true;overlay\.volume=0/);
  assert.match(frameSync, /v\.style\.setProperty\('opacity','0','important'\)/);
  assert.match(frameSync, /o\.readyState>=2&&Math\.abs\(delta\)<=\.45/);
  assert.match(stream, /window\.__pongDirectDecoderTrial===true/);
  assert.match(stream, /const mediaSource=direct\?null:new MediaSource\(\)/);
  assert.match(stream, /mediaSource\.addSourceBuffer\(mime\)/);
  assert.match(stream, /response\.body\.getReader\(\)/);
  assert.match(frameSync, /requestVideoFrameCallback/);
  assert.match(frameSync, /seekThreshold=s\.visible\?1\.25:\.45/);
  assert.match(stream, /revealPending:false/);
  assert.match(stream, /const mediaHost=v=>/);
  assert.match(stream, /host=mediaHost\(original\)/);
  assert.doesNotMatch(stream, /const host=original\.parentElement/);
  assert.match(source, /__pongDomSwapAttach/);
  assert.match(source, /https:\/\/www\.tiktok\.com\/__pong_swap\//);
  assert.match(source, /integratedSwapStreams\.put\(sessionId, streamUrl\)/);
  assert.match(source, /PongTikTokLiveCatchUp/);
  const ensureBlock = source.slice(
    source.indexOf('private void ensureTikTokWebView()'),
    source.indexOf('private void openTikTokMode()')
  );
  assert.doesNotMatch(ensureBlock, /ensureTikTokVideoSurface\(\)/);
});

test('TikTok prepares a bounded queue and decodes only the immediate next one', () => {
  assert.match(webSource, /const preferredForward = \[\]/);
  assert.match(webSource, /appendForward\(pongTikTokLiveState\.next\)/);
  assert.match(webSource, /candidates\.slice\(0, PONG_FACE_SWAP_PREFETCH_COUNT\)/);
  assert.match(webSource, /if \(preparedJobs\[0\]\) await createPreparedJob\(preparedJobs\[0\], 0\)/);
  assert.match(webSource, /attachRequested = jobIndex === 0/);
  assert.match(webSource, /desiredAttachmentKeys\.add\(job\.key\)/);
  assert.match(webSource, /if \(prefetched\) playable\.startSeconds =/);
  assert.match(webSource, /isTikTokDeck && jobIndex===0/);
  assert.match(webSource, /prebufferSeconds: isTikTokDeck \? 1 : index === 0/);
  assert.match(stream, /window\.__pongDomSwapWarmClear\(\)/);
});

test('a lagging high-quality stream catches up without pausing the TikTok original', () => {
  assert.match(frameSync, /bufferHeadroom:end-target/);
  assert.match(source, /missedInitialHandoff/);
  assert.match(source, /requestTikTokSwapCatchUp\(sessionId\)/);
  assert.match(source, /if \(position <= 0\.80d\) return 0d/);
  assert.match(source, /return position \+ Math.min\(0\.60d, remaining\)/);
  assert.equal([...source.matchAll(/tikTokSwapStartSeconds\(tiktokTimelineSeconds, tiktokDurationSeconds\)/g)].length,3);
  assert.match(source, /PongTikTokLiveCatchUp/);
  assert.match(frameSync, /target<-\.05/);
  assert.match(source, /boolean timelineReset =/);
  assert.match(source, /currentChanged \|\| \(timelineReset && !reusableFullSwap\)/);
  assert.match(webSource, /pongTikTokLiveState\.timelineSeconds =/);
  assert.match(webSource, /pongTikTokLiveState\.timelineSeconds - sessionStart/);
  assert.match(webSource, /sessions\/\$\{encodeURIComponent\(sessionId\)\}\/playback/);
  assert.match(webSource, /paused: pongTikTokLiveState\.paused/);
});

test('refreshing Pong keeps the TikTok view and reinstalls the overlay', () => {
  const mainClient = source.slice(
    source.indexOf('web.setWebViewClient(new WebViewClient()'),
    source.indexOf('web.setWebChromeClient')
  );
  assert.match(mainClient, /onPageStarted/);
  assert.doesNotMatch(mainClient, /if \(tiktokVisible\) hideTikTokMode\(\)/);
  assert.match(mainClient, /PongTikTokOverlaySetActive\(true\)/);
});

test('TikTok Swap is a one-tap action when a face is already selected', () => {
  assert.match(source, /"pong-face-swap-button"\.equals\(key\)/);
  assert.match(source, /PongTikTokLiveEnableSelectedSwap/);
  assert.match(source, /"started"\.equals\(result\.optString\("status"\)\)/);
  assert.match(source, /requestTikTokIntegratedSwap\(false\)/);
  assert.match(webSource, /window\.PongTikTokLiveEnableSelectedSwap = \(\) =>/);
  assert.match(webSource, /const faceId = pongFaceSwapSelectionKey\(\)/);
  assert.match(webSource, /setPongFaceSwapPersistentEnabled\(true\)/);
  assert.match(webSource, /JSON\.stringify\(\{ status: 'started', key: faceId \}\)/);
  assert.match(webSource, /void openPongFaceSwapPicker\(\)/);
});

test('native vertical touch gestures advance the desktop For You feed', () => {
  assert.match(source, /window\.__pongTikTokStep=direction/);
  assert.match(source, /touch-action','none'/);
  assert.match(source, /40,180,420,800/);
  assert.match(source, /scrollIntoView\(\{behavior:'auto',block:'start'\}\)/);
  assert.match(source, /MotionEvent\.ACTION_DOWN/);
  assert.match(source, /MotionEvent\.ACTION_MOVE/);
  assert.match(source, /__pongTikTokStep\(" \+ direction/);
});
