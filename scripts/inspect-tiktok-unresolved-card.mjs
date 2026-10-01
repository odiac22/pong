import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const t=await connectWebView(60196,'tiktok');
try{console.log(JSON.stringify(await t.read(`(()=>{
 const own=(o,k)=>{try{return Object.getOwnPropertyDescriptor(o,k)?.value}catch{}};
 const v=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].find(v=>{const r=v.getBoundingClientRect();return r.top<200&&r.bottom>innerHeight/2});
 const c=v?.closest('[data-e2e="recommend-list-item-container"]');if(!c)return {card:false};
 const keys=Object.keys(c).filter(k=>k.startsWith('__react'));
 const found=[],queue=keys.map(k=>({o:own(c,k),path:k,d:0})),seen=new WeakSet();
 for(let cursor=0;cursor<queue.length&&cursor<1500;cursor++){
  const {o,path,d}=queue[cursor];if(!o||typeof o!=='object'||seen.has(o))continue;seen.add(o);
  const id=own(o,'id'),author=own(o,'author');
  if(typeof id==='string'&&/^\\d{15,22}$/.test(id))found.push({path,id,keys:Object.keys(o),shareLink:typeof own(o,'shareLink')==='string'?own(o,'shareLink').split('?')[0]:null,authorType:typeof author,authorKeys:author&&typeof author==='object'?Object.keys(author):[],name:typeof author==='object'?own(author,'uniqueId'):author,isAd:own(o,'isAd'),photo:!!own(o,'imagePost')});
  if(d>=9)continue;
  for(const k of Object.keys(o).slice(0,70))if(!['return','stateNode','ownerDocument','_owner','ref'].includes(k)){
   const x=own(o,k);if(x&&typeof x==='object'&&queue.length<2000)queue.push({o:x,path:path+'.'+k,d:d+1});
  }
 }
 return {hidden:document.hidden,post:window.__pongTikTokPostEvidence?.kind,cardAttributes:[...c.attributes].map(a=>[a.name,a.value]),found,queueLength:queue.length};
})()`),null,2));}finally{t.close()}
