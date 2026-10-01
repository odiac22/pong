import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const signal=html.slice(html.indexOf('let pongTikTokFaceSignalQueued'),html.indexOf('// Privacy-safe, bounded lifecycle telemetry'));
function fixture(bridge){
  const queued=[],state={enabled:false,selection:'one'};
  const context={PongNativeSwap:bridge,pongFaceSwapState:state,
    pongFaceSwapSelectionKey:()=>state.selection,queueMicrotask:f=>queued.push(f)};
  vm.createContext(context);vm.runInContext(signal,context);
  return {state,signal:()=>vm.runInContext('notifyPongTikTokFaceSelectionChanged()',context),flush:()=>{while(queued.length)queued.shift()();},queued};
}
test('selection + enable in one turn wakes native once without passing face data',()=>{
  const calls=[],f=fixture({selectionChanged(...args){calls.push(args);}});
  f.signal();f.state.enabled=true;f.signal();f.signal();
  assert.equal(f.queued.length,1);assert.equal(calls.length,0);f.flush();
  assert.deepEqual(calls,[[]]);f.signal();f.flush();assert.equal(calls.length,1);
  f.state.selection='two';f.signal();f.flush();assert.equal(calls.length,2);
  f.state.enabled=false;f.signal();f.flush();assert.equal(calls.length,3);
});
test('older APK falls back to polling and failed native calls may retry',()=>{
  const old=fixture({});old.signal();assert.equal(old.queued.length,0);
  let calls=0;const f=fixture({selectionChanged(){if(++calls===1)throw Error('retired');}});
  f.signal();f.flush();f.signal();f.flush();assert.equal(calls,2);
});
test('both state setters notify; native reads only trusted Pong and coalesces in-flight work',()=>{
  const setter=html.slice(html.indexOf('function setPongFaceSwapSelection('),html.indexOf('let pongTikTokFaceSignalQueued'));
  const enabled=html.slice(html.indexOf('function setPongFaceSwapPersistentEnabled('),html.indexOf('function clearPongFaceSwapTransitionOverlay('));
  assert.match(setter,/notifyPongTikTokFaceSelectionChanged\(\)/);assert.match(enabled,/notifyPongTikTokFaceSelectionChanged\(\)/);
  const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
  const notify=java.slice(java.indexOf('@JavascriptInterface public void selectionChanged()'),java.indexOf('private final class TikTokSwapPresentationBridge'));
  assert.match(notify,/isPongUrl\(Uri.parse\(web.getUrl\(\)\)\)/);
  assert.match(notify,/removeCallbacks\(tiktokFacePoller\)/);
  const poll=java.slice(java.indexOf('private void pollPongFaceSelectionForTikTok()'),java.indexOf('private void forwardTikTokFeedToPong('));
  assert.match(poll,/if \(tiktokFacePollInFlight\) \{ tiktokFacePollRequested = true; return; \}/);
  assert.match(poll,/tiktokFacePollRequested \? 0 : 500/);
  assert.match(poll,/tiktokFacePollInFlight = false;/);
});
