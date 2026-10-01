import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/MainActivity.java',import.meta.url),'utf8');
const mobile=readFileSync(new URL('../android-app/app/src/main/assets/tiktok-mobile.js',import.meta.url),'utf8');

test('Following feed without a column ID keeps black letterboxes and no reserved scroll gutter',()=>{
  const fit=readFileSync(new URL('../android-app/app/src/main/assets/tiktok-phone-fit.js',import.meta.url),'utf8');
  assert.match(fit,/\[class\*="DivColumnListContainer"\]\{[^}]*background:#000!important;[^}]*scrollbar-width:none!important;scrollbar-gutter:auto!important/);
  assert.match(fit,/object-fit:contain!important/);
});

test('LIVE feed player uses the same card bounds without crop or blurred border',()=>{
  const fit=readFileSync(new URL('../android-app/app/src/main/assets/tiktok-phone-fit.js',import.meta.url),'utf8');
  assert.match(fit,/\[data-e2e="feed-video"\] \[class\*="DivRecommendLivePlayer"\]\{width:100%!important;height:100%!important/);
  assert.match(fit,/\[class\*="DivLiveBlurBg"\]\{display:none!important/);
  assert.match(fit,/object-position:center!important/);
  assert.match(fit,/object-fit:contain!important/);
});

test('phone layout keeps desktop request identity across restarts and fills the native view',()=>{
  assert.match(source,/TIKTOK_MOBILE_WEB = true/);
  const ua=source.slice(source.indexOf('private static String browserLikeTikTokUserAgent'),source.indexOf('private void updateTikTokStatus'));
  assert.doesNotMatch(ua,/if \(TIKTOK_MOBILE_WEB\)/);
  assert.match(ua,/Windows NT 10\.0/);
  assert.match(source,/bundledJavascript\("tiktok-phone-fit.js"\)/);
  const bounds=source.slice(source.indexOf('private void syncTikTokPlayerBounds()'),source.indexOf('private void syncTikTokDesktopPlayerBounds()'));
  assert.match(bounds,/MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT/);
  assert.doesNotMatch(bounds,/postDelayed|evaluateJavascript/);
  assert.match(source,/tiktokWeb\.evaluateJavascript\(\s*"window\.__pongTikTokStep/);
  assert.doesNotMatch(source,/if \(!TIKTOK_MOBILE_WEB\) tiktokWeb\.evaluateJavascript\(\s*"window\.__pongTikTokStep/);
  assert.match(source,/if \(TIKTOK_MOBILE_WEB\) return tiktokMobileObserverScript/);
});

test('mobile mode overlays the actual Pong webview without a substitute toolbar',()=>{
  const controls=source.slice(source.indexOf('private void updateTikTokPongControls'),source.indexOf('LinkedHashSet<String> visibleKeys',source.indexOf('private void updateTikTokPongControls')));
  assert.match(controls,/TIKTOK_MOBILE_WEB/);
  assert.match(controls,/setVisibility\(View.GONE\)/);
  // Entry establishes layering; the periodic control poll must not reorder it.
  assert.doesNotMatch(controls,/bringToFront/);
  const bounds=source.slice(source.indexOf('private void syncTikTokPlayerBounds()'),source.indexOf('private void syncTikTokDesktopPlayerBounds()'));
  assert.match(bounds,/web.bringToFront\(\)/);
  assert.doesNotMatch(source,/String\[\]\[\] actions|tiktokControlsExpanded/);
  assert.match(source,/tiktokWeb.dispatchTouchEvent\(forwarded\)/);
  assert.match(source,/MotionEvent.ACTION_DOWN/);
  assert.match(source,/private JSONArray tiktokOverlayHitRects/);
});

test('TikTok session uses persistent storage and flushes cookies without clearing login',()=>{
  assert.match(source,/settings.setDomStorageEnabled\(true\)/);
  assert.match(source,/setAcceptThirdPartyCookies\(tiktokWeb, true\)/);
  const close=source.slice(source.indexOf('private void hideTikTokMode'),source.indexOf('private void setTikTokPongUiForeground'));
  assert.match(close,/CookieManager.getInstance\(\).flush\(\)/);
  assert.doesNotMatch(source,/removeAllCookies|removeSessionCookies|deleteAllData/);
});

test('original overlay reports original control geometry and cleans up without creating buttons',()=>{
  const overlay=readFileSync(new URL('../android-app/app/src/main/assets/tiktok-pong-overlay.js',import.meta.url),'utf8');
  const reports=[],classes=new Set();let observerActive=false,intervals=0;
  const node={hidden:false,parentElement:null,getBoundingClientRect:()=>({left:10,top:20,right:60,bottom:60,width:50,height:40})};
  const context={innerWidth:400,innerHeight:800,window:{PongNativeSwap:{overlayRects:r=>reports.push(JSON.parse(r))}},
    document:{head:{appendChild(){}},body:{},createElement:t=>{assert.equal(t,'style');return {};},documentElement:{classList:{toggle:(c,on)=>on?classes.add(c):classes.delete(c)}},querySelectorAll:()=>[node]},
    performance:{now:()=>0},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    MutationObserver:class{observe(){observerActive=true;}disconnect(){observerActive=false;}},
    setInterval:()=>++intervals,clearInterval:()=>{},requestAnimationFrame:()=>1,cancelAnimationFrame(){},addEventListener(){}};
  vm.runInNewContext(overlay,context);
  context.window.PongTikTokOverlaySetActive(true);
  assert.equal(reports[0][0].x,.025);assert.equal(reports[0][0].h,.05);
  assert.equal(observerActive,true);assert.equal(classes.size,1);
  context.window.PongTikTokOverlaySetActive(false);
  assert.equal(observerActive,false);assert.equal(classes.size,0);assert.equal(reports.at(-1).length,0);
  assert.doesNotMatch(overlay,/\.click\(|innerHTML|createElement\(['"]button/);
});

function observe({url='https://www.tiktok.com/@fixture/video/1234567890123456789',video=true,photo=false,cinema=photo}={}){
  const reports=[],tasks=[];
  const element={currentTime:4,duration:30,paused:false,playbackRate:1,
    getBoundingClientRect:()=>({left:0,right:400,top:0,bottom:800}),closest:()=>null,querySelector:()=>null};
  const context={URL,location:{href:url},innerWidth:400,innerHeight:800,performance:{now:()=>1000},
    getComputedStyle:()=>({display:'block'}),setTimeout:f=>tasks.push(f),clearTimeout(){},setInterval:()=>{},addEventListener(){},
    MutationObserver:class{observe(){}},document:{hidden:false,documentElement:{},addEventListener(){},
      querySelector:s=>cinema&&s.includes('cinema-mode-exit')?{}:null,querySelectorAll:s=>(s.startsWith('video')&&video)||(s.startsWith('img')&&photo)?[element]:[]},
    window:{PongTikTokFeed:{report:raw=>reports.push(JSON.parse(raw))}}};
  vm.runInNewContext(mobile,context);while(tasks.length)tasks.shift()();return reports[0];
}
test('visible watch video reports its identity and timeline',()=>{
  const r=observe();assert.equal(r.activeVideo,true);assert.equal(r.currentTime,4);assert.equal(r.urls.length,1);
});
test('profile grid or unknown feed cannot inherit and swap the previous video',()=>{
  const r=observe({url:'https://www.tiktok.com/@fixture',video:false});
  assert.equal(r.activeVideo,false);assert.equal(r.current,'');
  assert.match(source,/supplied\.has\("activeVideo"\).*supplied\.optBoolean\("activeVideo"\)/);
});
test('a cinema photo keeps vertical navigation without claiming to be a swappable video',()=>{
 const r=observe({url:'https://www.tiktok.com/@fixture/photo/1234567890123456789',video:false,photo:true});
 assert.equal(r.activeVideo,false);assert.equal(r.current,'');assert.equal(r.swipeRegion.right,1);
 const grid=observe({url:'https://www.tiktok.com/@fixture',video:false});assert.equal(grid.swipeRegion,null);
});
test('a For You photo keeps vertical navigation as well as native horizontal photo swiping',()=>{
 const r=observe({url:'https://www.tiktok.com/foryou',video:false,photo:true,cinema:false});
 assert.equal(r.activeVideo,false);assert.equal(r.current,'');assert.equal(r.swipeRegion.right,1);
});
test('mobile observer leaves swipes, profile navigation and dialogs to the website',()=>{
  assert.doesNotMatch(mobile,/preventDefault|stopPropagation|scrollIntoView|\.click\(|touch-action|removeAllCookie/);
});
