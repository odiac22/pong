(()=>{
 const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}};
 const media=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].map(v=>{
  const ancestors=[];let n=v;
  for(let i=0;n&&i<16;i++,n=n.parentElement)ancestors.push({tag:n.tagName,id:n.id,e2e:n.dataset?.e2e,className:String(n.className).slice(0,180),rect:rect(n),scroll:n.scrollTop,sh:n.scrollHeight,ch:n.clientHeight,overflow:getComputedStyle(n).overflowY});
  return{paused:v.paused,ancestors};
 });
 return{path:location.pathname,viewport:{w:innerWidth,h:innerHeight},media,
  navigation:[...document.querySelectorAll('button[aria-label="Next video"],button[aria-label="Previous video"],[data-e2e="feed-navigation-next"],[data-e2e="feed-navigation-prev"],[data-e2e="cinema-mode-exit"]')].map(e=>({e2e:e.dataset.e2e,aria:e.getAttribute('aria-label'),rect:rect(e),disabled:e.disabled})),
  cards:[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')].map(e=>({rect:rect(e)}))};
})()
