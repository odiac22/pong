import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
async function connect(page){
 if(!page)throw Error('Live WebView missing');
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m);pending.delete(m.id)};
 return {ws,read:expression=>new Promise((r,j)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);j(Error('snapshot timeout'))},5000);pending.set(n,m=>{clearTimeout(t);m.result?.exceptionDetails?j(Error('evaluation failed')):r(m.result?.result?.value)});ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}))})};
}
const tik=await connect(pages.find(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com'));
const pong=await connect(pages.find(p=>p.type==='page'&&new URL(p.url).pathname==='/pong'));
const state=`(()=>{const s=window.__pongDomSwap;return {session:s?.sessionId,visible:!!s?.visible,time:s?.overlay?.currentTime,originalTime:s?.original?.currentTime,ready:s?.overlay?.readyState,seeking:s?.overlay?.seeking,buffered:s?.overlay?[...Array(s.overlay.buffered.length)].map((_,i)=>[s.overlay.buffered.start(i),s.overlay.buffered.end(i)]):[],age:s?performance.now()-s.createdAt:0}})()`;
const backend=`(async()=>{const id=pongFaceSwapCurrentWrapper()?.dataset.pongFaceSwapSessionId;if(!id)return {};const r=await pongFaceSwapBackgroundFetch('/pong-swap/sessions/'+encodeURIComponent(id),{cache:'no-store'}),p=await r.json(),s=p.session||{};return {session:id,status:r.status,state:s.state,profile:s.restorationProfile,adaptive:s.adaptiveRestoration,frames:s.frames,transformed:s.transformedFrames,created:s.createdAt,firstTransformed:s.firstTransformedFrameAt,firstByte:s.firstByteAt}})()`;
const started=Date.now(),trials=[];
try{
 await tik.read(`(()=>{const mute=()=>document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0});mute();window.__pongSilentAudit?.disconnect();window.__pongSilentAudit=new MutationObserver(mute);window.__pongSilentAudit.observe(document.documentElement,{childList:true,subtree:true});return true})()`);
 for(let n=0;n<5;n++){
  const before=await tik.read(state),start=Date.now(),samples=[];let firstVisible=null,lastBackend=0,b={};
  execFileSync(adb,['shell','input','swipe','950','1550','950','500','300']);
  while(Date.now()-start<12000){
   const s=await tik.read(state);
   if(Date.now()-lastBackend>500){b=await pong.read(backend);lastBackend=Date.now()}
   const at=Date.now()-start;samples.push({at,...s,backend:b});
   if(firstVisible===null&&s.session&&s.session!==before.session&&s.visible&&s.session===b.session&&b.transformed>0)firstVisible=at;
   await new Promise(r=>setTimeout(r,150));
  }
  const trial={trial:n+1,firstVisibleMs:firstVisible,samples};trials.push(trial);
  console.log(JSON.stringify({trial:n+1,firstVisibleMs:firstVisible,lastBackend:b}));
 }
}finally{tik.ws.close();pong.ws.close();const path='C:/Users/arian/Documents/New project/tiktok-adaptive-live-'+started+'.json';writeFileSync(path,JSON.stringify({started,trials},null,2));console.log(JSON.stringify({saved:path,trials:trials.length}));}
