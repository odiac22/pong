import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60195,'tiktok');
try{
 await c.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();window.__pongDomSwapInstalled=false;window.__pongDirectDecoderTrial=true');
 for(const file of ['tiktok-avc-fragments.js','tiktok-direct-decoder.js','tiktok-stream.js','tiktok-frame-sync.js'])await c.read(readFileSync('android-app/app/src/main/assets/'+file,'utf8'));
 console.log(JSON.stringify({trial:true,emulatorOnly:true,productionDefaultUnchanged:true}));
}finally{c.close()}
