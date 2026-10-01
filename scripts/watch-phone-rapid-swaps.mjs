// Bounded passive phone recording: no navigation, social actions or playback writes.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {writeFile} from 'node:fs/promises';
const [output, seconds='120']=process.argv.slice(2);
if(!output)throw Error('Output path required');
const tik=await connectWebView(60196,'tiktok'),pong=await connectWebView(60196,'pong');
const records=[];
const install=String.raw`(()=>{
 window.__pongRapidAudit?.stop();
 const events=[],raf=[],paints=[],watched=new Map();let running=true,last=0,rafId;
 const bounded=(a,x)=>{if(a.length>=1500)a.shift();a.push(x)};
 const tick=t=>{if(last)bounded(raf,t-last);last=t;if(running)rafId=requestAnimationFrame(tick)};
 rafId=requestAnimationFrame(tick);
 const id=()=>String(window.__pongTikTokObservedVideo?.pageUrl||location.pathname).match(/video\/(\d+)/)?.[1]||'';
 const mark=e=>{const b=e.target?.closest?.('button,[role="button"],[data-e2e]');
   const key=[b?.getAttribute('data-e2e'),b?.getAttribute('aria-label'),e.target?.getAttribute?.('data-e2e')].join(' ');
   if(/like|unlike|digg/i.test(key)&&!/^likes\s/i.test(key))bounded(events,{kind:'like-control',at:performance.now(),id:id(),key:key.slice(0,140)});
   if(e.type==='dblclick'&&e.target?.closest?.('[data-e2e="feed-video"]'))bounded(events,{kind:'video-double-tap',at:performance.now(),id:id()});
 };
 document.addEventListener('click',mark,true);document.addEventListener('dblclick',mark,true);
 const watch=(v,role)=>{if(!v||watched.has(v))return;let cb;
  const painted=(now,f)=>{if(!running||!v.isConnected)return;
   const s=window.__pongDomSwap,o=window.__pongTikTokObservedVideo;
   if(v===s?.overlay||v===o?.video)bounded(paints,{at:now,time:f.mediaTime,role:v===s?.overlay?'swap':'original',visible:v===s?.overlay?!!s.visible:!s?.visible,session:v===s?.overlay?s.sessionId:'',id:id()});
   cb=v.requestVideoFrameCallback(painted);
  };if(v.requestVideoFrameCallback)cb=v.requestVideoFrameCallback(painted);
  const ev=e=>bounded(events,{kind:e.type,at:performance.now(),id:id(),role,ready:v.readyState,time:v.currentTime});
  for(const n of ['waiting','stalled','error'])v.addEventListener(n,ev);
  watched.set(v,()=>{v.cancelVideoFrameCallback?.(cb);for(const n of ['waiting','stalled','error'])v.removeEventListener(n,ev)});
 };
 const media=v=>{if(!v)return null;const q=v.getVideoPlaybackQuality?.();return {time:v.currentTime,ready:v.readyState,paused:v.paused,seeking:v.seeking,width:v.videoWidth,height:v.videoHeight,decoded:q?.totalVideoFrames,dropped:q?.droppedVideoFrames}};
 window.__pongRapidAudit={read(){const s=window.__pongDomSwap,o=window.__pongTikTokObservedVideo;
  for(const [v,stop] of watched)if(!v.isConnected||(v!==s?.overlay&&v!==o?.video)){stop();watched.delete(v)};
  watch(o?.video,'original');watch(s?.overlay,'swap');
  return {at:performance.now(),hidden:document.hidden,path:location.pathname,id:id(),original:media(o?.video),swap:media(s?.overlay),session:s?.sessionId||'',visible:!!s?.visible,age:s?performance.now()-s.createdAt:null,firstVisibleAt:s?.firstVisibleAt,transport:s?.transport,queue:s?.queue?.length||0,events:events.splice(0),raf:raf.splice(0),paints:paints.splice(0)};
 },stop(){running=false;cancelAnimationFrame(rafId);for(const stop of watched.values())stop();watched.clear();document.removeEventListener('click',mark,true);document.removeEventListener('dblclick',mark,true);delete window.__pongRapidAudit}};
 return true;
})()`;
try{
 await tik.read(install);console.log('Passive phone recorder ready; no playback or social actions.');
 const end=Date.now()+Number(seconds)*1000;let lastId='',i=0;
 while(Date.now()<end){
  const view=await tik.read('window.__pongRapidAudit?.read()');
  if(!view){await tik.read(install);continue;}
  const control=await pong.read(`(()=>{const w=pongFaceSwapCurrentWrapper();return {session:w?.dataset.pongFaceSwapSessionId||'',active:w?.dataset.pongFaceSwapActive,busy:w?.dataset.pongFaceSwapBusy,enabled:pongFaceSwapState.enabled,panel:document.getElementById('pong-face-swap-status')?.textContent||'',diagnostics:pongRuntimeDiagnostics.slice(-4).map(d=>({type:d.type,at:d.at}))}})()`);
  let backend=null;
  if(i%2===0&&/^[a-f0-9]{32}$/.test(control.session))try{const r=await fetch('http://127.0.0.1:8792/sessions/'+control.session,{signal:AbortSignal.timeout(1500)}).then(r=>r.json()),b=r.session||{};backend={id:b.id,state:b.state,frames:b.frames,transformedFrames:b.transformedFrames,multiFace:b.multiFace,fps:b.fps,errorCode:b.errorCode,timings:b.timings};}catch(e){backend={error:String(e)}}
  records.push({wall:Date.now(),view,control,backend});
  if(view.id!==lastId||view.events.some(e=>/like|tap/.test(e.kind))||i%10===0)console.log(JSON.stringify({elapsed:records.length*.5,id:view.id,path:view.path,visible:view.visible,original:view.original,swap:view.swap,panel:control.panel,backend,markers:view.events.filter(e=>/like|tap/.test(e.kind)),rafMax:view.raf.length?Math.max(...view.raf):null}));
  lastId=view.id;i++;await new Promise(r=>setTimeout(r,500));
 }
}finally{
 await tik.read('window.__pongRapidAudit?.stop()').catch(()=>{});tik.close();pong.close();
 await writeFile(output,JSON.stringify({recordedAt:new Date().toISOString(),records},(_,v)=>typeof v==='string'?v.replace(/https?:\/\/\S+/g,'[URL omitted]'):v),{flag:'wx'});
 console.log('Saved '+records.length+' samples to '+output);
}
