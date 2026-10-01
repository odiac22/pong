import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const script=readFileSync(new URL('./tiktok-audit-tunnel-state.js',import.meta.url),'utf8');
test('rewrites only exact owned stream, survives republishing, restores latest state function',()=>{
  const origin='http://192.168.1.124:8787';
  const publisher=()=>JSON.stringify({sessionId:'abc',streamUrl:origin+'/pong-swap/sessions/abc/stream'});
  const context={URL,location:{origin,href:origin+'/pong'},PongTikTokLiveIntegratedState:publisher};
  context.window=context;vm.createContext(context);vm.runInContext(script,context);
  assert.equal(JSON.parse(context.PongTikTokLiveIntegratedState()).streamUrl,'http://127.0.0.1:18787/pong-swap/sessions/abc/stream');
  const latest=()=>JSON.stringify({sessionId:'abc',streamUrl:origin+'/pong-swap/sessions/other/stream'});
  context.PongTikTokLiveIntegratedState=latest;
  assert.equal(JSON.parse(context.PongTikTokLiveIntegratedState()).streamUrl,origin+'/pong-swap/sessions/other/stream');
  assert.equal(context.__pongAuditTunnelStats.replacements,1);
  assert.equal(context.__pongAuditTunnelRestore(),true);
  assert.equal(context.PongTikTokLiveIntegratedState,latest);
  assert.equal(context.__pongAuditTunnelRestore,undefined);
});
