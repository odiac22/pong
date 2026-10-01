// Diagnostic only: revisit the one already-observed, saved clip. No account writes.
import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const stored=JSON.parse(readFileSync('E:/Pong Benchmarks/tiktok-webview-2026-09-29/host-decoder-paired-source.json','utf8'));
const source=new URL(stored.pages?.[0]);
if(source.origin!=='https://www.tiktok.com'||!/^\/@[^/]+\/video\/\d{15,22}$/.test(source.pathname)||source.search||source.hash)
 throw Error('Expected a saved canonical TikTok video');
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
try{
 console.log(await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')));
 await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
 await tik.call('Page.navigate',{url:source.href});
 let ready=false;
 for(let i=0;i<30;i++){
  await new Promise(r=>setTimeout(r,500));
  const status=await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
   document.querySelectorAll('video').forEach(e=>{e.muted=true;e.defaultMuted=true;e.volume=0});
   return {challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'),
    ready:location.pathname===${JSON.stringify(source.pathname)}&&!!v?.isConnected&&v.readyState>=2&&!v.paused,
    width:v?.videoWidth,height:v?.videoHeight};})()`);
  if(status.challenge)throw Error('Verification requires user; no scored diagnostic started');
  if(status.ready){ready=true;console.log(status);break;}
 }
 if(!ready)throw Error('Saved video did not become ready');
 const selection=await pong.read('({selected:pongFaceSwapFaceIds().length,enabled:pongFaceSwapState.enabled})');
 if(!selection.selected||selection.enabled)throw Error('Expected existing approved selections with swap off');
 console.log({ready:true,selected:selection.selected});
}finally{pong.close();tik.close()}
