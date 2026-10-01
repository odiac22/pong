import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {warmChaseTrial} from './lib/tiktok-warm-chase-trial.mjs';
const code=warmChaseTrial(readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8'));
function fixture(){
 let clock=1000,time=0,seeks=0,paint;
 const original={isConnected:true,currentTime:.6,paused:false,playbackRate:1,style:{setProperty(){}},dataset:{}};
 const overlay={readyState:4,seeking:false,paused:true,style:{},playbackRate:1,
   buffered:{length:1,start:()=>0,end:()=>4},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},
   requestVideoFrameCallback(fn){paint=fn;return 1}};
 Object.defineProperty(overlay,'currentTime',{get:()=>time,set:x=>{time=x;seeks++;overlay.seeking=true}});
 const s={original,overlay,host:{isConnected:true},start:0,createdAt:990,transport:{warm:true,adoptedAt:990},visible:false,sessionId:'one'};
 const window={__pongDomSwap:s,__pongDomSwapSync(){},__pongDomSwapClear(){window.__pongDomSwap=null},PongTikTokSwap:{presented(){}}};
 vm.runInNewContext(code,{window,performance:{now:()=>clock},document:{documentElement:{classList:{add(){},remove(){}}}}});
 return {s,window,sync:()=>window.__pongDomSwapSync(),seeks:()=>seeks,advance:n=>clock+=n,
   decode:n=>time=n,paint:n=>paint?.(clock,{mediaTime:n})};
}
test('modest positive warm lag keeps decoding past the old retry deadline',()=>{
 const f=fixture();f.sync();assert.equal(f.seeks(),0);assert.equal(f.s.overlay.playbackRate,3);
 f.advance(800);f.decode(.6);f.s.original.currentTime=1.2;f.sync();
 assert.equal(f.seeks(),0);assert.equal(f.s.visible,false);
 f.decode(1);f.sync();f.paint(1);assert.equal(f.s.visible,true);
});
test('a completed seek cannot immediately flush the decoded warm frame again',()=>{
 const f=fixture();f.s.original.currentTime=2;f.sync();assert.equal(f.seeks(),1);
 f.s.overlay.seeking=false;f.advance(700);f.s.original.currentTime=2.7;f.sync();
 assert.equal(f.seeks(),1);assert.equal(f.s.visible,false);
 f.decode(2.5);f.sync();f.paint(2.5);assert.equal(f.s.visible,true);
});
test('rewind, paused, cold, large jumps, and already visible retain seek behavior',()=>{
 for(const change of [f=>f.s.original.paused=true,f=>f.s.transport.warm=false,
  f=>f.s.original.currentTime=2,f=>{f.decode(2);f.s.original.currentTime=0},
  f=>{f.s.visible=true;f.s.original.currentTime=2}]){
  const f=fixture();change(f);f.sync();assert.equal(f.seeks(),1);
 }
});
test('retired, future-offset and unbuffered media never bypass reveal evidence',()=>{
 const f=fixture();f.decode(.4);f.sync();f.window.__pongDomSwap=null;f.paint(.4);assert.equal(f.s.visible,false);
 const future=fixture();future.s.start=1;future.sync();assert.equal(future.s.visible,false);
 const empty=fixture();empty.s.overlay.buffered.length=0;empty.sync();assert.equal(empty.s.transport.warmChaseTrial,undefined);
});
