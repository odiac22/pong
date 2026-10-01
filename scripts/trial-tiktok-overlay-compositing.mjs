// No source/model/codec change. Measure redundant backdrop blur on Pong's
// transparent toolbar (the TikTok pixels are in a separate native WebView).
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/overlay-compositing-${Date.now()}.json`;
const result={experimental:true};
try{
 result.installed=await pong.read(`(()=>{
  const selectors=['#save-current-video-button','#save-current-artist-button','#repair-saved-links-button','#auto-skip-video-button','#skip-current-video-button','#paste-nav-button','#remove-saved-button','#pong-face-swap-button','.show-controls-button','.random-sort-button','.duration-sort-button','.refresh-button','.autoplay-button','.update-app-button','.auto-scroll-button','.erome-checkpoint-button','.clear-played-history-button','#skip-played-filter-button','#pong-face-detect-button','#pong-server-toggle','#pong-collection-save-button'];
  const before=selectors.map(selector=>{const e=document.querySelector(selector);return e?{selector,filter:getComputedStyle(e).backdropFilter}:null}).filter(Boolean);
  const style=document.createElement('style');style.id='pong-toolbar-compositor-trial';
  style.textContent=selectors.map(s=>'html.pong-tiktok-original-overlay '+s).join(',')+'{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
  document.head.appendChild(style);return before;
 })()`);
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','8','--videos'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'1000',PONG_AUDIT_VARIANT:'29.13-toolbar-no-backdrop-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}finally{
 await pong.read('document.getElementById("pong-toolbar-compositor-trial")?.remove();true').catch(()=>{});
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
