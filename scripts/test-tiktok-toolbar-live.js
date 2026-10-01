(() => {
 const root=document.documentElement,active=root.classList.contains('pong-tiktok-original-overlay');
 const el=document.getElementById('save-current-video-button');
 const rect=()=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
 const current=rect();
 const style=document.getElementById('pong-tiktok-approved-positions');
 root.classList.remove('pong-tiktok-original-overlay');
 style.disabled=true;const baseline=rect();style.disabled=false;
 let outside,cleared;
 try {root.classList.remove('pong-tiktok-original-overlay');window.PongTikTokToolbarLayout.refresh();outside=rect();cleared=!style.textContent;}
 finally {root.classList.toggle('pong-tiktok-original-overlay',active);window.PongTikTokToolbarLayout.refresh();}
 const panels=[...document.querySelectorAll('#pong-face-swap-settings-panel button,#pong-face-swap-picker button')].map(e=>({scale:getComputedStyle(e).scale}));
 return {page:location.origin+location.pathname,current,restored:rect(),outside,baseline,originalPositionsRestored:Math.abs(outside.y-baseline.y)<1&&Math.abs(outside.x-baseline.x)<1,positionRulesClearedOutsideTikTok:cleared,panelButtonCount:panels.length,panelScales:[...new Set(panels.map(p=>p.scale))]};
})()
