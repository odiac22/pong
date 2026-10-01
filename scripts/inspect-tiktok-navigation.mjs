import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const p=await connectWebView(60195,'tiktok');
try{console.log(JSON.stringify(await p.read(`(()=>({
 path:location.pathname,
 next:!!document.querySelector('button[aria-label="Next video"],[data-e2e="feed-navigation-next"]'),
 cinema:!!document.querySelector('[data-e2e="cinema-mode-exit"]'),
 grid:document.querySelectorAll('[data-e2e="user-post-item"]').length,
 cards:document.querySelectorAll('[data-e2e="recommend-list-item-container"]').length,
 videos:document.querySelectorAll('video:not(.pong-tiktok-swap-stream)').length,
 challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'),
 step:typeof window.__pongTikTokStep}))()`)));}finally{p.close()}
