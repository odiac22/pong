import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const page=await connectWebView(60195,'tiktok');
try{const r=await page.call('Page.captureScreenshot',{format:'png'});writeFileSync('E:/Pong Benchmarks/tiktok-profile-check.png',Buffer.from(r.data,'base64'));console.log('E:/Pong Benchmarks/tiktok-profile-check.png')}finally{page.close()}
