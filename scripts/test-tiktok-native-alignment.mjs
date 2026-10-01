import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const root=resolve(import.meta.dirname,'..');
const java=readFileSync(join(root,'android-app/app/src/main/java/com/odiac22/pong/MainActivity.java'),'utf8');
const html=readFileSync(join(root,'index.html'),'utf8');
test('real Java alignment gate rejects stale/duplicate callbacks and bounds rapid retries',()=>{
 const output=mkdtempSync(join(tmpdir(),'pong-native-alignment-'));
 execFileSync('javac',['-d',output,
  join(root,'android-app/app/src/main/java/com/odiac22/pong/TikTokNativeAlignmentGate.java'),
  join(root,'android-app/app/src/test/java/com/odiac22/pong/TikTokNativeAlignmentGateHarness.java')]);
 execFileSync('java',['-cp',output,'com.odiac22.pong.TikTokNativeAlignmentGateHarness']);
});
test('native clock holds the swapped frame when ahead and resumes with hysteresis',()=>{
 const output=mkdtempSync(join(tmpdir(),'pong-native-clock-'));
 execFileSync('javac',['-d',output,
  join(root,'android-app/app/src/main/java/com/odiac22/pong/TikTokNativeClockGate.java'),
  join(root,'android-app/app/src/test/java/com/odiac22/pong/TikTokNativeClockGateHarness.java')]);
 execFileSync('java',['-cp',output,'com.odiac22.pong.TikTokNativeClockGateHarness']);
 assert.match(java,/setPlayWhenReady\(tiktokNativeClockGate.shouldPlay\(target,position,snap.optBoolean\("paused"\)\)\)/);
});
test('slow polling begins after accepted visibility, not merely first decode',()=>{
 assert.match(java,/private int readyPollDelayMs\(\)\s*\{\s*return tiktokNativeFrameVisible \? 1000 : 240;/);
 assert.match(java,/if\(!tiktokNativeAlignmentGate.complete\(ticket\)\)return;/);
 assert.match(java,/finally\s*\{\s*scheduleAuditNativeAlignmentRetry\(session,ticket\);/);
});
test('polled readiness cannot give an old same-page session a new request generation',()=>{
 const wrapper={dataset:{index:'0',pongFaceSwapSessionId:'s',pongFaceSwapExternalStreamUrl:'http://example.test/pong-swap/sessions/s/stream',pongFaceSwapActive:'true',pongFaceSwapNativeHandoffGeneration:'4',pongFaceSwapActivationSequence:'9'},querySelector:()=>({currentTime:0,paused:true})};
 const window={},state={current:'page',nativeHandoffGeneration:4};
 const context={window,pongFaceSwapCurrentWrapper:()=>wrapper,pongTikTokWrapperUrl:()=> 'page',pongTikTokLiveState:state};
 vm.runInNewContext(html.slice(html.indexOf('window.PongTikTokLiveIntegratedState ='),html.indexOf('// The renderer publishes only')),context);
 const snapshot=()=>JSON.parse(window.PongTikTokLiveIntegratedState());
 assert.equal(snapshot().ready,true);assert.equal(snapshot().handoffGeneration,4);
 state.nativeHandoffGeneration=5;
 assert.equal(snapshot().ready,false);assert.equal(snapshot().handoffGeneration,4);
 wrapper.dataset.pongFaceSwapNativeHandoffGeneration='5';
 assert.equal(snapshot().ready,true);assert.equal(snapshot().activationSequence,9);
 delete wrapper.dataset.pongFaceSwapNativeHandoffGeneration;
 assert.equal(snapshot().ready,false);
});
test('all native attachment paths pass through committed generation validation',()=>{
 const method=java.slice(java.indexOf('private void playTikTokNativeSwap('),java.indexOf('private void clearTikTokNativeVideo('));
 assert.match(method,/state.has\("handoffGeneration"\) && state.optInt\("handoffGeneration", -1\) != tiktokSwapGeneration/);
 assert.match(html,/wrapper.dataset.pongFaceSwapNativeHandoffGeneration = String\(nativeHandoffGeneration\)/);
});
