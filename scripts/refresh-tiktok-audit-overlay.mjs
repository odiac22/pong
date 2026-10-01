import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const file=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/overlay-refresh-${Date.now()}.json`;
const result={test:'Pong overlay-only reload; TikTok login/storage untouched',pass:false};
const state=`(()=>({timeOrigin:performance.timeOrigin,path:location.pathname,
  challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'),
  videos:document.querySelectorAll('video:not(.pong-tiktok-swap-stream)').length}))()`;
try{
  result.before=await tik.read(state);const began=performance.now();
  await pong.call('Page.reload',{ignoreCache:true});
  while(performance.now()-began<30000){
    try{
      result.overlay=await pong.read(`(()=>({
        ready:typeof window.PongTikTokLiveIntegratedState==='function',
        transparent:document.documentElement.classList.contains('pong-tiktok-original-overlay'),
        guard:typeof transferForegroundVideoPriority==='function'&&transferForegroundVideoPriority.toString().includes('pongExternalPlaybackAuthority'),
        selected:typeof pongFaceSwapFaceIds==='function'?pongFaceSwapFaceIds().length:0
      }))()`);
      if(result.overlay.ready&&result.overlay.transparent&&result.overlay.guard)break;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  result.reloadMs=performance.now()-began;result.after=await tik.read(state);
  result.pass=!!result.overlay?.ready&&result.overlay.transparent&&result.overlay.guard&&
    result.before.timeOrigin===result.after.timeOrigin&&result.before.path===result.after.path;
}catch(error){result.error=error.message}
finally{pong.close();tik.close();writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:file,...result}));}
