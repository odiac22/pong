import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const page=await connectWebView(60195,'tiktok');
try{
 await page.read(readFileSync('scripts/tiktok-audit-instrument.js','utf8'));
 const start=performance.now();
 const advanced=await page.read('window.__pongTikTokStep(1)');const clickMs=performance.now()-start;
 await new Promise(r=>setTimeout(r,5000));
 const state=await page.read('window.__pongAuditSnapshot()');
 const sorted=state.rafIntervals.toSorted((a,b)=>a-b);
 console.log(JSON.stringify({advanced,clickMs,path:state.path,rafMedianMs:sorted[Math.floor(sorted.length*.5)],rafP95Ms:sorted[Math.floor(sorted.length*.95)],maxRafMs:sorted.at(-1),callbacks:sorted.length,longTasks:state.longTasks,original:state.original}));
 writeFileSync('E:/Pong Benchmarks/tiktok-webview-2026-09-29/ui-baseline.json',JSON.stringify(state,null,2));
}finally{await page.read('window.__pongAuditStop?.()');page.close()}
