import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const p=await connectWebView(60195,'tiktok');
try{
 const code=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 const helper=code.slice(code.indexOf('  const reactVideo ='),code.indexOf('  const itemUrl ='));
 console.log(JSON.stringify(await p.read(`(()=>{const canonical=x=>x;${helper};return [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')].map(c=>({id:c.id,top:c.getBoundingClientRect().top,video:c.querySelectorAll('video').length,photos:c.querySelectorAll('img[class*="ImgPhotoSlide"]').length,url:reactVideo(c)}))})()`)));
}finally{p.close()}
