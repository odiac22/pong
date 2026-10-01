import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const code=html.slice(html.indexOf('window.PongTikTokLiveFeed ='),html.indexOf('window.PongTikTokLiveSwapCurrent ='));
const one='https://www.tiktok.com/@fixture/video/1234567890123456789';
const two='https://www.tiktok.com/@fixture/video/1234567890123456790';
const observer=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
const canonical=observer.slice(observer.indexOf('  const canonical ='),observer.indexOf('  const area ='));
const profilePolicy=observer.slice(observer.indexOf('  const profileForwardVideos ='),observer.indexOf('  const navigationBounds ='));
function profileForward(route,posts,current='',photo=true){
 const fn=vm.runInNewContext(`(()=>{${canonical}${profilePolicy}return profileForwardVideos})()`,{
  URL,location:{href:route},document:{querySelectorAll:()=>posts.map(href=>({href}))}});
 return Array.from(fn(current,photo));
}
test('creator cinema photo keeps the next video prepared across consecutive photos',()=>{
 const photo='https://www.tiktok.com/@fixture/photo/1234567890123456700';
 const later='https://www.tiktok.com/@fixture/photo/1234567890123456701';
 assert.deepEqual(profileForward(photo,[one,photo,photo,later,two]),[two]);
 assert.deepEqual(profileForward(later,[one,photo,later,two]),[two]);
});
test('route-ahead cinema video keeps the observed decoder playlist position',()=>{
 assert.deepEqual(profileForward(two,[one,two],one,false),[two]);
 assert.deepEqual(profileForward(two,[one,two],'',true),[]);
});
test('unknown or foreign photo routes cannot seed a creator queue',()=>{
 const photo='https://www.tiktok.com/@fixture/photo/1234567890123456700';
 assert.deepEqual(profileForward(photo,[one,two]),[]);
 assert.deepEqual(profileForward('https://bad.test/@fixture/photo/1234567890123456700',[photo,two]),[]);
 assert.deepEqual(profileForward(photo,[photo,two],'',false),[]);
});
function fixture(source='tiktok-live'){
 const warmed=[],state={activeVideo:true,current:'outgoing',timelineSeconds:3},wrapper={dataset:{pongTikTokPresentedSession:'old'},querySelector:()=>null};
 let scheduled=0,deck=0;
 const context={window:{},pongTikTokLiveState:state,videoMetadata:[{source}],pongFaceSwapCurrentWrapper:()=>wrapper,
  document:{getElementById:()=>null},updatePongFaceSwapButton(){},
  pongCanonicalTikTokVideoPage:x=>/^https:\/\/www\.tiktok\.com\/@fixture\/video\/\d+$/.test(x)?x:'',
  syncPongTikTokRollingDeck(){deck++},schedulePongFaceSwapPrefetch(){scheduled++},
  random40WarmServerVideoCache:(urls,options)=>warmed.push({urls,options})};
 vm.runInNewContext(code,context);
 return {send:context.window.PongTikTokLiveFeed,state,wrapper,warmed,scheduled:()=>scheduled,deck:()=>deck};
}
test('photo prepares following video URLs without selecting or presenting a hidden video',()=>{
 const f=fixture();f.send({activeVideo:false,urls:[one,two,one,'https://bad.test/video/123']});
 assert.equal(f.state.activeVideo,false);assert.equal(f.state.current,'outgoing');
 assert.equal(f.wrapper.dataset.pongTikTokPresentedSession,undefined);
 assert.deepEqual(Array.from(f.state.urls),[one,two]);assert.equal(f.state.next,one);
 assert.equal(f.warmed.length,1);assert.equal(f.warmed[0].options.activeUrl,'');
 assert.equal(f.warmed[0].options.foregroundStalled,false);assert.equal(f.scheduled(),1);
 f.send({activeVideo:false,urls:[one,two]});assert.equal(f.warmed.length,1);assert.equal(f.scheduled(),1);
});
test('photo warming never schedules ordinary Recall wrappers or creates a fake current source',()=>{
 const f=fixture('recall');f.send({activeVideo:false,urls:[one]});
 assert.equal(f.deck(),0);assert.equal(f.scheduled(),0);assert.equal(f.warmed.length,1);
 assert.equal(f.state.current,'outgoing');
 f.send({activeVideo:false,urls:[]});assert.equal(f.state.urls.length,0);assert.equal(f.state.next,'');
});
test('native inactive report keeps the bounded validated queue without enabling swap',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const block=java.slice(java.indexOf('if (supplied.has("activeVideo")'),java.indexOf('LinkedHashSet<String> validated'));
 assert.match(block,/upcoming.size\(\)<8/);assert.match(block,/isTikTokPageUrl\(page\)/);
 assert.match(block,/nearbyTikTokUrls.addAll\(upcoming\)/);
 assert.doesNotMatch(block,/tiktokSwapEnabled = true|requestTikTokIntegratedSwap/);
 assert.match(block,/inactive.put\("postKind", "photo".equals\(inactiveKind\) \? "photo" : "ad".equals\(inactiveKind\) \? "ad" : "unknown"\)/);
});

