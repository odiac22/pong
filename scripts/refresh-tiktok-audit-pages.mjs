// Reload documents only: never clear TikTok cookies/login or Pong selections.
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/refresh-${Date.now()}.json`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={loginStorageCleared:false};
try {
 result.paused=await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 const route=await tik.read('location.pathname');
 const start=performance.now();
 await tik.call('Page.reload',{ignoreCache:false});
 await pong.call('Page.reload',{ignoreCache:false});
 const deadline=performance.now()+30000;
 while(performance.now()<deadline){
  const state=await tik.read(`({ready:document.readyState==='complete'&&typeof window.__pongTikTokStep==='function',challenge:!!document.querySelector('#captcha-verify-container,[class*=captcha-drag-icon]')})`);
  if(state.challenge)throw Error('Verification appeared; not bypassed');
  if(state.ready&&await pong.read(`typeof window.PongTikTokLiveSwapCurrent==='function'`)){
   result.readyMs=performance.now()-start;break;
  }
  await pause(200);
 }
 if(!result.readyMs)throw Error('Refreshed WebViews did not initialize');
 result.sameRoute=route===await tik.read('location.pathname');
 result.transparentControls=await pong.read(`document.documentElement.classList.contains('pong-tiktok-original-overlay')`);
 result.pass=result.sameRoute&&result.transparentControls;
}catch(error){result.error=error.message;process.exitCode=1}
finally{pong.close();tik.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));}
