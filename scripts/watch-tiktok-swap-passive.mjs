import {writeFileSync} from 'node:fs';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
async function connect(page){
 if(!page)throw Error('Required live WebView missing');
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}};
 return {ws,read:expression=>new Promise((r,j)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);j(Error('snapshot timeout'))},5000);pending.set(n,m=>{clearTimeout(t);m.result?.exceptionDetails?j(Error('evaluation failed')):r(m.result?.result?.value)});ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}))})};
}
const tiktok=await connect(pages.find(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com'));
const pong=await connect(pages.find(p=>p.type==='page'&&new URL(p.url).pathname==='/pong'));
await tiktok.read(`(()=>{window.__pongPassiveGestureAt=0;addEventListener('touchstart',()=>window.__pongPassiveGestureAt=Date.now(),{capture:true,passive:true});const mute=()=>document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0});mute();window.__pongSilentAudit?.disconnect();window.__pongSilentAudit=new MutationObserver(mute);window.__pongSilentAudit.observe(document.documentElement,{childList:true,subtree:true});return true})()`);
const start=Date.now(),samples=[];let lastCard='',lastPrint=0,lastBackend=0,backend={};
console.log(JSON.stringify({recording:true,durationSeconds:120,passive:true}));
try{while(Date.now()-start<120000){
 const screen=await tiktok.read(`(()=>{const cards=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];const c=cards.reduce((a,b)=>!a||Math.abs(b.getBoundingClientRect().top)<Math.abs(a.getBoundingClientRect().top)?b:a,null);const s=window.__pongDomSwap,v=c?.querySelector('video:not(.pong-tiktok-swap-stream)');return {card:c?.id,gestureAt:window.__pongPassiveGestureAt,originalReady:v?.readyState,originalTime:v?.currentTime,session:s?.sessionId,visible:!!s?.visible,overlayReady:s?.overlay?.readyState,overlayTime:s?.overlay?.currentTime,ageMs:s?performance.now()-s.createdAt:0}})()`);
 if(Date.now()-lastBackend>=1000){lastBackend=Date.now();backend=await pong.read(`(async()=>{const w=pongFaceSwapCurrentWrapper(),id=w?.dataset.pongFaceSwapSessionId;if(!id)return {session:null};const r=await pongFaceSwapBackgroundFetch('/pong-swap/sessions/'+encodeURIComponent(id),{cache:'no-store'});const p=await r.json().catch(()=>({})),s=p.session||{};return {session:id,http:r.status,frames:s.frames,transformed:s.transformedFrames,reason:s.multiFace?.reason,state:s.state}})()`);}
 const row={at:Date.now()-start,...screen,backend};samples.push(row);
 if(screen.card!==lastCard||Date.now()-lastPrint>=5000){console.log(JSON.stringify(row));lastCard=screen.card;lastPrint=Date.now();}
 await new Promise(r=>setTimeout(r,250));
}}finally{tiktok.ws.close();pong.ws.close();const path='C:/Users/arian/Documents/New project/tiktok-passive-swap-'+start+'.json';writeFileSync(path,JSON.stringify({start,samples},null,2));console.log(JSON.stringify({saved:path,samples:samples.length,durationMs:Date.now()-start}));}
