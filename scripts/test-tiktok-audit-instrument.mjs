import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('scripts/tiktok-audit-instrument.js','utf8');
test('republished production sync does not freeze diagnostic alignment or get called by snapshot',()=>{
 let now=1000,oldCalls=0,newCalls=0;
 const rect=()=>({left:0,top:0,right:400,bottom:800});
 const original={isConnected:true,paused:false,currentTime:.2,readyState:4,
  getBoundingClientRect:rect,addEventListener(){},removeEventListener(){}};
 const overlay={isConnected:true,paused:false,currentTime:.1,readyState:4,seeking:false,
  buffered:{length:1,end:()=>.5},getBoundingClientRect:rect,
  addEventListener(){},removeEventListener(){}};
 const swap={original,overlay,start:0,sessionId:'session',createdAt:900,visible:false};
 const firstSync=()=>{oldCalls++;return {active:true,sessionId:'session',target:.2,bufferEnd:.5}};
 firstSync.pongFrameSync=1;firstSync.pongStableHandoff=2;
 const window={__pongDomSwap:swap,__pongDomSwapSync:firstSync,
  __pongTikTokObservedVideo:{video:original,pageUrl:'https://www.tiktok.com/@fixture/video/222'}};
 const context={window,WeakMap,Map,performance:{now:()=>now},innerWidth:400,innerHeight:800,
  requestAnimationFrame(){},location:{pathname:'/foryou'},
  document:{querySelector:()=>null,querySelectorAll:s=>s.startsWith('video')?[original]:[]}};
 vm.runInNewContext(code,context);
 window.__pongDomSwapSync();
 assert.equal(window.__pongAuditSnapshot().sync.target,.2);
 const republished=()=>{newCalls++;return {active:true}};
 republished.pongFrameSync=1;republished.pongStableHandoff=2;
 window.__pongDomSwapSync=republished;
 original.currentTime=1.5;overlay.currentTime=.4;overlay.buffered.end=()=>1.2;now=2000;
 const snapshot=window.__pongAuditSnapshot();
 assert.equal(snapshot.syncObservation.stillInstalled,false);
 assert.equal(snapshot.syncObservation.currentStableHandoff,2);
 assert.equal(snapshot.syncObservation.productionSyncKnown,true);
 assert.equal(snapshot.sync.sampledFrom,'dom-read');
 assert.equal(snapshot.sync.target,1.5);
 assert.equal(snapshot.sync.bufferHeadroom,-.30000000000000004);
 assert.equal(oldCalls,1);assert.equal(newCalls,0);
 window.__pongAuditStop();
 assert.equal(window.__pongDomSwapSync,republished);
});
test('visible login modal stops scoring while a hidden modal or ordinary login button does not',()=>{
 const modal={innerText:'Log in to TikTok\nUse QR code\nUse phone or email',
  getBoundingClientRect:()=>({width:300,height:600,top:50,bottom:650})};
 let nodes=[modal],style={display:'block',visibility:'visible'};
 const window={},context={window,WeakMap,Map,performance:{now:()=>0},innerWidth:400,innerHeight:800,
  requestAnimationFrame(){},location:{pathname:'/foryou'},getComputedStyle:()=>style,
  document:{querySelector:()=>null,querySelectorAll:s=>s.startsWith('[role="dialog"]')?nodes:[]}};
 vm.runInNewContext(code,context);
 assert.equal(window.__pongAuditSnapshot().loginBlocked,true);
 style={display:'none',visibility:'visible'};
 assert.equal(window.__pongAuditSnapshot().loginBlocked,false);
 style={display:'block',visibility:'visible'};modal.innerText='Log in';
 assert.equal(window.__pongAuditSnapshot().loginBlocked,false);
 nodes=[];assert.equal(window.__pongAuditSnapshot().loginBlocked,false);
});
test('the observer releases retired media and removes remaining callbacks on stop',()=>{
 let serial=0;const pending=new Map(),removed=[];
 const video=()=>({isConnected:true,paused:false,currentTime:0,readyState:4,
  getBoundingClientRect:()=>({left:0,top:0,right:400,bottom:800}),
  requestVideoFrameCallback:fn=>{const id=++serial;pending.set(id,fn);return id},
  cancelVideoFrameCallback:id=>pending.delete(id),
  addEventListener(){},removeEventListener:type=>removed.push(type)});
 const old=video(),next=video();let connected=[old];
 const window={},context={window,WeakMap,Map,performance:{now:()=>0},innerWidth:400,innerHeight:800,
  requestAnimationFrame(){},location:{pathname:'/foryou'},
  document:{querySelector:()=>null,querySelectorAll:s=>s.startsWith('video')?connected:[]}};
 vm.runInNewContext(code,context);assert.equal(pending.size,1);
 old.isConnected=false;connected=[next];window.__pongAuditSnapshot();
 assert.equal(pending.size,1);assert.equal(removed.length,8);
 assert.deepEqual([...new Set(removed)].sort(),['ended','error','pause','playing','seeked','seeking','stalled','waiting']);
 window.__pongAuditStop();assert.equal(pending.size,0);assert.equal(removed.length,16);
});
test('new original and swapped media are watched before the next diagnostic poll',()=>{
 let mutation,callback,disconnected=false;
 const video={nodeType:1,tagName:'VIDEO',isConnected:true,paused:false,
  requestVideoFrameCallback:f=>{callback=f;return 1},cancelVideoFrameCallback(){},addEventListener(){},removeEventListener(){},querySelectorAll:()=>[]};
 const window={__pongTikTokObservedVideo:{video,pageUrl:'https://www.tiktok.com/@fixture/video/222'}};
 const context={window,WeakMap,Map,performance:{now:()=>0},innerWidth:400,innerHeight:800,
  requestAnimationFrame(){},location:{pathname:'/foryou'},
  document:{documentElement:{},querySelector:()=>null,querySelectorAll:()=>[]},
  MutationObserver:class{constructor(f){mutation=f}observe(){}disconnect(){disconnected=true}}};
 vm.runInNewContext(code,context);
 mutation([{addedNodes:[{nodeType:3},video]}]);assert.equal(typeof callback,'function');
 callback(250,{mediaTime:.1});
 const result=window.__pongAuditSnapshot();assert.equal(result.originalPaintEvents[0].at,250);
 assert.equal(result.originalPaintEvents[0].videoId,'222');
 window.__pongAuditStop();assert.equal(disconnected,true);
});
test('active observed video outranks a lingering photo; stale observer cannot claim a video',()=>{
 const rect=(w,h)=>({left:0,top:0,right:w,bottom:h});
 const video=()=>({isConnected:true,paused:false,currentTime:0,readyState:4,
  getBoundingClientRect:()=>rect(400,800),requestVideoFrameCallback:()=>1,
  cancelVideoFrameCallback(){},addEventListener(){},removeEventListener(){}});
 const photoCard={isConnected:true};
 const old=video(),current=video(),photo={src:'https://fixture.invalid/photo.jpg',
  getBoundingClientRect:()=>rect(400,800),closest:()=>photoCard};
 let videos=[current];
 const window={__pongTikTokObservedVideo:{video:current,pageUrl:'https://www.tiktok.com/@fixture/video/222'}};
 const context={window,WeakMap,Map,performance:{now:()=>0},innerWidth:400,innerHeight:800,
  requestAnimationFrame(){},location:{pathname:'/foryou'},
  document:{querySelector:()=>null,querySelectorAll:s=>s.startsWith('video')?videos:
    s.startsWith('img')?[photo]:[]}};
 vm.runInNewContext(code,context);
 assert.equal(window.__pongAuditSnapshot().postKind,'video');
 assert.equal(window.__pongAuditCurrentPostKey(),'video:222');
 window.__pongTikTokPostEvidence={kind:'ad',adId:'1234567890123456789'};
 assert.equal(window.__pongAuditSnapshot().postKind,'video');
 delete window.__pongTikTokPostEvidence;
 window.__pongTikTokObservedVideo={video:old,pageUrl:'https://www.tiktok.com/@fixture/video/111'};
 assert.equal(window.__pongAuditSnapshot().postKind,'unknown');
 assert.equal(window.__pongAuditCurrentPostKey(),'');
 videos=[];
 assert.equal(window.__pongAuditSnapshot().postKind,'unknown');
 window.__pongTikTokPostEvidence={kind:'photo',photoId:'1234567890123456789',photoCard,photoMedia:photo};
 assert.equal(window.__pongAuditSnapshot().postKind,'photo');
 assert.equal(window.__pongAuditCurrentPostKey(),'photo:1234567890123456789');
 window.__pongTikTokPostEvidence={kind:'ad',adId:'1234567890123456789'};
 assert.equal(window.__pongAuditSnapshot().postKind,'ad');
 window.__pongAuditStop();assert.equal(window.__pongAuditCurrentPostKey,undefined);
});

