// Read-only DOM evidence for one photo-post gesture audit. No URLs or pixels.
(() => {
  const rect = node => {
    const r = node.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height)};
  };
  const photo = [...document.querySelectorAll('img[class*="ImgPhotoSlide"]')]
    .sort((a, b) => {
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      return y.width * y.height - x.width * x.height;
    })[0];
  const selector = 'button[aria-label="Next video"],button[aria-label="Previous video"],' +
    '[data-e2e="feed-navigation-next"],[data-e2e="feed-navigation-prev"],' +
    '[data-e2e="feed-navigation-previous"]';
  const navigation = [...document.querySelectorAll(selector)].map(node => ({
    e2e: node.getAttribute('data-e2e') || '', aria: node.getAttribute('aria-label') || '',
    rect: rect(node), disabled: !!node.disabled,
    feedCardAncestor: !!node.closest('[data-e2e="recommend-list-item-container"]'),
    swiperAncestor: !!node.closest('.swiper-slide'),
    photoAncestor: !!node.closest('[class*="Photo"],[class*="photo"]'),
  }));
  const cards = [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];
  const slides = [...document.querySelectorAll('.swiper-slide')];
  const point = document.elementFromPoint(innerWidth * .5, innerHeight * .75);
  return {
    viewport: {w: innerWidth, h: innerHeight},
    postKind: window.__pongTikTokPostEvidence?.kind || '',
    photoImages: document.querySelectorAll('img[class*="ImgPhotoSlide"]').length,
    photo: photo ? {rect: rect(photo), feedCardAncestor:
      !!photo.closest('[data-e2e="recommend-list-item-container"]'),
      swiperAncestor: !!photo.closest('.swiper-slide')} : null,
    feedCards: cards.length, swiperSlides: slides.length,
    currentPoint: point ? {tag: point.tagName,
      e2e: point.getAttribute('data-e2e') || '',
      className: String(point.className).slice(0, 90),
      feedCardAncestor: !!point.closest('[data-e2e="recommend-list-item-container"]')} : null,
    navigation,
  };
})()
