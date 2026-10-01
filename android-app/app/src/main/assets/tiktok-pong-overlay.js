(() => {
  if (window.PongTikTokOverlaySetActive) return;
  let active = false, timer = 0, pending = 0, last = '', targets = [], targetsDirty = true;
  const style = document.createElement('style');
  style.id = 'pong-tiktok-original-overlay-style';
  // Keep the original nodes, dimensions, colors and event handlers. Only the
  // opaque media/background beneath those controls is removed in this mode.
  style.textContent = `
    html.pong-tiktok-original-overlay,
    html.pong-tiktok-original-overlay body,
    html.pong-tiktok-original-overlay #video-container,
    html.pong-tiktok-original-overlay .video-wrapper {
      background: transparent !important;
    }
    html.pong-tiktok-original-overlay #video-container video,
    html.pong-tiktok-original-overlay .pm-video-poster,
    html.pong-tiktok-original-overlay .pong-face-swap-transition-overlay,
    html.pong-tiktok-original-overlay .video-ready-loader,
    html.pong-tiktok-original-overlay #pong-overlay,
    html.pong-tiktok-original-overlay .tap-area::before {
      visibility: hidden !important;
    }
    html.pong-tiktok-original-overlay .controls-overlay {
      background: transparent !important;
    }
    html.pong-tiktok-original-overlay .video-progress-container {
      display: none !important;
      pointer-events: none !important;
    }
    html.pong-tiktok-original-overlay .controls-overlay .url-input {
      display: none !important;
    }
    html.pong-tiktok-original-overlay select {
      background-color: #182b38; color: #dceaf2; color-scheme: dark;
    }
  `;
  document.head.appendChild(style);
  const selector = 'button,a[href],input,textarea,select,[role="button"],[role="slider"],.video-progress-container,.audio-toggle-button,.control-button,.pong-face-swap-picker,.pong-face-swap-menu,#pong-face-swap-picker,#pong-face-swap-settings-panel,#pong-collection-panel,.auth-helper-panel';
  function visibleRect(node, visibility) {
    const visited=[];
    for (let parent = node; parent; parent = parent.parentElement) {
      if (visibility.has(parent)) {
        if (!visibility.get(parent)) { visited.forEach(p=>visibility.set(p,false)); return null; }
        break;
      }
      visited.push(parent);
      const c = getComputedStyle(parent);
      if (parent.hidden || c.display === 'none' || c.visibility === 'hidden' || Number(c.opacity) === 0) {
        visited.forEach(p=>visibility.set(p,false)); return null;
      }
    }
    visited.forEach(p=>visibility.set(p,true));
    // Most candidates belong to closed panels. Exclude their entire ancestry
    // before requesting geometry, not after forcing layout for each child.
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
    return {x:r.left/innerWidth,y:r.top/innerHeight,w:r.width/innerWidth,h:r.height/innerHeight};
  }
  function report() {
    pending = 0;
    if (!active) return;
    const began=performance.now();
    const visibility = new WeakMap();
    if(targetsDirty){
      targetsDirty=false;targets=Array.from(document.querySelectorAll(selector));
      sizeObserver?.disconnect();targets.forEach(node=>sizeObserver?.observe(node));
    }
    const nodes=targets;
    const rects = nodes.map(node=>visibleRect(node,visibility)).filter(Boolean).slice(0,256);
    const json = JSON.stringify(rects);
    if (json !== last) { last = json; window.PongNativeSwap?.overlayRects?.(json); }
    const stats=window.PongTikTokOverlayStats??={reports:0,totalMs:0,maxMs:0};
    const elapsed=performance.now()-began;stats.reports++;stats.totalMs+=elapsed;stats.maxMs=Math.max(stats.maxMs,elapsed);stats.candidates=nodes.length;stats.visible=rects.length;
  }
  function schedule() { if (active && !pending) pending = requestAnimationFrame(report); }
  const sizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  const panels='.pong-face-swap-picker,.pong-face-swap-menu,#pong-face-swap-picker,#pong-face-swap-settings-panel,#pong-collection-panel,.auth-helper-panel';
  const geometryStyle=value=>(String(value||'').match(/(?:^|;)\s*(?:display|visibility|opacity|pointer-events|transform|translate|scale|left|right|top|bottom|width|height|position)\s*:[^;]*/g)||[]).join(';');
  const observer = new MutationObserver(records=>{
    let changed=false;
    for(const record of records){
      if(record.type==='childList'){
        const nodes=[...record.addedNodes,...record.removedNodes];
        if(nodes.some(node=>node.nodeType===1&&(node.matches?.(selector)||node.querySelector?.(selector)))){targetsDirty=true;changed=true;}
      }else if(record.attributeName==='hidden'||record.attributeName==='open')changed=true;
      else if(record.attributeName==='style'){
        if(geometryStyle(record.oldValue)!==geometryStyle(record.target.getAttribute('style'))&&
          (record.target.matches?.(selector)||record.target.matches?.(panels)))changed=true;
      }else if(record.attributeName==='class'&&record.target.matches?.(panels))changed=true;
    }
    if(changed)schedule();
  });
  window.PongTikTokOverlaySetActive = enabled => {
    const entering = !!enabled && !active;
    active = !!enabled;
    if (entering) {
      const importer = document.getElementById?.('pong-overlay');
      if (importer) {
        if (window.__pongTikTokOverlayDisplay === undefined) window.__pongTikTokOverlayDisplay = importer.style.display || '';
        importer.style.display = 'none';
      }
    }
    document.documentElement.classList.toggle('pong-tiktok-original-overlay', active);
    clearInterval(timer); observer.disconnect();sizeObserver?.disconnect();targetsDirty=true;
    if (pending) cancelAnimationFrame(pending);
    pending = 0; last = '';
    if (active) {
      observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style','hidden','open']});
      // ResizeObserver handles button/panel size changes without polling every
      // status text, progress fill or color change. Position changes are reported
      // by the toolbar-layout, resize and scroll events below.
      if(!sizeObserver)timer = setInterval(report,500);
      report();
    } else window.PongNativeSwap?.overlayRects?.('[]');
  };
  addEventListener('resize',schedule,{passive:true});
  addEventListener('scroll',schedule,{passive:true,capture:true});
  addEventListener('pong-toolbar-layout',schedule);
})();
