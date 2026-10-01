import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=['hasVideoPlayableData','canResumePongFaceSwapPlayback','toggleVideoPlaybackFromIntent'].map(n=>html.match(new RegExp(`function ${n}\\([^]*?\\n}`))[0]).join('\n');
function fixture(){
 const wrapper={dataset:{pongFaceSwapSessionId:'owned',pongFaceSwapActive:'true',userPaused:'true'}};
 const video={paused:true,ended:false,error:null,readyState:3,ahead:.4,currentSrc:'http://localhost/pong-swap/sessions/owned/stream'};
 let plays=0,prepares=0;
 const ctx=vm.createContext({String,Boolean,encodeURIComponent,window:{},getVideoBufferedAheadSeconds:v=>v.ahead,isVideoReadyForInitialPlayback:()=>false,restartPongVideoFromBeginning:()=> 'not-ended',markVideoPlayIntent:w=>{w.dataset.playIntent='true';},playVideoCleanly:v=>{plays++;v.paused=false;},prepareVideoForPlayback:()=>prepares++,updateVideoReadyLoader(){}});
 ctx.isPongFaceSwapManagedMedia=()=>true;
 vm.runInContext(code,ctx);return {wrapper,video,ctx,run:()=>ctx.toggleVideoPlaybackFromIntent(wrapper,video),counts:()=>({plays,prepares})};
}
test('explicit native play starts decoded media below the six-second reserve',()=>{const f=fixture();f.ctx.isPongFaceSwapManagedMedia=()=>false;f.wrapper.dataset.pongFaceSwapActive='false';f.wrapper.dataset.playIntent='true';f.video.currentSrc='/fixture.mp4';f.video.ahead=2.7;f.run();assert.equal(f.counts().plays,1);assert.equal(f.counts().prepares,0);assert.equal(f.wrapper.dataset.userPaused,undefined);});
test('paused owned swap resumes below the startup reserve without lowering render quality',()=>{const f=fixture();f.run();assert.equal(f.video.paused,false);assert.equal(f.wrapper.dataset.playIntent,'true');assert.equal(f.wrapper.dataset.userPaused,undefined);assert.equal(f.counts().plays,1);});
for(const [name,edit] of [['metadata only',f=>f.video.readyState=1],['empty buffer',f=>f.video.ahead=0],['failed media',f=>f.video.error={code:3}],['old session',f=>f.video.currentSrc='/pong-swap/sessions/old/stream'],['original placeholder',f=>f.video.currentSrc='/original.mp4'],['swap off',f=>f.wrapper.dataset.pongFaceSwapActive='false']])test('reserve bypass rejects '+name,()=>{const f=fixture();edit(f);assert.equal(f.ctx.canResumePongFaceSwapPlayback(f.wrapper,f.video),false);f.run();assert.equal(f.counts().plays,0);});
