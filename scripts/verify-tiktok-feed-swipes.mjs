import {execFileSync} from 'node:child_process';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com');
if(!page)throw Error('TikTok WebView unavailable');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const call=(method,params={})=>new Promise((r,j)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);j(Error(method+' timeout'));},10000);pending.set(key,m=>{clearTimeout(timer);m.error?j(Error(m.error.message)):r(m.result);});ws.send(JSON.stringify({id:key,method,params}));});
const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true})).result?.value;
try{
 ws.send(JSON.stringify({id:100000,method:'Input.dispatchTouchEvent',params:{type:'touchCancel',touchPoints:[]}}));
 await evaluate(`(()=>{const mute=()=>document.querySelectorAll('video,audio').forEach(v=>v.muted=true);mute();window.__pongSilentAudit?.disconnect();window.__pongSilentAudit=new MutationObserver(mute);window.__pongSilentAudit.observe(document.documentElement,{childList:true,subtree:true});})()`);
 const seen=new Set(),samples=[];
 for(let i=0;i<5;i++){
  const s=await evaluate(`(()=>{const v=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].sort((a,b)=>{const area=v=>{const r=v.getBoundingClientRect();return Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))*r.width};return area(b)-area(a)})[0];return {key:v?.currentSrc||'',w:innerWidth,h:innerHeight,ready:v?.readyState,time:v?.currentTime,cards:document.querySelectorAll('[data-e2e="recommend-list-item-container"]').length,desktop:navigator.userAgent.includes('Windows NT'),layout:!!document.getElementById('pong-tiktok-phone-fit-trial')};})()`);
  if(s.key)seen.add(s.key);delete s.key;samples.push(s);
  if(i===4)break;
  execFileSync(adb,['shell','input','swipe','997','1600','997','440','260']);
  await new Promise(r=>setTimeout(r,2400));
 }
 console.log(JSON.stringify({distinctVideoSources:seen.size,samples}));
}finally{ws.close();}
