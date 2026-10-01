(()=>{
 const out=[];
 for(const card of [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')].filter(c=>c.querySelector('video')).slice(0,3)){
  const nodes=[card,card.querySelector('[data-e2e="feed-video"]'),card.querySelector('video')].filter(Boolean);
  const own=(x,k)=>{try{return Object.getOwnPropertyDescriptor(x,k)?.value}catch{return undefined}};
  for(const node of nodes){
   const q=[],seen=new WeakSet(),found=[];let cursor=0;
   const add=(x,path,depth)=>{if(!x||typeof x!=='object'||seen.has(x)||depth>12||q.length>=1000)return;seen.add(x);q.push({x,path,depth});};
   for(const key of Object.keys(node).filter(k=>k.startsWith('__reactProps')))add(own(node,key),'props',0);
   while(cursor<q.length){const {x,path,depth}=q[cursor++];
    const id=own(x,'id'),author=own(x,'author');
    if(typeof id==='string'&&/^\d{15,22}$/.test(id))found.push({path,id,authorType:typeof author,authorKeys:author&&typeof author==='object'?Object.keys(author).slice(0,16):[],uniqueId:typeof author==='string'?author:own(author,'uniqueId')});
    for(const key of Object.keys(x).slice(0,80)){if(['return','stateNode','ownerDocument','_owner','ref'].includes(key))continue;add(own(x,key),path+'.'+key,depth+1);}
   }
   out.push({card:card.id,node:node.tagName,e2e:node.getAttribute('data-e2e'),visited:q.length,found:found.slice(0,8)});
  }
 }
 return out;
})()
