// Actual Pong APK receiver -> existing authenticated TikTok emulator.
// No audio, visible desktop windows, public posting, or credentials in reports.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
const adb='C:/Users/arian/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const out=process.argv[2]||'E:/Pong Benchmarks/v3038-detect/receiver-live';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={version:'30.38',scope:'Actual Pong Android receiver, existing TikTok Android source, local PC',
  backgroundDownloadActive:true,audio:false,complete:false,phases:[]};
const useSwap=process.argv.includes('--swap');
const swipeCount=Math.min(15,Math.max(0,Number((process.argv.find(x=>x.startsWith('--swipes='))||'').split('=')[1])||0));
const collectScreens=process.argv.includes('--screens');
const requestedCodec=(process.argv.find(x=>x.startsWith('--codec='))||'').split('=')[1];
if(requestedCodec&&!['h264','vp8'].includes(requestedCodec))throw Error('Unsupported test codec');
report.experimentalCodec=requestedCodec||null;
await mkdir(out,{recursive:true});
const save=()=>writeFile(out+'/report.json',JSON.stringify(report,null,2));
const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
const config=(await fetch('http://127.0.0.1:8792/settings').then(r=>r.json())).config;
report.quality={restorer:config.parameters.RestorerTypeTextSel,strength:config.parameters.RestorerSlider};
if(health.activeSessions)throw Error('Ordinary render sessions active; benchmark deferred');
const key=(await readFile('Pong Swap/cache/tiktok-remote-pairing-token','utf8')).trim();
const remoteStatus=await fetch('http://127.0.0.1:8820/status',{headers:{Authorization:'Bearer '+key}}).then(r=>r.json());
if(remoteStatus.sessions.some(s=>!['closed','failed'].includes(s.connection)))throw Error('Remote controller already active');
const target=(await fetch('http://127.0.0.1:9225/json/list').then(r=>r.json())).find(t=>t.type==='page');
if(!target)throw Error('Pong receiver debugger unavailable');
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let serial=0,remoteContext=null;
const pending=new Map(),contexts=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.method==='Runtime.executionContextCreated')contexts.set(m.params.context.id,m.params.context);
  if(m.method==='Runtime.executionContextDestroyed')contexts.delete(m.params.executionContextId);
  const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);
  m.error?p.reject(Error(m.error.message)):p.resolve(m.result);
};
function send(method,params={},timeout=30000){return new Promise((resolve,reject)=>{const id=++serial;
  pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},timeout)});
  ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression,contextId,timeout=30000){const r=await send('Runtime.evaluate',
  {expression,contextId,returnByValue:true,awaitPromise:true,userGesture:true},timeout);
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result?.value;}
async function until(expression,contextId,ms=20000){const end=Date.now()+ms;
  while(Date.now()<end){const value=await evaluate(expression,contextId);if(value)return value;await delay(100);}
  throw Error('Receiver condition timed out');}
async function tap(x,y){await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
async function screenBounds(){await evaluate(`video.scrollIntoView({block:'center'});true`,remoteContext);
  return evaluate(`(()=>{const f=document.querySelector('#pong-remote-panel iframe');
  const fr=f.getBoundingClientRect(),v=f.contentDocument.querySelector('#screen'),r=v.getBoundingClientRect();
  return {x:fr.x+r.x,y:fr.y+r.y,width:r.width,height:r.height};})()`);}
async function drag(bounds,from,to){const xy=p=>({x:bounds.x+p[0]*bounds.width,y:bounds.y+p[1]*bounds.height});
  await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[xy(from)]});
  for(let step=1;step<=8;step++){await delay(25);const t=step/8;
    await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[xy([from[0]+(to[0]-from[0])*t,from[1]+(to[1]-from[1])*t])]});}
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
async function telemetry(){return evaluate(`(async()=>{const all=[...await pc.getStats()].map(x=>x[1]);
  const s=all.find(x=>x.type==='inbound-rtp'&&x.kind==='video')||{};
  const codec=all.find(x=>x.id===s.codecId)||{};
  return {frames:frameCount,acks:[...measurements.inputAckMs],server:lastServer,
    connection:pc?.connectionState,muted:video.muted,
    frameIntervalsMs:[...measurements.presentedFrameIntervalMs],
    rtc:{codec:codec.mimeType,framesDecoded:s.framesDecoded,framesDropped:s.framesDropped,
      framesReceived:s.framesReceived,framesPerSecond:s.framesPerSecond,bytesReceived:s.bytesReceived,
      totalDecodeTime:s.totalDecodeTime,jitter:s.jitter,packetsLost:s.packetsLost,
      jitterBufferDelay:s.jitterBufferDelay,jitterBufferEmittedCount:s.jitterBufferEmittedCount,
      freezeCount:s.freezeCount,totalFreezesDuration:s.totalFreezesDuration}};})()`,remoteContext);}
