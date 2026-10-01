(()=>{
 const own=(x,k)=>{try{return Object.getOwnPropertyDescriptor(x,k)?.value}catch{return undefined}};
 const cards=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];
 const card=cards.find(c=>{const r=c.getBoundingClientRect();return r.top<innerHeight*.5&&r.bottom>innerHeight*.5});
 if(!card)return {card:false};
 const seen=new WeakSet(),q=[],found=[];
 const add=(x,depth)=>{if(!x||typeof x!=='object'||depth>8||seen.has(x)||q.length>=180)return;seen.add(x);q.push({x,depth})};
 Object.keys(card).filter(k=>k.startsWith('__reactProps')).forEach(k=>add(own(card,k),0));
 for(let i=0;i<q.length;i++){const {x,depth}=q[i];
  if(typeof own(x,'id')==='string'&&own(x,'author')){
   const fields=Object.fromEntries(Object.keys(x).filter(k=>/ad|promot|sponsor/i.test(k)).map(k=>[k,
    typeof own(x,k)==='boolean'||typeof own(x,k)==='number'?own(x,k):{type:typeof own(x,k),keys:own(x,k)&&typeof own(x,k)==='object'?Object.keys(own(x,k)).slice(0,12):[]}]));
   found.push({videoId:own(x,'id'),fields});
  }
  for(const key of Object.keys(x).slice(0,60)){if(['return','stateNode','ownerDocument','_owner','ref'].includes(key))continue;add(own(x,key),depth+1)}
 }
 return {card:true,items:found,e2e:[...card.querySelectorAll('[data-e2e]')].map(e=>e.getAttribute('data-e2e')).filter(x=>/ad|spon|promo/i.test(x)),
  labels:[...card.querySelectorAll('span,div,a')].filter(e=>e.children.length===0&&/^(Sponsored|Promoted)$/.test(e.textContent.trim())).slice(0,5).map(e=>({tag:e.tagName,e2e:e.getAttribute('data-e2e'),class:e.className}))};
})()
