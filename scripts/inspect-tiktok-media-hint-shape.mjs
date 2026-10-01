import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const client=await connectWebView(60195,'tiktok');
try {
 const source=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 const helper=source.slice(source.indexOf('  const reactVideo ='),source.indexOf('  const itemUrl ='))
  .replace("return canonical('/@' + author + '/video/' + id);",'return item;');
 console.log(JSON.stringify(await client.read(`(()=>{const canonical=x=>x;${helper};
 const shape=(x,depth=0)=>{if(depth>4)return typeof x;if(typeof x==='string')return /^https?:/.test(x)?{urlHost:(()=>{try{return new URL(x).hostname}catch{return ''}})()}:x.length<50?x:'string';if(Array.isArray(x))return x.slice(0,6).map(v=>shape(v,depth+1));if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).slice(0,24).map(k=>[k,shape(Object.getOwnPropertyDescriptor(x,k)?.value,depth+1)]));return x};
 return [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')].filter(c=>c.querySelector('video')).slice(0,3).map(card=>{const item=reactVideo(card);return {id:item?.id,video:shape(item?.video)}})})()`)));
} finally {client.close();}