test('unresolved visible video must not be treated as an idle photo',()=>{
 const rect=()=>({left:0,right:400,top:0,bottom:800});
 const video={paused:false,currentTime:0,playbackRate:1,closest:()=>null,querySelector:()=>null,
   getBoundingClientRect:rect,getAttribute:()=>null};
 const photo={getBoundingClientRect:rect,closest:()=>null};
 let scheduled,payload;
 const c={window:{PongTikTokFeed:{report:s=>payload=JSON.parse(s)}},
   document:{hidden:false,documentElement:{},querySelector:()=>null,addEventListener(){},
     querySelectorAll:s=>s.startsWith('video')?[video]:s.startsWith('img')?[photo]:[]},
   getComputedStyle:()=>({display:'block'}),performance:{now:()=>1000},
   location:{href:'https://www.tiktok.com/'},URL,innerWidth:400,innerHeight:800,
   setTimeout:f=>(scheduled=f,1),clearTimeout(){},setInterval(){},addEventListener(){},MutationObserver:class{observe(){}}};
 vm.runInNewContext(observer,c);scheduled();
 assert.equal(payload.activeVideo,false);assert.equal(payload.postKind,'unknown');
 assert.equal(payload.current,'');
});

test('real observer looks forward from the visible photo and excludes photo IDs',()=>{
 const observer=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 const photoItem=id=>({id,author:{uniqueId:'fixture'},imagePost:{images:[{}]}});
 const card=item=>({closest:()=>null,querySelector:()=>null,__reactProps$test:{item}});
 const cards=[card(photoItem('1234567890123456700')),card(photoItem('1234567890123456701')),
   card({id:'1234567890123456789',author:{uniqueId:'fixture'}})];
 const photo={getBoundingClientRect:()=>({left:0,right:400,top:0,bottom:800}),
   closest:s=>s.includes('DivCinema')?null:cards[0]};
 cards[0].getBoundingClientRect=photo.getBoundingClientRect;
 let scheduled,payload;
 const context={window:{PongTikTokFeed:{report:s=>payload=JSON.parse(s)}},
   document:{hidden:false,documentElement:{},querySelector:()=>null,addEventListener(){},
     querySelectorAll:s=>s.startsWith('video')?[]:s.startsWith('.swiper')?cards:s.startsWith('img')?[photo]:[]},
   performance:{now:()=>1000},location:{href:'https://www.tiktok.com/'},URL,innerWidth:400,innerHeight:800,
   setTimeout:f=>(scheduled=f,1),clearTimeout(){},setInterval(){},addEventListener(){},
   MutationObserver:class{observe(){}}};
 vm.runInNewContext(observer,context);scheduled();
 assert.equal(payload.activeVideo,false);assert.equal(payload.current,'');
 assert.equal(payload.postKind,'photo');
 assert.deepEqual(payload.urls,[one]);assert.equal(payload.next,one);
 assert.equal(context.window.__pongTikTokPostEvidence.photoId,'1234567890123456700');
 assert.equal(context.window.__pongTikTokPostEvidence.photoCard,cards[0]);
 assert.equal(context.window.__pongTikTokPostEvidence.photoMedia,photo);
 // Rotating the displayed image is not a new post; recycling the real item is.
 photo.src='https://fixture.invalid/next-slide.jpg';
 context.window.__pongTikTokScan();scheduled();
 assert.equal(context.window.__pongTikTokPostEvidence.photoId,'1234567890123456700');
 cards[0].__reactProps$test={item:photoItem('1234567890123456702')};
 context.window.__pongTikTokScan();scheduled();
 assert.equal(context.window.__pongTikTokPostEvidence.photoId,'1234567890123456702');
 cards[0].__reactProps$test={item:{id:'1234567890123456702',author:{uniqueId:'fixture'}}};
 context.window.__pongTikTokScan();scheduled();
 assert.equal(context.window.__pongTikTokPostEvidence.photoId,'');
 assert.equal(context.window.__pongTikTokPostEvidence.photoCard,null);
 assert.equal(context.window.__pongTikTokPostEvidence.photoMedia,null);
});

