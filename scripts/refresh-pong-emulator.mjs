import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const page=await connectWebView(60195,'pong');
try{await page.call('Page.reload',{ignoreCache:true});console.log('Pong refreshed; TikTok login storage unchanged.')}finally{page.close()}
