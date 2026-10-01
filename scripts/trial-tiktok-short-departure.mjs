import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {installShortDepartureTrial} from './lib/tiktok-short-departure-trial.mjs';
const count=Number(process.argv[2]||8);
const baseline=process.argv.includes('--baseline');
if(!Number.isSafeInteger(count)||count<1||count>40)throw Error('Expected 1..40 videos');
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/short-departure-${Date.now()}.json`;
const result={startedAt:Date.now(),leaseMs:baseline?0:1000,baseline,events:[],experimental:true,restored:false};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const pending=new Set(),leases=new Map();
const control=async(row,action)=>{
  const response=await fetch(`http://127.0.0.1:8792/sessions/${row.sessionId}/${action}`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({token:row.token,leaseMs:1000}),signal:AbortSignal.timeout(2000)});
  return {status:response.status,ok:response.ok};
};
const unsubscribe=tik.onEvent(message=>{
  if(message.method!=='Runtime.bindingCalled'||message.params.name!=='__pongAuditDeparture')return;
  let event;try{event=JSON.parse(message.params.payload)}catch{return}
  if(!/^[a-f0-9]{32}$/.test(event.sessionId||'')||!Number.isSafeInteger(event.requestId)||result.events.length>=500)return;
  if(event.kind==='depart'){
    const row={at:Date.now(),sessionId:event.sessionId,requestId:event.requestId,token:randomUUID()};
    result.events.push(row);leases.set(event.requestId,row);
    const job=control(row,'departure').then(async r=>{
      Object.assign(row,r,{ackAt:Date.now()});
      // A return may precede the response; never let network order lose it.
      if(row.returnRequested&&r.ok)row.returnResult=await control(row,'return');
    }).catch(()=>{row.error='departure failed'}).finally(()=>pending.delete(job));
    row.job=job;pending.add(job);
  }else if(event.kind==='return'){
    const row=leases.get(event.requestId);if(!row||row.sessionId!==event.sessionId)return;
    row.returnRequested=true;row.returnReason='no-observed-navigation';
    const job=row.job.then(async()=>{if(row.ok&&!row.returnResult)row.returnResult=await control(row,'return')})
      .catch(()=>{row.returnError=true}).finally(()=>pending.delete(job));
    pending.add(job);
  }
});
try{
  const health=await fetch('http://127.0.0.1:8792/health').then(r=>r.json());
  if(!health.departureTrial?.installed)throw Error('Departure trial renderer is not installed');
  await pong.read(pause);await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
  if(!baseline){
    await tik.call('Runtime.addBinding',{name:'__pongAuditDeparture'});
    result.installed=await tik.read(`(${installShortDepartureTrial.toString()})()`);
  }
  await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
  await new Promise(r=>setTimeout(r,4000));
  const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs',String(count),'--videos'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
      PONG_AUDIT_SAMPLE_MS:'100',PONG_AUDIT_VARIANT:baseline?'guest-departure-paired-baseline':'guest-one-second-departure-trial'}});
  let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
  result.exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  try{result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1))}catch{result.error='Missing benchmark summary';}
}catch(e){result.error=String(e.message).replace(/https?:\/\/\S+/g,'[redacted]');process.exitCode=1;}
finally{
  await tik.read('window.__pongUndoShortDeparture?.();true').catch(()=>{});
  unsubscribe();await Promise.allSettled([...pending]);
  await Promise.allSettled([...leases.values()].filter(row=>row.ok&&!row.returnResult).map(row=>control(row,'return')));
  await pong.read(pause).catch(()=>{});
  await tik.call('Runtime.removeBinding',{name:'__pongAuditDeparture'}).catch(()=>{});
  tik.close();pong.close();result.finishedAt=Date.now();result.restored=true;
  for(const row of result.events){delete row.job;delete row.token;}
  writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({saved:output,events:result.events.length,benchmark:result.benchmark,error:result.error||null}));
}
