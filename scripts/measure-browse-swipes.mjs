// Drives N vertical swipes on the current TikTok viewer and records whether each one advanced the post.
// Metadata only: path change flags, step stats, overlay visibility. No pixels or page text.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
const [transport='',label='browse',count='6']=process.argv.slice(2);
const c=await connectWebView(Number(process.env.PONG_CDP_PORT||9222),'tiktok');
const state=()=>c.read(`(()=>({path:location.pathname.replace(/\\d{6,}/g,'#'),id:(location.pathname.match(/\\/(video|photo)\\/(\\d+)/)||[])[2]||'',stats:window.__pongTikTokStepStats?.(),swap:!!window.__pongDomSwap?.visible,session:(window.__pongDomSwap?.sessionId||'').slice(0,8),arrows:!!document.querySelector('button[data-e2e="arrow-right"]'),feedNext:!!document.querySelector('[data-e2e="feed-navigation-next"]')}))()`);
const size=await c.read('({w:innerWidth*devicePixelRatio,h:innerHeight*devicePixelRatio})');
const adb=transport?['-t',transport]:[];
const rows=[];
try{
 for(let i=0;i<Number(count);i++){
  const before=await state();const t0=Date.now();
  await exec('adb',[...adb,'shell','input','swipe',String(Math.round(size.w*.45)),String(Math.round(size.h*.66)),String(Math.round(size.w*.45)),String(Math.round(size.h*.31)),'110'],{windowsHide:true,timeout:5000});
  let changedAt=null;
  for(let k=0;k<12;k++){await delay(100);const now=await state();if(now.id&&now.id!==before.id){changedAt=Date.now()-t0;break;}}
  const after=await state();
  rows.push({i,beforeId:!!before.id,changed:after.id!==before.id,changedAtMs:changedAt,swapVisibleBefore:before.swap,swapVisibleAfter:after.swap,sessionChanged:after.session!==before.session,arrows:after.arrows,feedNext:after.feedNext,stats:after.stats});
  console.log(JSON.stringify(rows[rows.length-1]));
  await delay(1500);
 }
}finally{c.close();writeFileSync(`E:/Pong Benchmarks/perf-audit-20261101/phone/browse-swipes-${label}.json`,JSON.stringify(rows,null,1));}
