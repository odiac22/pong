// Temporary CDP experiment: desktop request identity, original phone dimensions.
// No CSS/DOM layout replacement, cookie changes, or APK changes.
const port=Number(process.argv[2]);
const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
const matches=pages.filter(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com');
if(matches.length!==1)throw Error('Expected one existing TikTok WebView');
const ws=new WebSocket(matches[0].webSocketDebuggerUrl), pending=new Map();let seq=0;
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(Error(method+' timed out'));},8000).unref();});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Page evaluation failed');return r.result?.value;};
const original=await evaluate(`(async()=>({ua:navigator.userAgent,platform:navigator.platform,width:innerWidth,height:innerHeight,scale:devicePixelRatio,metadata:navigator.userAgentData?await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList']):null}))()`);
const ua=original.ua.replace(/\([^)]*\)/,'(Windows NT 10.0; Win64; x64)').replace(/ Mobile/g,'').replace('Version/4.0 ','');
const metadata=original.metadata?{...original.metadata,platform:'Windows',platformVersion:'10.0.0',architecture:'x86',bitness:'64',model:'',mobile:false}:undefined;
await send('Emulation.setUserAgentOverride',{userAgent:ua,platform:'Win32',...(metadata?{userAgentMetadata:metadata}:{})});
await send('Emulation.setDeviceMetricsOverride',{width:original.width,height:original.height,deviceScaleFactor:original.scale,mobile:false});
await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
// Ensure this diagnostic produces no audible playback when TikTok reloads.
const mute=`(()=>{const silence=()=>document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0});new MutationObserver(silence).observe(document,{childList:true,subtree:true});silence()})()`;
const installed=await send('Page.addScriptToEvaluateOnNewDocument',{source:mute});
await send('Page.navigate',{url:'https://www.tiktok.com/foryou'});
console.log(JSON.stringify({trial:'desktop requests with native TikTok layout',width:original.width,height:original.height,loginStorage:'unchanged',audio:'muted',automaticRestoreSeconds:150}));
async function snapshot(){console.log(JSON.stringify(await evaluate(`(()=>{let s={};try{s=JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent||'{}').__DEFAULT_SCOPE__||{}}catch{}return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,desktopUA:!navigator.userAgent.includes('Mobile'),accountPresent:!!s['webapp.app-context']?.user?.uid,appPrompt:document.body?.innerText.includes('Get the full app experience'),videoCount:document.querySelectorAll('video').length,videos:[...document.querySelectorAll('video')].slice(0,4).map(v=>({duration:Number.isFinite(v.duration)?v.duration:null,ready:v.readyState,paused:v.paused,error:v.error?.code||0}))}})()`)));}
await new Promise(r=>setTimeout(r,6000));await snapshot();
await new Promise(r=>setTimeout(r,9000));await snapshot();
console.log('Trial remains active for user inspection; original request identity will be restored without a reload.');
await new Promise(r=>setTimeout(r,135000));
await send('Emulation.setUserAgentOverride',{userAgent:original.ua,platform:original.platform,...(original.metadata?{userAgentMetadata:original.metadata}:{})});
await send('Emulation.clearDeviceMetricsOverride');
await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:installed.identifier});
console.log('Temporary overrides restored. The displayed page was not reloaded; audio remains muted.');ws.close();
