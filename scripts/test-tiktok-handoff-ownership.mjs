import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
test('external presentation keeps monitoring encoded evidence and opens next-source preparation',async()=>{
 const w={isConnected:true,dataset:{pongFaceSwapGeneration:'g',pongFaceSwapSessionId:'s',pongExternalPlaybackAuthority:'true',pongFaceSwapActive:'true'},querySelector:()=>null};
 let prepared=0,remembered=0,delay;
 const context={Date,setTimeout:(_f,n)=>{delay=n},pongFaceSwapState:{enabled:true,selectedFaceId:'f',terminalSessions:new Set()},pongFaceSwapCurrentWrapper:()=>w,
 pongFaceSwapBackgroundFetch:async()=>({ok:true,json:async()=>({session:{firstByteAt:1,firstTransformedFrameAt:1,frames:5}})}),
 rememberPongSwapTransformation:()=>remembered++,schedulePongFaceSwapPrefetch:()=>prepared++,updatePongFaceSwapLoading(){},hidePongFaceSwapLoading(){}};
 vm.runInNewContext(html.slice(html.indexOf('function monitorPongFaceSwapEncoding('),html.indexOf('function reportPongFaceSwapPlayback(')),context);
 context.monitorPongFaceSwapEncoding(w,'s','g');await new Promise(r=>setImmediate(r));
 assert.equal(remembered,1);assert.equal(prepared,1);assert.equal(delay,220);
 w.dataset.pongTikTokPresentedSession='s';context.monitorPongFaceSwapEncoding(w,'s','g');await new Promise(r=>setImmediate(r));assert.equal(delay,1000);
 w.dataset.pongFaceSwapSessionId='new';context.monitorPongFaceSwapEncoding(w,'s','g');await new Promise(r=>setImmediate(r));assert.equal(remembered,2);
});
test('published media identity comes from its own wrapper, never the newly requested URL',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 assert.match(html,/requestedUrl = pongTikTokWrapperUrl\(wrapper\)/);
 assert.match(html,/state\.requestedUrl !== requestedUrl/);
 assert.match(html,/requestedUrl = pongTikTokWrapperUrl\(wrapper\)/);
 assert.match(java,/!currentTikTokUrl.equals\(state.optString\("requestedUrl", ""\)\)/);
});

test('native ready and prepare validate the trusted WebView only on its UI thread',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 for(const name of ['prepare','ready']){
   const start=java.indexOf('@JavascriptInterface public void '+name+'(String rawState)');
   const ui=java.indexOf('runOnUiThread(() -> {',start);
   assert.doesNotMatch(java.slice(start,ui),/web\.getUrl\(/);
   assert.match(java.slice(ui,java.indexOf('});',ui)),/isPongUrl\(Uri.parse\(web.getUrl\(\)\)\)/);
 }
});
test('feed handoff retains bounded registered stream routes until pending readers open',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const clear=java.slice(java.indexOf('private void clearTikTokIntegratedSwap(String'),java.indexOf('private final class TikTokFeedBridge'));
 assert.match(clear,/if \(!tiktokVisible \|\| !tiktokSwapEnabled\) \{\s*integratedSwapStreams.clear\(\)/);
 assert.match(java,/while \(integratedSwapStreamOrder.size\(\) > 4\)/);
 const play=java.slice(java.indexOf('private void playTikTokNativeSwap('),java.indexOf('private void clearTikTokNativeVideo('));
 assert.match(play,/JSONObject.quote\(currentTikTokUrl\)/);
});
test('refresh keeps the import form from intercepting TikTok swipes without hiding Pong controls',()=>{
 const overlay=readFileSync('android-app/app/src/main/assets/tiktok-pong-overlay.js','utf8');
 assert.match(overlay,/html\.pong-tiktok-original-overlay \.controls-overlay \.url-input\s*\{\s*display: none !important/);
 assert.doesNotMatch(overlay,/html\.pong-tiktok-original-overlay \.controls-overlay\s*\{\s*display: none/);
});
test('native evidence callbacks cannot report a retired session as current',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const sync=java.slice(java.indexOf('private void syncTikTokNativeTimeline('),java.indexOf('private void requestTikTokSwapCatchUp('));
 assert.match(sync,/tiktokTimelineSyncPendingGeneration == generation/);
 assert.match(sync,/generation != tiktokSwapGeneration \|\| !observedSession.equals\(tiktokVideoSessionId\)/);
 assert.ok(sync.indexOf('generation != tiktokSwapGeneration')<sync.indexOf('PongTikTokLiveSwapEvidence'));
 assert.ok(sync.indexOf('!observedSession.equals(state.optString("sessionId", ""))')<sync.indexOf('PongTikTokLiveSwapEvidence'));
 assert.ok(sync.indexOf('presentationRevision != tiktokPresentationRevision')<sync.indexOf('PongTikTokLiveSwapEvidence'));
});

test('hidden presentation revokes green immediately without stopping the next producer',()=>{
 const w={dataset:{pongFaceSwapSessionId:'current',pongTikTokPresentedSession:'current'},pongTikTokFrameEvidence:{visible:true}};
 let updates=0;
 const c={window:{},pongFaceSwapCurrentWrapper:()=>w,performance:{now:()=>123},PONG_FACE_SWAP_PHASES:{ORIGINAL:'original'},setPongFaceSwapPhase:(w,p)=>w.phase=p,updatePongFaceSwapButton:()=>updates++};
 vm.runInNewContext(html.slice(html.indexOf('window.PongTikTokLiveSwapHidden ='),html.indexOf('window.PongTikTokLiveSwapPresented =')),c);
 assert.equal(c.window.PongTikTokLiveSwapHidden('retired'),false);
 assert.equal(w.pongTikTokFrameEvidence.visible,true);
 assert.equal(c.window.PongTikTokLiveSwapHidden('current'),true);
 assert.equal(w.dataset.pongTikTokPresentedSession,undefined);
 assert.equal(w.pongTikTokFrameEvidence.visible,false);assert.equal(w.phase,'original');assert.equal(updates,1);
});
test('network error documents are not styled black and retry excludes verification/authentication',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const retry=java.slice(java.indexOf('private void retryTikTokNetworkFailure('),java.indexOf('private static String browserLikeTikTokUserAgent('));
 assert.match(retry,/tiktokNetworkRetryCount >= 2/);
 assert.match(retry,/generation != tiktokPageLoadGeneration/);
 const client=java.slice(java.indexOf('tiktokWeb.setWebViewClient('),java.indexOf('private void openTikTokMode('));
 assert.match(client,/code == ERROR_HOST_LOOKUP \|\| code == ERROR_CONNECT \|\| code == ERROR_TIMEOUT \|\| code == ERROR_IO/);
 assert.match(client,/response.getStatusCode\(\) >= 500\) retryTikTokNetworkFailure/);
 assert.ok(client.indexOf('if (tiktokMainFrameFailed) return;')<client.indexOf('view.evaluateJavascript(tiktokDomSwapSupportScript()'));
});
