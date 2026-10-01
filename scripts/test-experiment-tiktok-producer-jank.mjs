import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CONDITIONS, WINDOW_MS, attributableHeadless, compactRenderer,
  attributableFullSwap, parseJankTrialArgs, installProbe, installHeadlessPong,
  installHeadlessTikTok } from './experiment-tiktok-producer-jank.mjs';

test('same-playhead start target is opt-in and strictly validated', () => {
  const run='--run-isolated-jank-trial';
  assert.deepEqual(parseJankTrialArgs([run]),{samePlayhead:false,startSeconds:0});
  assert.deepEqual(parseJankTrialArgs([run,'--same-playhead']),
    {samePlayhead:true,startSeconds:0});
  assert.deepEqual(parseJankTrialArgs([run,'--same-playhead','--start-seconds','6']),
    {samePlayhead:true,startSeconds:6});
  assert.deepEqual(parseJankTrialArgs([run,'--start-seconds','6.25','--same-playhead']),
    {samePlayhead:true,startSeconds:6.25});
  for(const args of [
    [run,'--start-seconds','6'],[run,'--same-playhead','--start-seconds'],
    [run,'--same-playhead','--start-seconds','-1'],
    [run,'--same-playhead','--start-seconds','Infinity'],
    [run,'--same-playhead','--start-seconds','NaN'],
    [run,'--same-playhead','--start-seconds',''],
    [run,'--same-playhead','--same-playhead'],
    [run,'--same-playhead','--start-seconds','6','--start-seconds','7']
  ]) assert.throws(()=>parseJankTrialArgs(args));
});

test('all three six-second conditions are fixed and browser expressions compile offline', () => {
  assert.deepEqual(CONDITIONS, ['original-only','producer-headless','full-swap']);
  assert.equal(WINDOW_MS, 6000);
  for(const source of [installProbe,installHeadlessPong,installHeadlessTikTok])
    assert.doesNotThrow(()=>new Function(`return ${source}`));
});

test('Pong suppression changes only ready and restores only its own wrapper', () => {
  const original=()=>JSON.stringify({requestedUrl:'page',streamUrl:'stream',sessionId:'abc',
    ready:true,startSeconds:2,paused:false});
  const context={window:{PongTikTokLiveIntegratedState:original},JSON};
  vm.runInNewContext(installHeadlessPong,context);
  const payload=JSON.parse(context.window.PongTikTokLiveIntegratedState());
  assert.deepEqual(payload,{requestedUrl:'page',streamUrl:'stream',sessionId:'abc',
    ready:false,startSeconds:2,paused:false});
  assert.equal(context.window.__pongProducerHeadless.inspect().suppressedReadyCalls,1);
  context.window.__pongProducerHeadless.restore();
  assert.equal(context.window.PongTikTokLiveIntegratedState,original);
  vm.runInNewContext(installHeadlessPong,context);
  const newer=()=>'{"ready":true}';
  context.window.PongTikTokLiveIntegratedState=newer;
  assert.equal(JSON.parse(context.window.PongTikTokLiveIntegratedState()).ready,false);
  assert.equal(context.window.__pongProducerHeadless.inspect().replacements,1);
  context.window.__pongProducerHeadless.restore();
  assert.equal(context.window.PongTikTokLiveIntegratedState,newer);
  const objectPublisher=()=>({ready:true,sessionId:'object'});
  context.window.PongTikTokLiveIntegratedState=objectPublisher;
  vm.runInNewContext(installHeadlessPong,context);
  const objectResult=context.window.PongTikTokLiveIntegratedState();
  assert.equal(typeof objectResult,'object');assert.equal(objectResult.ready,false);
  context.window.__pongProducerHeadless.restore();
});

