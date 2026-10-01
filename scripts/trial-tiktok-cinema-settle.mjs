import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok');
const scrollOnly=process.argv.includes('--scroll-only');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/cinema-settle-trial-${Date.now()}.json`;
try {
 const installed=await tik.read(`(()=>{
  const previous=window.__pongTikTokStep;
  window.__pongCinemaSettleTrial=[];
  window.__pongUndoCinemaSettleTrial=()=>{window.__pongTikTokStep=previous;delete window.__pongUndoCinemaSettleTrial;};
  window.__pongTikTokStep=direction=>{
   const root=document.querySelector('[class*="DivCinemaModeRoot"]');
   const video=root&&[...root.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].find(v=>!v.paused);
   let scroll=video;
   while(scroll&&scroll!==root&&!(scroll.scrollHeight>scroll.clientHeight+20&&getComputedStyle(scroll).overflowY==='auto'))scroll=scroll.parentElement;
   let target=null;
   if(scroll&&scroll!==root){const list=scroll.firstElementChild;const cards=[...(list?.children||[])];
    const top=scroll.getBoundingClientRect().top;
    const active=cards.reduce((a,b)=>!a||Math.abs(b.getBoundingClientRect().top-top)<Math.abs(a.getBoundingClientRect().top-top)?b:a,null);
    const next=cards[cards.indexOf(active)+(direction>0?1:-1)];
    if(next&&Math.abs(next.getBoundingClientRect().height-scroll.clientHeight)<3)target=scroll.scrollTop+next.getBoundingClientRect().top-top;
   }
   if(${scrollOnly}&&target!==null){
    window.__pongDomSwapDepart?.();scroll.scrollTo({top:target,behavior:'instant'});
    window.__pongCinemaSettleTrial.push({at:performance.now(),target,actual:scroll.scrollTop,scrollOnly:true});
    return true;
   }
   const result=previous(direction);
   if(result&&target!==null){const owner=scroll;requestAnimationFrame(()=>{
    if(!owner.isConnected||!root.isConnected)return;
    owner.scrollTo({top:target,behavior:'instant'});
    window.__pongCinemaSettleTrial.push({at:performance.now(),target,actual:owner.scrollTop});
    window.__pongTikTokScan?.();
   });}
   return result;
  };return true;
 })()`);
 const child=spawnSync(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','5','--original-only'],{
  encoding:'utf8',env:{...process.env,PONG_AUDIT_VARIANT:scrollOnly?'29.11-cinema-scroll-only-trial':'29.11-cinema-native-click-then-settle-trial'},timeout:70000});
 const record={installed,status:child.status,stdout:child.stdout,stderr:child.stderr,settles:await tik.read('window.__pongCinemaSettleTrial')};
 writeFileSync(output,JSON.stringify(record,null,2));console.log(JSON.stringify({saved:output,...record}));
}finally{await tik.read('window.__pongUndoCinemaSettleTrial?.();true').catch(()=>{});tik.close();}
