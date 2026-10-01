// Actual Pong UI, current Recall 2, original playback only. No screenshots/audio/swap.
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const app='http://127.0.0.1:8787';
const expected=process.argv[2];
if(!expected)throw Error('Expected source page is required');
const channel=Number(process.argv[3]||2);
if(![1,2].includes(channel))throw Error('Recall channel must be 1 or 2');
const out=path.resolve(process.argv[4]||'artifacts/live-userscript-7.26.0');
await mkdir(out,{recursive:true});
const report={silent:true,headless:true,private:true,faceSwap:false,channel,playbackVerified:false,mediaResponses:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const state=await(await fetch(app+'/simpcity/recall?channel='+channel+'&consume=0',{signal:AbortSignal.timeout(5000)})).json();
const videos=state.recall?.genericBundles?.flatMap(b=>b.videos||[])||[];
if(videos.length!==1||videos[0].pageUrl!==expected||state.mediaCapture?.state!=='complete')throw Error('Recall does not match the completed one-video test');
report.receiptDuration=videos[0].durationSeconds;
const resolveOnPc=process.argv.includes('--resolve-on-pc');
if(resolveOnPc){
 const began=performance.now();
 const r=await fetch(app+'/media-page/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:expected}),signal:AbortSignal.timeout(55000)});
 const resolved=await r.json();
 const page=resolved.pages?.find(p=>p.ok&&p.pageUrl===expected&&Math.abs(Number(p.durationSeconds)-Number(videos[0].durationSeconds))<=8);
 if(!page?.videoUrls?.length)throw Error('PC resolver did not return the matching main video');
 Object.assign(videos[0],{videoUrl:page.videoUrls[0],videoUrls:page.videoUrls,phoneConnectionOnly:false});
 delete videos[0].browserRelayUrl;
 report.pcResolutionMs=Math.round(performance.now()-began);report.isolatedPcResolvedPlayback=true;
 // Only this disposable browser sees the substituted response. Live Recall
 // and the phone's capture are never overwritten by this diagnostic.
}
let chrome,ws,id=0;const pending=new Map();
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error(method+' timeout'));},12000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error('Page evaluation failed');return r.result?.value;};
try{
 const profile=await mkdtemp(path.join(out,'silent-chrome-'));
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--incognito','--mute-audio','--disable-audio-output','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking','--autoplay-policy=no-user-gesture-required','about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100&&!port;i++){try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}await delay(100);}
 if(!port)throw Error('Headless browser did not start');
 const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));
   if(m.method==='Fetch.requestPaused'){
     const u=new URL(m.params.request.url);
     const result=Number(u.searchParams.get('channel')||1)===channel
       ? send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'}],body:Buffer.from(JSON.stringify(state)).toString('base64')})
       : send('Fetch.continueRequest',{requestId:m.params.requestId});
     result.catch(()=>{});
   }
   if(m.method==='Network.responseReceived'){
     const r=m.params.response;
     try{const u=new URL(r.url);if(u.origin===app&&['/proxy','/generic-media/hls','/media-browser-relay/stream','/video-cache/stream'].some(p=>u.pathname.startsWith(p))){report.mediaResponses.push({route:u.pathname.split('/').slice(0,3).join('/'),status:r.status,mimeType:r.mimeType});report.mediaResponses=report.mediaResponses.slice(-30);}}catch{}
   }
   const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);
 });
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
 if(resolveOnPc)await send('Fetch.enable',{patterns:[{urlPattern:'*8787/simpcity/recall*',requestStage:'Request'}]});
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`
  localStorage.setItem('pong_autoplay','0');localStorage.setItem('pong_random40_local_endpoint_v1',${JSON.stringify(app)});
  window.confirm=()=>true;
  for(const [key,value] of [['muted',true],['volume',0]]){const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);Object.defineProperty(HTMLMediaElement.prototype,key,{...d,set(){d.set.call(this,value)}});}
  const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){this.muted=true;this.volume=0;return play.call(this)};
 `});
 await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true});
 await send('Page.navigate',{url:app+'/pong'});
 const loaded=performance.now();
 while(performance.now()-loaded<15000){if(await ev("document.readyState==='complete'&&!!document.getElementById('simpcity-recall-2')"))break;await delay(200);}
 await ev("document.getElementById('pong-overlay')?.classList.add('hidden');if(typeof hideControls==='function')hideControls();window.pongUserWantsAudio=false;document.getElementById('simpcity-recall-"+channel+"').click();");
 const recalled=performance.now();
 const snapshot=`(()=>{const w=document.querySelector('.video-wrapper'),v=w?.querySelector('video');return v?{readyState:v.readyState,networkState:v.networkState,paused:v.paused,muted:v.muted,volume:v.volume,time:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,width:v.videoWidth,height:v.videoHeight,error:v.error?.code||0,frames:v.getVideoPlaybackQuality?.().totalVideoFrames||0,sourceKind:(v.currentSrc||'').includes('/media-browser-relay/')?'browser-relay':(v.currentSrc||'').includes('/proxy?')?'proxy':'other',faceSwap:w.dataset.pongFaceSwapActive==='true'}:null})()`;
 let last;
 while(performance.now()-recalled<35000){last=await ev(snapshot);if(last?.readyState>=2||last?.error)break;await delay(200);}
 report.firstFrameMs=Math.round(performance.now()-recalled);report.initial=last;
 if(!last||last.readyState<2)throw Error('No decoded source frame');
 if(last.faceSwap)throw Error('Unexpected face swap active');
 if(Math.abs(last.duration-report.receiptDuration)>8)throw Error('Wrong-duration source');
 await ev(`(()=>{const v=document.querySelector('.video-wrapper video');v.pause();v.currentTime=0;window.__playEvidence={frames:[],stalls:0,startupWaits:0};let first;
  const cb=(t,m)=>{if(first===undefined)first=m.mediaTime;window.__playEvidence.frames.push({wall:t,media:m.mediaTime,elapsed:m.mediaTime-first});v.requestVideoFrameCallback(cb)};
  v.requestVideoFrameCallback(cb);v.addEventListener('waiting',()=>{if(first===undefined)window.__playEvidence.startupWaits++;else window.__playEvidence.stalls++});v.muted=true;v.volume=0;return v.play().then(()=>true).catch(()=>false)})()`);
 const playStart=performance.now();let evidence;
 while(performance.now()-playStart<22000){evidence=await ev('window.__playEvidence');if(evidence?.frames?.at(-1)?.elapsed>=10)break;await delay(200);}
 report.playWallMs=Math.round(performance.now()-playStart);report.final=await ev(snapshot);
 report.presentedFrames=evidence?.frames?.length||0;report.presentedSeconds=evidence?.frames?.at(-1)?.elapsed||0;
 report.maxFrameGapMs=Math.max(0,...(evidence?.frames||[]).slice(1).map((f,i)=>f.wall-evidence.frames[i].wall));
 report.stalls=evidence?.stalls||0;
 report.startupWaits=evidence?.startupWaits||0;
 report.playbackVerified=report.presentedSeconds>=10&&report.presentedFrames>100&&report.final.muted&&report.final.volume===0&&!report.final.error;
 report.smoothPlayback=report.playbackVerified&&report.maxFrameGapMs<250&&report.stalls===0;
 await ev("document.querySelectorAll('video,audio').forEach(v=>v.pause())");
}catch(e){report.failure=e.message;}
finally{
 if(ws?.readyState===1){await send('Browser.close').catch(()=>{});ws.close();}
 for(const p of pending.values()){clearTimeout(p.timer);}pending.clear();
 await writeFile(path.join(out,'pong-playback.json'),JSON.stringify(report,null,2));
 await writeFile(path.join(out,'pong-playback-'+Date.now()+'.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}
