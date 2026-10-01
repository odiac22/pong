(()=>{
 const own=(x,k)=>{try{return Object.getOwnPropertyDescriptor(x,k)?.value}catch{return undefined}};
 const cards=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];
 const current=cards.find(c=>{const r=c.getBoundingClientRect();return r.top<=innerHeight*.5&&r.bottom>innerHeight*.5});
 const placeholder=cards[cards.indexOf(current)+2];
 const out=[];
 let fiber=placeholder&&own(placeholder,Object.keys(placeholder).find(k=>k.startsWith('__reactFiber')));
 for(let i=0;fiber&&i<18;i++,fiber=own(fiber,'return')){
  const p=own(fiber,'memoizedProps'),state=own(fiber,'memoizedState');
  const hooks=[];if(i<7){for(let h=state,j=0;h&&j<16;j++,h=own(h,'next')){const value=own(h,'memoizedState'),selected=own(own(value,'current'),'value');hooks.push({type:typeof value,selectedKeys:selected&&typeof selected==='object'?Object.keys(selected).slice(0,30):[],selectedId:own(selected,'id'),selectedAuthor:typeof own(selected,'author'),keys:value&&typeof value==='object'?Object.keys(value).slice(0,30):[],nested:value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k,v])=>v&&typeof v==='object'&&/^(0|1|current|value|state|item)$/.test(k)).map(([k,v])=>[k,Object.keys(v).slice(0,20)])):undefined})}}
  out.push({depth:i,props:p&&typeof p==='object'?Object.keys(p).slice(0,50):[],hooks,value:p&&typeof own(p,'value')==='object'?Object.keys(own(p,'value')||{}).slice(0,25):[]});
 }
 const embedded=document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');let scope={};
 try{scope=JSON.parse(embedded?.textContent||'{}').__DEFAULT_SCOPE__||{}}catch{}
 return {placeholderFound:!!placeholder,fiber:out,itemModule:!!window.SIGI_STATE?.ItemModule,scopeKeys:Object.keys(scope),feedShape:Object.fromEntries(Object.entries(scope).filter(([k])=>/recommend|feed/.test(k)).map(([k,v])=>[k,Object.keys(v||{})]))};
})()
