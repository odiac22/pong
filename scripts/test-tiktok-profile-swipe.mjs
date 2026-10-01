import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-phone-fit.js','utf8');
const navigation=code.slice(code.indexOf('  const feedCards'),code.indexOf('  window.__pongUndoPhoneFit',code.indexOf('  const feedCards')));
test('single-post body and list letterboxes stay black without cropping media',()=>{
 assert.match(code,/html,body,\[class\*="BaseBodyContainer"\],#column-list-container,[^\n]+background:#000!important/);
 assert.match(code,/object-fit:contain!important/);
});
test('creator touch-down does not measure unused feed-card geometry',()=>{
 const context={window:{},document:{querySelector:()=>({}),querySelectorAll:()=>{throw Error('cinema must not enumerate feed cards')}}};
 vm.runInNewContext(navigation,context);context.window.__pongTikTokBeginGesture();
});
test('feed fallback retains the card selected when the gesture began',()=>{
 let moved=false,selected=0;
 const cards=[0,1,2].map((_,i)=>({getBoundingClientRect:()=>({top:(i-(moved?1:0))*800}),scrollIntoView(){selected=i;}}));
 const context={window:{},document:{querySelector:()=>null,querySelectorAll:()=>cards},requestAnimationFrame(){},setTimeout(){}};
 vm.runInNewContext(navigation,context);context.window.__pongTikTokBeginGesture();moved=true;
 context.window.__pongTikTokStep(1);assert.equal(selected,1);
});
test('profile swipes use the actual next and previous buttons before hidden feed cards',()=>{
 const clicks=[];
 const context={window:{},document:{querySelector:s=>s.includes('aria-label')?{disabled:false,getAttribute:()=>null,click:()=>clicks.push(s)}:null,querySelectorAll:()=>[]},requestAnimationFrame(){},setTimeout(){}};
 vm.runInNewContext(navigation,context);
 assert.equal(context.window.__pongTikTokStep(1),true);
 assert.equal(context.window.__pongTikTokStep(-1),true);
 assert.deepEqual(clicks,['button[aria-label="Next video"]','button[aria-label="Previous video"]']);
});
test('the end of a profile is not reported as an advanced video',()=>{
 const context={window:{},document:{querySelector:()=>({disabled:true,getAttribute:()=>null,click:()=>{throw Error('must not click')}}),querySelectorAll:()=>[]}};
 vm.runInNewContext(navigation,context);assert.equal(context.window.__pongTikTokStep(1),false);
});
test('retirement runs before navigation, never in a delayed native callback',()=>{
 const calls=[];
 const context={window:{__pongDomSwapClear:()=>calls.push('clear')},document:{querySelector:()=>({disabled:false,getAttribute:()=>null,click:()=>calls.push('next')}),querySelectorAll:()=>[]}};
 vm.runInNewContext(navigation,context);context.window.__pongTikTokStep(1);
 assert.deepEqual(calls,['clear','next']);
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const touch=java.slice(java.indexOf('tiktokWeb.setOnTouchListener('),java.indexOf('CookieManager.getInstance().setAcceptCookie(true)',java.indexOf('tiktokWeb.setOnTouchListener(')));
 assert.doesNotMatch(touch,/clearTikTokNativeVideo/);
});
test('navigation uses the departure fence when the stream compositor supports it',()=>{
 const calls=[];
 const context={window:{__pongDomSwapDepart:()=>calls.push('depart'),__pongDomSwapClear:()=>{throw Error('plain clear loses departure identity')}},document:{querySelector:()=>({disabled:false,getAttribute:()=>null,click:()=>calls.push('next')}),querySelectorAll:()=>[]}};
 vm.runInNewContext(navigation,context);context.window.__pongTikTokStep(1);
 assert.deepEqual(calls,['depart','next']);
});
test('native vertical navigation never starts a competing DOM drag; taps and horizontal seeks are replayed',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const touch=java.slice(java.indexOf('tiktokWeb.setOnTouchListener('),java.indexOf('CookieManager.getInstance().setAcceptCookie(true)',java.indexOf('tiktokWeb.setOnTouchListener(')));
 assert.match(touch,/tiktokPendingTouchDown = MotionEvent.obtain\(event\)/);
 assert.match(touch,/tiktokGesturePassThrough = tiktokSwipeRegion == null/);
 assert.match(touch,/touchY > tiktokSwipeRegion.optDouble\("bottom", 0\)/);
 assert.doesNotMatch(touch,/setAction\(MotionEvent.ACTION_CANCEL\)/);
 assert.match(touch,/Math.abs\(dx\) >= dp\(12\)/);
 assert.match(touch,/tiktokWeb.onTouchEvent\(tiktokPendingTouchDown\);\s*tiktokWeb.onTouchEvent\(event\)/);
 assert.match(touch,/ViewConfiguration.getLongPressTimeout\(\)/);
});
