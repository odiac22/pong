import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installSurfaceCounter,installWarmSuppressor,installPausedOriginalIsolation,
  seekObservedToStart,validWindow,armEvidence} from './experiment-tiktok-decoder-attribution.mjs';

function fixture(){
 let next=7,intervals=new Map(),cleared=[];
 const window={__pongDomSwap:null,__pongDomSwapWarm:null,
   __pongDomSwapPrepare:()=>true,__pongDomSwapWarmClear(){this.__pongDomSwapWarm=null}};
 const context={window,Map,performance:{now:()=>0},
   setInterval(fn){const id=next++;intervals.set(id,fn);return id},
   clearInterval(id){cleared.push(id);intervals.delete(id)}};
 return {window,context,tick:()=>{for(const fn of [...intervals.values()])fn()},cleared};
}

test('counter separates detached warm object from active DOM replacement and accumulates both decoders',()=>{
 const f=fixture();
 vm.runInNewContext(installSurfaceCounter,f.context);
 const q=n=>({getVideoPlaybackQuality:()=>({totalVideoFrames:n.value})});
 const a={value:2},w={value:1};
 f.window.__pongDomSwap={overlay:q(a)};
 f.window.__pongDomSwapWarm={overlay:q(w)};
 f.window.__pongDecoderSurfaceCounter.begin();
 a.value=5;w.value=4;f.tick();
 const next={value:0};f.window.__pongDomSwap={overlay:q(next)};
 f.tick();next.value=2;f.tick();
 const row=f.window.__pongDecoderSurfaceCounter.end();
 assert.equal(row.activeObjects,2);
 assert.equal(row.warmObjects,1);
 assert.equal(row.activeSessions,2);
 assert.equal(row.activeReplacements,1);
 assert.equal(row.warmSessions,1);
 assert.equal(row.activeDecodedDelta,5);
 assert.equal(row.warmDecodedDelta,3);
 assert.ok(row.simultaneousSamples>=2);
 assert.equal(row.simultaneousDecodedSamples,1);
 assert.deepEqual(f.cleared,[7]);
});

test('two sequential active insertions are not reported as simultaneous decoders',()=>{
 const f=fixture();vm.runInNewContext(installSurfaceCounter,f.context);
 const a={n:0},b={n:0};
 const active=x=>({overlay:{getVideoPlaybackQuality:()=>({totalVideoFrames:x.n})}});
 f.window.__pongDomSwap=active(a);f.window.__pongDecoderSurfaceCounter.begin();
 a.n=10;f.tick();f.window.__pongDomSwap=null;f.tick();
 f.window.__pongDomSwap=active(b);f.tick();b.n=12;f.tick();
 const row=f.window.__pongDecoderSurfaceCounter.end();
 assert.equal(row.activeSessions,2);
 assert.equal(row.activeReplacements,1);
 assert.equal(row.activeDecodedDelta,22);
 assert.equal(row.simultaneousSamples,0);
 assert.equal(row.simultaneousDecodedSamples,0);
});

test('one object temporarily named warm and active is not two surfaces',()=>{
 const f=fixture();vm.runInNewContext(installSurfaceCounter,f.context);
 const count={n:0},session={overlay:{getVideoPlaybackQuality:()=>({totalVideoFrames:count.n})}};
 f.window.__pongDomSwap=session;f.window.__pongDomSwapWarm=session;
 f.window.__pongDecoderSurfaceCounter.begin();count.n=10;f.tick();
 const row=f.window.__pongDecoderSurfaceCounter.end();
 assert.equal(row.simultaneousSamples,0);
 assert.ok(row.sameObjectRoleOverlapSamples>=2);
 assert.equal(row.simultaneousDecodedSamples,0);
});

test('warm suppression is reversible only while the exact hook is still ours',()=>{
 const f=fixture();
 const original=f.window.__pongDomSwapPrepare;
 vm.runInNewContext(installWarmSuppressor,f.context);
 assert.equal(f.window.__pongDomSwapPrepare(),false);
 assert.equal(f.window.__pongDiagnosticWarmSuppressor.inspect().calls,1);
 assert.equal(f.window.__pongDiagnosticWarmSuppressor.restore(),true);
 assert.equal(f.window.__pongDomSwapPrepare,original);
 vm.runInNewContext(installWarmSuppressor,f.context);
 const replacement=()=>true;
 f.window.__pongDomSwapPrepare=replacement;
 assert.equal(f.window.__pongDiagnosticWarmSuppressor.restore(),false);
 assert.equal(f.window.__pongDomSwapPrepare,replacement);
});

