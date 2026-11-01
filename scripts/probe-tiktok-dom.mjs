// Read-only TikTok WebView DOM probe: control names/labels/geometry only. No pixels, no text content.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const port=Number(process.env.PONG_CDP_PORT||9222);
const tik=await connectWebView(port,'tiktok');
try{
 const out=await tik.read(`(()=>{
  const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'};
  const desc=e=>({tag:e.tagName,e2e:e.getAttribute('data-e2e'),aria:e.getAttribute('aria-label'),testid:e.getAttribute('data-testid'),cls:String(e.className).slice(0,60),visible:vis(e),disabled:!!(e.disabled||e.getAttribute('aria-disabled')==='true'),rect:(r=>[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)])(e.getBoundingClientRect())});
  const buttons=[...document.querySelectorAll('button,[role="button"],a[data-e2e]')].filter(e=>e.getAttribute('data-e2e')||e.getAttribute('aria-label')).map(desc);
  const nav=buttons.filter(b=>/arrow|next|prev|navigation|close|back/i.test([b.e2e,b.aria].join(' ')));
  const filters=[...document.querySelectorAll('[data-e2e*="filter" i],[class*="Filter"],[class*="SearchTab"],[data-e2e*="search" i],[role="tab"]')].map(desc).slice(0,30);
  const roots=['[data-e2e="recommend-list-item-container"]','[data-e2e="browse-video"]','[class*="DivCinemaModeRoot"]','[data-pong-browse-root]','[data-e2e="search_video-item"]','[data-e2e="search-common-link"]','[class*="DivBrowserModeContainer"]','[class*="DivVideoContainer"]'].map(s=>({sel:s,count:document.querySelectorAll(s).length}));
  const videos=[...document.querySelectorAll('video')].map(v=>({cls:String(v.className).slice(0,40),w:v.videoWidth,h:v.videoHeight,paused:v.paused,ready:v.readyState,rect:(r=>[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)])(v.getBoundingClientRect())}));
  return {path:location.pathname.slice(0,40),search:location.search.slice(0,80),page:document.documentElement.dataset.pongNativePage,discover:document.documentElement.hasAttribute('data-pong-discover'),innerWidth,innerHeight,nav,filters,roots,videos,buttonCount:buttons.length,e2eNames:[...new Set(buttons.map(b=>b.e2e).filter(Boolean))].slice(0,60)};
 })()`);
 console.log(JSON.stringify(out,null,1));
}finally{tik.close()}
