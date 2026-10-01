// Isolated swipe handoff experiment. Only a session whose DOM overlay has
// actually been retired can yield its GPU slot; normal activation is unchanged.
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok');
const result={startedAt:Date.now(),events:[],experimental:true};
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/departure-${Date.now()}.json`;
const pending=new Set(),leases=new Map();
const control=async(id,action,token)=>{
 const response=await fetch(`http://127.0.0.1:8792/sessions/${encodeURIComponent(id)}/${action}`,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,leaseMs:3500}),
  signal:AbortSignal.timeout(2000)});
 return {status:response.status,ok:response.ok};
};
const unsubscribe=tik.onEvent(message=>{
 if(message.method!=='Runtime.bindingCalled'||message.params.name!=='__pongAuditDeparture')return;
 let event;try{event=JSON.parse(message.params.payload)}catch{return}
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(event.sessionId||'')||result.events.length>=500)return;
 const token=randomUUID(),row={at:Date.now(),pageAt:event.at,sessionId:event.sessionId,token};
 result.events.push(row);leases.set(event.sessionId,token);
 const job=control(event.sessionId,'departure',token).then(r=>Object.assign(row,r,{ackAt:Date.now()}))
  .catch(()=>{row.error='departure request failed'}).finally(()=>pending.delete(job));
 pending.add(job);
});
try{
 const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
 if(!health.departureTrial)throw Error('Departure trial renderer is not installed');
 await tik.call('Runtime.addBinding',{name:'__pongAuditDeparture'});
 result.installed=await tik.read(`(()=>{
  const original=window.__pongDomSwapDepart;
  if(typeof original!=='function')throw Error('No existing departure handler');
  window.__pongDomSwapDepart=function(...args){
   const sessionId=window.__pongDomSwap?.sessionId;
   const value=original.apply(this,args);
   // Notify only AFTER the old transformed pixels have been disposed.
   if(sessionId&&!window.__pongDomSwap)
    window.__pongAuditDeparture(JSON.stringify({sessionId,at:performance.now()}));
   return value;
  };
  window.__pongUndoDepartureLease=()=>{window.__pongDomSwapDepart=original;delete window.__pongUndoDepartureLease;};
  return true;
 })()`);
 const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
   PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_VARIANT:'29.21-departure-lease'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));
 try{result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1))}catch{result.error='Missing benchmark summary'}
}finally{
 await tik.read('window.__pongUndoDepartureLease?.();true').catch(()=>{});
 unsubscribe();await Promise.allSettled([...pending]);
 await Promise.allSettled([...leases].map(([id,token])=>control(id,'return',token)));
 await tik.call('Runtime.removeBinding',{name:'__pongAuditDeparture'}).catch(()=>{});
 tik.close();result.finishedAt=Date.now();
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
