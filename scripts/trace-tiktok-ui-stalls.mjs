// Bounded renderer/compositor attribution. Persist event names/durations only.
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const client=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/ui-trace-${Date.now()}.json`;
let tracing=false,stream=null;
try {
  const safe=await client.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
    return !!v&&!v.paused&&v.muted&&!window.__pongDomSwap&&!window.__pongDomSwapWarm&&
      !document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')})()`);
  if(!safe)throw Error('Trace requires muted original video and no challenge');
  let complete;
  const completed=new Promise(resolve=>{complete=resolve});
  const remove=client.onEvent(event=>{if(event.method==='Tracing.tracingComplete')complete(event.params)});
  await client.call('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline,cc,viz',
    transferMode:'ReturnAsStream',options:'record-until-full'});
  tracing=true;
  await new Promise(resolve=>setTimeout(resolve,5000));
  await client.call('Tracing.end');tracing=false;
  const end=await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Trace completion timed out')),10000))]);
  remove();stream=end.stream;
  const chunks=[];let total=0;
  for(;;){
    const chunk=await client.call('IO.read',{handle:stream,size:1024*1024});
    const data=chunk.base64Encoded?Buffer.from(chunk.data,'base64').toString('utf8'):chunk.data;
    total+=data.length;if(total>64*1024*1024)throw Error('Trace exceeds bounded memory');
    chunks.push(data);if(chunk.eof)break;
  }
  const trace=JSON.parse(chunks.join(''));chunks.length=0;
  const byName=new Map(),threads=new Map();
  for(const event of trace.traceEvents??[]){
    if(event.ph==='M'&&event.name==='thread_name')threads.set(`${event.pid}/${event.tid}`,String(event.args?.name??'').slice(0,80));
    if(event.ph!=='X'||!Number.isFinite(event.dur))continue;
    const key=`${event.pid}/${event.tid}/${event.name}`;
    const row=byName.get(key)??{name:String(event.name).slice(0,120),pid:event.pid,tid:event.tid,count:0,totalMs:0,maxMs:0,over50Ms:0};
    row.count++;row.totalMs+=event.dur/1000;row.maxMs=Math.max(row.maxMs,event.dur/1000);row.over50Ms+=Number(event.dur>50000);
    byName.set(key,row);
  }
  const rows=[...byName.values()].map(row=>({...row,thread:threads.get(`${row.pid}/${row.tid}`)??'unknown'})).sort((a,b)=>b.totalMs-a.totalMs);
  writeFileSync(output,JSON.stringify({diagnosticOnly:true,notFpsQualification:true,eventArgumentsSaved:false,rows},null,2));
  console.log(JSON.stringify({output,top:rows.filter(row=>row.maxMs>30).slice(0,35)}));
}finally{
  if(tracing)await client.call('Tracing.end').catch(()=>{});
  if(stream)await client.call('IO.close',{handle:stream}).catch(()=>{});
  client.close();
}
