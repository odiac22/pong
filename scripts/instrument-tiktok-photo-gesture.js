// Temporary one-gesture probe. Restored by __pongGestureProbeStop; no URLs/pixels.
(() => {
  window.__pongGestureProbeStop?.();
  const oldBegin = window.__pongTikTokBeginGesture;
  const oldStep = window.__pongTikTokStep;
  const firstPhoto = window.__pongTikTokPostEvidence?.photoMedia || null;
  const outerCardIndex = () => {
    const cards=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];
    const card=window.__pongTikTokPostEvidence?.photoCard;
    return cards.indexOf(card);
  };
  const carousel = () => {
    const media=window.__pongTikTokPostEvidence?.photoMedia;
    const card=media?.closest('[data-e2e="recommend-list-item-container"]');
    const slides=card?[...card.querySelectorAll('.swiper-slide')]:[];
    return {slideCount:slides.length,activeSlide:slides.findIndex(s=>s.classList.contains('swiper-slide-active')),
      targetImageIndex:[...document.querySelectorAll('img[class*="ImgPhotoSlide"]')].indexOf(media)};
  };
  const events = [];
  const state = {beginCalls:0,stepCalls:0,stepDirections:[],stepResults:[],
    nativeTouchEvents:events,kindBefore:window.__pongTikTokPostEvidence?.kind||'',
    carouselBefore:carousel(),outerCardBefore:outerCardIndex(),photoNodeChanged:false};
  const eventProbe = event => {
    if (events.length >= 32) return;
    const touch = event.changedTouches?.[0];
    events.push({type:event.type,x:touch?.clientX??null,y:touch?.clientY??null,
      targetTag:event.target?.tagName||'',
      targetE2e:event.target?.getAttribute?.('data-e2e')||''});
  };
  for (const type of ['touchstart','touchmove','touchend','touchcancel'])
    window.addEventListener(type,eventProbe,{capture:true,passive:true});
  window.__pongTikTokBeginGesture = function(...args) {
    state.beginCalls++;
    return oldBegin?.apply(this,args);
  };
  window.__pongTikTokStep = function(direction,...args) {
    state.stepCalls++;state.stepDirections.push(direction);
    const result=oldStep?.call(this,direction,...args);
    state.stepResults.push(result===true);
    return result;
  };
  window.__pongGestureProbeStop = () => {
    for (const type of ['touchstart','touchmove','touchend','touchcancel'])
      window.removeEventListener(type,eventProbe,true);
    if (window.__pongTikTokBeginGesture !== oldBegin) window.__pongTikTokBeginGesture=oldBegin;
    if (window.__pongTikTokStep !== oldStep) window.__pongTikTokStep=oldStep;
    state.kindAfter=window.__pongTikTokPostEvidence?.kind||'';
    state.photoNodeChanged=firstPhoto !== (window.__pongTikTokPostEvidence?.photoMedia||null);
    state.carouselAfter=carousel();
    state.outerCardAfter=outerCardIndex();
    delete window.__pongGestureProbeStop;
    return state;
  };
  return {armed:true,kind:state.kindBefore};
})()
