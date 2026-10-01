import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const java = readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java', 'utf8');
const helper = html.slice(
  html.indexOf('function pongTikTokNotifyNativeReady('),
  html.indexOf('// TikTok presents the transformed media', html.indexOf('function pongTikTokNotifyNativeReady('))
);

function fixture() {
  const notifications = [];
  const wrapper = {isConnected:true, dataset:{pongFaceSwapSessionId:'session-1'}};
  const state = {nativeHandoffGeneration:7, requestedUrl:'https://www.tiktok.com/@test/video/1',
    current:'https://www.tiktok.com/@test/video/1', activeVideo:true};
  const context = {pongTikTokLiveState:state, pongFaceSwapState:{enabled:true},
    pongFaceSwapCurrentWrapper:()=>wrapper, PongNativeSwap:{ready:raw=>notifications.push(JSON.parse(raw))}};
  context.window = context;
  context.globalThis = context;
  context.PongTikTokLiveIntegratedState = () => JSON.stringify({
    requestedUrl:state.current, sessionId:wrapper.dataset.pongFaceSwapSessionId,
    streamUrl:`https://local.test/pong-swap/sessions/${wrapper.dataset.pongFaceSwapSessionId}/stream`,
    ready:true
  });
  vm.runInNewContext(helper, context);
  const notify = (generation=7, session='session-1', page='https://www.tiktok.com/@test/video/1') =>
    context.pongTikTokNotifyNativeReady(wrapper, session, generation, page);
  return {context, wrapper, state, notifications, notify};
}

test('exact ready notification includes native generation and the owned session', () => {
  const f=fixture();
  assert.equal(f.notify(), true);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].handoffGeneration, 7);
  assert.equal(f.notifications[0].sessionId, 'session-1');
});

test('late ready cannot attach after swipe, Original, exit, remount, or a newer generation', () => {
  const f=fixture();
  assert.equal(f.notify(6), false);
  f.state.current='https://www.tiktok.com/@test/video/2';
  assert.equal(f.notify(), false);
  f.state.current='https://www.tiktok.com/@test/video/1';
  f.context.pongFaceSwapState.enabled=false;
  assert.equal(f.notify(), false);
  f.context.pongFaceSwapState.enabled=true;
  f.state.activeVideo=false;
  assert.equal(f.notify(), false);
  f.state.activeVideo=true;
  f.wrapper.isConnected=false;
  assert.equal(f.notify(), false);
  assert.equal(f.notifications.length, 0);
});

test('late old-session callback cannot borrow current session or page identity', () => {
  const f=fixture();
  f.wrapper.dataset.pongFaceSwapSessionId='session-2';
  assert.equal(f.notify(), false);
  f.wrapper.dataset.pongFaceSwapSessionId='session-1';
  f.state.requestedUrl='https://www.tiktok.com/@test/video/2';
  assert.equal(f.notify(), false);
  assert.equal(f.notifications.length, 0);
});

test('native validates event generation and uses an immediate status read for legacy callbacks', () => {
  const request=java.slice(java.indexOf('private void requestTikTokIntegratedSwap('),
    java.indexOf('private static double tikTokSwapStartSeconds('));
  const ready=java.slice(java.indexOf('@JavascriptInterface public void ready(String rawState)'),
    java.indexOf('@JavascriptInterface public void selectionChanged()',
      java.indexOf('@JavascriptInterface public void ready(String rawState)')));
  assert.match(request,/requestedStartSeconds \+ "," \+ generation/);
  assert.match(ready,/state\.optInt\("handoffGeneration", -1\) != tiktokSwapGeneration/);
  assert.match(ready,/!currentTikTokUrl\.equals\(state\.optString\("requestedUrl", ""\)\)/);
  assert.match(ready,/if \(!state\.has\("handoffGeneration"\)\) \{[\s\S]*?tiktokSwapHandler\.post\(tiktokSwapPoller\)/);
});
