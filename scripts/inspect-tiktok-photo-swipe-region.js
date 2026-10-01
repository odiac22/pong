// Read-only geometry audit. No URLs, user content, pixels, or UI mutation.
(() => {
  const rect = node => {
    const r = node.getBoundingClientRect();
    return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,
      width:r.width,height:r.height};
  };
  const area = node => {
    const r = node.getBoundingClientRect();
    return Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left)) *
      Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));
  };
  const images = [...document.querySelectorAll('img[class*="ImgPhotoSlide"]')]
    .sort((a,b)=>area(b)-area(a));
  const image = images[0];
  const card = image?.closest('[data-e2e="recommend-list-item-container"]') ||
    image?.closest('.swiper-slide');
  const r = card && rect(card);
  const region = r && {x:Math.max(0,r.left)/innerWidth,
    y:Math.max(0,r.top)/innerHeight,
    right:Math.min(innerWidth,r.right)/innerWidth,
    bottom:Math.min(innerHeight,r.bottom)/innerHeight};
  const points = [[500,1750],[800,1750],[500,600],[800,600]].map(([px,py]) => {
    const x=px/1080*innerWidth,y=py/2340*innerHeight;
    const node=document.elementFromPoint(x,y);
    return {x,y,inRegion:!!region&&x>=region.x*innerWidth&&
      x<=region.right*innerWidth&&y>=region.y*innerHeight&&
      y<=region.bottom*innerHeight,
      hitTag:node?.tagName||'',hitClass:String(node?.className||'').slice(0,90),
      hitFeedCard:!!node?.closest('[data-e2e="recommend-list-item-container"]')};
  });
  return {viewport:{w:innerWidth,h:innerHeight},kind:window.__pongTikTokPostEvidence?.kind||'',
    imageCount:images.length,visibleImageCount:images.filter(i=>area(i)>0).length,
    image:image?{rect:rect(image),visibleArea:area(image)}:null,
    card:r,region,points};
})()
