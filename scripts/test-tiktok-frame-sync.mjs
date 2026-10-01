import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8');
function fixture(stable=false){
 let clock=1000,time=1,seeks=0,reported=0,callbackId=0;
 const callbacks=new Map();
 const style=()=>({setProperty(k,v){this[k]=v}});
 const v={currentTime:3,paused:false,playbackRate:1,isConnected:true,dataset:{},style:style()};
 const o={readyState:4,seeking:false,buffered:{length:1,start:()=>0,end:()=>10},style:style(),pause(){},play:()=>Promise.resolve(),requestVideoFrameCallback:f=>{callbacks.set(++callbackId,f);return callbackId},cancelVideoFrameCallback:id=>callbacks.delete(id)};
 Object.defineProperty(o,'currentTime',{get:()=>time,set:x=>{time=x;seeks++;o.seeking=true}});
 const s={original:v,overlay:o,host:{isConnected:true},start:0,createdAt:0,sessionId:'s',visible:false};
 const window={__pongEventDrivenReveal:true,__pongDomSwap:s,__pongDomSwapSync(){},__pongDomSwapClear(){window.__pongDomSwap=null},PongTikTokSwap:{presented(){reported++}}};
 vm.runInNewContext(code,{window,performance:{now:()=>clock},document:{documentElement:{classList:{add(){},remove(){}}}},requestAnimationFrame:f=>f()});
 if(stable)vm.runInNewContext(readFileSync('android-app/app/src/main/assets/tiktok-stable-handoff.js','utf8'),{window,performance:{now:()=>clock},document:{documentElement:{classList:{add(){},remove(){}}}}});
 return {window,s,seekCount:()=>seeks,reported:()=>reported,pending:()=>callbacks.size,paint:t=>{const current=[...callbacks.values()];callbacks.clear();current.forEach(f=>f(clock,{mediaTime:t}))},advance:n=>{clock+=n}};
}
test('one in-flight alignment seek cannot be restarted by another sync',()=>{
 const f=fixture();f.window.__pongDomSwapSync();f.s.original.currentTime=4;f.advance(100);f.window.__pongDomSwapSync();assert.equal(f.seekCount(),1);
});

test('paused prefetched decoder resumes before its initial alignment seek',()=>{
 const f=fixture(),events=[];
 f.s.overlay.paused=true;
 f.s.overlay.play=()=>{events.push({seeking:f.s.overlay.seeking});f.s.overlay.paused=false;return Promise.resolve()};
 f.window.__pongDomSwapSync();
 assert.deepEqual(events,[{seeking:false}]);
 assert.equal(f.seekCount(),1);assert.equal(f.s.visible,false);
 f.s.original.currentTime=4;f.advance(600);f.window.__pongDomSwapSync();
 assert.equal(events.length,1);assert.equal(f.seekCount(),1);
});

test('already pending alignment seek cannot suppress playback resumption',()=>{
 const f=fixture();let plays=0;
 f.s.overlay.paused=true;f.s.overlay.seeking=true;
 f.s.overlay.play=()=>{plays++;f.s.overlay.paused=false;return Promise.resolve()};
 f.window.__pongDomSwapSync();assert.equal(plays,1);assert.equal(f.seekCount(),0);
 assert.equal(f.s.visible,false);assert.equal(f.reported(),0);
});

test('paused source and ahead-of-source prepared frame are not auto-played',()=>{
 const f=fixture();let plays=0,pauses=0;
 f.s.overlay.paused=false;f.s.overlay.seeking=true;f.s.original.paused=true;
 f.s.overlay.pause=()=>{pauses++;f.s.overlay.paused=true};
 f.s.overlay.play=()=>{plays++;return Promise.resolve()};
 f.window.__pongDomSwapSync();assert.equal(pauses,1);assert.equal(plays,0);
 f.s.original.paused=false;f.s.original.currentTime=0;
 f.window.__pongDomSwapSync();assert.equal(plays,0);
});
test('visibility requires an aligned painted frame, not merely currentTime',()=>{
 const f=fixture();f.window.__pongDomSwapSync();f.s.overlay.seeking=false;f.window.__pongDomSwapSync();assert.equal(f.s.visible,false);
 f.paint(1);assert.equal(f.s.visible,false);assert.equal(f.reported(),0);
 f.window.__pongDomSwapSync();f.paint(3);assert.equal(f.s.visible,true);assert.equal(f.reported(),1);
});
test('a callback from the previous session cannot reveal its video',()=>{
 const f=fixture();f.window.__pongDomSwapSync();f.s.overlay.seeking=false;f.window.__pongDomSwapSync();f.window.__pongDomSwap=null;f.paint(3);assert.equal(f.reported(),0);
});
test('a new observed post revokes stale visible pixels before synchronization',()=>{
 const f=fixture();f.s.pageUrl='https://www.tiktok.com/@test/video/1';f.s.visible=true;
 f.window.__pongTikTokObservedVideo={pageUrl:'https://www.tiktok.com/@test/video/2',video:f.s.original};
 assert.equal(f.window.__pongDomSwapSync().active,false);
 assert.equal(f.window.__pongDomSwap,null);assert.equal(f.reported(),0);
});
test('future-offset loop never shows a mismatched swapped frame',()=>{
 const f=fixture();f.s.start=4;f.s.visible=true;assert.equal(f.window.__pongDomSwapSync().visible,false);
});
test('buffer recovery retains already swapped pixels; decoder errors clear them',()=>{
 const f=fixture();f.s.visible=true;f.s.overlay.buffered.length=0;assert.equal(f.window.__pongDomSwapSync().visible,true);
 f.s.overlay.error={code:3};assert.equal(f.window.__pongDomSwapSync().active,false);
});

