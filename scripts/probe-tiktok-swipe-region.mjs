// Read-only: what the native swipe interception sees on the current TikTok page (geometry/flags only).
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(Number(process.env.PONG_CDP_PORT||9222),'tiktok');
const pong=await connectWebView(Number(process.env.PONG_CDP_PORT||9222),'pong');
try{
 const t=await tik.read(`(()=>{const R=e=>{if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};
  const o=window.__pongTikTokObservedVideo;const root=document.querySelector('[data-pong-browse-root]');
  return {path:location.pathname.slice(0,30),observed:!!o,observedVideo:R(o?.video),observedPageUrlKind:o?.pageUrl?'set':'none',postKind:window.__pongTikTokPostEvidence?.kind,
   browseRoot:R(root),browseVideo:R(root?.querySelector('video')),closeButton:!!document.querySelector('[data-e2e="browse-close"]'),
   arrows:[...document.querySelectorAll('button[data-e2e="arrow-left"],button[data-e2e="arrow-right"]')].map(b=>({e2e:b.dataset.e2e,rect:R(b),disabled:b.disabled})),
   touchInfo:typeof window.__pongTikTokTouchInfo,step:typeof window.__pongTikTokStep,begin:typeof window.__pongTikTokBeginGesture,
   probeTouch:window.__pongTikTokTouchInfo?window.__pongTikTokTouchInfo(.5,.5):null,
   scrollY:scrollY,docHeight:document.documentElement.scrollHeight,inner:[innerWidth,innerHeight]}})()`);
 const p=await pong.read(`(()=>{const s=window.pongTikTokLiveState||{};return {current:s.current?'set':'none',next:s.next?'set':'none',urls:(s.urls||[]).length,swipeRegion:s.swipeRegion||null,postKind:s.postKind,activeVideo:s.activeVideo}})()`);
 console.log(JSON.stringify({tiktok:t,pong:p}));
}finally{tik.close();pong.close()}
