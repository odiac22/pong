(() => {
  window.__pongUndoPhoneFit?.();
  const viewport=document.querySelector('meta[name="viewport"]');
  const oldViewport=viewport?.getAttribute('content');
  if(viewport)viewport.setAttribute('content','width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1');
  const style=document.createElement('style');
  style.id='pong-tiktok-phone-fit-trial';
  style.textContent=`
html,body{max-width:100vw!important;overflow-x:hidden!important}
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
[data-e2e="recommend-list-item-container"]{width:100%!important;height:calc(100dvh - 64px)!important;min-height:0!important;margin:0!important;padding:0!important;box-sizing:border-box!important}
[data-e2e="recommend-list-item-container"] [class*="DivContentFlexLayout"]{position:relative!important;width:100%!important;height:100%!important;padding:0!important;margin:0!important;max-width:none!important}
[data-e2e="feed-video"]{width:100%!important;height:100%!important;max-width:none!important;flex:1 1 auto!important;margin:0!important;border-radius:0!important}
[data-e2e="feed-video"] [class*="DivVideoPlayerContainer"],
[data-e2e="feed-video"] [class*="DivBasicPlayerWrapper"]{width:100%!important;height:100%!important;max-width:none!important}
[data-e2e="feed-video"] video{width:100%!important;height:100%!important;object-fit:contain!important;border-radius:0!important}
[data-e2e="recommend-list-item-container"] [class*="SectionActionBarContainer"]{position:absolute!important;right:10px!important;bottom:72px!important;z-index:20!important;margin:0!important}
/* Keep native navigation handlers; only reposition and label their controls. */
html,body,[data-e2e="feed-video"],[data-e2e="feed-video"] [class*="DivVideoPlayerContainer"],[data-e2e="feed-video"] [class*="DivBasicPlayerWrapper"],.xgplayer-container{background:#000!important;background-image:none!important}
[data-e2e="feed-video"] video{background:#000!important}
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
html,body,#column-list-container{scrollbar-width:none!important}
::-webkit-scrollbar{width:0!important;height:0!important}
[class*="SectionActionBarContainer"] button,[class*="SectionActionBarContainer"] strong,[class*="SectionActionBarContainer"] span{color:#fff!important}
[class*="SectionActionBarContainer"] button svg{color:#fff!important}
`;
  document.head.appendChild(style);
  window.__pongUndoPhoneFit=()=>{style.remove();if(viewport&&oldViewport!==null)viewport.setAttribute('content',oldViewport);delete window.__pongUndoPhoneFit;};
  return {applied:true,layoutOnly:true,reversible:true,navigation:'native controls positioned at top and bottom',videoFit:'contain; black bars; no crop or stretch'};
})()
