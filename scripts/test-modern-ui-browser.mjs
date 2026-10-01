// Silent, isolated visual/behavioral QA of the real served page. No remote media.
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const output=process.env.PONG_UI_REPORT||'E:/Pong Benchmarks/v3002-throughput/ui';
const fixture='http://127.0.0.1:18897/ec6b3fdf5f7447ee86f19f2ba3dc9967/candidate-minute-2.mp4';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={silent:true,environment:'Headless incognito Chrome; actual /pong UI, local approved silent fixture',checks:[],errors:[],screens:[]};
let chrome,ws;
const pending=new Map();let seq=0;
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
async function wait(expression,label,ms=20000){for(const end=Date.now()+ms;Date.now()<end;){const v=await evaluate(expression);if(v)return v;await delay(100);}throw Error(label+' timeout');}
async function screenshot(name){await delay(200);const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,name+'.png'),Buffer.from(data,'base64'));report.screens.push(name+'.png');}
async function check(name,expression){const result=await evaluate(expression);assert.ok(result,name);report.checks.push(name);}
try{
 await mkdir(output,{recursive:true});const profile=await mkdtemp(path.join(output,'chrome-'));
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--incognito','--mute-audio','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--autoplay-policy=no-user-gesture-required','about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100&&!port;i++){try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}await delay(100);}
 const tab=(await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page');
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 await send('Page.enable');await send('Runtime.enable');
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('pong_autoplay','0'); window.pongUserWantsAudio=false; const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');Object.defineProperty(HTMLMediaElement.prototype,'muted',{...descriptor,set(){descriptor.set.call(this,true)}});const volume=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'volume');Object.defineProperty(HTMLMediaElement.prototype,'volume',{...volume,set(){volume.set.call(this,0)}});`});
 await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true});
 await send('Page.navigate',{url:'http://127.0.0.1:8787/pong'});
 await wait(`!!window.PongModernUI && !!document.querySelector('.show-controls-button')`,'UI');
 await evaluate(`document.getElementById('pong-overlay').classList.add('hidden'); hideControls()`);
 await screenshot('mobile-empty');
 await evaluate(`document.querySelector('.show-controls-button').click()`);
 await check('Library opens and is keyboard reachable',`!document.querySelector('.controls-overlay').inert && !document.body.classList.contains('controls-hidden')`);
 await screenshot('mobile-library');
 await evaluate(`hideControls()`);
 await check('Legacy controls retain original parents',`[...document.querySelectorAll('.control-button')].every(el=>el.parentElement===document.body)`);
 await evaluate(`videoUrls=[${JSON.stringify(fixture)}];videoMetadata=[{duration:64.59}];allVideoUrls=[...videoUrls];allVideoMetadata=[...videoMetadata];createVideoElements();const w=document.querySelector('.video-wrapper'),v=w.querySelector('video');setPongVideoSource(v,${JSON.stringify(fixture)});v.muted=true;v.volume=0;v.load();`);
 await wait(`document.querySelector('video.video-player')?.readyState>=2`,'Local video',40000);
 await evaluate(`{const v=document.querySelector('video.video-player');v.pause();v.currentTime=12.5;}`);
 await wait(`document.querySelector('.pm-elapsed')?.textContent==='0:12'`,'Elapsed time');
 await check('Elapsed and total visible separately',`document.querySelector('.video-duration').textContent==='1:04'`);
 await screenshot('mobile-player');
 report.geometry=await evaluate(`[...document.querySelectorAll('.show-controls-button,.save-actions-panel,.video-progress-container,.pm-elapsed,.video-duration,.audio-toggle-button,.pong-face-swap-wrap')].map(el=>({name:el.className,rect:JSON.parse(JSON.stringify(el.getBoundingClientRect()))}))`);
 await evaluate(`(()=>{const w=document.querySelector('.video-wrapper');toggleVideoPlaybackFromIntent(w,w.querySelector('video'));})()`);
 await wait(`!document.querySelector('video.video-player').paused`,'Transport play');
 await delay(1500);await evaluate(`(()=>{const w=document.querySelector('.video-wrapper');toggleVideoPlaybackFromIntent(w,w.querySelector('video'));})()`);
 await wait(`document.querySelector('video.video-player').paused`,'Transport pause');report.checks.push('Transport play and pause preserve existing intent');
 await evaluate(`document.querySelector('.video-progress-bar').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
 await delay(500);
 await check('Keyboard seeking advances original timeline',`document.querySelector('video.video-player').currentTime>17`);
 await evaluate(`(()=>{const w=document.querySelector('.video-wrapper'),v=w.querySelector('video');w.dataset.pongFaceSwapActive='true';v.__pongSwapOriginal={startSeconds:30,duration:64.59};window.PongModernUI.updateTime(w,v)})()`);
 await check('Swapped counter includes source-time offset',`parseInt(document.querySelector('.pm-elapsed').textContent.split(':')[1])>=47`);
 await evaluate(`(()=>{const w=document.querySelector('.video-wrapper'),v=w.querySelector('video');delete w.dataset.pongFaceSwapActive;delete v.__pongSwapOriginal;window.PongModernUI.updateTime(w,v);})()`);
 await evaluate(`document.getElementById('pong-face-swap-button').click()`);
 await wait(`document.getElementById('pong-face-swap-menu').classList.contains('open')`,'Face picker');await screenshot('mobile-faces');
 await evaluate(`document.getElementById('pong-face-swap-menu').classList.remove('open')`);
 for(const [name,width,height] of [['small-phone',360,740],['landscape',915,412],['desktop',1440,900]]){
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<1000});await screenshot(name);
   await check(name+' original compact button positions',`(()=>{
     const gear=getComputedStyle(document.querySelector('.show-controls-button'));
     const swap=getComputedStyle(document.querySelector('.pong-face-swap-wrap'));
     const audio=getComputedStyle(document.querySelector('.audio-toggle-button'));
     return gear.left==='12px'&&gear.bottom==='48px'&&gear.width==='24px'&&gear.height==='24px'&&swap.left==='12px'&&audio.left==='12px'&&audio.top==='12px'&&!document.querySelector('.pm-dock');
   })()`);
 }
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await check('Reduced motion disables decorative transitions',`parseFloat(getComputedStyle(document.querySelector('.show-controls-button')).transitionDuration)<.001`);
 await check('No audio enabled',`[...document.querySelectorAll('video,audio')].every(v=>v.muted&&v.volume===0)`);
 await evaluate(`document.querySelector('video.video-player').dispatchEvent(new Event('emptied'))`);
 await check('Requested bottom extras are removed',`!document.querySelector('.pm-transport-play,.pm-first-frame')`);
 report.completed=true;
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);await screenshot('failure').catch(()=>{});}
finally{
 await writeFile(path.join(output,'ui-report.json'),JSON.stringify(report,null,2));
 if(ws?.readyState===1)await send('Browser.close').catch(()=>{});ws?.close();
 console.log(JSON.stringify(report,null,2));
}
