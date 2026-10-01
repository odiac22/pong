import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const begin='// BEGIN_TIKTOK_MOUNTED_ACTIVATION';
const end='// END_TIKTOK_MOUNTED_ACTIVATION';
const start=source.indexOf(begin),finish=source.indexOf(end,start);
assert.ok(start>=0&&finish>start&&source.indexOf(begin,start+1)<0,
  'Exactly one production mounted-activation block must exist');
const block=source.slice(start+begin.length,finish);

function fixture(){
 const current='https://www.tiktok.com/@creator/video/1234567890123456789';
 const frames=[],starts=[];
 const video={muted:false,defaultMuted:false,volume:1,paused:false,
   duration:8,currentTime:0,pause(){this.paused=true}};
 const matchingWrapper={isConnected:true,dataset:{},querySelector:()=>video};
 let wrapper=null,now=1000,wrapperUrl=current;
 const pongFaceSwapState={enabled:true,activationSequence:7,
   selectedFaceId:'A',selectedFaceIds:['A','B']};
 const pongTikTokLiveState={activeVideo:true,current,requestedUrl:current,
   requestedStartSeconds:1.25};
 const context={current,retainedFaceIds:['A','B'],pongFaceSwapState,pongTikTokLiveState,
   Date:{now:()=>now},requestAnimationFrame:fn=>{frames.push(fn)},
   normalizePongFaceSwapFaceIds:value=>Array.isArray(value)?value:[value],
   pongFaceSwapCurrentWrapper:()=>wrapper,pongTikTokWrapperUrl:()=>wrapperUrl,
   startPongFaceSwap:(face,options)=>{starts.push({face,options});return Promise.resolve(true)}};
 vm.runInNewContext(`(()=>{${block}})()`,context);
 return {frames,starts,video,matchingWrapper,pongFaceSwapState,pongTikTokLiveState,
   attach:()=>{wrapper=matchingWrapper},setWrapperUrl:value=>{wrapperUrl=value},
   advance:ms=>{now+=ms},run:()=>frames.shift()?.()};
}

test('normal mount waits for exact wrapper then starts once with captured timeline',()=>{
 const f=fixture();
 f.run();assert.equal(f.frames.length,1);assert.equal(f.starts.length,0);
 f.attach();f.run();
 assert.equal(f.starts.length,1);
 assert.equal(f.starts[0].face,'A');
 assert.equal(f.starts[0].options.startSeconds,1.25);
 assert.equal(f.video.currentTime,1.25);
 assert.equal(f.video.paused,true);
 assert.equal(f.video.muted,true);
 assert.equal(f.frames.length,0);
});

test('Original/off cancels queued mount; it cannot resurrect a stopped session',()=>{
 const f=fixture();f.attach();
 f.pongFaceSwapState.enabled=false;f.pongFaceSwapState.activationSequence++;
 f.run();assert.equal(f.starts.length,0);assert.equal(f.frames.length,0);
 assert.equal(f.video.paused,false);
});

test('navigation or changed requested start invalidates queued mount',()=>{
 for(const change of [
   f=>{f.pongTikTokLiveState.current='https://www.tiktok.com/@other/video/2234567890123456789'},
   f=>{f.pongTikTokLiveState.requestedUrl='https://www.tiktok.com/@other/video/2234567890123456789'},
   f=>{f.pongTikTokLiveState.activeVideo=false},
   f=>{f.pongTikTokLiveState.requestedStartSeconds=2}]){
   const f=fixture();f.attach();change(f);f.run();
   assert.equal(f.starts.length,0);assert.equal(f.frames.length,0);
 }
});

test('face-set change and activation-sequence bump each cancel old callback',()=>{
 for(const change of [
   f=>{f.pongFaceSwapState.selectedFaceIds=['A','C']},
   f=>{f.pongFaceSwapState.selectedFaceId='C'},
   f=>{f.pongFaceSwapState.activationSequence++}]){
   const f=fixture();f.attach();change(f);f.run();
   assert.equal(f.starts.length,0);assert.equal(f.frames.length,0);
 }
});

test('detached or wrong-source wrapper never starts; deadline ends retry',()=>{
 const f=fixture();f.attach();f.matchingWrapper.isConnected=false;
 f.run();assert.equal(f.starts.length,0);assert.equal(f.frames.length,1);
 f.matchingWrapper.isConnected=true;
 f.setWrapperUrl('https://www.tiktok.com/@other/video/2234567890123456789');
 f.run();assert.equal(f.starts.length,0);assert.equal(f.frames.length,1);
 f.advance(8001);f.run();assert.equal(f.starts.length,0);
 assert.equal(f.frames.length,0);
});
