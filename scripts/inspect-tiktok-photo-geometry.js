(()=>({path:location.pathname,images:[...document.querySelectorAll('img')].map(e=>{
 const r=e.getBoundingClientRect();
 return {class:e.className,visible:r.bottom>0&&r.top<innerHeight,width:r.width,height:r.height,
  ancestors:[e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement].map(n=>({class:n?.className,e2e:n?.getAttribute('data-e2e')}))};
}).filter(e=>e.visible&&e.width>100&&e.height>100)}))()
