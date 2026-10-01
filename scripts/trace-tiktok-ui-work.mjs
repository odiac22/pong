// Read-only timing attribution on the dedicated Android WebView. Raw event
// arguments (URLs, page text and script bodies) are deliberately not retained.
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const port=Number(process.env.PONG_AUDIT_CDP_PORT||60195);
const page=await connectWebView(port,'tiktok');
const out=process.env.PONG_AUDIT_TRACE_OUTPUT||`E:/Pong Benchmarks/tiktok-webview-2026-09-29/ui-work-${Date.now()}.json`;
const events=[],threads=new Map();let stopped,unsubscribe,swipeResult=null;
const swipes=process.argv.includes('--swipes');
if(swipes&&port!==60195)throw Error('Automated emulator swipes are not allowed on a different target');
const complete=new Promise(resolve=>{stopped=resolve});
try{
 unsubscribe=page.onEvent(({method,params})=>{
  if(method==='Tracing.tracingComplete')stopped();
  if(method!=='Tracing.dataCollected')return;
  for(const event of params.value||[]){
   if(event.ph==='M'&&event.name==='thread_name')threads.set(`${event.pid}:${event.tid}`,String(event.args?.name||''));
   if(event.ph==='X'&&Number.isFinite(event.dur)&&events.length<250000){
    const row={name:event.name,cat:event.cat,pid:event.pid,tid:event.tid,ts:event.ts,dur:event.dur};
    // Function names and script classification only, never source text,
    // request headers, signed URLs, query strings, or page/account content.
    if(event.name==='FunctionCall'){
      const data=event.args?.data||{};row.functionName=String(data.functionName||'').slice(0,120);
      try{const u=new URL(data.url);row.scriptKind=u.pathname==='/pong'?'pong':
        /tiktok|tiktokcdn|ttwstatic/.test(u.hostname)?'tiktok':'other'}catch{row.scriptKind='injected-or-native'}
    }
    events.push(row);
   }
  }
 });
 await page.call('Performance.enable');
 const before=await page.call('Performance.getMetrics');
 await page.call('Tracing.start',{categories:'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,cc,blink,media',transferMode:'ReportEvents'});
 if(swipes){
  const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','4'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'1000',
      PONG_AUDIT_VARIANT:'diagnostic-swipes-with-Chromium-tracing-NOT-FPS-qualification'}});
  let log='';child.stdout.on('data',data=>{log+=data;process.stdout.write(data)});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  try{swipeResult={code,...JSON.parse(log.trim().split(/\r?\n/).at(-1))}}catch{swipeResult={code,error:'Missing benchmark record'}}
 }else await new Promise(resolve=>setTimeout(resolve,10000));
 await page.call('Tracing.end');
 await Promise.race([complete,new Promise((_,reject)=>setTimeout(()=>reject(Error('Trace completion timed out')),10000))]);
 const after=await page.call('Performance.getMetrics');
 const metrics=Object.fromEntries(after.metrics.map(m=>[m.name,m.value-(before.metrics.find(x=>x.name===m.name)?.value||0)]));
 const groups=new Map();
 for(const e of events){const key=`${e.pid}:${e.tid}:${e.name}`;let g=groups.get(key);
  if(!g){g={thread:threads.get(`${e.pid}:${e.tid}`)||`${e.pid}:${e.tid}`,name:e.name,count:0,totalMs:0,maxMs:0};groups.set(key,g)}
  g.count++;g.totalMs+=e.dur/1000;g.maxMs=Math.max(g.maxMs,e.dur/1000);
 }
 const result={note:'Diagnostic timing attribution; optional four physical feed swipes. Nested durations overlap; NOT an FPS qualification.',
  swipeResult,metrics,groups:[...groups.values()].sort((a,b)=>b.totalMs-a.totalMs),events};
 writeFileSync(out,JSON.stringify(result,null,2));
 console.log(JSON.stringify({saved:out,metrics,top:result.groups.slice(0,30)}));
}finally{unsubscribe?.();await page.call('Tracing.end').catch(()=>{});await page.call('Performance.disable').catch(()=>{});page.close()}
