import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-playback-lifecycle.js','utf8');
function fixture(paused=false){
 const v={paused,ended:false,isConnected:true,currentSrc:'original',playCount:0,
  getBoundingClientRect:()=>({left:0,right:400,top:0,bottom:800}),
  pause(){this.paused=true},async play(){this.paused=false;this.playCount++}};
 const context={window:{},innerWidth:400,innerHeight:800,challenge:false};
 context.document={querySelectorAll:()=>[v],querySelector:()=>context.challenge?{}:null};
 vm.runInNewContext(code,context);return {v,context,w:context.window};
}
test('Exit/background pauses silently and resumes the same playing original once',async()=>{
 const {v,w}=fixture();w.__pongTikTokPauseForPong();w.__pongTikTokPauseForPong();
 assert.equal(v.paused,true);assert.equal(v.volume,0);
 assert.equal(await w.__pongTikTokResumeFromPong(),true);
 await w.__pongTikTokResumeFromPong();assert.equal(v.playCount,1);
});
test('user-paused videos remain paused on reopen',async()=>{
 const {v,w}=fixture(true);w.__pongTikTokPauseForPong();
 assert.equal(await w.__pongTikTokResumeFromPong(),false);assert.equal(v.playCount,0);
});
test('an old DOM node or changed source is never resumed',async()=>{
 for(const change of [v=>v.isConnected=false,v=>v.currentSrc='different',v=>v.getBoundingClientRect=()=>({left:0,right:400,top:900,bottom:1700})]){
  const {v,w}=fixture();w.__pongTikTokPauseForPong();change(v);
  assert.equal(await w.__pongTikTokResumeFromPong(),false);assert.equal(v.playCount,0);
 }
});
test('verification remains untouched; playback can resume only after normal dismissal',async()=>{
 const {v,w,context}=fixture();w.__pongTikTokPauseForPong();context.challenge=true;
 assert.equal(await w.__pongTikTokResumeFromPong(),false);assert.equal(v.playCount,0);
 context.challenge=false;assert.equal(await w.__pongTikTokResumeFromPong(),true);
});
