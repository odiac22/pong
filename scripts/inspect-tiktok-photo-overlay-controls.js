// Read-only photo overlay child/control geometry; no URLs, pixels or user text.
(() => {
  const photo=window.__pongTikTokPostEvidence?.photoMedia;
  const card=photo?.closest('[data-e2e="recommend-list-item-container"]');
  const overlay=card?.querySelector('[class*="DivMediaCardOverlay"]');
  const rect=node=>{const r=node.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};};
  const interactive=overlay?[...overlay.querySelectorAll('button,a,input,textarea,select,[role="button"],[role="slider"]')]
    .map(node=>({tag:node.tagName,e2e:node.getAttribute('data-e2e')||'',
      aria:node.getAttribute('aria-label')||'',className:String(node.className).slice(0,80),rect:rect(node)})):[];
  return {kind:window.__pongTikTokPostEvidence?.kind||'',overlay:!!overlay,
    overlayRect:overlay?rect(overlay):null,childElements:overlay?.querySelectorAll('*').length||0,
    interactive};
})()