async function sourceResponsive(){const {stdout}=await execFileAsync(adb,
  ['-s','emulator-5580','shell','dumpsys','window','windows'],{windowsHide:true,timeout:10000,maxBuffer:1024*1024});
  if(/Application Not Responding: com\.zhiliaoapp\.musically|Application Error: com\.zhiliaoapp\.musically/.test(stdout))
    throw Error('Source TikTok app has an ANR/crash dialog; do not count swipes as successful');}
async function capture(ordinal){if(!collectScreens)return;
  // Android hardware video overlays are absent from Page.captureScreenshot.
  // Use the native display for visual evidence instead of saving black rectangles.
  const name=`receiver-${String(ordinal).padStart(2,'0')}.png`;
  await execFileAsync(adb,['-s','emulator-5582','shell','screencap','-p','/sdcard/pong-receiver-audit.png'],{windowsHide:true,timeout:10000});
  await execFileAsync(adb,['-s','emulator-5582','pull','/sdcard/pong-receiver-audit.png',out+'/'+name],{windowsHide:true,timeout:10000});
  return name;}
let controllerOwned=false;
try{
  await sourceResponsive();
  await send('Page.enable');await send('Runtime.enable');
  report.ui=await evaluate(`({version:document.querySelector('.version-number')?.textContent,
    hasRemote:!!document.getElementById('tiktok-remote'),secureContext:isSecureContext,
    rtc:typeof RTCPeerConnection})`);
  if(!report.ui.hasRemote)throw Error('Pong remote button missing');
  await evaluate(`document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0;v.pause()})`);
  for(let n=0;n<3;n++){
    const hotspot=await evaluate(`(()=>{const o=document.getElementById('pong-overlay');
      if(!o||o.classList.contains('hidden')||getComputedStyle(o).display==='none')return null;
      const r=document.getElementById('pong-hotspot').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if(!hotspot)break;
    await tap(hotspot.x,hotspot.y);await delay(80);
  }
  await until(`getComputedStyle(document.getElementById('pong-overlay')).display==='none'`,undefined,4000);
  const button=await evaluate(`(()=>{const b=document.getElementById('tiktok-remote');b.scrollIntoView();
    const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,
      hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id};})()`);
  report.button=button;
  if(!button.w||!button.h)throw Error('Remote button not visible; no synthetic pass');
  if(button.hit!=='tiktok-remote')throw Error('Remote button obscured; no synthetic pass');
  const panelStart=Date.now();await tap(button.x,button.y);
  await until(`!!document.querySelector('#pong-remote-panel iframe')`);
  let frame;
  for(let attempt=0;attempt<40;attempt++){
    const tree=await send('Page.getFrameTree');
    frame=tree.frameTree.childFrames?.find(f=>f.frame.url.includes('/pong-tiktok-remote.html'));
    const context=frame&&[...contexts.values()].find(c=>c.auxData?.frameId===frame.frame.id&&c.auxData?.isDefault);
    if(context){remoteContext=context.id;break;}await delay(100);
  }
  if(!remoteContext)throw Error('Remote iframe context unavailable');
  await until(`!!document.querySelector('#connect')`,remoteContext);
  report.panelOpenMs=Date.now()-panelStart;
  report.remoteUi=await evaluate(`({rtc:typeof RTCPeerConnection,secureContext:isSecureContext,
    faces:document.querySelector('#face').options.length-1})`,remoteContext);
  await evaluate(`document.querySelector('#token').value=${JSON.stringify(key)}`,remoteContext);
  if(requestedCodec)await evaluate(`(()=>{const preferred=${JSON.stringify('video/'+requestedCodec)};
    const nativeAdd=RTCPeerConnection.prototype.addTransceiver;
    RTCPeerConnection.prototype.addTransceiver=function(kind,init){const t=nativeAdd.call(this,kind,init);
      if(kind==='video'){const c=RTCRtpReceiver.getCapabilities('video').codecs;
        const choice=c.filter(x=>x.mimeType.toLowerCase()===preferred);
        if(!choice.length)throw Error('Experimental codec not supported');
        t.setCodecPreferences([...choice,...c.filter(x=>x.mimeType.toLowerCase()!==preferred)]);}
      return t;};return true;})()`,remoteContext);
  await evaluate(`window.__auditConnectStart=performance.now();document.querySelector('#connect').click();true`,remoteContext);
  controllerOwned=true;
  try{
    report.firstReceiverFrame=await until(`(()=>{const v=document.querySelector('#screen');return v.videoWidth&&v.readyState>=2?
      {elapsedMs:performance.now()-window.__auditConnectStart,width:v.videoWidth,height:v.videoHeight,
       muted:v.muted,frames:frameCount,connection:pc?.connectionState}:null;})()`,remoteContext,25000);
  }catch(error){
    report.connectionFailure=await evaluate(`({message:document.querySelector('#stats').textContent,
      peer:pc?.connectionState,ice:pc?.iceConnectionState,signaling:pc?.signalingState})`,remoteContext);
    throw error;
  }
  report.transport=await evaluate(`(async()=>{const v=document.querySelector('#screen'),before=frameCount;
    const start=performance.now();await new Promise(r=>setTimeout(r,10000));return {
      frames:frameCount-before,elapsedMs:performance.now()-start,muted:v.muted,
      measurements:JSON.parse(JSON.stringify(measurements)),server:lastServer};})()`,remoteContext);
  report.transportTelemetry=await telemetry();
  if(useSwap){
    const faces=(await fetch('http://127.0.0.1:8792/faces').then(r=>r.json())).faces;
    const approved=faces.find(f=>f.name==='Approved 3');if(!approved)throw Error('Approved 3 missing');
    await until(`document.querySelector('#face').options.length>1`,remoteContext);
    await evaluate(`document.querySelector('#face').value=${JSON.stringify(approved.id)};
      document.querySelector('#mark').click();true`,remoteContext);
    const bounds=await screenBounds();
    await drag(bounds,[.01,.13],[.84,.86]);
    report.roi=await evaluate('roi',remoteContext);
    if(!report.roi||Math.abs(report.roi[0]-.01)>.04)throw Error('ROI touch did not select expected video region');
    await evaluate(`window.__auditApply=performance.now();document.querySelector('#swap').click();true`,remoteContext);
    await delay(10000);
    report.swapStart=await evaluate(`({afterMs:performance.now()-window.__auditApply,
      regionStatus:regionStatus.textContent,displayedFrames:frameCount,server:lastServer})`,remoteContext);
    report.swapStartTelemetry=await telemetry();
    report.swapStartScreenshot=await capture(0);
    await save();
    for(let ordinal=1;ordinal<=swipeCount;ordinal++){
      await sourceResponsive();
      const before=await telemetry();
      const began=Date.now();await drag(await screenBounds(),[.5,.72],[.5,.27]);
      await delay(5000);
      await sourceResponsive();
      const after=await telemetry();
      const row={ordinal,elapsedMs:Date.now()-began,displayedFrames:after.frames-before.frames,
        inputAckMs:after.acks.slice(before.acks.length),connection:after.connection,muted:after.muted,
        swap:after.server.swap,error:after.server.error,
        processedFrames:after.server.swap.processedFrames-before.server.swap.processedFrames,
        transformedFrames:after.server.swap.transformedFrames-before.server.swap.transformedFrames,
        telemetryBefore:before,telemetryAfter:after,screenshot:await capture(ordinal),
        actualNewVideoVerified:false,firstSwappedFrameScope:'PC completion only; no RTP-to-presentation correlation'};
      report.phases.push(row);await save();
      if(after.connection!=='connected')throw Error('Remote disconnected during swipe');
    }
  }
  report.complete=true;
}catch(error){report.error=String(error.message).slice(0,1500);}
finally{
  if(remoteContext&&controllerOwned){try{await evaluate('stop()',remoteContext);}catch{}}
  try{await evaluate(`document.getElementById('pong-remote-panel')?.remove();true`);}catch{}
  try{report.qualityConfigUnchanged=JSON.stringify(config)===JSON.stringify((await fetch('http://127.0.0.1:8792/settings').then(r=>r.json())).config);}catch{}
  await save();ws.close();
}
console.log(JSON.stringify({complete:report.complete,ui:report.ui,remoteUi:report.remoteUi,
  first:report.firstReceiverFrame,frames:report.transport?.frames,
  swap:report.swapStart?.server?.swap,swipes:report.phases.length,
  failure:report.connectionFailure,error:report.error}));