test('identity-verified photo with changed image class retains vertical swipe region',()=>{
 const item={id:'1234567890123456700',author:{uniqueId:'fixture'},imagePost:{images:[{}]}};
 const rect=()=>({left:0,right:400,top:0,bottom:800});
 const photo={getBoundingClientRect:rect,closest:s=>s.includes('Cinema')?null:card};
 const card={isConnected:true,__reactProps$test:{item},getBoundingClientRect:rect,
   querySelector:()=>null,querySelectorAll:s=>s==='img'?[photo]:[]};
 let scheduled,payload;
 const context={window:{PongTikTokFeed:{report:s=>payload=JSON.parse(s)}},
   document:{hidden:false,documentElement:{},querySelector:()=>null,addEventListener(){},
     querySelectorAll:s=>s==='[data-e2e="recommend-list-item-container"]'?[card]:[]},
   getComputedStyle:()=>({display:'block'}),performance:{now:()=>1000},
   location:{href:'https://www.tiktok.com/foryou'},URL,innerWidth:400,innerHeight:800,
   setTimeout:f=>(scheduled=f,1),clearTimeout(){},setInterval(){},addEventListener(){},
   MutationObserver:class{observe(){}}};
 vm.runInNewContext(observer,context);scheduled();
 assert.equal(payload.postKind,'photo');
 assert.equal(payload.activeVideo,false);
 assert.deepEqual(payload.swipeRegion,{x:0,y:0,right:1,bottom:1});
 assert.equal(context.window.__pongTikTokPostEvidence.photoCard,card);
});

test('an unknown large feed image cannot capture vertical swipes',()=>{
 const rect=()=>({left:0,right:400,top:0,bottom:800});
 const photo={getBoundingClientRect:rect};
 const card={getBoundingClientRect:rect,querySelector:()=>null,
   querySelectorAll:s=>s==='img'?[photo]:[]};
 let scheduled,payload;
 const context={window:{PongTikTokFeed:{report:s=>payload=JSON.parse(s)}},
   document:{hidden:false,documentElement:{},querySelector:()=>null,addEventListener(){},
     querySelectorAll:s=>s==='[data-e2e="recommend-list-item-container"]'?[card]:[]},
   performance:{now:()=>1000},location:{href:'https://www.tiktok.com/foryou'},URL,
   innerWidth:400,innerHeight:800,setTimeout:f=>(scheduled=f,1),clearTimeout(){},
   setInterval(){},addEventListener(){},MutationObserver:class{observe(){}}};
 vm.runInNewContext(observer,context);scheduled();
 assert.equal(payload.postKind,'unknown');
 assert.equal(payload.swipeRegion,null);
});

