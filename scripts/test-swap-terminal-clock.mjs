import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=n=>html.match(new RegExp(`(?:async )?function ${n}\\([^]*?\\n}`))[0];
test('late original restore events cannot seek or play a replacement swap',()=>{
 const code=fn('stopPongFaceSwapForWrapper');
 const block=code.slice(code.indexOf('    const shouldPlay = original.wasPlaying'),code.indexOf('  } else if (!restore && detachMedia)'));
 let generation=1,managed=false,plays=0;const listeners={};
 const video={src:'',duration:1800,currentTime:0,load(){}};
 const c=vm.createContext({URL,location:{href:'http://localhost/pong'},video,wrapper:{dataset:{},classList:{contains:()=>true}},original:{source:'http://localhost/original',wasPlaying:true},resumeAt:900,generation:'old',beginPongFaceSwapMediaCallbacks:()=>({listen:(e,f)=>listeners[e]=f}),pongVideoSourceGeneration:()=>generation,isPongFaceSwapManagedMedia:()=>managed,applyPlayerAudioPreference(){},playVideoCleanly(){plays++},setPongVideoSource:(v,s)=>{v.src=s;generation++}});
 vm.runInContext(block,c);listeners.loadedmetadata();assert.equal(video.currentTime,900);
 video.currentTime=0;video.src='http://localhost/pong-swap/sessions/new/stream';managed=true;generation++;
 listeners.loadedmetadata();listeners.canplay();assert.equal(video.currentTime,0);assert.equal(plays,0);
});
test('truncated EOF does not save the synthetic end as the recovery position',()=>{
 const c=vm.createContext({pongFaceSwapFullDuration:()=>2000});vm.runInContext(fn('pongFaceSwapAbsoluteTime'),c);
 const w={dataset:{pongFaceSwapActive:'true',pongFaceSwapGeneration:'new'}};
 const v={currentTime:2000,ended:true,__pongSwapOriginal:{startSeconds:300},__pongSwapPresentedMediaTime:2,__pongSwapPresentedGeneration:'new'};
 assert.equal(c.pongFaceSwapAbsoluteTime(w,v),302);
 v.__pongSwapPresentedGeneration='old';assert.equal(c.pongFaceSwapAbsoluteTime(w,v),300);
 v.ended=false;v.currentTime=10;assert.equal(c.pongFaceSwapAbsoluteTime(w,v),310);
});
test('EOF before the first seek frame retains the requested offset and is early',()=>{
 const c=vm.createContext({pongFaceSwapFullDuration:()=>1698.56,pongFaceSwapProgressState:()=>({duration:1698.56,currentTime:1698.56})});
 vm.runInContext(fn('pongFaceSwapAbsoluteTime')+'\n'+fn('pongFaceSwapEndedEarly'),c);
 const w={dataset:{pongFaceSwapActive:'true',pongFaceSwapGeneration:'seek'}};
 const v={currentTime:1528.66,ended:true,__pongSwapOriginal:{startSeconds:169.9}};
 assert.equal(c.pongFaceSwapAbsoluteTime(w,v),169.9);
 assert.equal(c.pongFaceSwapEndedEarly(w,v),true);
 v.ended=false;v.error={code:3};assert.equal(c.pongFaceSwapAbsoluteTime(w,v),169.9);
});
for(const terminal of ['ended','error'])test(`explicit seek replaces busy ${terminal} reader`,async()=>{
 let prepared=null;
 const w={dataset:{pongFaceSwapActive:'true',pongFaceSwapBusy:'true',pongFaceSwapFaceId:'f'}};
 const v={paused:true,ended:false,error:null,[terminal]:true};
 const c=vm.createContext({pongFaceSwapFullDuration:()=>2000,pongFaceSwapState:{seekGeneration:0},suspendPongFaceSwapForScrub(){},retirePongFaceSwapSeekEntry(){},setPongFaceSwapPhase(){},PONG_FACE_SWAP_PHASES:{SEEKING:'seeking'},updatePongFaceSwapProgress(){},preparePongFaceSwapSeek:r=>{prepared=r;return true}});
 vm.runInContext(fn('seekPongVideoTo'),c);
 assert.equal(await c.seekPongVideoTo(w,v,347),true);assert.equal(prepared.target,347);assert.equal(w.dataset.pongFaceSwapBusy,undefined);
});
test('forward-only HTTP swap seeks replace the reader and retain play intent',async()=>{
 let prepared;
 const w={dataset:{pongFaceSwapActive:'true',pongFaceSwapFaceId:'f',playIntent:'true'}};
 const ranges={length:1,start:()=>0,end:()=>20};
 const v={currentSrc:'http://localhost/pong-swap/sessions/a/stream',paused:true,ended:false,readyState:4,currentTime:2,__pongSwapOriginal:{startSeconds:100},buffered:ranges,seekable:ranges};
 const c=vm.createContext({pongFaceSwapFullDuration:()=>2000,pongFaceSwapState:{seekGeneration:0},suspendPongFaceSwapForScrub(){},retirePongFaceSwapSeekEntry(){},setPongFaceSwapPhase(){},PONG_FACE_SWAP_PHASES:{SEEKING:'seeking'},updatePongFaceSwapProgress(){},preparePongFaceSwapSeek:r=>{prepared=r;return true}});
 vm.runInContext(fn('seekPongVideoTo'),c);
 await c.seekPongVideoTo(w,v,105);
 assert.equal(v.currentTime,2);assert.equal(prepared.target,105);assert.equal(prepared.shouldPlay,true);
 w.dataset.userPaused='true';await c.seekPongVideoTo(w,v,106);
 // Clear the previous queued request before checking a fresh explicit pause.
 c.pongFaceSwapState.pendingSeekTarget=null;
 await c.seekPongVideoTo(w,v,107);assert.equal(prepared.shouldPlay,false);
});
