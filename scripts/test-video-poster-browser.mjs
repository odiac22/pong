// Actual media decoding + UI canvas lifecycle. Synthetic, silent, private/headless.
// Swap routes below are explicit synthetic renderer stand-ins, not model-quality tests.
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const version=(await readFile('index.html','utf8')).match(/class="version-number">([^<]+)/)[1];
const out=path.resolve(`artifacts/poster-${version}`); await mkdir(out,{recursive:true});
const tmp=await mkdtemp(path.join(os.tmpdir(),'pong-poster-'));
const fixture=path.join(tmp,'fixture.mp4');
assert.equal(spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=30','-t','8','-an','-c:v','libx264','-preset','ultrafast','-movflags','+faststart',fixture],{windowsHide:true}).status,0);
const media=await readFile(fixture),js=await readFile('ui/pong-modern.js','utf8'),css=await readFile('ui/pong-modern.css','utf8');
const server=createServer((req,res)=>{
 if(req.url==='/harness') {
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><style>body{margin:0;background:black}.video-wrapper{position:relative;width:412px;height:740px}video{width:100%;height:100%;object-fit:contain}${css}</style>
   <div id="video-container"></div><script>
   window.pongFaceSwapState={enabled:false,selectedFaceId:'',prefetches:new Map()};
   window.pongFaceSwapProgressState=(w,v)=>({currentTime:v.currentTime,duration:v.duration});
   window.seekPongVideoTo=()=>{};
   window.draws=0;const originalDraw=CanvasRenderingContext2D.prototype.drawImage;
   CanvasRenderingContext2D.prototype.drawImage=function(...args){draws++;return originalDraw.apply(this,args)};
   window.addCard=(id)=>{const w=document.createElement('div');w.className='video-wrapper';w.dataset.originalVideoUrl=id;w.innerHTML='<video muted preload="auto" playsinline></video><div class="video-progress-container"><span class="video-duration"></span><div class="video-progress-bar"></div></div>';document.getElementById('video-container').append(w);return w};
   window.w=addCard('synthetic-a');window.v=w.querySelector('video');
   v.muted=true;v.volume=0;v.src='/fixture.mp4';
   </script><script>${js}</script>`); return;
 }
 const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);
 const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),media.length-1):media.length-1;
 res.writeHead(range?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${media.length}`}:{})});res.end(media.subarray(start,end+1));
});
await new Promise(r=>server.listen(0,'0.0.0.0',r));const port=server.address().port;
const report={silent:true,synthetic:true,checks:[],limitations:['Synthetic swap stream tests ownership/display, not face model quality.','Physical phone unavailable on ADB.']};
const pending=new Map();let seq=0,ws,chrome;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
async function wait(expression,label){for(const end=Date.now()+15000;Date.now()<end;){if(await evaluate(expression))return;await delay(80);}throw Error(label+' timeout');}
async function check(name,expression){assert.ok(await evaluate(expression),name);report.checks.push(name);}
async function screenshot(name){const {data}=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,name+'.png'),Buffer.from(data,'base64'));}
const ready=`v.readyState>=2&&!v.seeking&&!!w.querySelector('canvas')`;
try {
 const profile=await mkdtemp(path.join(tmp,'chrome-'));
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--incognito','--mute-audio','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--disable-background-networking','--autoplay-policy=no-user-gesture-required','about:blank'],{windowsHide:true,stdio:'ignore'});
 let debugPort;for(let i=0;i<100&&!debugPort;i++){try{debugPort=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}await delay(100);}
 const tab=(await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(t=>t.type==='page');
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data)),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 await send('Page.enable');await send('Runtime.enable');
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.pongUserWantsAudio=false;for(const [key,value] of [['muted',true],['volume',0]]){const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);Object.defineProperty(HTMLMediaElement.prototype,key,{...d,set(){d.set.call(this,value)}});}`});
 await send('Emulation.setDeviceMetricsOverride',{width:412,height:740,deviceScaleFactor:1,mobile:true});
 await send('Page.navigate',{url:`http://127.0.0.1:${port}/harness`});
 await wait(ready,'original poster');
 await check('Initial paused frame is native 640x360 full-player poster',`v.paused&&!w.querySelector('.pm-video-poster').hidden&&w.querySelector('canvas').width===640&&w.querySelector('canvas').height===360`);
 await screenshot('original-paused');
 await evaluate(`v.currentTime=2`);await wait(ready,'seek');
 await check('Paused seek snapshot matches the decoded frame',`(()=>{const c=document.createElement('canvas');c.width=640;c.height=360;c.getContext('2d').drawImage(v,0,0);return c.toDataURL()===w.querySelector('canvas').toDataURL()})()`);
 await evaluate(`v.play()`);await wait(`!w.querySelector('.pm-video-poster').hidden===false`,'poster hide');
 const draws=await evaluate('draws');await delay(700);
 await evaluate(`for(let i=0;i<60;i++)PongModernUI.framePresented(w,v)`);
 assert.equal(await evaluate('draws'),draws,'No per-playing-frame copies');report.checks.push('Playing hides poster and 60 callbacks perform zero extra copies');
 await evaluate('v.pause()');await check('Pause immediately retains current decoded frame',`!w.querySelector('.pm-video-poster').hidden&&!!w.querySelector('canvas')`);
 for(let i=0;i<3;i++){
  await evaluate('v.play()');await wait(`w.querySelector('.pm-video-poster').hidden`,'repeat resume');
  await delay(80);await evaluate('v.pause()');
  await check(`Pause/resume cycle ${i+1} releases poster without freezing playback`,`!w.querySelector('.pm-video-poster').hidden`);
 }
 await evaluate(`pongFaceSwapState.enabled=true;pongFaceSwapState.selectedFaceId='synthetic-face';PongModernUI.refreshPreviews()`);
 await check('Enabling swap clears original thumbnail before new stream arrives',`!w.querySelector('canvas')&&!w.querySelector('.pm-video-poster').hidden`);
 await evaluate(`w.dataset.pongFaceSwapSessionId='qa-a';w.dataset.pongFaceSwapFaceId='synthetic-face';v.src='/pong-swap/sessions/qa-a/stream';v.load()`);
 await wait(ready,'swapped poster');
 await check('Owned synthetic swap stream supplies swapped paused poster',`w.querySelector('.pm-video-poster').dataset.swapped==='true'`);
 await evaluate(`v.currentTime=3`);await wait(ready,'swapped seek');
 await screenshot('swap-owned-paused');
 await evaluate(`PongModernUI.holdPreview(w);v.removeAttribute('src');v.load()`);await delay(100);
 await check('Reload preserves prior swapped frame',`v.readyState===0&&!!w.querySelector('canvas')&&!w.querySelector('.pm-video-poster').hidden`);
 await evaluate(`window.seekImage=new Image();seekImage.src=w.querySelector('canvas').toDataURL()`);await wait('seekImage.complete&&seekImage.naturalWidth','seek image');
 await check('Stale exact-seek session is rejected',`PongModernUI.capturePreview(w,seekImage,true,'stale')===false`);
 await check('Current exact-seek session is accepted',`PongModernUI.capturePreview(w,seekImage,true,'qa-a')===true`);
 await evaluate(`pongFaceSwapState.selectedFaceId='other-face';PongModernUI.refreshPreviews()`);
 await check('Identity change clears old face and rejects its delayed image',`!w.querySelector('canvas')&&PongModernUI.capturePreview(w,seekImage,true,'qa-a')===false`);
 await evaluate(`pongFaceSwapState.enabled=false;PongModernUI.refreshPreviews();v.src='http://localhost:${port}/fixture.mp4';v.load()`);await wait(ready,'cross-origin');
 await check('Cross-origin frame displays without requiring readable pixels',`(()=>{try{w.querySelector('canvas').toDataURL();return false}catch(e){return e.name==='SecurityError'&&!w.querySelector('.pm-video-poster').hidden}})()`);
 await screenshot('cross-origin-paused');
 await evaluate(`w.dataset.originalVideoUrl='synthetic-b'`);await delay(100);
 await check('Logical source change invalidates old thumbnail',`!w.querySelector('canvas')`);
 await evaluate(`window.oldCanvas=null;PongModernUI.capturePreview(w,v);oldCanvas=w.querySelector('canvas');w.remove()`);await delay(100);
 await check('Unmount releases full-resolution canvas',`oldCanvas.width===0&&oldCanvas.height===0`);
 await evaluate(`window.cards=Array.from({length:5},(_,i)=>addCard('budget-'+i))`);await delay(100);
 await evaluate(`for(const card of cards){card.dataset.pongFaceSwapSessionId='qa-b';card.dataset.pongFaceSwapFaceId='synthetic-face'}pongFaceSwapState.enabled=true;pongFaceSwapState.selectedFaceId='synthetic-face';PongModernUI.refreshPreviews();for(const card of cards)PongModernUI.capturePreview(card,seekImage,true,'qa-b')`);
 await check('Snapshot allocation remains bounded to three full-resolution canvases',`document.querySelectorAll('.pm-video-poster canvas').length===3`);
 await check('No audio or bottom-right thumbnail/play control',`[...document.querySelectorAll('video')].every(v=>v.muted)&&!document.querySelector('.pm-first-frame,.pm-transport-play')`);
 // Actual served Pong page: prove the integrated runtime (not just the harness)
 // produces a paused cross-origin poster without altering the phone's state.
 await send('Page.navigate',{url:'http://127.0.0.1:8787/pong'});
 await wait('!!window.PongModernUI','live UI');
 await evaluate(`document.getElementById('pong-overlay')?.classList.add('hidden');hideControls();videoUrls=['http://127.0.0.1:${port}/fixture.mp4'];videoMetadata=[{duration:8}];allVideoUrls=[...videoUrls];allVideoMetadata=[...videoMetadata];createVideoElements();window.w=document.querySelector('.video-wrapper');window.v=w.querySelector('video');v.muted=true;v.volume=0;setPongVideoSource(v,'http://127.0.0.1:${port}/fixture.mp4');v.load();v.pause()`);
 await wait(ready,'live page poster');
 await check(`Live Pong ${version} renders full-size original paused poster`,`document.querySelector('.version-number').textContent===${JSON.stringify(version)}&&!!w.querySelector('canvas')&&!w.querySelector('.pm-video-poster').hidden`);
 await screenshot('live-pong-poster');
 await evaluate(`renderPongRecallCaptureStatus({id:'fixture',desktop:{ready:2,pending:1,failed:1,qualityFailed:1,total:4}},2)`);
 await check('Pong shows destination, pending and highest-quality failure without Firefox',`document.querySelector('.pong-recall-pc-status').textContent==='Recall 2: 2/4 ready · 1 pending · 1 failed · 1 could not verify highest quality'`);
 await screenshot('live-recall-progress');
 await evaluate(`renderPongRecallCaptureStatus({id:'fixture'},2,true)`);
 await check('Temporary LAN failure is visibly reconnecting, not a false empty result',`document.querySelector('.pong-recall-pc-status').textContent.includes('reconnecting')`);
 report.completed=true;
}catch(error){report.error=error.stack;process.exitCode=1;await screenshot('failure').catch(()=>{});}
finally{
 if(ws?.readyState===1)await send('Browser.close').catch(()=>{});ws?.close();
 server.close();server.closeAllConnections();
 await writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
