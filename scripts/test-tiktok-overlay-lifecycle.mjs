import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const java=readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/MainActivity.java',import.meta.url),'utf8');
const overlay=readFileSync(new URL('../android-app/app/src/main/assets/tiktok-pong-overlay.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
test('Pong refresh preserves TikTok and reinstalls the transparent overlay',()=>{
 const client=java.slice(java.indexOf('web.setWebViewClient'),java.indexOf('private static boolean isTikTokPageUrl'));
 assert.doesNotMatch(client,/hideTikTokMode\(\)/);
 assert.match(client,/onPageFinished[\s\S]*PongTikTokOverlaySetActive\(true\)/);
});
test('opening TikTok twice is idempotent rather than dismissing it',()=>{
 const open=java.slice(java.indexOf('private void openTikTokMode'),java.indexOf('private void hideTikTokMode'));
 const reentry=open.slice(open.indexOf('if (tiktokVisible)'),open.indexOf('ensureTikTokWebView();'));
 assert.match(reentry,/return;/);
 assert.doesNotMatch(reentry,/hideTikTokMode\(\)/);
 assert.match(open,/tiktokExitButton\.setOnClickListener\(v -> hideTikTokMode\(\)\)/);
});
test('first open has one navigation owner, after sizing the WebView',()=>{
 const ensure=java.slice(java.indexOf('private void ensureTikTokWebView()'),java.indexOf('private void openTikTokMode()'));
 assert.doesNotMatch(ensure,/\.loadUrl\(TIKTOK_HOME_URL\)/);
 const open=java.slice(java.indexOf('private void openTikTokMode()'),java.indexOf('private void cancelTikTokPendingGesture()'));
 assert.equal((open.match(/\.loadUrl\(TIKTOK_HOME_URL\)/g)||[]).length,1);
 assert.ok(open.indexOf('syncTikTokPlayerBounds();',open.indexOf('tiktokWeb.resumeTimers();'))<open.indexOf('.loadUrl(TIKTOK_HOME_URL)'));
});
test('only actual controls and panels intercept feed touches',()=>{
 assert.match(java,/tiktokOverlayGestureToFeed = true/);
 const selector=overlay.match(/const selector = '([^']+)'/)[1];
 assert.ok(!selector.split(',').includes('.controls-overlay'));
 assert.ok(selector.includes('#pong-face-swap-picker'));
});
test('every playhead report reaches renderer while source warming is deduplicated',()=>{
 assert.doesNotMatch(java,/if \(feedChanged\) forwardTikTokFeedToPong/);
 assert.match(java,/forwardTikTokFeedToPong\(safe\)/);
 assert.match(html,/lastWarmKey !== warmKey/);
 assert.match(html,/lastPlaybackReportAt >= 500/);
});
test('Fix is dark yellow and remote launcher is absent',()=>{
 assert.match(html,/\.pong-face-match-fix[^\n]*background:#b38b00!important/);
 assert.doesNotMatch(html,/<button[^>]*id="tiktok-remote"/);
});
test('Pong progress hides only in TikTok and native progress stays above swapped pixels',()=>{
 assert.match(overlay,/html\.pong-tiktok-original-overlay \.video-progress-container\s*\{\s*display: none !important/);
 const fit=readFileSync(new URL('../android-app/app/src/main/assets/tiktok-phone-fit.js',import.meta.url),'utf8');
 assert.match(fit,/DivVideoProgressContainer[\s\S]*?z-index:10!important/);
});
test('mobile face-selection polling does not measure or reorder the unchanged controls',()=>{
 const poll=java.slice(java.indexOf('private void pollPongFaceSelectionForTikTok()'),java.indexOf('private void forwardTikTokFeedToPong'));
 const mobile=poll.slice(poll.indexOf('TIKTOK_MOBILE_WEB ?'),poll.indexOf(')()" :')+6);
 assert.match(mobile,/enabled:!!s.enabled/);
 assert.match(mobile,/selectedFaceIds/);
 assert.doesNotMatch(mobile,/getBoundingClientRect|getComputedStyle|innerText|bringToFront/);
 assert.match(poll,/if \(!TIKTOK_MOBILE_WEB\) \{\s*setTikTokPongUiForeground/);
 const update=java.slice(java.indexOf('private void updateTikTokPongControls'),java.indexOf('private void updateTikTokPongControls')+560);
 assert.doesNotMatch(update,/bringToFront/);
});
test('TikTok defaults to its existing hardware layer; compositor trial is emulator-only opt-in',()=>{
 assert.match(java,/boolean auditNormalLayer = \("ranchu"\.equals\(Build\.HARDWARE\) \|\| "goldfish"\.equals\(Build\.HARDWARE\)\)\s*&& getIntent\(\)\.getBooleanExtra\("pong_audit_normal_tiktok_layer", false\)/);
 assert.match(java,/window\.__pongCompositorLayer=" \+ view\.getLayerType\(\)/);
 assert.match(java,/tiktokWeb\.setLayerType\(auditNormalLayer \? View\.LAYER_TYPE_NONE : View\.LAYER_TYPE_HARDWARE, null\)/);
 assert.doesNotMatch(java,/tiktokWeb\.setLayerType\(View\.LAYER_TYPE_SOFTWARE/);
 const manifest=readFileSync(new URL('../android-app/app/src/main/AndroidManifest.xml',import.meta.url),'utf8');
 assert.match(manifest,/android:hardwareAccelerated="true"/);
});
