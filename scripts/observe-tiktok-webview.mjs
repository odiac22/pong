// Read-only, bounded diagnostics. Never log cookies, headers, bodies or URL queries.
const port=Number(process.argv[2]), seconds=Number(process.argv[3]||30);
const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
const targets=pages.filter(p=>{try{return p.type==='page'&&/(^|\.)tiktok\.com$/.test(new URL(p.url).hostname);}catch{return false;}});
console.log(JSON.stringify({tiktokTargets:targets.length,totalTargets:pages.length}));
if(targets.length!==1)process.exit(1);
const ws=new WebSocket(targets[0].webSocketDebuggerUrl), pending=new Map(), requests=new Map();let id=0;
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
const route=raw=>{try{const u=new URL(raw);return {host:u.hostname,path:u.pathname.replace(/\/@[^/]+/g,'/@profile').replace(/\d{8,}/g,':id')};}catch{return {};}};
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);p(m.result);}return;}
 const p=m.params||{};
 if(m.method==='Network.requestWillBeSent')requests.set(p.requestId,{...route(p.request.url),type:p.type});
 if(m.method==='Network.responseReceived'&&(['Fetch','XHR','Document','Media'].includes(p.type)||p.response.status>=400))console.log(JSON.stringify({event:'response',...route(p.response.url),status:p.response.status,type:p.type}));
 if(m.method==='Network.loadingFailed')console.log(JSON.stringify({event:'failed',...requests.get(p.requestId),error:p.errorText,blocked:p.blockedReason,canceled:p.canceled}));
};
const send=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);ws.send(JSON.stringify({id:n,method,params}));setTimeout(()=>{if(pending.delete(n))resolve({timeout:true});},5000).unref();});
await send('Network.enable');
const expression=`(()=>({path:location.pathname.replace(/\\/@[^/]+/g,'/@profile').replace(/\\d{8,}/g,':id'),ready:document.readyState,ua:navigator.userAgent,videos:[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,network:v.networkState,paused:v.paused,time:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,error:v.error?.code||0,width:v.videoWidth,height:v.videoHeight,visible:v.getBoundingClientRect().height>0})),prompts:{app:/Get the full app experience|Open TikTok|Not now/.test(document.body.innerText),login:/Log in to TikTok|Log in or sign up/.test(document.body.innerText)},profileLinks:document.querySelectorAll('a[href*="/video/"]').length,resources:performance.getEntriesByType('resource').filter(r=>/\\/api\\//.test(r.name)).slice(-12).map(r=>({path:new URL(r.name).pathname,duration:Math.round(r.duration),bytes:r.transferSize,status:r.responseStatus}))}))()`;
async function snapshot(){const r=await send('Runtime.evaluate',{expression,returnByValue:true});console.log(JSON.stringify({event:'snapshot',data:r?.result?.value||r}));}
await snapshot();const timer=setInterval(()=>void snapshot(),5000);
await new Promise(r=>setTimeout(r,seconds*1000));clearInterval(timer);ws.close();
