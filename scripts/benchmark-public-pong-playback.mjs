// Replay real recorded public-site captures through the actual isolated Recall
// route and Pong UI, using the unchanged production swap engine. No fixture media.
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
const [input,out,app='http://127.0.0.1:17891',mode='userscript']=process.argv.slice(2);
const swap='http://127.0.0.1:8792';
await mkdir(out,{recursive:true});
let report;try{report=JSON.parse(await readFile(out+'/report.json','utf8'));}catch{report={silent:true,headless:true,private:true,mode,scope:'Recorded public capture replay through real isolated Recall and Pong UI; not Android; discovery and replay clocks reported separately',cases:[]};}
const capture=JSON.parse(await readFile(input,'utf8')),rows=capture.sites||capture.cases;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const request=async(base,p,method='GET',body)=>{const r=await fetch(base+p,{method,headers:{'Content-Type':'application/json','X-Pong-SimpCity-Controller':'1'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});const j=await r.json();if(!r.ok)throw Error(p+': '+(j.error||r.status));return j;};
const save=()=>writeFile(out+'/report.json',JSON.stringify(report,null,2));
let chrome,ws,sid;let seq=0;const pending=new Map();
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
const wait=async(expression,label,ms=25000)=>{const t=performance.now();while(performance.now()-t<ms){const v=await ev(expression);if(v)return v;await delay(80);}throw Error(label+' timeout');};
try{
 report.settings=(await request(swap,'/settings')).config;
 if(report.settings.runtime.swapAudioEnabled!==false)throw Error('Silent engine is required');
 if((await request(swap,'/sessions')).sessions.some(s=>!s.complete&&!s.playbackPaused))throw Error('Another renderer is active');
 const face=(await request(swap,'/faces')).faces.find(f=>f.name==='Approved 3');if(!face)throw Error('Approved 3 missing');report.face={name:face.name,id:face.id};
 const profile=await mkdtemp(path.join(out,'chrome-'));
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--incognito','--mute-audio','--disable-audio-output','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking','--disable-component-update','--autoplay-policy=no-user-gesture-required','about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<150&&!port;i++){try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}await delay(100);}
 const tab=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.type==='page');
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data)),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true});
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`
 localStorage.setItem('pong_autoplay','0');localStorage.setItem('pong_random40_local_endpoint_v1',${JSON.stringify(app)});
 for(const [key,value]of [['muted',true],['volume',0]]){const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);Object.defineProperty(HTMLMediaElement.prototype,key,{...d,set(){d.set.call(this,value)}});}
 const rf=window.fetch;window.fetch=(input,options)=>{const u=new URL(typeof input==='string'?input:input.url,location.href);if(['127.0.0.1','192.168.1.124'].includes(u.hostname)&&['8787','8793','8795','17887','17889'].includes(u.port))input=${JSON.stringify(app)}+u.pathname+u.search;return rf(input,options);};
 `});
 for(const c of rows){
  if(report.cases.some(r=>r.site===c.site&&r.ordinal===c.ordinal))continue;
  const row={site:c.site,ordinal:c.ordinal,pageUrl:c.requestedUrl||c.url,pageTitle:c.title||c.listingTitle,discoveryMs:mode==='userscript'?c.captureMs:c.elapsedMs};report.cases.push(row);
  const bundle=(mode==='userscript'?c.recall:c.result?.recall)?.genericBundles?.[0];
  if(!bundle?.videos?.length){row.status='no-capture';await save();continue;}
  row.captured=bundle.videos[0];
  try{
   const start=performance.now();
   await request(app,'/media-page/recall','POST',{sourceUrl:row.pageUrl,channel:2,mode:'main',ignoreUnder30:false,title:bundle.title,entries:bundle.videos.map(v=>({...v,postUrl:v.pageUrl}))});
   row.handoffMs=performance.now()-start;
   await send('Page.navigate',{url:app+'/pong'});
   await wait("document.readyState==='complete'&&!!window.PongModernUI",'Pong UI');
   await ev("document.getElementById('pong-overlay').classList.add('hidden');hideControls();window.pongFaceSwapChannel=()=> 'test';window.pongUserWantsAudio=false;");
   const recalled=performance.now();await ev("document.getElementById('simpcity-recall-2').click()");
   await wait("document.querySelector('.video-wrapper video')?.readyState>=2",'Recall source',20000);
   row.recallFirstFrameMs=performance.now()-recalled;
   row.metadata=await ev("({metadata:allVideoMetadata[0],width:document.querySelector('.video-wrapper video').videoWidth,height:document.querySelector('.video-wrapper video').videoHeight,duration:document.querySelector('.video-wrapper video').duration})");
   await ev("(()=>{const w=document.querySelector('.video-wrapper'),v=w.querySelector('video');v.pause();v.currentTime=0;w.dataset.userPaused='false';w.dataset.playIntent='true';document.getElementById('pong-face-swap-button').click();})()");
   await wait(`[...document.querySelectorAll('#pong-face-swap-menu button')].some(b=>b.textContent.trim()===${JSON.stringify(face.name)})`,'Face menu');
   const selected=performance.now();await ev(`[...document.querySelectorAll('#pong-face-swap-menu button')].find(b=>b.textContent.trim()===${JSON.stringify(face.name)}).click()`);
   sid=await wait("(()=>{const w=document.querySelector('.video-wrapper'),v=w?.querySelector('video');return w?.dataset.pongFaceSwapActive==='true'&&w.dataset.pongFaceSwapBusy!=='true'&&v.readyState>=2&&w.dataset.pongFaceSwapSessionId;})()",'Swapped frame',35000);
   row.swapFirstPlayableMs=performance.now()-selected;row.recallToSwapMs=performance.now()-recalled;
   await ev("(()=>{const v=document.querySelector('.video-wrapper video');window.__frames=[];window.__events=[];let prev;const cb=(t,m)=>{if(prev)window.__frames.push({gap:t-prev,media:m.mediaTime});prev=t;v.requestVideoFrameCallback(cb)};v.requestVideoFrameCallback(cb);for(const n of ['waiting','stalled','ended'])v.addEventListener(n,()=>window.__events.push({name:n,t:performance.now()}));return v.play()})()");
   const playStart=performance.now();let state;
   while(performance.now()-playStart<16000){state=await ev("(()=>{const v=document.querySelector('.video-wrapper video');return {t:v.currentTime,ended:v.ended,duration:v.duration,muted:v.muted,volume:v.volume,width:v.videoWidth,height:v.videoHeight}})()");if(state.t>=10||state.ended)break;await delay(100);}
   row.playWallMs=performance.now()-playStart;row.playback=state;row.frames=await ev('window.__frames');row.events=await ev('window.__events');row.session=(await request(swap,'/sessions/'+sid)).session;
   row.maxPresentedGapMs=Math.max(0,...row.frames.map(f=>f.gap));row.transformedRatio=row.session.transformedFrames/Math.max(1,row.session.frames);
   row.requiredPlaySeconds=Math.min(10,row.metadata.duration-.15);
   // currentTime can jump to the declared MP4 duration after a truncated fMP4
   // reaches EOF. Only presented-frame timestamps prove actual playback.
   row.presentedSeconds=row.frames.at(-1)?.media||0;
   row.playbackPass=state.muted&&state.volume===0&&!row.session.error&&row.session.state!=='error'&&row.presentedSeconds>=row.requiredPlaySeconds-.08&&row.maxPresentedGapMs<250;
   row.faceSwapPass=row.playbackPass&&row.session.transformedFrames>0&&row.transformedRatio>=.95;
   row.status=row.faceSwapPass?'swapped-playback-pass':'playback-or-transformation-fail';
   // Silent image evidence, never autoplaying exported video.
   const shot=await send('Page.captureScreenshot',{format:'jpeg',quality:65});await writeFile(path.join(out,c.site+'-'+c.ordinal+'.jpg'),Buffer.from(shot.data,'base64'));
  }catch(e){row.status='failed';row.error=String(e);row.ui=await ev("({text:document.body.innerText.slice(-600),videos:[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,error:v.error?.message})),session:document.querySelector('.video-wrapper')?.dataset.pongFaceSwapSessionId})").catch(()=>null);sid=sid||row.ui?.session;}
  finally{await ev("document.querySelectorAll('video').forEach(v=>v.pause())").catch(()=>{});if(sid)await request(swap,'/sessions/'+sid+'?defer=false','DELETE').catch(()=>{});sid=null;}
  console.log(JSON.stringify({site:row.site,ordinal:row.ordinal,status:row.status,recallMs:row.recallFirstFrameMs,swapMs:row.swapFirstPlayableMs,transformed:row.transformedRatio,error:row.error}));await save();
 }
 report.processedCaptures=rows.length;
}catch(e){report.error=String(e);console.error(e);process.exitCode=1;}
finally{if(sid)await request(swap,'/sessions/'+sid+'?defer=false','DELETE').catch(()=>{});ws?.close();if(chrome?.pid)await new Promise(r=>{const p=spawn('taskkill',['/pid',String(chrome.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});p.once('close',r);p.once('error',r)});await save();}
