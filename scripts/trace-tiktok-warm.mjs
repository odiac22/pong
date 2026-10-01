import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const t=await connectWebView(60195,'tiktok'),p=await connectWebView(60195,'pong');
try{
 await t.read(`(()=>{const base=window.__pongDomSwapPrepare;window.__pongDomSwapPrepare=(...args)=>{window.__pongWarmAttempt={at:performance.now(),id:args[1]};return base(...args)};return typeof base})()`);
 console.log(await p.read('schedulePongFaceSwapPrefetch(0);true'));
 await new Promise(r=>setTimeout(r,2000));
 console.log(await t.read(`({attempt:window.__pongWarmAttempt,error:window.__pongDomSwapLastError,warm:window.__pongDomSwapWarm?{id:window.__pongDomSwapWarm.sessionId,ready:window.__pongDomSwapWarm.overlay.readyState,transport:window.__pongDomSwapWarm.transport}:null})`));
}finally{t.close();p.close()}
