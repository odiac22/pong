(() => {
  window.__pongUndoCompactTikTokControls?.();
  window.PongTikTokToolbarLayout?.dispose();
  const stack=['#save-current-video-button','#save-current-artist-button','#repair-saved-links-button','#auto-skip-video-button','#skip-current-video-button','#paste-nav-button','#remove-saved-button','#pong-face-swap-button'];
  const row=['.show-controls-button','.random-sort-button','.duration-sort-button','.refresh-button','.autoplay-button','.update-app-button','.auto-scroll-button','.erome-checkpoint-button','.clear-played-history-button','#skip-played-filter-button'];
  const toolbar=[...stack,...row,'#pong-face-detect-button','#pong-server-toggle','#pong-collection-save-button'];
  const excluded='#pong-face-swap-settings-panel,#pong-face-swap-picker,.pong-face-swap-picker,.pong-face-swap-menu';
  const get=s=>{const e=document.querySelector(s);return e&&!e.closest(excluded)?e:null;};
  const style=document.createElement('style'),positions=document.createElement('style');
  style.id='pong-toolbar-approved-size';positions.id='pong-tiktok-approved-positions';
  // Only the named playback toolbar is resized. Never scale a panel or its descendants.
  style.textContent=toolbar.map(s=>s+':not('+excluded+' *)').join(',')+'{scale:.625!important;transform-origin:top left!important}\nhtml.pong-tiktok-original-overlay #github-token-button{display:none!important}';
  document.head.append(style,positions);
  let pending=0;
  const place=(s,x,y)=>'html.pong-tiktok-original-overlay '+s+'{position:fixed!important;left:'+x+'px!important;top:'+y+'px!important;right:auto!important;bottom:auto!important;transform:none!important;translate:none!important;margin:0!important;transition:none!important}';
  function layout(){
    pending=0;
    if(!document.documentElement.classList.contains('pong-tiktok-original-overlay')){positions.textContent='';return;}
    const video=get(stack[0]);if(!video)return;
    const targets=[],add=(s,x,y)=>targets.push({s,x,y});
    const left=12,gap=8,videoY=Math.max(300,innerHeight-202.428589);
    let y=videoY;
    for(let i=0;i<stack.length;i++){const e=get(stack[i]);if(!e)continue;if(i)y-=e.offsetHeight*.625+gap;add(stack[i],left,y);if(stack[i]==='#pong-face-swap-button')add('#pong-face-detect-button',left+e.offsetWidth*.625+gap,y);}
    let x=left+video.offsetWidth*.625+gap;
    const center=videoY+video.offsetHeight*.625/2;
    for(const s of row){const e=get(s);if(!e)continue;add(s,x,center-e.offsetHeight*.625/2);x+=e.offsetWidth*.625+gap;}
    positions.textContent=targets.map(t=>place(t.s,t.x,t.y)).join('\n');
    // Fixed-position controls inside transformed parents have a different origin.
    const corrected=targets.map(t=>{const r=get(t.s)?.getBoundingClientRect();return r?place(t.s,2*t.x-r.left,2*t.y-r.top):'';});
    positions.textContent=corrected.join('\n');
    window.dispatchEvent(new Event('pong-toolbar-layout'));
  }
  function schedule(){if(!pending)pending=requestAnimationFrame(layout);}
  const mode=new MutationObserver(schedule);mode.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  const controls=new MutationObserver(schedule);controls.observe(document.body,{childList:true,subtree:true});
  addEventListener('resize',schedule);
  window.PongTikTokToolbarLayout={refresh:layout,dispose(){mode.disconnect();controls.disconnect();removeEventListener('resize',schedule);cancelAnimationFrame(pending);style.remove();positions.remove();delete window.PongTikTokToolbarLayout;}};
  layout();
  return {saved:true,toolbarScale:.625,panelsUnchanged:true,tiktokPositionsOnly:true};
})()