test('photo carousel URLs never define navigation; bound post IDs do',()=>{
 const rect=()=>({left:0,top:0,right:400,bottom:800});
 const card={isConnected:true},otherCard={isConnected:true};
 const photo={isConnected:true,currentSrc:'https://fixture.invalid/slide-1.jpg',
  getBoundingClientRect:rect,closest:()=>card};
 let visible=photo;
 const evidence={kind:'photo',photoId:'1234567890123456789',photoCard:card,photoMedia:photo};
 const window={__pongTikTokPostEvidence:evidence};
 const context={window,WeakMap,Map,performance:{now:()=>0},innerWidth:400,innerHeight:800,
  requestAnimationFrame(){},location:{pathname:'/foryou'},
  document:{querySelector:()=>null,querySelectorAll:s=>s.startsWith('img')?[visible]:[]}};
 vm.runInNewContext(code,context);
 assert.equal(window.__pongAuditCurrentPostKey(),'photo:1234567890123456789');
 photo.currentSrc='https://fixture.invalid/slide-2.jpg';
 assert.equal(window.__pongAuditCurrentPostKey(),'photo:1234567890123456789');
 // A new post reusing the DOM nodes gets its new React post ID on rescan.
 evidence.photoId='9876543210987654321';
 assert.equal(window.__pongAuditCurrentPostKey(),'photo:9876543210987654321');
 // Before that rescan, a newly mounted image cannot inherit stale evidence.
 visible={...photo,currentSrc:'https://fixture.invalid/new-post.jpg'};
 assert.equal(window.__pongAuditSnapshot().postKind,'unknown');
 assert.equal(window.__pongAuditCurrentPostKey(),'');
 // Nor can an image from another vertical card inherit the old card's ID.
 evidence.photoMedia=visible;
 visible.closest=()=>otherCard;
 assert.equal(window.__pongAuditCurrentPostKey(),'');
 window.__pongAuditStop();
});