test('on-device rVFC logic accepts validated natural wrap and rejects arbitrary seek', async () => {
  let callback, nextId=0;
  const video={isConnected:true,readyState:3,paused:false,duration:9.706,currentTime:8.8,
    requestVideoFrameCallback:fn=>{callback=fn;return ++nextId},
    cancelVideoFrameCallback:()=>{},getVideoPlaybackQuality:()=>({totalVideoFrames:10,droppedVideoFrames:0})};
  const page='https://www.tiktok.com/@example/video/1234567890123456789';
  const window={__pongTikTokObservedVideo:{video,pageUrl:page}};
  const context={window,document:{querySelector:()=>null,documentElement:{}},
    location:{hostname:'www.tiktok.com'},performance:{now:()=>10},
    requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},
    setTimeout:()=>1,clearTimeout:()=>{},
    PerformanceObserver:class{observe(){}disconnect(){}},
    MutationObserver:class{observe(){}disconnect(){}}};
  vm.runInNewContext(installProbe,context);
  window.__pongProducerJankProbe.begin('producer-headless',6000);
  for(const mediaTime of [8.8,9.5,.2,.9])callback(10,{mediaTime});
  const wrapped=window.__pongProducerJankProbe.finish();
  assert.equal(wrapped.original.loops,1);
  assert.ok(wrapped.original.mediaProgress>1);
  assert.equal(wrapped.original.unexpectedSeek,false);
  window.__pongProducerJankProbe.begin('producer-headless',6000);
  for(const mediaTime of [6,2])callback(10,{mediaTime});
  const sought=window.__pongProducerJankProbe.finish();
  assert.equal(sought.original.unexpectedSeek,true);
  window.__pongProducerJankProbe.restore();
});

test('TikTok guard clears existing decoder and blocks prepare/attach without creating one', () => {
  let clears=0,warms=0,prepares=0,attaches=0;
  const prepare=()=>{prepares++;return true},attach=()=>{attaches++;return true};
  const context={window:{__pongDomSwapClear:()=>{clears++},__pongDomSwapWarmClear:()=>{warms++},
    __pongDomSwapPrepare:prepare,__pongDomSwapAttach:attach},
    document:{querySelector:()=>null,querySelectorAll:()=>[]}};
  vm.runInNewContext(installHeadlessTikTok,context);
  assert.equal(clears,1);assert.equal(warms,1);
  assert.equal(context.window.__pongDomSwapPrepare(),false);
  assert.equal(context.window.__pongDomSwapAttach(),false);
  assert.equal(prepares+attaches,0);
  assert.equal(context.window.__pongProducerTikTokGuard.inspect().nativeAttachBlocked,1);
  context.window.__pongProducerTikTokGuard.restore();
  assert.equal(context.window.__pongDomSwapPrepare,prepare);
  assert.equal(context.window.__pongDomSwapAttach,attach);
});

test('headless attribution fails closed without producer or with any decoder evidence', () => {
  const proof={probe:{sameVideo:true,original:{frameCallbacks:150,mediaProgress:5},
    swapSeenFrames:0,swapDomInsertions:0,overlay:{active:false,warm:false}},
    guard:{pongInstalled:true,pongStillInstalled:true,invalidCalls:0,
      tiktokInstalled:true,tiktokStillInstalled:true,tiktokActive:false,tiktokWarm:false,
      overlayCount:0,suppressedReadyCalls:5,nativePrepareBlocked:0,nativeAttachBlocked:0},
    producer:{id:'session',transformedFrames:50,bytesWritten:10000,completeFragments:4}};
  assert.equal(attributableHeadless(proof),true);
  assert.equal(attributableHeadless({...proof,producer:null}),false);
  assert.equal(attributableHeadless({...proof,probe:{...proof.probe,swapDomInsertions:1}}),false);
  assert.equal(attributableHeadless({...proof,guard:{...proof.guard,pongStillInstalled:false}}),false);
  assert.equal(attributableHeadless({...proof,probe:{...proof.probe,original:{frameCallbacks:0,mediaProgress:0}}}),false);
});

test('full-swap attribution requires actual transformed renderer frames and decoded overlay', () => {
  const proof={probe:{sameVideo:true,swapSeenFrames:60,overlay:{maxDecoded:50}},
    producer:{id:'session',transformedFrames:40,bytesWritten:10000,completeFragments:4}};
  assert.equal(attributableFullSwap(proof),true);
  assert.equal(attributableFullSwap({...proof,producer:{...proof.producer,transformedFrames:0}}),false);
  assert.equal(attributableFullSwap({...proof,probe:{...proof.probe,overlay:{maxDecoded:0}}}),false);
  assert.equal(attributableFullSwap({...proof,probe:{...proof.probe,sameVideo:false}}),false);
});

