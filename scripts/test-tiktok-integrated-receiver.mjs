// UI integration check in the designated test receiver, never the user's phone.
// --live additionally requires the activated sidecar and observes real decoded
// frames. UI-only results must not be presented as a live swap qualification.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),adb='C:/Users/arian/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const out='E:/Pong Benchmarks/v3039-continuation/tiktok-integrated';
const live=process.argv.includes('--live');
const codec=process.argv.includes('--h264')?'video/H264':null;
const original=process.argv.includes('--original');
const swipe=!process.argv.includes('--no-swipe');
const pages=await fetch('http://127.0.0.1:9225/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&new URL(p.url).origin==='http://192.168.1.124:8787'&&new URL(p.url).pathname==='/pong');
if(!page)throw Error('Designated Pong receiver is not available');
const ws=new WebSocket(page.webSocketDebuggerUrl),pending=new Map();let serial=0;
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error('Debugger request failed')):p.resolve(m.result);}};
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject,timer:setTimeout(()=>reject(Error('Debugger timeout')),10000)});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(String(r.exceptionDetails.exception?.description||r.exceptionDetails.text).split('\n')[0]);return r.result?.value;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(expression,timeout=10000){const end=Date.now()+timeout;do{const v=await evaluate(expression);if(v)return v;await delay(150);}while(Date.now()<end);throw Error('UI condition timed out');}
const report={version:'30.38.4',createdAt:new Date().toISOString(),liveRequested:live,mode:original?'original':'swap',inputMethod:'actual UI event handlers; not a touch latency benchmark',functionalPassed:false,performanceQualified:false};
try{
  await mkdir(out,{recursive:true});
  const key=(await readFile('Pong Swap/cache/tiktok-remote-pairing-token','utf8')).trim();
  const service=await fetch('http://127.0.0.1:8820/status',{headers:{Authorization:'Bearer '+key}}).then(r=>r.json());
  report.sidecarVersion=service.version;
  if(live&&!service.automaticVideoRegion)throw Error('TikTok-only service activation is still required');
  if(codec)report.experimentalCodec=codec;
  await evaluate(`window.__remoteReloadMarker=true;true`);
  await send('Page.reload',{ignoreCache:true});
  await until(`!window.__remoteReloadMarker&&document.readyState==='complete'&&document.querySelector('.version-number')?.textContent==='30.38.4'&&!!document.getElementById('tiktok-remote')`,20000);
  if(codec)await evaluate(`window.__pongCodecTestReady=event=>{const frame=document.querySelector('#pong-remote-panel iframe');if(event.origin!==location.origin||event.source!==frame?.contentWindow||event.data?.type!=='pong-remote-ready')return;const w=frame.contentWindow,add=w.RTCPeerConnection.prototype.addTransceiver;w.RTCPeerConnection.prototype.addTransceiver=function(kind,init){const t=add.call(this,kind,init);if(kind==='video'){const selected=w.RTCRtpReceiver.getCapabilities('video').codecs.filter(c=>c.mimeType===${JSON.stringify(codec)});if(!selected.length)throw Error('Requested test codec unavailable');t.setCodecPreferences(selected);}return t;};};window.addEventListener('message',window.__pongCodecTestReady,true);true`);
  await evaluate(`document.getElementById('tiktok-remote').click();true`);
  await until(`!!document.querySelector('#pong-remote-panel iframe')?.contentDocument?.querySelector('#connect')`);
  report.panel=await evaluate(`(()=>{const f=document.querySelector('#pong-remote-panel iframe'),d=f.contentDocument;return {tokenInputs:d.querySelectorAll('input').length,manualRegionControls:d.querySelectorAll('#mark').length,buttons:[...document.querySelectorAll('#pong-remote-panel nav button')].map(b=>b.textContent),bodyMode:document.body.classList.contains('pong-remote-active'),frameHeight:f.getBoundingClientRect().height,viewportHeight:innerHeight}})()`);
  assert.equal(report.panel.tokenInputs,0);assert.equal(report.panel.manualRegionControls,0);assert.equal(report.panel.bodyMode,true);
  assert.ok(report.panel.frameHeight/report.panel.viewportHeight>.99);
  report.overlay=await evaluate(`(()=>{const f=document.querySelector('#pong-remote-panel iframe'),b=document.querySelector('#pong-remote-panel .remote-face'),r=b.getBoundingClientRect(),p=document.querySelector('#pong-remote-panel');return {buttonHit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b,background:getComputedStyle(b).backgroundColor,centerPassThrough:document.elementFromPoint(innerWidth*.55,innerHeight*.5)===f,bottomPassThrough:document.elementFromPoint(innerWidth*.9,innerHeight*.94)===f,menuPointerEvents:getComputedStyle(p.querySelector('nav')).pointerEvents}})()`);
  assert.equal(report.overlay.buttonHit,true);assert.equal(report.overlay.centerPassThrough,true);assert.equal(report.overlay.bottomPassThrough,true);
  await evaluate(`document.querySelector('#pong-remote-panel .remote-toggle').click();true`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#pong-remote-panel .remote-face')).display`),'none');
  await evaluate(`document.querySelector('#pong-remote-panel .remote-toggle').click();true`);
  if(live){
    report.firstVideo=await until(`(()=>{const v=document.querySelector('#pong-remote-panel iframe').contentDocument.querySelector('#screen');return v.videoWidth&&v.readyState>=2?{width:v.videoWidth,height:v.videoHeight,muted:v.muted}:null})()`,20000);
  }
  await evaluate(`document.querySelector('#pong-remote-panel .remote-face').click();true`);
  await until(`document.querySelectorAll('#pong-face-swap-list .pong-face-choice').length>1`);
  report.picker=await evaluate(`(()=>{const p=document.getElementById('pong-face-swap-picker'),b=p.querySelector('.pong-face-choice');const r=b.getBoundingClientRect();return {visible:!p.hidden&&getComputedStyle(p).visibility==='visible',hit:p.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
  assert.equal(report.picker.visible,true);assert.equal(report.picker.hit,true);
  if(live){
    if(original){
      await evaluate(`document.getElementById('pong-face-swap-close').click();document.querySelector('#pong-remote-panel .remote-original').click();true`);
    }else await evaluate(`document.querySelectorAll('#pong-face-swap-list .pong-face-choice')[1].click();document.getElementById('pong-face-swap-apply').click();true`);
    const start=Date.now();
    if(!original){
      try{
        await until(`document.querySelector('#pong-remote-panel .remote-state').textContent==='Face swap on'`,12000);
        report.swapStatusObservedMs=Date.now()-start;
      }catch{
        report.swapStatusObservedMs=null;
        report.swapQualification='No transformed frame confirmed within 12 seconds; not a successful swap sample';
      }
    }
    const metricExpression=`(async()=>{const rows=[...await pc.getStats()].map(x=>x[1]),v=rows.find(x=>x.type==='inbound-rtp'&&x.kind==='video')||{};return {codec:rows.find(x=>x.id===v.codecId)?.mimeType,decoder:v.decoderImplementation??null,powerEfficientDecoder:v.powerEfficientDecoder??null,presented:frameCount,decoded:v.framesDecoded||0,dropped:v.framesDropped||0,freezeCount:v.freezeCount||0,freezeSeconds:v.totalFreezesDuration||0,acks:[...measurements.inputAckMs],intervals:[...measurements.presentedFrameIntervalMs],swap:!!lastServer.swap?.enabled,transformed:lastServer.swap?.transformedFrames||0,renderMs:lastServer.swap?.renderMs,captured:lastServer.capturedFrames,submitted:lastServer.submittedFrames,timings:lastServer.timings,jitterDelay:v.jitterBufferDelay,emitted:v.jitterBufferEmittedCount,decodeSeconds:v.totalDecodeTime};})()`;
    const metrics=()=>evaluate(`document.querySelector('#pong-remote-panel iframe').contentWindow.eval(${JSON.stringify(metricExpression)})`);
    await until(`document.querySelector('#pong-remote-panel iframe').contentWindow.eval('Number.isFinite(lastServer.capturedFrames)')`,5000);
    const before=await metrics(),started=Date.now();
    await delay(10000);
    const after=await metrics(),seconds=(Date.now()-started)/1000;
    report.playback={seconds,decodedFps:(after.decoded-before.decoded)/seconds,presentedFps:(after.presented-before.presented)/seconds,dropped:after.dropped-before.dropped,freezes:after.freezeCount-before.freezeCount,freezeSeconds:after.freezeSeconds-before.freezeSeconds,transformedFrames:after.transformed-before.transformed};
    report.performanceChecks={presentedAtLeast30Fps:report.playback.presentedFps>=30,noDecoderDrops:report.playback.dropped===0,noFreezes:report.playback.freezes===0,swapObserved:original?null:report.playback.transformedFrames>0,firstVisibleSwapMs:null,touchToVisibleMs:null};
    // Presentation FPS and ACKs alone cannot qualify first-visible-swap or
    // causal touch-to-visible latency. Those remain explicitly unmeasured.
    report.pipeline={codec:after.codec,decoder:after.decoder,powerEfficientDecoder:after.powerEfficientDecoder,lastRenderMs:after.renderMs,captureFps:(after.captured-before.captured)/seconds,submittedFps:(after.submitted-before.submitted)/seconds,timings:after.timings,meanDecodeMs:1000*(after.decodeSeconds-before.decodeSeconds)/(after.decoded-before.decoded),meanJitterBufferMs:1000*(after.jitterDelay-before.jitterDelay)/(after.emitted-before.emitted)};
    if(codec){report.codecExperimentNegotiated=after.codec===codec;assert.equal(after.codec,codec,'Requested experiment codec was not negotiated');}
    // Actual browser touch events cross the WebRTC input channel to TikTok.
    if(swipe){
    const bounds=await evaluate(`(()=>{const f=document.querySelector('#pong-remote-panel iframe'),r=f.getBoundingClientRect();return {x:r.x+r.width*.55,top:r.y,height:r.height}})()`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x,y:bounds.top+bounds.height*.72}]});
    for(let step=1;step<=8;step++){await delay(20);await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:bounds.x,y:bounds.top+bounds.height*(.72-.42*step/8)}]});}
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await delay(1200);
    const swiped=await metrics(),acks=swiped.acks.slice(after.acks.length).sort((a,b)=>a-b);
    report.swipe={acknowledgements:acks.length,medianAcknowledgementMs:acks.length?acks[Math.floor(acks.length/2)]:null,p95AcknowledgementMs:acks.length?acks[Math.ceil(acks.length*.95)-1]:null,scope:'RPC acknowledgement, not touch-to-visible latency'};
    assert.ok(acks.length>0,'No remote touch acknowledgement');
    }
  }else await evaluate(`document.getElementById('pong-face-swap-close').click();true`);
  await exec(adb,['-s','emulator-5582','shell','screencap','-p','/sdcard/pong-integrated-ui.png'],{windowsHide:true});
  await exec(adb,['-s','emulator-5582','pull','/sdcard/pong-integrated-ui.png',out+'/receiver.png'],{windowsHide:true});
  await evaluate(`document.querySelector('#pong-remote-panel nav button:last-child').click();true`);
  await until(`!document.getElementById('pong-remote-panel')`,45000);
  assert.equal(await evaluate(`document.body.classList.contains('pong-remote-active')`),false);
  report.functionalPassed=true;
}catch(e){report.error=e.message;process.exitCode=1;}
finally{
  // Failed/no-face samples must not leave a renderer/controller consuming GPU.
  await evaluate(`document.querySelector('#pong-remote-panel nav button:last-child')?.click();true`).catch(()=>{});
  await until(`!document.getElementById('pong-remote-panel')`,45000).catch(()=>{report.cleanupUnconfirmed=true;});
  if(codec)await evaluate(`window.removeEventListener('message',window.__pongCodecTestReady,true);delete window.__pongCodecTestReady;true`).catch(()=>{});
  ws.close();
  await writeFile(out+'/report'+(original?'-original':'')+(codec?'-h264':'')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  await writeFile(out+'/run-'+report.createdAt.replace(/[:.]/g,'-')+'.json',JSON.stringify(report,null,2));
}
