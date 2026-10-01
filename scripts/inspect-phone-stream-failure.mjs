import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60196,'pong');
const safe=(k,v)=>/url|path|title|name|source|key/i.test(k)?undefined:v;
try {
 const state=await c.read(`(()=>{const w=pongFaceSwapCurrentWrapper();const v=w?.querySelector('video');return {src:v?.currentSrc,session:w?.dataset.pongFaceSwapSessionId,metadata:typeof videoMetadata!=='undefined'?videoMetadata[Number(w?.dataset.index)]:null}})()`);
 console.log('metadata',JSON.stringify(state.metadata,safe));
 console.log('clock',JSON.stringify(await c.read(`(()=>{const w=pongFaceSwapCurrentWrapper(),v=w?.querySelector('video');return JSON.parse(JSON.stringify({dataset:w?.dataset,original:v?.__pongSwapOriginal,current:v?.currentTime,duration:v?.duration},(k,v)=>/url|path|title|name|source|image/i.test(k)?undefined:v))})()`)));
 if(state.session){const r=await fetch('http://127.0.0.1:8787/pong-swap/sessions/'+state.session);console.log('session',r.status,JSON.stringify(await r.json(),safe));}
 if(state.src){const u=new URL(state.src);u.host='127.0.0.1:8787';const r=await fetch(u,{method:'HEAD',signal:AbortSignal.timeout(10000)});console.log('streamHEAD',r.status,Object.fromEntries([...r.headers].filter(([k])=>/content-|accept-ranges/.test(k))));}
} finally {c.close()}
