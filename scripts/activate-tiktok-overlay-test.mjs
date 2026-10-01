import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const page=await connectWebView(60195,'pong');
try{
 await page.read("window.PongTikTokOverlaySetActive?.(false);delete window.PongTikTokOverlaySetActive;document.getElementById('pong-tiktok-original-overlay-style')?.remove();");
 await page.read(readFileSync('android-app/app/src/main/assets/tiktok-pong-overlay.js','utf8'));
 await page.read('window.PongTikTokOverlaySetActive(true)');
 console.log('Current overlay asset applied to test emulator.');
}finally{page.close()}