test('horizontal photo slides never consume vertical next-video preparation slots',()=>{
 const photoItem=id=>({id,author:{uniqueId:'fixture'},imagePost:{images:[{}]}});
 const card=item=>({closest:()=>null,querySelector:()=>null,__reactProps$test:{item}});
 const articles=[card(photoItem('1234567890123456700')),card(photoItem('1234567890123456701')),
   card({id:'1234567890123456789',author:{uniqueId:'fixture'}})];
 const innerSlides=Array.from({length:30},()=>card(photoItem('1234567890123456700')));
 const rect=()=>({left:0,right:400,top:0,bottom:800});
 const photo={getBoundingClientRect:rect,closest:s=>s.includes('DivCinema')?null:s==='[data-e2e="recommend-list-item-container"]'?articles[0]:innerSlides[0]};
 // The next video already has an offscreen decoder. It must not become the
 // queue's current position and skip itself while the photo is still active.
 const nextVideo={paused:true,getBoundingClientRect:()=>({left:0,right:400,top:800,bottom:1600}),closest:()=>articles[2]};
 articles[0].getBoundingClientRect=rect;innerSlides[0].getBoundingClientRect=()=>({left:100,right:200,top:0,bottom:800});
 let scheduled,payload;
 const c={window:{PongTikTokFeed:{report:s=>payload=JSON.parse(s)}},document:{hidden:false,documentElement:{},querySelector:()=>null,addEventListener(){},
   querySelectorAll:s=>s.startsWith('video')?[nextVideo]:s==='[data-e2e="recommend-list-item-container"]'?articles:s.startsWith('.swiper')?innerSlides:s.startsWith('img')?[photo]:[]},
   getComputedStyle:()=>({display:'block'}),
   performance:{now:()=>1000},location:{href:'https://www.tiktok.com/'},URL,innerWidth:400,innerHeight:800,
   setTimeout:f=>(scheduled=f,1),clearTimeout(){},setInterval(){},addEventListener(){},MutationObserver:class{observe(){}}};
 vm.runInNewContext(observer,c);scheduled();
 assert.deepEqual(payload.urls,[one]);assert.equal(payload.next,one);assert.equal(payload.current,'');
 assert.equal(payload.postKind,'photo');
 assert.equal(payload.swipeRegion.x,0);assert.equal(payload.swipeRegion.right,1);
});

test('sponsored original remains navigable but is never resolved as a public swap video',()=>{
 const ad={id:'1234567890123456700',author:{uniqueId:'fixture'},isAd:true};
 const card=item=>({closest:()=>null,querySelector:()=>null,__reactProps$test:{item}});
 const cards=[card(ad),card({...ad,id:'1234567890123456701'}),card({id:'1234567890123456789',author:{uniqueId:'fixture'}})];
 const rect=()=>({left:0,right:400,top:0,bottom:800});
 const video={paused:false,currentTime:2,playbackRate:1,getBoundingClientRect:rect,
   getAttribute:()=>null,closest:s=>s.includes('recommend-list')?cards[0]:null,querySelector:()=>null};
 cards[0].getBoundingClientRect=rect;
 let scheduled,payload;
 const c={window:{PongTikTokFeed:{report:s=>payload=JSON.parse(s)}},
   document:{hidden:false,documentElement:{},querySelector:()=>null,addEventListener(){},
     querySelectorAll:s=>s.startsWith('video')?[video]:s.startsWith('[data-e2e="recommend')?cards:[]},
   getComputedStyle:()=>({display:'block'}),performance:{now:()=>1000},
   location:{href:'https://www.tiktok.com/'},URL,innerWidth:400,innerHeight:800,
   setTimeout:f=>(scheduled=f,1),clearTimeout(){},setInterval(){},addEventListener(){},MutationObserver:class{observe(){}}};
 vm.runInNewContext(observer,c);scheduled();
 assert.equal(payload.postKind,'ad');assert.equal(payload.activeVideo,false);assert.equal(payload.current,'');
 assert.deepEqual(payload.urls,[one]);assert.equal(payload.next,one);
 assert.equal(payload.swipeRegion.right,1);assert.equal(video.currentTime,2);assert.equal(video.paused,false);
 assert.equal(c.window.__pongTikTokPostEvidence.adId,ad.id);
 // Same component recycled as an ordinary post must become eligible again.
 ad.isAd=false;c.window.__pongTikTokScan();scheduled();
 assert.equal(payload.postKind,'video');assert.ok(payload.current.endsWith(ad.id));
});