test('probe reports fragment batching and packet counts from the active swap transport', () => {
  const video={isConnected:true,readyState:3,paused:false,duration:10,currentTime:1,
    requestVideoFrameCallback:()=>1,cancelVideoFrameCallback(){},
    getVideoPlaybackQuality:()=>({totalVideoFrames:1,droppedVideoFrames:0})};
  const page='https://www.tiktok.com/@example/video/1234567890123456789';
  const window={__pongTikTokObservedVideo:{video,pageUrl:page},
    __pongDomSwap:{visible:true,overlay:{readyState:3,
      getVideoPlaybackQuality:()=>({totalVideoFrames:4})},
      transport:{bytes:4000,chunks:8,appendCalls:5,fragmentBatch:true,packets:3}}};
  const context={window,document:{querySelector:()=>null,documentElement:{}},
    location:{hostname:'www.tiktok.com'},performance:{now:()=>10},
    requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},
    setTimeout:()=>1,clearTimeout:()=>{},
    PerformanceObserver:class{observe(){}disconnect(){}},
    MutationObserver:class{observe(){}disconnect(){}}};
  vm.runInNewContext(installProbe,context);
  window.__pongProducerJankProbe.begin('full-swap',6000);
  const row=window.__pongProducerJankProbe.finish();
  assert.equal(row.overlay.transport.fragmentBatch,true);
  assert.equal(row.overlay.transport.packets,3);
  assert.equal(row.overlay.maxDecoded,4);
  window.__pongProducerJankProbe.restore();
});

test('optional paired playhead seeks and confirms first presented source frame before restoring', async () => {
  const listeners=new Map();let currentTime=2.3,callbackId=0;
  const video={isConnected:true,readyState:3,paused:false,duration:10,seeking:false,
    get currentTime(){return currentTime},set currentTime(value){currentTime=value;this.seeking=true;
      queueMicrotask(()=>{this.seeking=false;for(const fn of listeners.get('seeked')||[])fn()});},
    pause(){this.paused=true},async play(){this.paused=false},
    addEventListener(name,fn){const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set)},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn)},
    requestVideoFrameCallback(fn){queueMicrotask(()=>fn(0,{mediaTime:currentTime}));return ++callbackId},
    cancelVideoFrameCallback(){},getVideoPlaybackQuality:()=>({totalVideoFrames:10,droppedVideoFrames:0})};
  const page='https://www.tiktok.com/@example/video/1234567890123456789';
  const window={__pongTikTokObservedVideo:{video,pageUrl:page}};
  const context={window,document:{querySelector:()=>null,documentElement:{}},
    location:{hostname:'www.tiktok.com'},performance:{now:()=>10},
    requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},
    setTimeout,clearTimeout,queueMicrotask,
    PerformanceObserver:class{observe(){}disconnect(){}},
    MutationObserver:class{observe(){}disconnect(){}}};
  vm.runInNewContext(installProbe,context);
  const start=await window.__pongProducerJankProbe.preparePlayhead(0);
  assert.equal(start.requestedSeconds,0);
  assert.equal(start.actualStartSeconds,0);
  assert.equal(start.firstPresentedMediaTime,0);
  assert.equal(video.paused,false);
  await assert.rejects(()=>window.__pongProducerJankProbe.preparePlayhead(6),
    /cannot support paired six-second window/);
  video.duration=15;
  const later=await window.__pongProducerJankProbe.preparePlayhead(6);
  assert.equal(later.requestedSeconds,6);
  assert.equal(later.actualStartSeconds,6);
  assert.equal(later.firstPresentedMediaTime,6);
  const restored=await window.__pongProducerJankProbe.restorePlayhead();
  assert.equal(restored.restored,true);
  assert.equal(restored.currentTime,2.3);
  assert.equal(video.paused,false);
  window.__pongProducerJankProbe.restore();
});

test('renderer output exposes only numeric work evidence, never source URLs or errors', () => {
  const compact=compactRenderer({id:'session',state:'streaming',frames:120,transformedFrames:80,
    bytesWritten:123456,completeFragments:20,muxedMediaSeconds:0.7,sourceOpenedAt:1,
    firstByteAt:2,sourceUrl:'sensitive',error:'sensitive'},'session');
  assert.equal(compact.transformedFrames,80);
  assert.equal(JSON.stringify(compact).includes('sensitive'),false);
  assert.equal(compactRenderer({id:'other'},'session'),null);
});
