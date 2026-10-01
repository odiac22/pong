// Read-only approximation of the native Pong overlay hit rects; no URLs/pixels.
(() => {
  const selector = 'button,a[href],input,textarea,select,[role="button"],[role="slider"],.video-progress-container,.audio-toggle-button,.control-button,.pong-face-swap-picker,.pong-face-swap-menu,#pong-face-swap-picker,#pong-face-swap-settings-panel,#pong-collection-panel,.auth-helper-panel';
  const visible = node => {
    for (let p=node;p;p=p.parentElement) {
      const s=getComputedStyle(p);
      if (p.hidden || s.display==='none' || s.visibility==='hidden' || Number(s.opacity)===0) return false;
    }
    const r=node.getBoundingClientRect();
    return !!r.width&&!!r.height&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;
  };
  const nodes=[...document.querySelectorAll(selector)].filter(visible).slice(0,256);
  const points=[[500,1750],[800,1750],[500,600],[800,600]].map(([px,py])=>{
    const x=px/1080*innerWidth,y=py/2340*innerHeight;
    const hits=nodes.filter(node=>{const r=node.getBoundingClientRect();
      return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;})
      .map(node=>({tag:node.tagName,id:node.id||'',
        className:String(node.className).slice(0,90),
        pointerEvents:getComputedStyle(node).pointerEvents}));
    return {x,y,hits};
  });
  return {viewport:{w:innerWidth,h:innerHeight},candidateRects:nodes.length,
    overlayActive:document.documentElement.classList.contains('pong-tiktok-original-overlay'),
    points};
})()
