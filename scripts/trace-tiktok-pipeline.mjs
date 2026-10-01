// Redacted attribution of source readiness vs renderer startup during real
// four-second swipes. Never records credentials, signed URLs or face IDs.
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const tik=await connectWebView(60195,'tiktok');
const production=process.argv.includes('--production');
// Network.dataReceived across TikTok's active media has observable overhead.
// Keep it opt-in for per-hop attribution, not normal timing qualification.
const transportNetwork=process.env.PONG_AUDIT_TRANSPORT_NETWORK==='1';
const decisionDiagnostics=process.env.PONG_AUDIT_DECISIONS==='1';
const result={startedAt:Date.now(),requests:[],cache:[],sessions:[],transport:[],decisions:[],experimental:!production||decisionDiagnostics,transportNetwork,decisionDiagnostics};
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/pipeline-${Date.now()}.json`;
const sourceKey=raw=>{
 try{const u=new URL(raw);return {cacheId:u.pathname.match(/\/video-cache\/media\/([a-f0-9]+)/)?.[1]||'',
  videoId:u.pathname.match(/\/video\/(\d{15,22})/)?.[1]||'',
  kind:u.pathname.includes('/video-cache/media/')?'pc-cache':/tiktok\.com$/.test(u.hostname)?'tiktok-page':'other'};
 }catch{return {kind:'invalid'}}
};
const unsubscribe=pong.onEvent(message=>{
 if(message.method!=='Network.requestWillBeSent')return;
 const request=message.params.request;
 if(request.method!=='POST'||!request.url.split('?')[0].endsWith('/sessions')||result.requests.length>=500)return;
 try{const body=JSON.parse(request.postData);result.requests.push({at:Date.now(),source:sourceKey(body.sourceUrl),
  start:body.startSeconds,prefetch:body.prefetch,navigationClass:body.navigationClass});}catch{}
});
const transportRequests=new Map();
const unsubscribeTransport=tik.onEvent(({method,params:p})=>{
 if(method==='Network.requestWillBeSent'){
  try{
   const url=new URL(p.request.url),match=url.pathname.match(/^\/__pong_swap\/([A-Za-z0-9_-]+)$/);
   if(url.hostname!=='www.tiktok.com'||!match||result.transport.length>=500)return;
   const row={session:match[1],at:Date.now(),bytes:0,chunks:0,seconds:[]};
   transportRequests.set(p.requestId,row);result.transport.push(row);
  }catch{}return;
 }
 const row=transportRequests.get(p?.requestId);if(!row)return;
 if(method==='Network.responseReceived'){row.http=p.response.status;row.mime=p.response.mimeType;row.headersAt=Date.now()}
 if(method==='Network.dataReceived'){
  row.bytes+=p.dataLength;row.chunks++;
  const second=Math.floor((Date.now()-result.startedAt)/1000);let bucket=row.seconds.at(-1);
  if(!bucket||bucket.second!==second){if(row.seconds.length>=1000)return;bucket={second,bytes:0,chunks:0};row.seconds.push(bucket)}
  bucket.bytes+=p.dataLength;bucket.chunks++;
 }
 if(method==='Network.loadingFinished'||method==='Network.loadingFailed'){
  row.endedAt=Date.now();row.finished=method==='Network.loadingFinished';
  row.canceled=!!p.canceled;transportRequests.delete(p.requestId);
 }
});
let running=true;
const poll=(async()=>{
 while(running){
  try{
   const state=await fetch('http://127.0.0.1:8787/video-cache/status',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
   const rows=state.records.filter(row=>row.urls?.some(u=>sourceKey(u).videoId));
   if(result.cache.length<1000)result.cache.push({at:Date.now(),rows:rows.map(row=>({id:row.id,status:row.status,
    bytes:row.bytes,total:row.totalBytes,priority:row.priority,
    failure:row.failure?{category:row.failure.category,attempts:row.failure.attempts,lastAt:row.failure.lastAt}:null,
    videoIds:row.urls.map(u=>sourceKey(u).videoId).filter(Boolean)}))});
  }catch{result.cacheErrors=(result.cacheErrors||0)+1}
  try{
   const state=await fetch('http://127.0.0.1:8792/sessions',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
   if(result.sessions.length<1000)result.sessions.push({at:Date.now(),rows:(state.sessions||[]).map(row=>({
    id:row.id,state:row.state,prefetch:row.prefetch,subscribers:row.subscribers,streamRequests:row.streamRequests,
    frames:row.frames,transformedFrames:row.transformedFrames,bytes:row.bytesWritten,
    complete:row.complete,active:row.active,paused:row.paused,error:row.errorCode||''}))});
  }catch{result.sessionErrors=(result.sessionErrors||0)+1}
  if(decisionDiagnostics){
   try{
    const health=await fetch('http://127.0.0.1:8792/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
    const diagnostic=health.multiFaceDecisionTrial;
    if(!diagnostic?.installed)throw Error('Decision diagnostic not installed');
    if(result.decisions.length<1000)result.decisions.push({at:Date.now(),counts:diagnostic.counts});
   }catch{result.decisionErrors=(result.decisionErrors||0)+1}
  }
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
})();
try{
 await pong.call('Network.enable');
 if(transportNetwork)await tik.call('Network.enable');
 const command=production?['scripts/benchmark-tiktok-emulator.mjs',process.env.PONG_AUDIT_COUNT||'8','--videos']:['scripts/trial-tiktok-nearest-prefetch.mjs'];
 const child=spawn(process.execPath,command,{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
   PONG_AUDIT_SAMPLE_MS:process.env.PONG_AUDIT_SAMPLE_MS||'500',
   PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_VARIANT:process.env.PONG_AUDIT_VARIANT||'29.21-source-attribution'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));
 try{result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1))}catch{result.error='Benchmark did not produce a final record'}
}finally{
 running=false;await poll;unsubscribe();unsubscribeTransport();
 await pong.call('Network.disable').catch(()=>{});if(transportNetwork)await tik.call('Network.disable').catch(()=>{});pong.close();tik.close();
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,exit:result.exit,requests:result.requests.length,benchmark:result.benchmark}));
}
