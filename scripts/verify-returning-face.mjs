import fs from 'node:fs/promises';
const base='http://127.0.0.1:8792';
const targets=await fetch('http://127.0.0.1:9223/json/list').then(r=>r.json());
const page=targets.find(p=>p.type==='page'&&p.title==='Pong 1');
if(!page)throw Error('Pong 1 unavailable');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
const input=await new Promise((resolve,reject)=>{
 const timeout=setTimeout(()=>{ws.close();reject(Error('WebView timeout'));},5000);
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==1)return;clearTimeout(timeout);ws.close();if(m.result?.exceptionDetails)reject(Error('WebView evaluation failed'));else resolve(m.result?.result?.value);};
 ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,expression:`(()=>{const w=pongFaceSwapCurrentWrapper(),v=w?.querySelector('video.video-player');return {sourceUrl:v?.__pongSwapOriginal?.source||(typeof allVideoUrls!=='undefined'?allVideoUrls[0]:'')||v?.src,faceId:w?.dataset.pongFaceSwapFaceId||pongFaceSwapState.selectedFaceId||'approved-8-f7bf754ac81f'}})()`}}));
});
if(!input?.sourceUrl)throw Error('No current source');
input.sourceUrl=new URL(input.sourceUrl,'http://127.0.0.1:8787').href;
let id;const abort=new AbortController();const rows=[];let bytes=0;
try{
 const response=await fetch(base+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,channel:'test',startSeconds:24,navigationClass:'seek',prefetch:false,prebufferSeconds:1}),signal:AbortSignal.timeout(30000)});
 const created=await response.json();id=created.session?.id||created.id;
 if(!response.ok||!id)throw Error('Test session creation failed '+response.status);
 const readerTask=(async()=>{const r=await fetch(base+'/sessions/'+id+'/stream',{signal:abort.signal});if(!r.ok)throw Error('Stream HTTP '+r.status);for await(const chunk of r.body)bytes+=chunk.length;})().catch(e=>{if(!abort.signal.aborted)console.error(e.message);});
 const started=Date.now();
 while(Date.now()-started<90000){
  const r=await fetch(base+'/sessions/'+id,{signal:AbortSignal.timeout(5000)}).then(r=>r.json());const s=r.session||r;
  rows.push({elapsedMs:Date.now()-started,frames:s.frames,transformed:s.transformedFrames,fps:s.fps,checks:s.targetIdentityChecks,rejected:s.targetIdentityRejections,samples:s.targetIdentityRejectionSamples,error:s.errorCode});
  if(s.errorCode||s.complete||s.frames>=Math.ceil((s.fps||30)*22))break;
  await new Promise(r=>setTimeout(r,500));
 }
 abort.abort();await readerTask;
 await fs.mkdir('artifacts/returning-face-30.24',{recursive:true});
 await fs.writeFile('artifacts/returning-face-30.24/live-test.json',JSON.stringify({bytes,rows},null,2));
 console.log(JSON.stringify({bytes,...rows.at(-1)},null,2));
}finally{abort.abort();if(id)await fetch(base+'/sessions/'+id,{method:'DELETE',signal:AbortSignal.timeout(5000)}).catch(()=>{});}
