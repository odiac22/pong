import {execFileSync} from 'node:child_process';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}};
const evaluate=expression=>new Promise((r,j)=>{const key=++id,t=setTimeout(()=>j(Error('CDP timeout')),8000);pending.set(key,m=>{clearTimeout(t);r(m?.result?.value)});ws.send(JSON.stringify({id:key,method:'Runtime.evaluate',params:{expression,returnByValue:true}}))});
await evaluate(`(()=>{const mute=()=>document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0});mute();window.__pongSilentAudit?.disconnect();window.__pongSilentAudit=new MutationObserver(mute);window.__pongSilentAudit.observe(document.documentElement,{childList:true,subtree:true})})()`);
const start=Date.now();let lastSwipe=0;const cardsSeen=new Set();let swipes=0,previousCard=null,changes=0,notReady=0;
while(Date.now()-start<120000){
 const elapsed=Date.now()-start;
 if(elapsed>=lastSwipe+10000&&elapsed<111000){lastSwipe=elapsed;swipes++;execFileSync(adb,['shell','input','swipe','950','1550','950','500','400']);console.log(JSON.stringify({swipeAt:Date.now()-start}));}
 const state=await evaluate(`(()=>{const cards=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];const active=cards.reduce((a,b)=>!a||Math.abs(b.getBoundingClientRect().top)<Math.abs(a.getBoundingClientRect().top)?b:a,null);const v=active?.querySelector('video:not(.pong-tiktok-swap-stream)');const s=document.querySelector('video.pong-tiktok-swap-stream');return {card:active?.id,cards:cards.length,scroll:document.getElementById('column-list-container')?.scrollTop,ready:v?.readyState,paused:v?.paused,time:v?.currentTime,swapVisible:window.__pongDomSwap?.visible,swapReady:s?.readyState,swapTime:s?.currentTime}})()`);
 if(state?.card)cardsSeen.add(state.card);if(previousCard&&state?.card!==previousCard)changes++;previousCard=state?.card;if(state?.ready<2)notReady++;
 console.log(JSON.stringify({at:Date.now()-start,...state}));await new Promise(r=>setTimeout(r,1000));
}
console.log(JSON.stringify({summary:true,durationMs:Date.now()-start,swipes,distinctCards:cardsSeen.size,changes,notReadySamples:notReady}));
ws.close();
