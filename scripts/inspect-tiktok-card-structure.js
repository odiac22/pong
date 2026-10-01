(()=>({
  videos:[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].map(v=>{
    const ancestors=[];for(let n=v;n&&ancestors.length<12;n=n.parentElement){const r=n.getBoundingClientRect();ancestors.push({tag:n.tagName,id:n.id,e2e:n.getAttribute('data-e2e'),role:n.getAttribute('role'),class:n.className,top:r.top,height:r.height,links:[...n.querySelectorAll('a[href*="/video/"]')].slice(0,4).map(a=>new URL(a.href).pathname)});}
    return{playing:!v.paused,time:v.currentTime,ancestors};
  }),cards:document.querySelectorAll('.swiper-slide,[data-e2e="recommend-list-item-container"]').length,
  grid:document.querySelectorAll('[data-e2e="user-post-item"]').length,
  cinema:!!document.querySelector('[data-e2e="cinema-mode-exit"]')
}))()
