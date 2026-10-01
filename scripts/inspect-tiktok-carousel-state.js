// Read-only carousel state. No URLs, pixels, or user text.
(() => {
  const images=[...document.querySelectorAll('img[class*="ImgPhotoSlide"]')];
  const target=window.__pongTikTokPostEvidence?.photoMedia;
  const rect=node=>{const r=node.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};};
  const card=target?.closest('[data-e2e="recommend-list-item-container"]');
  const slides=card?[...card.querySelectorAll('.swiper-slide')]:[];
  return {kind:window.__pongTikTokPostEvidence?.kind||'',images:images.length,
    targetImageIndex:images.indexOf(target),targetRect:target?rect(target):null,
    slides:slides.map((node,index)=>({index,active:node.classList.contains('swiper-slide-active'),
      className:String(node.className).slice(0,100),rect:rect(node),
      slideIndex:node.getAttribute('data-swiper-slide-index')||''})).slice(0,12),
    bullets:card?[...card.querySelectorAll('[class*="bullet"],[class*="Bullet"],[class*="dot"],[class*="Dot"]')]
      .slice(0,12).map((node,index)=>({index,className:String(node.className).slice(0,80),
        active:node.getAttribute('aria-current')||''})):[]};
})()
