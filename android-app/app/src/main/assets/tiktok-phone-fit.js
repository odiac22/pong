(() => {
  window.__pongTikTokCreatorLinksDispose?.();
  window.__pongTikTokNativeUiDispose?.();
  window.__pongUndoPhoneFit?.();
  const viewport=document.querySelector('meta[name="viewport"]');
  const oldViewport=viewport?.getAttribute('content');
  if(viewport)viewport.setAttribute('content','width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1');
  const style=document.createElement('style');
  style.id='pong-tiktok-phone-fit-trial';
  style.textContent=`
html,body{max-width:100vw!important;overflow-x:hidden!important}
[class*="DivVolumeControlContainer"]{translate:0 24px!important}
[class*="BaseBodyContainer"]{width:100%!important;max-width:100vw!important;min-width:0!important}
[class*="DivSideNavPlaceholderContainer"]{width:0!important;min-width:0!important;flex:0 0 0!important}
[class*="DivSideNavContainer"]{
 position:fixed!important;top:auto!important;bottom:0!important;left:0!important;right:0!important;
 width:100vw!important;height:64px!important;min-height:0!important;padding:4px 8px!important;
 display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;justify-content:flex-start!important;align-items:center!important;gap:8px!important;overflow-x:auto!important;overflow-y:hidden!important;
 background:rgba(10,14,20,.90)!important;z-index:1000!important;box-sizing:border-box!important;
}
[class*="DivSideNavContainer"] [class*="DivAnimationCover"],
[class*="DivSideNavContainer"] [class*="DivLogoWrapper"]{display:none!important}
[class*="DivSideNavContainer"] [class*="DivFixedContentContainer"],
[class*="DivSideNavContainer"] [class*="DivScrollingContentContainer"],
[class*="DivSideNavContainer"] [class*="DivMainNavContainer"],
[class*="DivSideNavContainer"] [class*="SubMainNavContentContainer"]{
 display:flex!important;flex-direction:row!important;align-items:center!important;flex:0 0 auto!important;
 width:auto!important;height:52px!important;max-height:52px!important;min-height:0!important;
 position:static!important;overflow:visible!important;margin:0!important;padding:0!important;gap:8px!important;
}
[class*="DivSideNavContainer"] [class*="DivMainNavContainer"]>*,
[class*="DivSideNavContainer"] [class*="DivSearchWrapper"]{flex:0 0 auto!important;margin:0!important;min-width:40px!important}
[class*="DivSideNavContainer"] [class*="SubMainNavFooterContainer"]{flex:0 0 auto!important}
main[id^="main-content-"]{margin-left:0!important;left:0!important;width:100vw!important;max-width:100vw!important;min-width:0!important;padding-bottom:64px!important;box-sizing:border-box!important}
#column-list-container{width:100%!important;height:calc(100dvh - 64px)!important;max-width:100vw!important}
/* Following can mount the feed without the column-list-container ID. Its
   scroll container must not leave a white gutter beside the contained video. */
[class*="DivColumnListContainer"]{background:#000!important;background-image:none!important;scrollbar-width:none!important;scrollbar-gutter:auto!important}
[data-e2e="recommend-list-item-container"]{width:100%!important;height:calc(100dvh - 64px)!important;min-height:0!important;margin:0!important;padding:0!important;box-sizing:border-box!important}
[data-e2e="recommend-list-item-container"] [class*="DivContentFlexLayout"]{position:relative!important;width:100%!important;height:100%!important;padding:0!important;margin:0!important;max-width:none!important}
[data-e2e="feed-video"]{width:100%!important;height:100%!important;max-width:none!important;flex:1 1 auto!important;margin:0!important;border-radius:0!important}
[data-e2e="feed-video"] [class*="DivVideoPlayerContainer"],
[data-e2e="feed-video"] [class*="DivBasicPlayerWrapper"]{width:100%!important;height:100%!important;max-width:none!important}
[data-e2e="feed-video"] video{width:100%!important;height:100%!important;object-fit:contain!important;border-radius:0!important}
/* Feed LIVE previews have a separate, intrinsically sized 9:16 wrapper.
   Fill the same card as recorded videos, centre with contain, and remove the
   blurred backdrop/rounded inset that made the right border grow on LIVE. */
[data-e2e="feed-video"] [class*="DivRecommendLivePlayer"]{width:100%!important;height:100%!important;max-width:100%!important;min-width:0!important;border-radius:0!important;box-sizing:border-box!important;background:#000!important}
[data-e2e="feed-video"] [class*="DivLiveBlurBg"]{display:none!important}
[data-e2e="feed-video"] [class*="DivRecommendLivePlayerContainer"] video{object-position:center!important}
/* TikTok's full-card photo overlay sits above Swiper and otherwise intercepts
   every horizontal touch. Route only empty photo-overlay space to Swiper; keep
   the actual native controls tappable. Do not change video or cinema players. */
[data-e2e="recommend-list-item-container"] [class*="DivPhotoPlayerContainer"] > [class*="DivMediaCardOverlay"]{pointer-events:none!important}
[data-e2e="recommend-list-item-container"] [class*="DivPhotoPlayerContainer"] > [class*="DivMediaCardOverlay"] :is(button,a,input,textarea,select,[role="button"],[role="slider"]){pointer-events:auto!important}
[data-e2e="recommend-list-item-container"] [class*="SectionActionBarContainer"]{position:absolute!important;right:10px!important;bottom:72px!important;z-index:20!important;margin:0!important}
/* Keep native navigation handlers; only reposition and label their controls. */
/* The single-post desktop route paints its own white body/list backdrop.
   Keep those letterboxes black too, without changing player geometry. */
html,body,[class*="BaseBodyContainer"],#column-list-container,[data-e2e="feed-video"],[data-e2e="feed-video"] [class*="DivVideoPlayerContainer"],[data-e2e="feed-video"] [class*="DivBasicPlayerWrapper"],.xgplayer-container{background:#000!important;background-image:none!important}
[data-e2e="feed-video"] video{background:#000!important}
/* Native progress must remain above the z-index:2 swapped video sibling. */
[data-e2e="feed-video"] [class*="DivVideoProgressContainer"],
[data-e2e="feed-video"] .xgplayer-controls{z-index:10!important}
[class*="DivSideNavContainer"]{background:#000!important;overflow:visible!important;z-index:1000!important}
[class*="DivSideNavContainer"] [class*="DivScrollingContentContainer"],
[class*="DivSideNavContainer"] [class*="DivFixedContentContainer"],
[class*="DivSideNavContainer"] [class*="DivMainNavContainer"],
[class*="DivSideNavContainer"] [class*="SubMainNavContentContainer"],
[class*="DivSideNavContainer"] [class*="DivLogoWrapper"],
[class*="DivSideNavContainer"] [class*="DivSearchWrapper"],
[class*="DivSideNavContainer"] h2{display:contents!important}
[class*="DivSideNavContainer"] [class*="SubMainNavFooterContainer"],
[data-e2e="nav-shop"],[data-e2e="nav-friends"],[data-e2e="nav-short-drama"],[data-e2e="nav-live"],[data-e2e="nav-messages"],[data-e2e="nav-more-menu"]{display:none!important}
[data-e2e="nav-following"],[data-e2e="nav-foryou"]{position:fixed!important;top:16px!important;bottom:auto!important;width:100px!important;height:38px!important;z-index:1005!important;text-align:center!important;color:#fff!important;text-shadow:0 1px 4px #000!important;font:600 18px/38px sans-serif!important}
[data-e2e="nav-following"]{left:calc(50% - 108px)!important}
[data-e2e="nav-foryou"]{left:calc(50% + 8px)!important}
[data-e2e="nav-following"]>*,[data-e2e="nav-foryou"]>*{display:none!important}
[data-e2e="nav-following"]::after{content:'Following'}
[data-e2e="nav-foryou"]::after{content:'For You'}
[data-e2e="nav-search"]{position:fixed!important;top:17px!important;right:14px!important;width:38px!important;min-width:38px!important;height:38px!important;background:transparent!important;color:#fff!important;z-index:1005!important}
[data-e2e="tiktok-logo"],[data-e2e="nav-explore"],[data-e2e="nav-upload"],[data-e2e="nav-activity"],[data-e2e="nav-profile"]{position:fixed!important;bottom:4px!important;top:auto!important;width:20vw!important;height:56px!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;gap:2px!important;color:#fff!important;background:transparent!important;z-index:1005!important;font:11px/14px sans-serif!important;padding:0!important;margin:0!important}
[data-e2e="tiktok-logo"]{left:0!important}
[data-e2e="nav-explore"]{left:20vw!important}
[data-e2e="nav-upload"]{left:40vw!important}
[data-e2e="nav-activity"]{left:60vw!important}
[data-e2e="nav-profile"]{left:80vw!important}
[data-e2e="nav-explore"] button,[data-e2e="nav-upload"] button,[data-e2e="nav-profile"] button{height:30px!important;min-height:30px!important;width:48px!important;min-width:48px!important;background:transparent!important;color:#fff!important;padding:0!important}
[data-e2e="tiktok-logo"]>*{display:none!important}
[data-e2e="tiktok-logo"]::before{content:'⌂';font:bold 34px/30px sans-serif}
[data-e2e="tiktok-logo"]::after{content:'Home'}
[data-e2e="nav-explore"]::after{content:'Discover'}
[data-e2e="nav-profile"]::after{content:'Profile'}
[data-e2e="nav-activity"]::after{content:'Inbox'}
[data-e2e="nav-upload"] button{border-radius:8px!important;background:#18222c!important;box-shadow:-4px 0 #25f4ee,4px 0 #fe2c55!important}
html,body,#column-list-container{scrollbar-width:none!important;scrollbar-gutter:auto!important}
::-webkit-scrollbar{width:0!important;height:0!important}
[class*="SectionActionBarContainer"] button,[class*="SectionActionBarContainer"] strong,[class*="SectionActionBarContainer"] span{color:#fff!important}
[class*="SectionActionBarContainer"] button svg{filter:drop-shadow(0 1px 2px #0006)}

/* Discover/search retain TikTok's real form, keyboard and result handlers. */
html[data-pong-discover] [class*="DivHeaderContainer"]{display:block!important;position:fixed!important;top:0!important;left:0!important;width:100%!important;height:76px!important;background:#080808!important;z-index:1010!important}
html[data-pong-discover] [class*="DivHeaderWrapperMain"]{display:flex!important;width:100%!important;min-width:0!important;height:76px!important;padding:10px 80px 10px 12px!important;box-sizing:border-box!important}
html[data-pong-discover] [class*="DivHeaderWrapperMain"] > :not([class*="DivHeaderCenterContainer"]){display:none!important}
html[data-pong-discover] [class*="DivHeaderCenterContainer"],html[data-pong-discover] [class*="DivSearchFormContainer"]{display:flex!important;position:relative!important;width:100%!important;min-width:0!important;max-width:none!important;margin:0!important}
html[data-pong-discover] [data-e2e="search-box"]{display:flex!important;width:100%!important;height:50px!important;margin:0!important;background:#242424!important;border-radius:12px!important}
html[data-pong-discover] [data-e2e="search-user-input"]{display:block!important;min-width:0!important;flex:1!important;width:100%!important;color:#fff!important;font-size:20px!important}
html[data-pong-discover] :is([data-e2e="nav-following"],[data-e2e="nav-foryou"],[data-e2e="nav-search"]){display:none!important}
html[data-pong-discover] [class*="ExploreLayout"]{padding-top:88px!important;padding-bottom:76px!important}
/* TikTok renders its search tab/filter bar (Top / Videos / Users, Filters) at this
   width, but it scrolled underneath Pong's fixed 76px header. Keep it visible. */
html[data-pong-discover] [class*="DivSearchTabB"],html[data-pong-discover] [class*="DivSearchTabBar"],html[data-pong-discover] [class*="DivFilter"]{display:flex!important;visibility:visible!important;position:sticky!important;top:76px!important;z-index:1009!important;background:#080808!important;margin:0!important;padding:4px 12px!important;max-width:none!important}
html[data-pong-discover] [data-e2e="explore-item-list"]{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:14px 10px!important;width:calc(100% - 24px)!important;margin:0 12px!important}
html[data-pong-discover] [data-e2e="explore-item-list"] > *{width:100%!important;min-width:0!important;margin:0!important}
/* Creator browse viewer is a desktop two-column modal, not cinema mode. */
@media(max-width:700px){
[data-pong-browse-root]{width:100vw!important;max-width:100vw!important;min-width:0!important;left:0!important;right:0!important;overflow:hidden!important}
[data-pong-browse-media]{flex:0 0 100%!important;width:100%!important;min-width:0!important;max-width:100%!important;height:100%!important}
[data-pong-browse-path]{width:100%!important;max-width:100%!important;min-width:0!important;height:100%!important}
[data-pong-browse-media] video{width:100%!important;height:100%!important;object-fit:contain!important;object-position:center!important}
[data-pong-browse-panel]{display:contents!important}
[data-pong-browse-root]:not([data-pong-comments-open]) [data-pong-browse-native-path]{display:contents!important}
[data-pong-browse-root]:not([data-pong-comments-open]) :is([data-pong-browse-panel],[data-pong-browse-native-path]) > :not([data-pong-browse-native-path]):not([data-pong-browse-native-author]):not([data-pong-browse-native-sound]):not([data-pong-browse-native-caption]):not([data-pong-browse-native-avatar]):not([data-pong-browse-native-action]){display:none!important}
[data-pong-browse-root]:not([data-pong-comments-open]) :is([data-pong-browse-native-author],[data-pong-browse-native-sound],[data-pong-browse-native-caption]){display:block!important;position:absolute!important;left:16px!important;right:80px!important;width:auto!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:#fff!important;text-shadow:0 1px 3px #000!important;z-index:25!important}
[data-pong-browse-root]:not([data-pong-comments-open]) [data-pong-browse-native-author]{bottom:164px!important;font-size:18px!important;font-weight:700!important}
[data-pong-browse-root]:not([data-pong-comments-open]) [data-pong-browse-native-caption]{bottom:108px!important;max-height:48px!important;overflow:hidden!important;font-size:15px!important}
[data-pong-browse-root]:not([data-pong-comments-open]) [data-pong-browse-native-sound]{bottom:76px!important;font-size:15px!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
[data-pong-browse-root]:not([data-pong-comments-open]) :is([data-pong-browse-native-author],[data-pong-browse-native-sound],[data-pong-browse-native-caption]) *{color:inherit!important}
[data-pong-browse-root]:not([data-pong-comments-open]) [data-pong-browse-native-avatar]{display:block!important;position:absolute!important;right:16px!important;bottom:220px!important;width:44px!important;height:44px!important;z-index:25!important}
[data-pong-browse-root]:not([data-pong-comments-open]) [data-pong-browse-native-avatar] img{width:44px!important;height:44px!important;border-radius:50%!important}
[data-pong-browse-root][data-pong-comments-open] [data-pong-browse-panel]{display:block!important;position:absolute!important;inset:64px 0 0!important;width:100%!important;min-width:0!important;max-width:100%!important;height:calc(100% - 64px)!important;z-index:50!important;overflow-y:auto!important;background:#121212!important}
[data-pong-browse-toggle]{position:absolute;right:72px;top:20px;z-index:51;border:0;border-radius:20px;background:#222;color:white;padding:10px 14px;font:14px sans-serif}
}
`;
  document.head.appendChild(style);
  // Desktop cinema opens comments by default, leaving an 89px video on a
  // phone. Close that native panel once on entry; the user can reopen it.
  let discoverPath='';
  const syncDiscover=()=>{
    const path=typeof location==='undefined'?'':location.pathname;
    if(path===discoverPath)return;
    discoverPath=path;
    document.documentElement.toggleAttribute('data-pong-discover',/^\/(explore|search)(\/|$)/.test(path));
  };
  syncDiscover();
  const fittedCinema = new WeakSet();
  const cinemaSelector='[class*="DivCinemaModeRoot"]';
  const cinemaCloseSelector='[class*="DivSidePanelSection"] button[data-testid="tux-web-icon-button"]';
  let cinemaFitPending = 0, cinemaRoot = null;
  const fitCinema = () => {
    cinemaFitPending = 0;
    const root = cinemaRoot?.isConnected ? cinemaRoot : document.querySelector(cinemaSelector);
    cinemaRoot = root;
    if (!root || fittedCinema.has(root) || innerWidth > 700) return;
    const close = root.querySelector(cinemaCloseSelector);
    if (!close) return;
    fittedCinema.add(root); close.click();
  };
  const cinemaObserver = new MutationObserver(records => {
    syncDiscover();
    // A fitted cinema needs no more layout work until it is replaced. TikTok
    // changes unrelated React subtrees constantly during playback; those
    // mutations used to schedule a frame callback and full-document query.
    if (cinemaRoot?.isConnected && fittedCinema.has(cinemaRoot)) return;
    for (const record of records) for (const node of record.addedNodes) {
      if(node.nodeType!==1)continue;
      const incoming=node.matches(cinemaSelector)?node:node.querySelector(cinemaSelector);
      if(incoming)cinemaRoot=incoming;
      const lateClose=cinemaRoot?.isConnected && cinemaRoot.contains(node) &&
        (node.matches(cinemaCloseSelector)||node.querySelector(cinemaCloseSelector));
      if((incoming||lateClose)&&!cinemaFitPending)cinemaFitPending=requestAnimationFrame(fitCinema);
    }
  });
  cinemaObserver.observe(document.body,{childList:true,subtree:true});
  fitCinema();
  let browseRoot=null, browsePending=0;
  const markedBrowse=new Set();
  const markBrowse=(node,name)=>{node.setAttribute(name,'');markedBrowse.add(node);};
  let browseDetailsPending=0;
  const fitBrowseDetails=()=>{
    browseDetailsPending=0;
    const panel=browseRoot?.querySelector('[data-pong-browse-panel]');
    if(!panel)return;
    const avatar=panel.querySelector('a[data-e2e="browse-user-avatar"]');
    const author=avatar?[...panel.querySelectorAll('a[href]')].find(n=>n!==avatar&&n.href===avatar.href&&n.textContent.trim()):null;
    const sound=panel.querySelector('[data-e2e="browse-music"]');
    const caption=panel.querySelector('[data-e2e="browse-video-desc"]');
    for(const [node,kind] of [[author,'author'],[sound,'sound'],[caption,'caption'],[avatar,'avatar']]){
      if(!node)continue;
      markBrowse(node,'data-pong-browse-native-'+kind);
      for(let n=node.parentElement;n&&n!==panel;n=n.parentElement)markBrowse(n,'data-pong-browse-native-path');
    }
    // Retain the original like/save/share buttons and their real state. The
    // old compact layout hid their entire branch along with the comment list.
    for(const [kind,selector] of [
      ['like','[data-e2e="browse-like"],[data-e2e="like-icon"]'],
      ['save','[data-e2e="browse-favorite"],[data-e2e="favorite-icon"]'],
      ['share','[data-e2e="browse-share"],[data-e2e="share-icon"]']]){
      const icon=panel.querySelector(selector);
      const control=icon?.closest('button,[role="button"]');
      if(!control||!panel.contains(control))continue;
      markBrowse(control,'data-pong-browse-native-action');
      control.setAttribute('data-pong-browse-action',kind);
      for(let n=control.parentElement;n&&n!==panel;n=n.parentElement)markBrowse(n,'data-pong-browse-native-path');
    }
  };
  const fitBrowse=()=>{
    browsePending=0;
    if(browseRoot?.isConnected)return;
    for(const n of markedBrowse)if(!n.isConnected)markedBrowse.delete(n);
    const video=document.querySelector('[data-e2e="browse-video"]');
    if(!video)return;
    let root=video;
    for(let depth=0;root&&depth<12;depth++,root=root.parentElement){
      if(getComputedStyle(root).position==='fixed')break;
    }
    if(!root||!root.querySelector('[data-e2e="browse-close"]'))return;
    const media=[...root.children].find(n=>n.contains(video));
    const panel=[...root.children].find(n=>n!==media&&n.querySelector('[data-e2e="browse-copy"],[data-e2e="comment-post"]'));
    if(!media||!panel)return;
    browseRoot=root;
    markBrowse(root,'data-pong-browse-root');markBrowse(media,'data-pong-browse-media');markBrowse(panel,'data-pong-browse-panel');
    for(let n=video;n&&n!==media;n=n.parentElement)markBrowse(n,'data-pong-browse-path');
    const toggle=document.createElement('button');toggle.type='button';toggle.setAttribute('data-pong-browse-toggle','');
    toggle.textContent='Comments';toggle.setAttribute('aria-expanded','false');
    toggle.onclick=()=>{const open=root.toggleAttribute('data-pong-comments-open');toggle.textContent=open?'Close comments':'Comments';toggle.setAttribute('aria-expanded',String(open));window.__pongTikTokScan?.();};
    root.appendChild(toggle);
    fitBrowseDetails();
    window.__pongTikTokScan?.();
  };
  const browseObserver=new MutationObserver(records=>{
    if(browseRoot?.isConnected){
      const panel=browseRoot.querySelector('[data-pong-browse-panel]');
      if(panel&&records.some(r=>panel.contains(r.target)&&[...r.addedNodes].some(n=>n.nodeType===1))&&!browseDetailsPending)
        browseDetailsPending=requestAnimationFrame(fitBrowseDetails);
      return;
    }
    if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches('[data-e2e="browse-video"]')||n.querySelector('[data-e2e="browse-video"]'))))){
      if(!browsePending)browsePending=requestAnimationFrame(fitBrowse);
    }
  });
  browseObserver.observe(document.body,{childList:true,subtree:true});fitBrowse();
  const profileButton=direction=>{
    const selector=direction>0?'button[data-e2e="arrow-right"],button[aria-label="Go to next video"],button[aria-label="Next video"]':'button[data-e2e="arrow-left"],button[aria-label="Go to previous video"],button[aria-label="Previous video"]';
    return [...document.querySelectorAll(selector)].find(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden');
  };
  // Advance the site's real scroll list; keep its React navigation and fetching.
  const feedCards = () => [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];
  const nearestCard = cards => cards.reduce((a,b) => Math.abs(a.getBoundingClientRect().top) < Math.abs(b.getBoundingClientRect().top) ? a : b, cards[0]);
  let gestureCard = null, waitingStep = null, drainedStep = null;
  const stepStats={queued:0,drained:0,expired:0,coalesced:0};
  const cancelWaitingStep=()=>{
    if(!waitingStep)return;
    waitingStep.observer.disconnect();clearTimeout(waitingStep.timer);
    if(waitingStep.frame)cancelAnimationFrame(waitingStep.frame);
    waitingStep=null;
  };
  // A feed fetch can temporarily disable Next. Keep only the latest intent,
  // bounded to this same visible card; never accumulate a multi-post jump.
  const waitForFeedStep=(direction,button)=>{
    const card=document.elementFromPoint(innerWidth*.5,innerHeight*.4)?.closest('[data-e2e="recommend-list-item-container"]');
    if(!card)return false;
    cancelWaitingStep();stepStats.queued++;
    const waiting={card,direction,button,frame:0,timer:0,observer:null};
    const retry=()=>{
      waiting.frame=0;if(waitingStep!==waiting)return;
      const active=document.elementFromPoint(innerWidth*.5,innerHeight*.4)?.closest('[data-e2e="recommend-list-item-container"]');
      if(!card.isConnected||active!==card||document.hidden){cancelWaitingStep();return;}
      const n=document.querySelector(direction>0?'[data-e2e="feed-navigation-next"]':'[data-e2e="feed-navigation-prev"],[data-e2e="feed-navigation-previous"]');
      if(!n||n.disabled||n.getAttribute('aria-disabled')==='true')return;
      cancelWaitingStep();stepStats.drained++;window.__pongTikTokStep?.(direction);drainedStep={card,direction,time:performance.now()};
    };
    waiting.observer=new MutationObserver(()=>{if(!waiting.frame)waiting.frame=requestAnimationFrame(retry)});
    waiting.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-disabled']});
    waiting.timer=setTimeout(()=>{if(waitingStep===waiting){stepStats.expired++;cancelWaitingStep();}},1800);
    waitingStep=waiting;return true;
  };
  // After clicking TikTok's Next, confirm the visible card actually changed. When
  // React drops the click (feed fetch, transition in flight) scroll the neighbouring
  // card into view directly; then run one queued follow-up gesture, if any.
  const VERIFY_MS=320;
  let verifyingStep=null;
  const currentCard=()=>document.elementFromPoint(innerWidth*.5,innerHeight*.4)?.closest('[data-e2e="recommend-list-item-container"]');
  const verifyFeedStep=(card,direction)=>{
    if(verifyingStep)clearTimeout(verifyingStep.timer);
    const record={card,direction,at:performance.now(),queued:0,timer:0};
    record.timer=setTimeout(()=>{
      if(verifyingStep!==record)return;
      verifyingStep=null;
      if(document.hidden)return;
      if(card&&card.isConnected&&currentCard()===card){
        stepStats.recovered=(stepStats.recovered||0)+1;
        const cards=feedCards();
        const next=cards[cards.indexOf(card)+(direction>0?1:-1)];
        if(next){next.scrollIntoView({behavior:'instant',block:'start'});requestAnimationFrame(()=>window.__pongTikTokScan?.());setTimeout(()=>window.__pongTikTokScan?.(),260);}
      }
      if(record.queued){stepStats.replayed=(stepStats.replayed||0)+1;requestAnimationFrame(()=>window.__pongTikTokStep?.(record.queued));}
    },VERIFY_MS);
    verifyingStep=record;
  };
  // Finger-following feed transition (2026-11-01). While the native layer owns a
  // vertical gesture it reports the drag as a fraction of the view height; the
  // active card, its neighbour in the drag direction and the swap overlay move
  // with the finger on the compositor (transform only). On release the cards
  // finish the motion and the existing step performs TikTok's real transition.
  let drag=null;
  const dragTargets=d=>[d.active,d.prev,d.next,d.overlay].filter(Boolean);
  window.__pongTikTokDrag=fraction=>{
    if(!Number.isFinite(fraction))return false;
    if(!drag){
      const cards=feedCards();
      // The For You feed also exposes "Go to next video" buttons (feed-navigation-*),
      // which must not be mistaken for the browse/cinema viewer's arrows.
      const cinemaOnly=d=>{const b=profileButton(d);return b&&!/^feed-navigation/.test(b.getAttribute('data-e2e')||'')?b:null};
      const browse=cinemaOnly(1)||cinemaOnly(-1);
      if(browse){
        // Browse/cinema viewer (search results, creator grid): no neighbour card
        // exists in the DOM, so only the outgoing media and the overlay follow the
        // finger; the arrow click then brings in the next post.
        const media=document.querySelector('[data-pong-browse-media],[class*="DivCinemaModeRoot"] video,[data-e2e="browse-video"] video');
        if(!media)return false;
        drag={active:media,prev:cinemaOnly(-1)?media:null,next:cinemaOnly(1)?media:null,overlay:window.__pongDomSwap?.overlay||null,dy:0,browse:true};
        for(const e of new Set(dragTargets(drag))){e.style.transition='none';e.style.willChange='transform';}
      }else{
        if(cards.length<2)return false;
        const active=cards.includes(gestureCard)?gestureCard:nearestCard(cards);
        if(!active)return false;
        const at=cards.indexOf(active);
        drag={active,prev:cards[at-1]||null,next:cards[at+1]||null,overlay:window.__pongDomSwap?.overlay||null,dy:0};
        for(const e of dragTargets(drag)){e.style.transition='none';e.style.willChange='transform';}
      }
    }
    const dy=fraction*innerHeight;
    const neighbour=dy<0?drag.next:drag.prev;
    // Rubber-band at the ends of the loaded list; the browse viewer moves only a
    // little (its next post is not in the DOM to slide in behind the finger).
    const applied=neighbour?(drag.browse?dy*.25:dy):dy*.35;
    drag.dy=applied;
    const value=`translate3d(0,${applied.toFixed(1)}px,0)`;
    for(const e of new Set(dragTargets(drag)))e.style.transform=value;
    return !!neighbour;
  };
  window.__pongTikTokDragEnd=(commit,direction)=>{
    const d=drag;drag=null;
    if(!d)return commit?!!window.__pongTikTokStep?.(direction):false;
    const els=[...new Set(dragTargets(d))];
    const finish=()=>{for(const e of els){e.style.transition='';e.style.transform='';e.style.willChange='';}};
    const neighbour=direction>0?d.next:d.prev;
    if(commit&&neighbour){
      const travel=d.browse?Math.round(innerHeight*.25):innerHeight;
      const remaining=Math.max(0,travel-Math.abs(d.dy));
      const ms=Math.max(60,Math.min(180,Math.round(remaining/travel*220)));
      const target=direction>0?-travel:travel;
      for(const e of els){e.style.transition=`transform ${ms}ms cubic-bezier(.2,.8,.2,1)`;e.style.transform=`translate3d(0,${target}px,0)`;}
      stepStats.dragCommits=(stepStats.dragCommits||0)+1;
      setTimeout(()=>{finish();window.__pongTikTokStep?.(direction);},ms+10);
      return true;
    }
    for(const e of els){e.style.transition='transform 160ms ease-out';e.style.transform='translate3d(0,0,0)';}
    stepStats.dragCancels=(stepStats.dragCancels||0)+1;
    setTimeout(finish,180);
    return false;
  };
  const cancelForNavigation=()=>cancelWaitingStep();
  document.addEventListener('pointerdown',cancelForNavigation,true);
  addEventListener('popstate',cancelForNavigation);
  document.addEventListener('visibilitychange',cancelForNavigation);
  window.navigation?.addEventListener('currententrychange',cancelForNavigation);
  window.__pongTikTokStepStats=()=>({...stepStats,pending:!!waitingStep});
  window.__pongTikTokBeginGesture = (x,y) => {
    cancelWaitingStep();
    // Hit testing identifies the touched card without forcing layout for the
    // entire feed on every DOWN. Legacy callers retain the geometry fallback.
    if(Number.isFinite(x)&&Number.isFinite(y)){
      const hit=document.elementFromPoint(x*innerWidth,y*innerHeight);
      const card=hit?.closest('[data-e2e="recommend-list-item-container"]');
      if(card){gestureCard=card;return;}
      if(hit?.closest('[data-pong-browse-root],[class*="DivCinemaModeRoot"]')){gestureCard=null;return;}
    }
    // Creator cinema navigates with its own buttons, never the feed fallback.
    // Avoid a layout read of every feed card on a touch that cannot use them.
    if((profileButton(1)||profileButton(-1))){
      gestureCard=null;return;
    }
    gestureCard = nearestCard(feedCards());
  };
  window.__pongTikTokStep = direction => {
    cancelWaitingStep();
    // A waiting command can become ready just as the next DOWN arrives. The
    // still-visible old card must not receive two Next clicks in that instant.
    if(drainedStep){
      const recent=drainedStep;drainedStep=null;
      if(recent.direction===direction&&performance.now()-recent.time<120&&
          document.elementFromPoint(innerWidth*.5,innerHeight*.4)?.closest('[data-e2e="recommend-list-item-container"]')===recent.card){stepStats.coalesced++;return true;}
    }
    // Use TikTok's own state transition. Scrolling alone can be undone by its
    // React player state, restarting the old post instead of selecting the next.
    // The creator-profile cinema viewer has different controls from For You.
    // Invoke its real buttons so React retains the creator's playlist/order.
    const profileNavigation = profileButton(direction);
    const depart = () => {
      window.__pongTikTokPassageBeginStep?.(direction);
      if(window.__pongDomSwapDepart)window.__pongDomSwapDepart();
      else window.__pongDomSwapClear?.();
    };
    if (profileNavigation) {
      gestureCard = null;
      if (profileNavigation.disabled || profileNavigation.getAttribute('aria-disabled') === 'true') return false;
      depart();profileNavigation.click();return true;
    }
    // In For You, the global feed-navigation-next button can advance an
    // imagePost's inner carousel instead of the next vertical post. For a
    // positively observed photo in the outer feed card, select the neighboring
    // outer card directly. Creator cinema's real Next-video button above wins.
    const evidence = window.__pongTikTokPostEvidence;
    if (evidence?.kind === 'photo') {
      const cards = feedCards();
      const active = cards.includes(gestureCard) ? gestureCard : nearestCard(cards);
      const media = evidence.photoMedia;
      const photoOwned = active && ((media?.isConnected && active.contains(media)) ||
        (evidence.photoCard === active && evidence.photoCard?.isConnected) ||
        !!active.querySelector('img[class*="ImgPhotoSlide"]'));
      if (photoOwned) {
        gestureCard = null;
        const next = cards[cards.indexOf(active) + (direction > 0 ? 1 : -1)];
        if (!next) return false;
        depart();next.scrollIntoView({behavior:'instant',block:'start'});
        requestAnimationFrame(() => window.__pongTikTokScan?.());
        setTimeout(() => window.__pongTikTokScan?.(),260);
        return true;
      }
    }
    const navigation = document.querySelector(direction > 0
      ? '[data-e2e="feed-navigation-next"]'
      : '[data-e2e="feed-navigation-prev"],[data-e2e="feed-navigation-previous"]');
    if (navigation) {
      const activeCards = feedCards();
      const activeCard = activeCards.includes(gestureCard) ? gestureCard : nearestCard(activeCards);
      gestureCard = null;
      if (navigation.disabled || navigation.getAttribute('aria-disabled') === 'true') return waitForFeedStep(direction,navigation);
      // A second gesture while TikTok is still transitioning used to be a second
      // click that React ignored (measured: 16 swipes -> 6 card changes). Queue
      // exactly one follow-up step for after the current transition instead.
      if (verifyingStep && performance.now()-verifyingStep.at < VERIFY_MS) {
        verifyingStep.queued = direction;stepStats.queued++;return true;
      }
      depart();navigation.click();
      verifyFeedStep(activeCard,direction);
      return true;
    }
    const cards = feedCards();
    if (cards.length < 2) return false;
    const active = cards.includes(gestureCard) ? gestureCard : nearestCard(cards);
    gestureCard = null;
    const next = cards[cards.indexOf(active) + (direction > 0 ? 1 : -1)];
    if (!next) return false;
    depart();
    next.scrollIntoView({behavior:'instant',block:'start'});
    requestAnimationFrame(() => window.__pongTikTokScan?.());
    setTimeout(() => window.__pongTikTokScan?.(),260);
    return true;
  };
  window.__pongUndoPhoneFit=()=>{cancelWaitingStep();document.removeEventListener('pointerdown',cancelForNavigation,true);removeEventListener('popstate',cancelForNavigation);document.removeEventListener('visibilitychange',cancelForNavigation);window.navigation?.removeEventListener('currententrychange',cancelForNavigation);delete window.__pongTikTokStepStats;document.documentElement?.removeAttribute('data-pong-discover');browseObserver.disconnect();if(browseDetailsPending)cancelAnimationFrame(browseDetailsPending);if(browsePending)cancelAnimationFrame(browsePending);for(const n of markedBrowse){for(const a of [...n.attributes])if(a.name.startsWith("data-pong-browse-")||a.name==="data-pong-comments-open")n.removeAttribute(a.name);}document.querySelectorAll("[data-pong-browse-toggle]").forEach(n=>n.remove());cinemaObserver.disconnect();if(cinemaFitPending)cancelAnimationFrame(cinemaFitPending);style.remove();if(viewport&&oldViewport!==null)viewport.setAttribute('content',oldViewport);delete window.__pongUndoPhoneFit;};
  return {applied:true,layoutOnly:true,reversible:true,navigation:'native controls positioned at top and bottom',videoFit:'contain; black bars; no crop or stretch'};
})()
