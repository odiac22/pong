// Read-only touch-target ancestry and swiper geometry. No URLs or pixels.
(() => {
  const rect=node=>{const r=node.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};};
  const describe=node=>{const style=getComputedStyle(node);return{
    tag:node.tagName,e2e:node.getAttribute('data-e2e')||'',
    className:String(node.className).slice(0,110),
    pointerEvents:style.pointerEvents,touchAction:style.touchAction,
    zIndex:style.zIndex,rect:rect(node)};};
  const x=800/1080*innerWidth,y=1100/2340*innerHeight;
  const target=document.elementFromPoint(x,y);
  const ancestry=[];for(let node=target;node&&ancestry.length<12;node=node.parentElement)
    ancestry.push(describe(node));
  const photo=window.__pongTikTokPostEvidence?.photoMedia;
  const photoAncestry=[];for(let node=photo;node&&photoAncestry.length<8;node=node.parentElement)
    photoAncestry.push(describe(node));
  const under=document.elementsFromPoint(x,y).slice(0,8).map(describe);
  return {kind:window.__pongTikTokPostEvidence?.kind||'',point:{x,y},
    targetInSwiper:!!target?.closest('.swiper-slide,.swiper-container,.swiper'),
    ancestry,photoAncestry,stack:under};
})()
