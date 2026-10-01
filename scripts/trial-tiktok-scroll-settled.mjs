// Disposable experiment: keep TikTok's actual Next handler and settle only its
// measured cinema scroll viewport. Never wrap native Element prototypes.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/scroll-settled-${Date.now()}.json`;
const result={};
const originalOnly=process.argv.includes('--original-only');
try {
 if(originalOnly)await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 result.installed=await tik.read(`(()=>{
  const previous=window.__pongTikTokStep,events=[];let epoch=0;
  window.__pongScrollSettledEvents=events;
  window.__pongUndoScrollSettled=()=>{epoch++;window.__pongTikTokStep=previous;delete window.__pongUndoScrollSettled;};
  window.__pongTikTokStep=direction=>{
   const root=document.querySelector('[class*="DivCinemaModeRoot"]');
   const media=root&&[...root.querySelectorAll('video:not(.pong-tiktok-swap-stream),img[class*="ImgPhotoSlide"]')].find(v=>v.tagName==='VIDEO'&&!v.paused)
     ||root?.querySelector('img[class*="ImgPhotoSlide"]');
   let scroll=media;
   while(scroll&&scroll!==root&&!(scroll.scrollHeight>scroll.clientHeight+20&&getComputedStyle(scroll).overflowY==='auto'))scroll=scroll.parentElement;
   let target=null;
   if(scroll&&scroll!==root){
    const cards=[...(scroll.firstElementChild?.children||[])],top=scroll.getBoundingClientRect().top;
    const active=cards.reduce((a,b)=>!a||Math.abs(b.getBoundingClientRect().top-top)<Math.abs(a.getBoundingClientRect().top-top)?b:a,null);
    const next=cards[cards.indexOf(active)+(direction>0?1:-1)];
    if(next&&Math.abs(next.getBoundingClientRect().height-scroll.clientHeight)<3)target=scroll.scrollTop+next.getBoundingClientRect().top-top;
   }
   const ticket=++epoch,result=previous(direction);
   if(result&&target!==null){
    // Cancel the just-requested smooth scroll with the same observed target.
    // Scroll dispatch updates the site's listener, followed by an actual-frame
    // boundary before notifying it that this instant movement has settled.
    scroll.scrollTo({top:target,behavior:'instant'});
    scroll.dispatchEvent(new Event('scroll'));
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
     if(epoch!==ticket||!scroll.isConnected||!root.isConnected||Math.abs(scroll.scrollTop-target)>3)return;
     scroll.dispatchEvent(new Event('scrollend'));
     events.push({at:performance.now(),target,actual:scroll.scrollTop});
     window.__pongTikTokScan?.();
    }));
   }
   return result;
  };return true;
 })()`);
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','8','--videos',...(originalOnly?['--original-only']:[])],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:process.env.PONG_AUDIT_SAMPLE_MS||'100',PONG_AUDIT_VARIANT:(process.env.PONG_AUDIT_VARIANT_PREFIX||'29.13')+'-native-click-instant-scrollend-trial'+(originalOnly?'-original-only':'')}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 result.events=await tik.read('window.__pongScrollSettledEvents');
}finally{
 await tik.read('window.__pongUndoScrollSettled?.();true').catch(()=>{});
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
