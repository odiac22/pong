import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
const url=process.argv[2];
const result={version:'29.44',qualitySettingsChanged:false};
const r=await fetch(url,{method:'HEAD'});result.apk={status:r.status,size:r.headers.get('content-length')};
const p=await connectWebView(60196,'pong');
try{result.phoneDownload=await p.read(`fetch(${JSON.stringify(url)},{method:'HEAD',mode:'no-cors',signal:AbortSignal.timeout(5000)}).then(r=>({reachable:true,type:r.type})).catch(e=>({reachable:false,error:String(e)}))`)}finally{p.close()}
const h=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());const a=h.exactAcceleration?.acceleration||h.exactAcceleration;
result.renderer={ready:h.ready,accelerationInstalled:a?.installed,reason:a?.reason,features:a?.gate?.features};
const root='E:/Pong Benchmarks/phone-live-2026-09-30/';
result.runs={};
for(const name of ['rapid-before','rapid-batch-foreground','rapid-restored-acceleration']){
 const rows=JSON.parse(readFileSync(root+name+'.json')).records,active=rows.filter(r=>!r.view.hidden&&r.view.id);
 const sessions=new Map();
 for(const r of active){const v=r.view;if(!v.session)continue;const old=sessions.get(v.session)||{id:v.id,appendCalls:0,chunks:0,decoded:0,dropped:0,transformed:0,paints:[]};
  old.appendCalls=Math.max(old.appendCalls,v.transport?.appendCalls||0);old.chunks=Math.max(old.chunks,v.transport?.chunks||0);
  old.decoded=Math.max(old.decoded,v.swap?.decoded||0);old.dropped=Math.max(old.dropped,v.swap?.dropped||0);
  if(r.backend?.id===v.session)old.transformed=Math.max(old.transformed,r.backend?.transformedFrames||0);
  old.paints.push(...v.paints.filter(p=>p.role==='swap'&&p.visible));sessions.set(v.session,old);
 }
 result.runs[name]={foregroundSamples:active.length,posts:new Set(active.map(r=>r.view.id)).size,
  markers:rows.flatMap(r=>r.view.events.filter(e=>/like|tap/.test(e.kind))),sessions:[...sessions.values()].map(({paints,...s})=>({...s,visibleFrameCallbacks:paints.length}))};
}
result.limits=['Different clips in observational runs: not a matched FPS speedup benchmark.','Cold-start failures remain; sub-one-second face-visible latency is NOT qualified.','29.44 is built, not installed on the phone.','Like-control/double-tap events are reported user markers, not verified social mutations.'];
writeFileSync(root+'rapid-release-2944.json',JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result));
