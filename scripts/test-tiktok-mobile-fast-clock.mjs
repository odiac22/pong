import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const code=readFileSync(new URL('../android-app/app/src/main/assets/tiktok-mobile.js',import.meta.url),'utf8');
const idA='1234567890123456789',idB='1234567890123456790',idC='1234567890123456791';
const url=id=>`https://www.tiktok.com/@fixture/video/${id}`;
const rect=()=>({left:0,top:0,right:400,bottom:800,width:400,height:800});

function fixture(trial=false,{kind='video',cinema=false,stable=false}={}){
  let now=0,mediaKind=kind,source='https://cdn.test/a.mp4',photoLeft=0;
  const reports=[],timers=[],intervals=[],events=new Map(),counts={articleQueries:0,videoQueries:0,photoQueries:0},
    item=(id,type=mediaKind)=>({id,author:{uniqueId:'fixture'},...(type==='photo'?{imagePost:{images:[{}]}}:{})});
  const card={isConnected:true,__reactProps$test:{item:item(idA)},getBoundingClientRect:rect,
    closest:()=>null,querySelector:s=>s.includes('ad-tag')&&mediaKind==='ad'?{}:null};
  const next={isConnected:true,__reactProps$test:{item:item(idB,'video')},getBoundingClientRect:rect,
    closest:()=>null,querySelector:()=>null};
  const video={isConnected:true,tagName:'VIDEO',classList:{contains:()=>false},currentTime:0,
    currentSrc:source,src:source,poster:'',duration:20,paused:false,playbackRate:1,
    getBoundingClientRect:rect,closest:s=>s.includes('recommend-list-item-container')?card:null,
    querySelector:()=>null};
  const photo={isConnected:true,src:'https://cdn.test/slide-a.jpg',currentSrc:'https://cdn.test/slide-a.jpg',srcset:'',
    getBoundingClientRect:()=>({...rect(),left:photoLeft,right:400+photoLeft}),
    closest:s=>s.includes('recommend-list-item-container')?card:null};
  let mutation;
  const context={URL,innerWidth:400,innerHeight:800,location:{href:url(idA)},
    performance:{now:()=>now},getComputedStyle:()=>({display:'block'}),
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},
    setInterval:fn=>{intervals.push(fn);return intervals.length;},
    addEventListener:(name,fn)=>events.set(name,fn),
    MutationObserver:class{constructor(fn){mutation=fn;}observe(){}},
    document:{hidden:false,documentElement:{},
      addEventListener:(name,fn)=>events.set(name,fn),
      querySelector:s=>s.includes('cinema-mode-exit')&&cinema?{}:null,
      querySelectorAll:s=>{
        if(s.startsWith('video')){counts.videoQueries++;return mediaKind==='photo'?[]:[video];}
        if(s.includes('recommend-list-item-container')){counts.articleQueries++;return [card,next];}
        if(s.startsWith('img')){counts.photoQueries++;return mediaKind==='photo'?[photo]:[];}
        return [];
      }},
    window:{__pongMobileFastClockTrial:trial,__pongMobileStableFeedTrial:stable,
      PongTikTokFeed:{report:r=>reports.push(JSON.parse(r))}}};
  vm.runInNewContext(code,context);
  const flush=()=>{while(timers.length)timers.shift()();};
  const tick=(ms=500)=>{now+=ms;intervals[0]();flush();};
  flush();
  return {reports,counts,context,video,photo,card,next,tick,flush,
    mutate:()=>{mutation([]);flush();},event:(name,target=video)=>{events.get(name)?.({target});flush();},
    setKind:value=>{mediaKind=value;},setSource:value=>{source=value;video.currentSrc=value;video.src=value;},
    setPhotoSource:value=>{photo.currentSrc=value;photo.src=value;},
    movePhoto:left=>{photoLeft=left;},
    replaceCurrent:id=>{card.__reactProps$test={item:item(id)};},
    markCurrent:key=>{card.__reactProps$test={item:{...item(idA),[key]:key==='isAd'?true:{images:[{}]}}};},
    replaceNext:id=>{next.__reactProps$test={item:item(id,'video')};}};
}

test('stable-feed opt-in reduces photo scans while preserving the exact payload',()=>{
  const fast=fixture(false,{kind:'photo',stable:true}),normal=fixture(false,{kind:'photo'});
  const before={...fast.counts};
  fast.tick();normal.tick();
  assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
  assert.equal(fast.counts.photoQueries,before.photoQueries);
  assert.equal(fast.counts.articleQueries,before.articleQueries);
  assert.equal(fast.context.window.__pongTikTokObserverStats.fastPhoto,1);
  fast.tick();normal.tick();
  assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
  assert.equal(fast.context.window.__pongTikTokObserverStats.fullScans,2);
  assert.ok(fast.counts.photoQueries<normal.counts.photoQueries);
});

test('ten seconds of steady photo feed halves full queries with a one-second bound',()=>{
  const fast=fixture(false,{kind:'photo',stable:true}),normal=fixture(false,{kind:'photo'});
  for(let i=0;i<20;i++){fast.tick();normal.tick();}
  assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
  assert.equal(fast.context.window.__pongTikTokObserverStats.fullScans,11);
  assert.equal(fast.context.window.__pongTikTokObserverStats.fastPhoto,10);
  assert.equal(normal.context.window.__pongTikTokObserverStats.fullScans,21);
  assert.equal(fast.counts.photoQueries,11);
  assert.equal(normal.counts.photoQueries,21);
});