test('stable playback does not issue repeated play commands',()=>{
 const f=fixture();f.s.original.currentTime=1;let plays=0;f.s.overlay.paused=true;
 f.s.overlay.play=()=>{plays++;f.s.overlay.paused=false;return Promise.resolve()};
 for(let i=0;i<5;i++)f.window.__pongDomSwapSync();assert.equal(plays,1);
});

test('polling an error first retains the owner-aware failure notification',()=>{
 const f=fixture();let failures=0;
 f.s.fail=()=>{assert.equal(f.window.__pongDomSwap,f.s);failures++;f.window.__pongDomSwapClear();};
 f.s.overlay.error={code:3};
 assert.equal(f.window.__pongDomSwapSync().active,false);
 assert.equal(failures,1);assert.equal(f.window.__pongDomSwap,null);
 f.window.__pongDomSwapSync();assert.equal(failures,1);
});

test('repeated loop handoffs retain exactly one paint-tracking callback chain',()=>{
 const f=fixture();f.s.original.currentTime=1;
 f.window.__pongDomSwapSync();f.paint(1);
 assert.equal(f.pending(),1);
 for(let i=0;i<20;i++){
  f.s.start=2;f.s.original.currentTime=0;f.window.__pongDomSwapSync();
  f.s.start=0;f.s.original.currentTime=1;f.window.__pongDomSwapSync();f.paint(1);
  assert.equal(f.pending(),1,'loop must not duplicate the permanent callback');
 }
});

test('aligned startup paint can reveal without waiting for another frame',()=>{
 const f=fixture();f.s.original.currentTime=1;
 f.window.__pongDomSwapSync({owner:f.s,now:1000,metadata:{mediaTime:1}});
 assert.equal(f.s.visible,true);assert.equal(f.reported(),1);
 assert.equal(f.pending(),1,'only the permanent tracking observer remains');
});

test('startup receipt from another owner or an unaligned frame cannot reveal',()=>{
 const f=fixture();f.s.original.currentTime=1;
 f.window.__pongDomSwapSync({owner:{},now:1000,metadata:{mediaTime:1}});
 assert.equal(f.s.visible,false);assert.equal(f.reported(),0);
 const g=fixture();g.s.original.currentTime=1;
 g.window.__pongDomSwapSync({owner:g.s,now:1000,metadata:{mediaTime:0}});
 assert.equal(g.s.visible,false);assert.equal(g.reported(),0);
});

test('fresh paint consumes an outstanding reveal request without a duplicate chain',()=>{
 const f=fixture();f.s.original.currentTime=1;
 f.window.__pongDomSwapSync();assert.equal(f.pending(),1);
 f.window.__pongDomSwapSync({owner:f.s,now:1000,metadata:{mediaTime:1}});
 assert.equal(f.s.visible,true);assert.equal(f.reported(),1);assert.equal(f.pending(),1);
 f.paint(1.04);assert.equal(f.reported(),1);assert.equal(f.pending(),1);
});

test('unqualified event-driven reveal is disabled unless explicitly opted in',()=>{
 const f=fixture();delete f.window.__pongEventDrivenReveal;f.s.original.currentTime=1;
 f.window.__pongDomSwapSync({owner:f.s,now:1000,metadata:{mediaTime:1}});
 assert.equal(f.s.visible,false);assert.equal(f.reported(),0);assert.equal(f.pending(),1);
 f.paint(1);assert.equal(f.s.visible,true);assert.equal(f.reported(),1);
});
test('stable-handoff composition forwards exact receipt without adding another frame wait',()=>{
 const f=fixture(true);f.s.original.currentTime=1;
 f.window.__pongDomSwapSync({owner:f.s,now:1000,metadata:{mediaTime:1}});
 assert.equal(f.s.visible,true);assert.equal(f.reported(),1);assert.equal(f.pending(),1);
 assert.equal(f.window.__pongDomSwapSync.pongFrameSync,1);
});
test('stable-handoff composition still rejects another owner and misaligned frames',()=>{
 for(const receipt of [{owner:{},metadata:{mediaTime:1}},{metadata:{mediaTime:0}}]){
  const f=fixture(true);f.s.original.currentTime=1;
  f.window.__pongDomSwapSync({owner:f.s,now:1000,...receipt});
  assert.equal(f.s.visible,false);assert.equal(f.reported(),0);
 }
});
test('startup can align within available buffer without seeking beyond it or relaxing reveal',()=>{
 const f=fixture(true);f.window.__pongBufferedStartupSeekTrial=true;
 f.s.original.currentTime=1.8;f.s.overlay.buffered.end=()=>1.65;
 f.window.__pongDomSwapSync();
 assert.equal(f.seekCount(),1);assert.ok(Math.abs(f.s.overlay.currentTime-1.55)<.001);
 assert.equal(f.s.visible,false);assert.equal(f.reported(),0);
 f.s.overlay.seeking=false;
 f.window.__pongDomSwapSync({owner:f.s,now:1000,metadata:{mediaTime:1.55}});
 assert.equal(f.s.visible,true);assert.equal(f.reported(),1);
});
test('buffered startup seek remains off by default and cannot bridge an old range or buffer gap',()=>{
 for(const variant of ['disabled','too-old','gap','visible']){
  const f=fixture();f.s.original.currentTime=1.8;
  f.window.__pongBufferedStartupSeekTrial=variant!=='disabled';
  f.s.overlay.buffered.end=()=>variant==='too-old'?1.2:1.65;
  if(variant==='gap')f.s.overlay.buffered.start=()=>1.6;
  if(variant==='visible')f.s.visible=true;
  f.window.__pongDomSwapSync();assert.equal(f.seekCount(),0,variant);
 }
});