test('paused-original isolation does not claim a visible frame and restores clock intent',async()=>{
 const f=fixture();
 const original={isConnected:true,paused:false,pause(){this.paused=true},
   play(){this.paused=false;return Promise.resolve()}};
 const overlay={paused:true,readyState:4,style:{opacity:'0'},
   play(){this.paused=false;return Promise.resolve()},pause(){this.paused=true}};
 const active={overlay,original,timer:13,visible:false,sessionId:'s'};
 const sync=()=>({visible:true});
 Object.assign(f.window,{__pongDomSwapSync:sync,
   __pongTikTokObservedVideo:{video:original},
   __pongDiagnosticWarmSuppressor:{inspect:()=>({installed:true})}});
 vm.runInNewContext(installPausedOriginalIsolation,f.context);
 assert.equal(f.window.__pongDomSwapSync().visible,false);
 const ready=f.window.__pongDiagnosticPausedOriginal.ready();
 f.window.__pongDomSwap=active;
 f.tick();
 assert.equal((await ready).sameSession,true);
 assert.equal(original.paused,true);
 assert.equal(f.window.__pongDomSwapSync().visible,false);
 assert.equal(active.timer,0);
 assert.equal(await f.window.__pongDiagnosticPausedOriginal.restore(),true);
 assert.equal(original.paused,false);
 assert.equal(f.window.__pongDomSwapSync,sync);
 assert.ok(active.timer>7);
 assert.ok(f.cleared.includes(13));
});

test('prearmed isolation rejects a republished synchronizer before mutating playback',async()=>{
 const f=fixture();
 const original={isConnected:true,paused:false,pause(){this.paused=true},
   play(){this.paused=false;return Promise.resolve()}};
 const sync=()=>({visible:true});
 Object.assign(f.window,{__pongDomSwapSync:sync,
   __pongTikTokObservedVideo:{video:original},
   __pongDiagnosticWarmSuppressor:{inspect:()=>({installed:true})}});
 vm.runInNewContext(installPausedOriginalIsolation,f.context);
 const ready=f.window.__pongDiagnosticPausedOriginal.ready();
 const replacement=()=>({visible:false});
 f.window.__pongDomSwapSync=replacement;
 f.tick();
 await assert.rejects(ready,/ownership changed/);
 assert.equal(original.paused,false);
 assert.equal(await f.window.__pongDiagnosticPausedOriginal.restore(),false);
 assert.equal(f.window.__pongDomSwapSync,replacement);
});

test('paused arm is never treated as a playback or green-paint pass',()=>{
 const row={probe:{sameVideo:true,raf:{count:150},
     original:{paused:true,firstCurrentTime:1,lastCurrentTime:1.01,unexpectedSeek:false},
     overlay:{visible:false}},
   surfaces:{samples:120,overflow:false,activeObjects:1,warmObjects:0,
     activeDecodedDelta:60,warmDecodedDelta:0,simultaneousSamples:0}};
 assert.equal(validWindow(row,{paused:true,noWarm:true}),true);
 assert.equal(validWindow({...row,probe:{...row.probe,overlay:{visible:true}}},
   {paused:true,noWarm:true}),false);
 assert.equal(validWindow({...row,surfaces:{...row.surfaces,warmObjects:1}},
   {paused:true,noWarm:true}),false);
 assert.equal(validWindow({...row,surfaces:{...row.surfaces,activeDecodedDelta:0}},
   {paused:true,noWarm:true}),false);
 assert.equal(validWindow({...row,probe:{...row.probe,original:{...row.probe.original,
   lastCurrentTime:1.4}}},{paused:true,noWarm:true}),false);
});

test('same observed source seek settles before each arm and rejects a short source',async()=>{
 const listeners=new Map();let time=8.2;
 const video={isConnected:true,duration:9.7,paused:false,seeking:false,
   pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},
   addEventListener(name,fn){listeners.set(name,fn)},
   removeEventListener(name,fn){if(listeners.get(name)===fn)listeners.delete(name)},
   get currentTime(){return time},set currentTime(value){time=value;listeners.get('seeked')?.()}};
 const pageUrl='https://www.tiktok.com/@x/video/1234567890123456789';
 const window={__pongTikTokObservedVideo:{video,pageUrl},
   __pongDecoderAudioPrior:{video,pageUrl},__pongDomSwap:null,__pongDomSwapWarm:null};
 const context={window,setTimeout,clearTimeout};
 const result=await vm.runInNewContext(seekObservedToStart,context);
 assert.equal(result.seekSettled,true);assert.equal(time,0);assert.equal(video.paused,false);
 video.duration=6;
 await assert.rejects(vm.runInNewContext(seekObservedToStart,context),/duration invalid/);
 video.duration=9.7;window.__pongDomSwap={};
 await assert.rejects(vm.runInNewContext(seekObservedToStart,context),/ownership/);
});

test('insufficient decoded frames invalidate one arm without invalidating later evidence',()=>{
 const row={probe:{sameVideo:true,raf:{count:300},original:{paused:false,
     unexpectedSeek:false}},surfaces:{samples:120,overflow:false,activeObjects:1,
     activeDecodedDelta:11,warmObjects:0,warmDecodedDelta:0,simultaneousSamples:0}};
 assert.deepEqual(armEvidence(row,{noWarm:true}),
   {valid:false,reasons:['active-decoder-under-30']});
 assert.equal(armEvidence({...row,surfaces:{...row.surfaces,activeDecodedDelta:144}},
   {noWarm:true}).valid,true);
 const paused={...row,probe:{...row.probe,original:{paused:true,
   firstCurrentTime:8.2,lastCurrentTime:9.6,unexpectedSeek:false}}};
 assert.ok(armEvidence(paused,{paused:true,noWarm:true}).reasons.includes(
   'paused-original-clock-moved'));
});
