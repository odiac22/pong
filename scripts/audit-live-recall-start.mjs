// Silent physical-phone audit. Emits only card indexes, timing and media state.
import fs from 'node:fs/promises';
const pages=await(await fetch('http://127.0.0.1:9223/json/list')).json();
const page=pages.find(p=>/Pong/i.test(p.title));
if(!page)throw Error('Pong debug target absent');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);p.resolve(m);pending.delete(m.id)}}};
ws.onclose=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Phone debug connection closed'))}pending.clear()};
async function evaluate(expression){const id=++seq;const p=new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{pending.delete(id);reject(Error('Phone evaluation timed out'))},30000);
 pending.set(id,{resolve,reject,timer});
});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));const m=await p;if(m.result?.exceptionDetails)throw Error(m.result.exceptionDetails.text);return m.result?.result?.value;}
const count=Number(process.argv[2]||15),results=[];
const offset=Number(process.argv[3]||0);
const report=`artifacts/live-recall-start/audit-${Date.now()}.json`;
await fs.mkdir('artifacts/live-recall-start',{recursive:true});
try {
 await evaluate(`(()=>{document.querySelectorAll('video').forEach(v=>{v.muted=true;v.defaultMuted=true;v.volume=0});return true})()`);
 const indexes=await evaluate(`getDeckWrappers().map(w=>getDeckIndex(w))`);
 if(indexes.length<count)throw Error(`Expected ${count} distinct cards; found ${indexes.length}`);
 for(const index of indexes.slice(offset,offset+count)){
  const row=await evaluate(`(async()=>{
    if(document.visibilityState!=='visible')return {index:${index},error:'app is not foreground',pass:false};
    document.querySelectorAll('video').forEach(v=>{v.muted=true;v.defaultMuted=true;v.volume=0});
    const t=performance.now();
    setDeckActiveIndex(${index},'up');
    const w=document.querySelector('.deck-active'),v=w?.querySelector('video');if(!v)return {error:'no active card'};
    if(getDeckIndex(w)!==${index})return {index:${index},error:'navigation mismatch',pass:false};
    v.muted=true;v.defaultMuted=true;v.volume=0;let first=null,from=null,last=null,stalls=0;
    let requested=false;
    for(let k=0;k<100;k++){
      if(!w.classList.contains('deck-active'))return {index:w.dataset.index,error:'card changed'};
      // Match pressing Play: preload alone need not decode frames on Android.
      // Waiting for readyState >= 2 before play artificially delays startup.
      if(!requested){requested=true;v.play().catch(()=>{});}
      if(!v.paused&&v.currentTime>0){if(first===null){first=performance.now()-t;from=v.currentTime;}if(last!==null&&v.currentTime===last)stalls++;last=v.currentTime;}
      if(from!==null&&v.currentTime-from>=3)return {index:w.dataset.index,firstMs:Math.round(first),elapsedMs:Math.round(performance.now()-t),advanced:v.currentTime-from,stalls,width:v.videoWidth,playbackPass:stalls===0,pass:stalls===0&&first<=1000};
      await new Promise(r=>setTimeout(r,200));
    }
    return {index:w.dataset.index,firstMs:first,elapsedMs:Math.round(performance.now()-t),ready:v.readyState,advanced:from===null?0:v.currentTime-from,stalls,pass:false};
  })()`);
  results.push(row);console.log(JSON.stringify(row));
  await fs.writeFile(report,JSON.stringify(results,null,2));
  if(row.error==='app is not foreground')throw Error(row.error);
 }
} finally {ws.close();await fs.writeFile(report,JSON.stringify(results,null,2));}
