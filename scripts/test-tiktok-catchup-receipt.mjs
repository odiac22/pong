// Contract tests execute the real index.html catch-up function in a CPU-only
// fixture. The native controller applies its cooldown only from the receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html=readFileSync('index.html','utf8');
const start=html.indexOf('window.PongTikTokLiveCatchUp = (rawUrl, startSeconds = 0, expectedSessionId = \'\', requestToken = \'\') => {');
const end=html.indexOf('\n};',start);
assert.ok(start>=0&&end>start,'catch-up function source contract changed');
const source=html.slice(start,end+3);

function fixture({started=false,sessionId='old',presented=''}={}){
 const calls=[],receipts=[];
 const wrapper={dataset:{pongFaceSwapSessionId:sessionId,
   pongFaceSwapGeneration:'old-generation',pongTikTokPresentedSession:presented},
   isConnected:true,querySelector:()=>({})};
 const window={PongNativeSwap:{tiktokCatchUpReceipt:(...args)=>receipts.push(args)}};
 const state={enabled:true,selectedFaceId:'approved',activationSequence:0};
 const context={window,
  pongTikTokLiveState:{current:'https://example.test/video/1'},
  pongFaceSwapState:state,
  pongCanonicalTikTokVideoPage:value=>value,
  pongTikTokWrapperUrl:()=>context.pongTikTokLiveState.current,
  pongFaceSwapCurrentWrapper:()=>wrapper,
  startPongFaceSwap:(face,options)=>{
   calls.push({face,options});state.activationSequence++;
   return Promise.resolve(started).then(value=>{
    if(value){wrapper.dataset.pongFaceSwapSessionId='new';
      wrapper.dataset.pongFaceSwapGeneration='new-generation';
      wrapper.dataset.pongFaceSwapActive='true';}
    return value;
   });
  },
 };
 vm.runInNewContext(source,context);
 return {window,wrapper,calls,receipts,state,context};
}

test('rejected async activation receives false, not an optimistic accepted receipt',async()=>{
 const f=fixture({started:false});
 const queued=f.window.PongTikTokLiveCatchUp('https://example.test/video/1',3.6,'old','token-1');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(queued,true);
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].options.startSeconds,3.6);
 assert.deepEqual(f.receipts,[['token-1','old',false]]);
});

test('stale old-session request cannot restart a newer same-page session',()=>{
 const f=fixture({sessionId:'replacement',presented:''});
 const queued=f.window.PongTikTokLiveCatchUp('https://example.test/video/1',3.6,'old','token-2');
 assert.equal(queued,false);
 assert.equal(f.calls.length,0);
 assert.deepEqual(f.receipts,[['token-2','old',false]]);
});

test('busy wrapper does not queue a face intent or lose catch-up startSeconds',()=>{
 const f=fixture({sessionId:'old'});
 f.wrapper.dataset.pongFaceSwapBusy='true';
 assert.equal(f.window.PongTikTokLiveCatchUp('https://example.test/video/1',3.6,'old','token-busy'),false);
 assert.equal(f.calls.length,0);
 assert.deepEqual(f.receipts,[['token-busy','old',false]]);
});

test('only a settled new-session owner reports accepted',async()=>{
 const f=fixture({started:true});
 assert.equal(f.window.PongTikTokLiveCatchUp('https://example.test/video/1',3.6,'old','token-3'),true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.receipts,[['token-3','old',true]]);
});

test('superseding activation invalidates an otherwise successful completion',async()=>{
 const f=fixture({started:true});
 f.window.PongTikTokLiveCatchUp('https://example.test/video/1',3.6,'old','token-4');
 f.state.activationSequence++;
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.receipts,[['token-4','old',false]]);
});

test('legacy two-argument caller remains valid without a native receipt',async()=>{
 const f=fixture({started:true});
 assert.equal(f.window.PongTikTokLiveCatchUp('https://example.test/video/1',3.6),true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.receipts.length,0);
});
