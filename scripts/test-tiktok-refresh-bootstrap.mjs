import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
const code=html.match(/<script id="pong-tiktok-overlay-bootstrap">([\s\S]*?)<\/script>/)[1];
function bootstrap(bridge){
 const classes=new Set();
 vm.runInNewContext(code,{window:{PongNativeSwap:bridge},document:{documentElement:{classList:{add:x=>classes.add(x)}}}});
 return classes.has('pong-tiktok-original-overlay');
}
test('active native TikTok mode restores transparency before any body content',()=>{
 assert.equal(bootstrap({tiktokModeActive:()=>true}),true);
 assert.ok(html.indexOf('id="pong-tiktok-overlay-bootstrap"')<html.indexOf('<body'));
 assert.match(html,/html\.pong-tiktok-original-overlay \.controls-overlay \{ background: transparent !important/);
});
test('ordinary Pong, old APKs and unavailable bridges never revive TikTok mode',()=>{
 for(const bridge of [undefined,{}, {tiktokModeActive:()=>false},{tiktokModeActive:()=>{throw Error('unavailable')}}])assert.equal(bootstrap(bridge),false);
});
test('mode bridge reads a volatile activity bit without reading a WebView off-thread',()=>{
 assert.match(java,/private volatile boolean tiktokVisible/);
 const method=java.match(/@JavascriptInterface public boolean tiktokModeActive\(\) \{([\s\S]*?)\n    \}/)[1];
 assert.match(method,/return TIKTOK_MOBILE_WEB && tiktokVisible/);
 assert.doesNotMatch(method,/getUrl|evaluateJavascript|getBoolean|appState/);
});
test('new document restores interaction regions before final page-load completion',()=>{
 const method=java.match(/onPageCommitVisible\(WebView view, String url\) \{([\s\S]*?)\n      \}/)[1];
 assert.match(method,/view == web && tiktokVisible && isPongUrl/);
 assert.match(method,/bundledJavascript\("tiktok-pong-overlay.js"\)/);
 assert.match(method,/PongTikTokOverlaySetActive\(true\)/);
});
