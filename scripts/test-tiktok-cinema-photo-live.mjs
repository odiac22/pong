import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const result={started:new Date().toISOString(),pass:false};
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await tik.read(`document.querySelector('[data-e2e="cinema-mode-exit"]')?.click()`);
 await pause(500);
 result.opened=await tik.read(`(()=>{const a=[...document.querySelectorAll('[data-e2e="user-post-item"] a')].find(a=>a.getClientRects().length&&new URL(a.href).pathname.includes('/photo/'));if(!a)return {opened:false};a.click();return {opened:true,path:new URL(a.href).pathname};})()`);
 if(!result.opened.opened)throw Error('No actual creator photo link available');
 for(let i=0;i<75;i++){
  result.view=await tik.read(`({path:location.pathname,photo:!![...document.querySelectorAll('img[class*="ImgPhotoSlide"]')].find(e=>{const r=e.getBoundingClientRect();return r.width>100&&r.height>100&&r.top<innerHeight&&r.bottom>0}),cinema:!!document.querySelector('[data-e2e="cinema-mode-exit"]')})`);
  result.feed=await pong.read(`({activeVideo:pongTikTokLiveState.activeVideo,current:pongTikTokLiveState.current,next:pongTikTokLiveState.next,urls:pongTikTokLiveState.urls})`);
  if(result.view.photo&&result.view.path===result.opened.path&&result.feed.activeVideo===false&&result.feed.next)break;
  await pause(200);
 }
 result.expected=await tik.read(String.raw`(()=>{const posts=[...document.querySelectorAll('[data-e2e="user-post-item"] a')].map(a=>new URL(a.href)).filter(u=>/^\/@[^/]+\/(video|photo)\/\d+$/.test(u.pathname)).map(u=>u.origin+u.pathname).filter((u,i,a)=>a.indexOf(u)===i);const at=posts.findIndex(u=>new URL(u).pathname===location.pathname);return at<0?[]:posts.slice(at+1).filter(u=>u.includes('/video/')).slice(0,3);})()`);
 // Pong retains the outgoing wrapper identity for ownership/cleanup; only
 // activeVideo=false is authoritative about whether a photo is a swap target.
 result.pass=result.view.photo&&result.view.cinema&&result.feed.activeVideo===false&&result.expected.length>0&&JSON.stringify(result.feed.urls)===JSON.stringify(result.expected)&&result.feed.next===result.expected[0];
 if(!result.pass)process.exitCode=1;
}catch(e){result.error=e.message;process.exitCode=1;}finally{
 tik.close();pong.close();const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/cinema-photo-live-${Date.now()}.json`;
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
