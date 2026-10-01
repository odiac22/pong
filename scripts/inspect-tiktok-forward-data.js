(()=>{
 const cards=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];
 const card=cards.sort((a,b)=>Math.abs(a.getBoundingClientRect().top)-Math.abs(b.getBoundingClientRect().top))[0];
 if(!card)return {feed:false};
 let fiber=card[Object.keys(card).find(k=>k.startsWith('__reactFiber'))];const parents=[];
 for(let depth=0;fiber&&depth<18;depth++,fiber=fiber.return){
  const props=fiber.memoizedProps;
  parents.push({depth,type:typeof fiber.type==='string'?fiber.type:typeof fiber.type,id:props?.id,keys:props&&typeof props==='object'?Object.keys(props).slice(0,30):[],arrays:props&&typeof props==='object'?Object.entries(props).filter(([k,v])=>Array.isArray(v)).map(([k,v])=>({name:k,length:v.length,itemKeys:v[0]&&typeof v[0]==='object'?Object.keys(v[0]).slice(0,15):[],posts:k==='cinemaModePreloadList'?v.slice(0,20).map(row=>({id:row.id,path:(()=>{try{return new URL(row.url,location.href).pathname}catch{return null}})()})):undefined})):[]});
 }
 return {feed:true,cards:cards.length,parents};
})()
