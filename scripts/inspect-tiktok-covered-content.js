(()=>{
 const root=document.querySelector('[class*="DivCinemaModeRoot"]'),chain=[];
 for(let e=root;e;e=e.parentElement)chain.push({tag:e.tagName,id:e.id,cls:String(e.className).slice(0,100),siblings:[...(e.parentElement?.children||[])].filter(s=>s!==e).map(s=>({tag:s.tagName,id:s.id,cls:String(s.className).slice(0,100),images:s.querySelectorAll('img').length,videos:s.querySelectorAll('video').length,posts:s.querySelectorAll('[data-e2e="user-post-item"]').length}))});
 return {chain,mains:[...document.querySelectorAll('main')].map(e=>({id:e.id,cinema:e.contains(root),images:e.querySelectorAll('img').length,rect:e.getBoundingClientRect().toJSON()})),videoCount:document.querySelectorAll('video').length};
})()
