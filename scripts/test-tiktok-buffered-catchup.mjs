import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {bufferedCatchupTrial} from './lib/tiktok-buffered-catchup-trial.mjs';
const source=bufferedCatchupTrial(readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8'));
function fixture(){
 let clock=1000,time=0,seeks=0,paint;
 const original={isConnected:true,currentTime:1,paused:false,playbackRate:1,style:{setProperty(){}},dataset:{}};
 const overlay={readyState:4,seeking:false,paused:true,style:{},playbackRate:1,
   buffered:{length:1,start:()=>0,end:()=>3},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},
   requestVideoFrameCallback(fn){paint=fn;return 1}};
 Object.defineProperty(overlay,'currentTime',{get:()=>time,set:x=>{time=x;seeks++;overlay.seeking=true}});
 const s={original,overlay,host:{isConnected:true},start:0,createdAt:990,transport:{warm:true,adoptedAt:990},visible:false,sessionId:'one'};
 const window={__pongDomSwap:s,__pongDomSwapSync(){},__pongDomSwapClear(){window.__pongDomSwap=null},PongTikTokSwap:{presented(){}}};
 vm.runInNewContext(source,{window,performance:{now:()=>clock},document:{documentElement:{classList:{add(){},remove(){}}}}});
 return {s,sync:()=>window.__pongDomSwapSync(),seeks:()=>seeks,advance:n=>clock+=n,
   decode:timeValue=>time=timeValue,paint:time=>paint?.(clock,{mediaTime:time})};
}
test('adopted warm stream catches up briefly without a destructive first seek',()=>{
 const f=fixture();f.sync();assert.equal(f.seeks(),0);assert.equal(f.s.overlay.playbackRate,3);assert.equal(f.s.visible,false);
 f.decode(.8);f.advance(250);f.sync();f.paint(.8);assert.equal(f.s.visible,true);assert.equal(f.seeks(),0);
});
test('catch-up cannot reveal a misaligned frame or grant a second grace window',()=>{
 const f=fixture();f.sync();f.paint(0);assert.equal(f.s.visible,false);
 f.advance(350);f.sync();assert.equal(f.seeks(),1);
 f.s.overlay.seeking=false;f.s.original.currentTime=2;f.advance(100);f.sync();assert.equal(f.seeks(),1);
 f.advance(500);f.sync();assert.equal(f.seeks(),2);
});
test('paused originals, cold streams, large jumps, and settled streams retain normal seeks',()=>{
 for(const mutate of [f=>f.s.original.paused=true,f=>f.s.transport.warm=false,
   f=>f.s.original.currentTime=2,f=>f.s.visible=true]){
   const f=fixture();mutate(f);if(f.s.visible)f.s.original.currentTime=2;
   f.sync();assert.equal(f.seeks(),1);assert.equal(f.s.transport.bufferedCatchupTrial,undefined);
 }
});
test('insufficient buffer never starts the catch-up trial or guesses a playable seek',()=>{
 const f=fixture();f.s.overlay.buffered.length=0;f.sync();assert.equal(f.seeks(),0);
 assert.equal(f.s.transport.bufferedCatchupTrial,undefined);assert.equal(f.s.visible,false);
});
