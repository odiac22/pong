import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const asset=readFileSync('android-app/app/src/main/assets/tiktok-phone-fit.js','utf8');
const html=readFileSync('index.html','utf8');
test('native feed forwards sanitized timeline fields alongside validated URLs',()=>{
 const native=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const handoff=native.slice(native.indexOf('JSONObject safe = new JSONObject();',native.indexOf('class TikTokFeedBridge')),native.indexOf('forwardTikTokFeedToPong(safe)',native.indexOf('class TikTokFeedBridge')));
 for(const [field,value] of [['currentTime','suppliedTime'],['duration','suppliedDuration'],['paused','suppliedPaused'],['playbackRate','suppliedRate']])assert.ok(handoff.includes(`safe.put("${field}", ${value});`),field);
 for(const value of ['rawTime','rawDuration','rawRate'])assert.ok(handoff.includes(`Double.isFinite(${value})`));
});
test('authorized GPEN512 is TikTok-only and forwarded by all three session creation paths',()=>{
 const context={document:{documentElement:{classList:{contains:()=>false}}}};
 vm.runInNewContext(html.slice(html.indexOf('function pongFaceSwapRestorationProfile('),html.indexOf('function pongFaceSwapSourceKey(')),context);
 assert.equal(context.pongFaceSwapRestorationProfile(),'default');
 context.document.documentElement.classList.contains=()=>true;
 assert.equal(context.pongFaceSwapRestorationProfile(),'tiktok-gpen512');
 assert.equal([...html.matchAll(/restorationProfile: pongFaceSwapRestorationProfile\(\)/g)].length,3);
 assert.match(html,/return `\$\{pongFaceSwapRestorationProfile\(\)\}\|/);
});
test('TikTok promotes an existing preparing session without requiring full prebuffer completion',()=>{
 const handoff=html.slice(html.indexOf('window.PongTikTokLiveSwapCurrent ='),html.indexOf('window.PongTikTokLiveIntegratedState ='));
 assert.match(handoff,/!!entry\?\.sessionId && !!entry\?\.streamUrl/);
 assert.doesNotMatch(handoff,/entry\?\.ready === true/);
 assert.match(handoff,/entry\?\.faceId === pongFaceSwapState.selectedFaceId/);
});
test('TikTok hides duplicate opaque media gates but does not hide its controls',()=>{
 const overlay=readFileSync('android-app/app/src/main/assets/tiktok-pong-overlay.js','utf8');
 assert.match(overlay,/html\.pong-tiktok-original-overlay \.pong-face-swap-transition-overlay/);
 assert.match(overlay,/html\.pong-tiktok-original-overlay \.video-ready-loader/);
 assert.doesNotMatch(overlay,/html\.pong-tiktok-original-overlay \.controls-overlay\s*\{\s*visibility:\s*hidden/);
});
test('TikTok playback detects missing sessions and checks ownership before recovery',()=>{
 const feed=html.slice(html.indexOf('window.PongTikTokLiveFeed ='),html.indexOf('window.PongTikTokLiveSwapCurrent ='));
 assert.match(feed,/response.status === 404 \|\| response.status === 410/);
 assert.match(feed,/pongFaceSwapGeneration !== reportGeneration/);
 assert.match(feed,/handlePongFaceSwapTerminalFailure\(wrapper, sessionId, reportGeneration/);
});
test('leaving video for a profile clears presentation and pauses credit without changing selected faces',()=>{
 const wrapper={dataset:{pongFaceSwapSessionId:'owned',pongExternalPlaybackAuthority:'true',pongTikTokPresentedSession:'owned'},pongTikTokFrameEvidence:{visible:true},querySelector:()=>({__pongSwapOriginal:{startSeconds:2}})};
 const posts=[],chip={hidden:false};
  const context={window:{},pongTikTokLiveState:{timelineSeconds:8},pongFaceSwapCurrentWrapper:()=>wrapper,
  pongCanonicalTikTokVideoPage:()=>'',
  pongTikTokPlaybackCreditPayload:(_wrapper,_session,positionSeconds,paused)=>JSON.stringify({positionSeconds,paused}),
  pongFaceSwapBackgroundFetch:(path,request)=>{posts.push(JSON.parse(request.body));return Promise.resolve({})},
  updatePongFaceSwapButton(){},document:{getElementById:()=>chip},encodeURIComponent};
 vm.runInNewContext(html.slice(html.indexOf('window.PongTikTokLiveFeed ='),html.indexOf('window.PongTikTokLiveSwapCurrent =')),context);
 assert.equal(context.window.PongTikTokLiveFeed({activeVideo:false}),true);
 assert.equal(wrapper.pongTikTokFrameEvidence,null);assert.equal(wrapper.dataset.pongTikTokPresentedSession,undefined);
 assert.equal(chip.hidden,true);assert.deepEqual(posts,[{positionSeconds:6,paused:true}]);
 context.window.PongTikTokLiveFeed({activeVideo:false});assert.equal(posts.length,1);
 assert.equal(wrapper.dataset.pongFaceSwapSessionId,'owned');
});
test('gesture advances from touch-down card, and successive gestures are not dropped',()=>{
  let current=0;
  const cards=Array.from({length:4},(_,i)=>({getBoundingClientRect:()=>({top:(i-current)*800}),scrollIntoView:()=>{current=i;}}));
  const context={window:{},document:{querySelectorAll:()=>cards,querySelector:()=>null},requestAnimationFrame:f=>f(),setTimeout:f=>f()};
  vm.runInNewContext(asset.slice(asset.indexOf('  const feedCards'),asset.indexOf('  window.__pongUndoPhoneFit',asset.indexOf('  const feedCards'))),context);
  context.window.__pongTikTokBeginGesture();
  current=1; // WebView partially moved before native gesture ownership.
  assert.equal(context.window.__pongTikTokStep(1),true);
  assert.equal(current,1); // Must not accidentally skip a second card.
  context.window.__pongTikTokBeginGesture();
  assert.equal(context.window.__pongTikTokStep(1),true);
  assert.equal(current,2);
});
test('site navigation wins over scroll-only fallback and disabled navigation is not success',()=>{
  let clicks=0;
  const nav={disabled:false,getAttribute:()=>null,click:()=>clicks++};
  const context={window:{},document:{querySelector:()=>nav,querySelectorAll:()=>{throw Error('Must not scroll when native navigation exists')}},requestAnimationFrame(){},setTimeout(){}};
  vm.runInNewContext(asset.slice(asset.indexOf('  const feedCards'),asset.indexOf('  window.__pongUndoPhoneFit',asset.indexOf('  const feedCards'))),context);
  assert.equal(context.window.__pongTikTokStep(1),true);assert.equal(clicks,1);
  nav.disabled=true;assert.equal(context.window.__pongTikTokStep(1),false);assert.equal(clicks,1);
});
test('For You photo vertical step selects next outer post, not its carousel control',()=>{
  let current=0,carouselClicks=0;
  const photo={isConnected:true};
  const cards=Array.from({length:3},(_,i)=>({isConnected:true,
    getBoundingClientRect:()=>({top:(i-current)*800}),
    contains:node=>i===0&&node===photo,
    querySelector:selector=>i===0&&selector.includes('ImgPhotoSlide')?photo:null,
    scrollIntoView:()=>{current=i;}}));
  const carousel={disabled:false,getAttribute:()=>null,click:()=>carouselClicks++};
  const context={window:{__pongTikTokPostEvidence:{kind:'photo',photoMedia:photo,photoCard:cards[0]}},
    document:{querySelector:selector=>selector.includes('feed-navigation-next')?carousel:null,
      querySelectorAll:()=>cards},requestAnimationFrame:f=>f(),setTimeout:f=>f()};
  vm.runInNewContext(asset.slice(asset.indexOf('  const feedCards'),asset.indexOf('  window.__pongUndoPhoneFit',asset.indexOf('  const feedCards'))),context);
  context.window.__pongTikTokBeginGesture();
  assert.equal(context.window.__pongTikTokStep(1),true);
  assert.equal(current,1);
  assert.equal(carouselClicks,0);
});
test('creator cinema Next video still wins over photo outer-card fallback',()=>{
  let creatorClicks=0,feedClicks=0;
  const creator={disabled:false,getAttribute:()=>null,click:()=>creatorClicks++};
  const feed={disabled:false,getAttribute:()=>null,click:()=>feedClicks++};
  const context={window:{__pongTikTokPostEvidence:{kind:'photo'}},
    document:{querySelector:selector=>selector.includes('button[aria-label="Next video"]')?creator:feed,
      querySelectorAll:()=>{throw Error('Creator cinema must not inspect For You cards')}},
    requestAnimationFrame(){},setTimeout(){}};
  vm.runInNewContext(asset.slice(asset.indexOf('  const feedCards'),asset.indexOf('  window.__pongUndoPhoneFit',asset.indexOf('  const feedCards'))),context);
  assert.equal(context.window.__pongTikTokStep(1),true);
  assert.equal(creatorClicks,1);assert.equal(feedClicks,0);
});
test('photo at last loaded outer post never clicks inner carousel as a feed fallback',()=>{
  let carouselClicks=0;
  const photo={isConnected:true};
  const card={isConnected:true,getBoundingClientRect:()=>({top:0}),contains:node=>node===photo,
    querySelector:()=>photo};
  const carousel={disabled:false,getAttribute:()=>null,click:()=>carouselClicks++};
  const context={window:{__pongTikTokPostEvidence:{kind:'photo',photoMedia:photo,photoCard:card}},
    document:{querySelector:selector=>selector.includes('feed-navigation-next')?carousel:null,
      querySelectorAll:()=>[card]},requestAnimationFrame(){},setTimeout(){}};
  vm.runInNewContext(asset.slice(asset.indexOf('  const feedCards'),asset.indexOf('  window.__pongUndoPhoneFit',asset.indexOf('  const feedCards'))),context);
  assert.equal(context.window.__pongTikTokStep(1),false);
  assert.equal(carouselClicks,0);
});
test('native horizontal photo swipe still releases the touch to TikTok',()=>{
  const native=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
  assert.match(native,/Math\.abs\(dx\) >= dp\(12\) && Math\.abs\(dx\) > Math\.abs\(dy\)[\s\S]*?tiktokReleaseHeldTouch\.run\(\);[\s\S]*?return false;/);
});
test('empty For You photo overlay passes horizontal touch through without disabling native controls',()=>{
  const photoOverlay='[data-e2e="recommend-list-item-container"] [class*="DivPhotoPlayerContainer"] > [class*="DivMediaCardOverlay"]';
  assert.ok(asset.includes(`${photoOverlay}{pointer-events:none!important}`));
  assert.ok(asset.includes(`${photoOverlay} :is(button,a,input,textarea,select,[role="button"],[role="slider"]){pointer-events:auto!important}`));
  assert.doesNotMatch(asset,/^\[class\*="DivMediaCardOverlay"\]\s*\{pointer-events:none/m);
});
test('green requires transformed frames from the current presented session',()=>{
  const classes=new Set(),label={},chipClasses=new Set(),chipTitle={},chipFill={style:{}};
  const wrapper={dataset:{pongFaceSwapActive:'true',pongFaceSwapSessionId:'new',pongTikTokPresentedSession:'new'}};
  const button={classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)},querySelector:()=>label};
  const chip={hidden:false,classList:{contains:key=>chipClasses.has(key),toggle:(key,on)=>on?chipClasses.add(key):chipClasses.delete(key)},querySelector:selector=>selector.endsWith('title')?chipTitle:chipFill};
  let now=100;
  let owner=true;
  const context={performance:{now:()=>now},document:{getElementById:id=>id==='pong-face-swap-button'?button:id==='pong-face-swap-loading'?chip:null,documentElement:{classList:{contains:()=>true}}},pongFaceSwapCurrentWrapper:()=>wrapper,pongFaceSwapState:{enabled:true},pongTikTokOwnsVisibleVideo:()=>owner};
  vm.runInNewContext(html.slice(html.indexOf('function pongSwapHasPresentedEvidence('),html.indexOf('function ensurePongFaceSwapButton(')),context);
  context.updatePongFaceSwapButton();assert.equal(classes.has('active'),false);
  context.rememberPongSwapTransformation(wrapper,'old',{transformedFrames:100});assert.equal(classes.has('active'),false);
  context.rememberPongSwapTransformation(wrapper,'new',{transformedFrames:0});assert.equal(classes.has('active'),false);
  context.rememberPongSwapTransformation(wrapper,'new',{transformedFrames:2});assert.equal(classes.has('active'),false);
  wrapper.pongTikTokFrameEvidence={sessionId:'new',visible:true,paintedRecently:true,presentedMediaTime:0,receivedAt:100};
  context.rememberPongSwapTransformation(wrapper,'new',{transformedFrames:2,fps:30,transformedFrameRanges:[[0,1]]});assert.equal(classes.has('active'),true);assert.equal(chipClasses.has('ready'),true);
  owner=false;context.updatePongFaceSwapButton();assert.equal(classes.has('active'),false);assert.equal(chipClasses.has('ready'),false);
  owner=true;context.updatePongFaceSwapButton();assert.equal(classes.has('active'),true);
  wrapper.pongTikTokFrameEvidence.presentedMediaTime=1;context.updatePongFaceSwapButton();assert.equal(classes.has('active'),false);assert.equal(chipClasses.has('ready'),false);assert.equal(chipTitle.textContent,'Swap enabled');
  wrapper.pongTikTokFrameEvidence.presentedMediaTime=0;now=1200;context.updatePongFaceSwapButton();assert.equal(classes.has('active'),false);
  wrapper.dataset.pongTikTokPresentedSession='old';context.updatePongFaceSwapButton();assert.equal(classes.has('active'),false);
});

test('queued old TikTok paint callbacks cannot re-green a photo or new video',()=>{
  const wrapper={dataset:{index:'0',pongFaceSwapSessionId:'old',pongFaceSwapActive:'true'}};
  const state={activeVideo:true,postKind:'video',current:'https://www.tiktok.com/@a/video/1'};
  const context={window:{},videoMetadata:[{originalVideoUrl:state.current}],
    pongTikTokLiveState:state,pongCanonicalTikTokVideoPage:v=>v,
    pongFaceSwapCurrentWrapper:()=>wrapper,pongFaceSwapState:{enabled:true,selectedFaceId:'face'},
    performance:{now:()=>100},updatePongFaceSwapButton(){},
    setPongFaceSwapPhase(){},PONG_FACE_SWAP_PHASES:{PLAYING:'playing'},
    hidePongFaceSwapLoading(){},schedulePongFaceSwapPrefetch(){}};
  vm.runInNewContext(html.slice(html.indexOf('function pongTikTokWrapperUrl('),
    html.indexOf('const pongTikTokStreamRetries =')),context);
  assert.equal(context.window.PongTikTokLiveSwapEvidence({sessionId:'old',visible:true}),true);
  assert.equal(context.window.PongTikTokLiveSwapPresented('old'),true);
  state.activeVideo=false;state.postKind='photo';
  wrapper.pongTikTokFrameEvidence=null;
  delete wrapper.dataset.pongTikTokPresentedSession;
  assert.equal(context.window.PongTikTokLiveSwapEvidence({sessionId:'old',visible:true}),false);
  assert.equal(context.window.PongTikTokLiveSwapPresented('old'),false);
  assert.equal(wrapper.pongTikTokFrameEvidence,null);
  assert.equal(wrapper.dataset.pongTikTokPresentedSession,undefined);
  state.activeVideo=true;state.postKind='video';state.current='https://www.tiktok.com/@a/video/2';
  assert.equal(context.window.PongTikTokLiveSwapEvidence({sessionId:'old',visible:true}),false);
  assert.equal(context.window.PongTikTokLiveSwapPresented('old'),false);
  assert.equal(context.window.PongTikTokLiveSwapPresented(''),false);
  assert.equal(wrapper.dataset.pongTikTokPresentedSession,undefined);
});