test('original buffering is hidden while owned swapped pixels are presented',()=>{
 const events=new Map();let now=0;
 const original={isConnected:true,paused:false,currentTime:1,readyState:4,
  getBoundingClientRect:()=>({left:0,top:0,right:400,bottom:800}),
  addEventListener:(type,fn)=>events.set(type,fn),removeEventListener(){}};
 const overlay={...original,addEventListener(){},buffered:{length:0}};
 const swap={visible:true,original,overlay,start:0,createdAt:0,sessionId:'session'};
 const window={__pongDomSwap:swap,__pongDomSwapSync:()=>({active:true}),
  __pongTikTokObservedVideo:{video:original,pageUrl:'https://www.tiktok.com/@fixture/video/222'}};
 const context={window,WeakMap,Map,performance:{now:()=>now},innerWidth:400,innerHeight:800,
  requestAnimationFrame(){},location:{pathname:'/foryou'},
  document:{querySelector:()=>null,querySelectorAll:s=>s.startsWith('video')?[original]:[]}};
 vm.runInNewContext(code,context);
 events.get('waiting')({type:'waiting'});
 let snapshot=window.__pongAuditSnapshot();
 assert.equal(snapshot.mediaEvents.find(e=>e.type==='waiting').visible,false);
 swap.visible=false;now=100;window.__pongDomSwapSync();
 snapshot=window.__pongAuditSnapshot();
 assert.equal(snapshot.mediaEvents.find(e=>e.type==='visibility'&&e.role==='original').visible,true);
 window.__pongAuditStop();
});
