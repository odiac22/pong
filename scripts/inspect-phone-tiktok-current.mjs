// Read-only phone inspection. No navigation, playback mutation or credentials.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {writeFile} from 'node:fs/promises';
const pong=await connectWebView(60196,'pong'),tik=await connectWebView(60196,'tiktok');
const output=process.argv[2];
const geometry=`(()=>{
 const rect=e=>{const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}:null};
 const style=e=>{if(!e)return null;const s=getComputedStyle(e);return {background:s.backgroundColor,color:s.color,overflowX:s.overflowX,overflowY:s.overflowY,width:s.width,height:s.height,margin:s.margin,padding:s.padding,position:s.position,objectFit:s.objectFit,opacity:s.opacity}};
 const media=v=>v?{rect:rect(v),style:style(v),ready:v.readyState,paused:v.paused,seeking:v.seeking,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,error:v.error?.code||null,buffered:Array.from({length:v.buffered?.length||0},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])}:null;
 const s=window.__pongDomSwap,o=window.__pongTikTokObservedVideo;
 const videos=[...document.querySelectorAll('video')];
 const original=o?.video||videos.filter(v=>!v.classList.contains('pong-tiktok-swap-stream')).sort((a,b)=>{const x=rect(a),y=rect(b);return y.width*y.height-x.width*x.height})[0];
 const parents=[];for(let e=original,i=0;e&&i<7;e=e.parentElement,i++)parents.push({tag:e.tagName,className:String(e.className).slice(0,160),rect:rect(e),style:style(e)});
 return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visualWidth:visualViewport?.width,visualHeight:visualViewport?.height},document:{width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,style:style(document.documentElement)},body:{rect:rect(document.body),style:style(document.body)},original:media(original),swap:media(s?.overlay),parents,
 compositor:{installed:!!window.__pongDomSwapInstalled,active:!!s,visible:!!s?.visible,session:s?.sessionId||'',frameSync:window.__pongDomSwapSync?.pongFrameSync||0,stableHandoff:window.__pongDomSwapSync?.pongStableHandoff||0,transport:s?.transport||null},
 videoCount:videos.length,styles:[...document.querySelectorAll('style[id]')].map(e=>({id:e.id,length:e.textContent.length}))};
})()`;
const state=`(()=>{const w=pongFaceSwapCurrentWrapper();return {
 nativeTikTok:window.PongNativeSwap?.tiktokModeActive?.(),
 enabled:pongFaceSwapState.enabled,selectedFaceCount:pongFaceSwapFaceIds().length,
 session:w?.dataset.pongFaceSwapSessionId||'',external:w?.dataset.pongExternalPlaybackAuthority,
 active:w?.dataset.pongFaceSwapActive,busy:w?.dataset.pongFaceSwapBusy,
 diagnostic:pongRuntimeDiagnostics.slice(-20).map(d=>({type:d.type,at:d.at,detail:d.detail})),
 panel:document.getElementById('pong-face-swap-status')?.textContent||'',
 wrapperCount:document.querySelectorAll('.video-wrapper').length};})()`;
const report={capturedAt:new Date().toISOString(),samples:[]};
try{
 for(let i=0;i<3;i++){
  const [p,v]=await Promise.all([pong.read(state),tik.read(geometry)]);
  let backend=null;
  if(/^[a-f0-9]{32}$/.test(p.session)){
   const r=await fetch('http://127.0.0.1:8792/sessions/'+p.session,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
   const b=r.session||{};backend={id:b.id,state:b.state,frames:b.frames,transformedFrames:b.transformedFrames,errorCode:b.errorCode,multiFace:b.multiFace,fps:b.fps,firstByteAt:b.firstByteAt,modelsReadyAt:b.modelsReadyAt};
  }
  report.samples.push({pong:p,view:v,backend});
  if(i<2)await new Promise(r=>setTimeout(r,2000));
 }
 await writeFile(output,JSON.stringify(report,(_,v)=>typeof v==='string'?v.replace(/https?:\/\/\S+/g,'[URL omitted]'):v,2),{flag:'wx'});
 console.log(JSON.stringify(report.samples.map(s=>({enabled:s.pong.enabled,selected:s.pong.selectedFaceCount,native:s.pong.nativeTikTok,active:s.pong.active,busy:s.pong.busy,backend:s.backend,compositor:s.view.compositor,viewport:s.view.viewport,document:s.view.document,original:s.view.original,swap:s.view.swap})),null,2));
}finally{pong.close();tik.close();}
