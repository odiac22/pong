import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60195,'tiktok');
try{
 await c.read(`window.__pongEventDrivenReveal=${process.env.PONG_AUDIT_EVENT_HANDOFF==='1'}`);
 await c.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();window.__pongDomSwapInstalled=false');
 await c.read(readFileSync('android-app/app/src/main/assets/tiktok-stream.js','utf8'));
 console.log(await c.read(readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8')));
 console.log(await c.read(readFileSync('android-app/app/src/main/assets/tiktok-phone-fit.js','utf8')));
}finally{c.close()}