test('photo cache invalidates on carousel source, React identity, forward identity, route and video entry',()=>{
  for(const change of [
    x=>x.setPhotoSource('https://cdn.test/slide-b.jpg'),
    x=>x.movePhoto(40),
    x=>x.replaceCurrent(idC),
    x=>x.replaceNext(idC),
    x=>{x.context.location.href=url(idB);},
    x=>x.setKind('video'),
    x=>{x.photo.isConnected=false;},
  ]){
    const fast=fixture(false,{kind:'photo',stable:true}),normal=fixture(false,{kind:'photo'});
    change(fast);change(normal);fast.tick();normal.tick();
    assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
    assert.equal(fast.context.window.__pongTikTokObserverStats.fastPhoto||0,0);
  }
});

test('photo carousel mutation, swipe, foreground and ad transition force full scan',()=>{
  for(const change of [
    x=>x.mutate(),x=>x.event('scroll'),x=>x.event('popstate'),
    x=>{x.context.document.hidden=true;x.event('visibilitychange');x.context.document.hidden=false;x.event('visibilitychange');},
    x=>{x.markCurrent('isAd');x.tick();},
  ]){
    const x=fixture(false,{kind:'photo',stable:true}),before=x.counts.photoQueries;
    change(x);
    assert.ok(x.counts.photoQueries>before);
    assert.equal(x.context.window.__pongTikTokObserverStats.fastPhoto||0,0);
  }
});

test('trial defaults off and timed ticks retain the full observer path',()=>{
  const x=fixture();x.video.currentTime=.5;x.tick();
  assert.equal(x.context.window.__pongTikTokObserverStats.fullScans,2);
  assert.equal(x.context.window.__pongTikTokObserverStats.fastClock,0);
  assert.equal(x.reports.at(-1).currentTime,.5);
});

test('stable video clock matches full payload with fewer card queries, then bounded fallback',()=>{
  const fast=fixture(true),normal=fixture(false);
  for(const x of [fast,normal])x.video.currentTime=.5;
  const before=fast.counts.articleQueries;
  fast.tick();normal.tick();
  assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
  assert.equal(fast.counts.articleQueries,before);
  assert.equal(fast.context.window.__pongTikTokObserverStats.fastClock,1);
  for(let i=0;i<3;i++){fast.video.currentTime+=.5;fast.tick();}
  assert.ok(fast.context.window.__pongTikTokObserverStats.fullScans>=2);
  assert.ok(fast.context.window.__pongTikTokObserverStats.fastClock>=2);
});

test('ten seconds of steady playback reduces full scans but never skips the 1.5s fallback',()=>{
  const fast=fixture(true),normal=fixture(false);
  for(let i=0;i<20;i++){fast.video.currentTime+=.5;normal.video.currentTime+=.5;fast.tick();normal.tick();}
  assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
  const counts=fast.context.window.__pongTikTokObserverStats;
  assert.equal(counts.fullScans+counts.fastClock,21);
  assert.ok(counts.fullScans>=7 && counts.fullScans<normal.context.window.__pongTikTokObserverStats.fullScans);
  assert.equal(fast.counts.articleQueries,counts.fullScans);
  assert.equal(normal.counts.articleQueries,21);
});

test('reused player source and React current/next identities force full rescan',()=>{
  for(const change of [x=>x.setSource('https://cdn.test/b.mp4'),
    x=>x.replaceCurrent(idC),x=>x.replaceNext(idC)]){
    const fast=fixture(true),normal=fixture(false);change(fast);change(normal);
    fast.tick();normal.tick();
    assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
    assert.equal(fast.context.window.__pongTikTokObserverStats.fastClock,0);
  }
});

test('same-ID silent React ad/photo transition cannot reuse a video clock snapshot',()=>{
  for(const key of ['isAd','imagePost']){
    const fast=fixture(true),normal=fixture(false);
    fast.markCurrent(key);normal.markCurrent(key);
    fast.tick();normal.tick();
    assert.deepEqual(fast.reports.at(-1),normal.reports.at(-1));
    assert.equal(fast.context.window.__pongTikTokObserverStats.fastClock,0);
    assert.equal(fast.context.window.__pongTikTokObserverStats.fullScans,2);
  }
});

test('disconnected active card forces full rescan',()=>{
  const x=fixture(true);x.card.isConnected=false;x.tick();
  assert.equal(x.context.window.__pongTikTokObserverStats.fastClock,0);
  assert.equal(x.context.window.__pongTikTokObserverStats.fullScans,2);
});

test('photo, ad and cinema never reuse cached video identity',()=>{
  for(const options of [{kind:'photo'},{kind:'ad'},{kind:'video',cinema:true}]){
    const x=fixture(true,options);x.tick();
    assert.equal(x.context.window.__pongTikTokObserverStats.fastClock,0);
    assert.equal(x.context.window.__pongTikTokObserverStats.fullScans,2);
  }
});

test('paused video and media-hint opt-in use full scans',()=>{
  const paused=fixture(true);paused.video.paused=true;paused.tick();
  assert.equal(paused.context.window.__pongTikTokObserverStats.fastClock,0);
  const hinted=fixture(true);hinted.context.window.__pongMediaHintTrial=true;hinted.tick();
  assert.equal(hinted.context.window.__pongTikTokObserverStats.fastClock,0);
});

test('mutation, scroll and playing events always force a full identity scan',()=>{
  for(const cause of [x=>x.mutate(),x=>x.event('scroll'),x=>x.event('playing')]){
    const x=fixture(true),before=x.counts.articleQueries;cause(x);
    assert.ok(x.counts.articleQueries>before);
    assert.equal(x.context.window.__pongTikTokObserverStats.fastClock,0);
  }
});
