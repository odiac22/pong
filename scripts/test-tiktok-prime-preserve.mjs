import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync('scripts/tiktok-prime-preserve-trial.js','utf8');
function fixture(){
  let plays=0,pauses=0,callback,time=.033,next=0;
  const timers=new Map(),abort=new AbortController();
  const overlay={style:{},readyState:4,play(){plays++;return Promise.resolve()},pause(){pauses++},
    requestVideoFrameCallback(fn){callback=fn;return 0},cancelVideoFrameCallback(id){assert.equal(id,0);callback=null}};
  Object.defineProperty(overlay,'currentTime',{get:()=>time,set(){throw Error('must never flush with seek')}});
  const s={overlay,abort,sessionId:'one',warm:true};
  const original=()=>true,window={__pongDomSwapPrepare:original,__pongDomSwapWarm:s};
  vm.runInNewContext(source,{window,performance:{now:()=>100},document:{body:{appendChild(){}}},
    setTimeout(fn){timers.set(++next,fn);return next},clearTimeout(id){timers.delete(id)}});
  return {window,s,original,plays:()=>plays,pauses:()=>pauses,timers,
    paint(){callback?.(100,{mediaTime:time})},timeout(){[...timers.values()].forEach(fn=>fn())}};
}
test('prime starts decoding immediately and preserves its first frame without a seek',()=>{
  const f=fixture();assert.equal(f.plays(),1);f.paint();assert.equal(f.pauses(),1);
  assert.equal(f.window.__pongPrimePreserveEvidence[0].ready,4);assert.equal(f.timers.size,0);
  assert.equal(f.s.overlay.muted,true);assert.equal(f.s.overlay.volume,0);
  f.window.__pongDomSwapPrepare();assert.equal(f.plays(),1);
});
test('late first frame does not pause an adopted active video',()=>{
  const f=fixture();f.window.__pongDomSwapWarm=null;f.s.warm=false;f.paint();assert.equal(f.pauses(),0);
  assert.equal(f.window.__pongPrimePreserveEvidence[0].reason,'adopted');
});
test('timeout and restoration are bounded, idempotent, and preserve the original prepare function',()=>{
  const f=fixture();f.timeout();assert.equal(f.pauses(),1);
  f.window.__pongUndoPrimePreserve();assert.equal(f.pauses(),1);
  assert.equal(f.window.__pongDomSwapPrepare,f.original);assert.equal(f.timers.size,0);
});
test('retirement cancels frame callback zero and cannot touch a new owner',()=>{
  const f=fixture();f.s.abort.abort();f.paint();assert.equal(f.pauses(),0);assert.equal(f.timers.size,0);
  assert.equal(f.window.__pongPrimePreserveEvidence[0].reason,'retired');
});
