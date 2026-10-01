(() => {
  const anchor=document.getElementById('save-current-video-button')?.getBoundingClientRect();
  if(!anchor?.height)throw new Error('Video button must be visible before positioning controls');
  const anchorLeft=anchor.left,anchorBottom=innerHeight-anchor.top;
  window.__pongUndoCompactTikTokControls?.();
  const style=document.createElement('style');
  style.id='pong-tiktok-compact-trial';
  style.textContent=`
html.pong-tiktok-original-overlay button,html.pong-tiktok-original-overlay .control-button{scale:.625!important;transform-origin:top left!important}
html.pong-tiktok-original-overlay #github-token-button{display:none!important}
`;
  document.head.appendChild(style);
  const positions=document.createElement('style');
  positions.id='pong-tiktok-spacing-trial';document.head.appendChild(positions);
  const stack=['#save-current-video-button','#save-current-artist-button','#repair-saved-links-button','#auto-skip-video-button','#skip-current-video-button','#paste-nav-button','#remove-saved-button','#pong-face-swap-button'];
  const row=['.show-controls-button','.random-sort-button','.duration-sort-button','.refresh-button','.autoplay-button','.update-app-button','.auto-scroll-button','.erome-checkpoint-button','.clear-played-history-button','#skip-played-filter-button'];
  const place=(selector,x,y)=>`html.pong-tiktok-original-overlay ${selector}{position:fixed!important;left:${x}px!important;top:${y}px!important;right:auto!important;bottom:auto!important;transform:none!important;translate:none!important;margin:0!important;transition:none!important}`;
  const layout=()=>{
    const gap=8,rules=[],targets=[];
    const add=(selector,x,y)=>{rules.push(place(selector,x,y));targets.push({selector,x,y});};
    let y=innerHeight-anchorBottom;
    const video=document.querySelector(stack[0]);
    for(let i=0;i<stack.length;i++){
      const el=document.querySelector(stack[i]);if(!el)continue;
      const height=el.offsetHeight*.625;
      if(i)y-=height+gap;
      add(stack[i],anchorLeft,y);
      if(stack[i]==='#pong-face-swap-button')add('#pong-face-detect-button',anchorLeft+el.offsetWidth*.625+gap,y);
    }
    let x=anchorLeft+video.offsetWidth*.625+gap;
    const center=innerHeight-anchorBottom+video.offsetHeight*.625/2;
    for(const selector of row){const el=document.querySelector(selector);if(!el)continue;add(selector,x,center-el.offsetHeight*.625/2);x+=el.offsetWidth*.625+gap;}
    positions.textContent=rules.join('\n');
    // Some controls live inside transformed overlay containers, which establish
    // their own fixed-position origin. Compensate without moving DOM or handlers.
    const corrected=targets.map(({selector,x,y})=>{const rect=document.querySelector(selector).getBoundingClientRect();return place(selector,x+(x-rect.left),y+(y-rect.top));});
    positions.textContent=corrected.join('\n');
  };
  layout();window.addEventListener('resize',layout);
  window.__pongUndoCompactTikTokControls=()=>{window.removeEventListener('resize',layout);style.remove();positions.remove();delete window.__pongUndoCompactTikTokControls;window.dispatchEvent(new Event('resize'));};
  window.dispatchEvent(new Event('resize'));
  return {applied:true,scope:'TikTok Pong overlay only',scale:0.625,videoAnchor:{x:anchorLeft,y:innerHeight-anchorBottom},gap:8};
})()
