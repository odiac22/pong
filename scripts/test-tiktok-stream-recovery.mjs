import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const source=html.slice(html.indexOf('const pongTikTokStreamRetries ='),html.indexOf('window.PongTikTokLiveCatchUp ='));
function fixture(){
 const page='https://www.tiktok.com/@test/video/123';
 const wrapper={dataset:{pongFaceSwapSessionId:'one',pongFaceSwapBusy:'true',pongTikTokPresentedSession:'one'},pongTikTokFrameEvidence:{visible:true}};
 const calls=[],stops=[];
 const context={window:{},performance:{now:()=>10},pongCanonicalTikTokVideoPage:x=>x,
  pongFaceSwapCurrentWrapper:()=>wrapper,pongTikTokWrapperUrl:()=>page,
  pongFaceSwapState:{enabled:true,selectedFaceId:'selected'},pongTikTokLiveState:{current:page},
  pongFaceSwapSelectionKey:()=>context.pongFaceSwapState.selectedFaceId,
  PONG_FACE_SWAP_PHASES:{ORIGINAL:'original'},setPongFaceSwapPhase:(w,p)=>w.phase=p,
  updatePongFaceSwapButton(){},startPongFaceSwap:(id,options)=>calls.push({id,options}),
  stopPongFaceSwapForWrapper:(w,options)=>stops.push(options)};
 vm.runInNewContext(source,context);
 return {page,wrapper,calls,stops,context,fail:context.window.PongTikTokLiveSwapFailed};
}
test('decoder failure revokes old paint evidence and starts one current-video retry',()=>{
 const f=fixture();assert.equal(f.fail(f.page,'one',2.2),true);
 assert.equal(f.wrapper.pongTikTokFrameEvidence.visible,false);
 assert.equal(f.wrapper.dataset.pongTikTokPresentedSession,undefined);
 assert.equal(f.wrapper.dataset.pongFaceSwapBusy,undefined);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.startSeconds,2.2);
 f.wrapper.dataset.pongFaceSwapSessionId='replacement';
 assert.equal(f.fail(f.page,'replacement',4),false);
 assert.equal(f.calls.length,1);assert.equal(f.stops.length,1);
});
test('stale session, changed video and swap-off errors do not alter new state',()=>{
 const f=fixture();assert.equal(f.fail(f.page,'retired',2),false);
 assert.equal(f.fail(f.page+'/other','one',2),false);
 f.context.pongFaceSwapState.enabled=false;assert.equal(f.fail(f.page,'one',2),false);
 assert.equal(f.wrapper.pongTikTokFrameEvidence.visible,true);assert.equal(f.calls.length,0);
});
test('a deliberate different face selection receives its own retry budget',()=>{
 const f=fixture();f.fail(f.page,'one',0);
 f.context.pongFaceSwapState.selectedFaceId='different';
 f.wrapper.dataset.pongFaceSwapSessionId='two';
 assert.equal(f.fail(f.page,'two',0),true);assert.equal(f.calls.length,2);
});
