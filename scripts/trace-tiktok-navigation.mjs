import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const page=await connectWebView(60195,'tiktok');
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
let resolveDone;
const events=[];
const done=new Promise(r=>resolveDone=r),stop=page.onEvent(m=>{
 if(m.method==='Tracing.tracingComplete')resolveDone(m.params);
 if(m.method==='Tracing.dataCollected')events.push(...m.params.value);
});
try{
 await page.call('Tracing.start',{categories:'-*,devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,toplevel',transferMode:'ReportEvents'});
 execFileSync(adb,['-s','emulator-5582','shell','input','swipe','650','1550','650','650','150']);
 await new Promise(r=>setTimeout(r,5000));await page.call('Tracing.end');
 await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('Trace completion timeout')),10000))]);
 const trace={traceEvents:events},data=JSON.stringify(trace),path=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/navigation-${Date.now()}.json`;
 // Timeline events are kept locally only; URLs/arguments are omitted from console.
 writeFileSync(path,data);
 const totals=new Map();for(const e of trace.traceEvents||[])if(e.ph==='X'&&e.dur){const key=e.name;const v=totals.get(key)||{name:key,ms:0,count:0,maxMs:0};v.ms+=e.dur/1000;v.count++;v.maxMs=Math.max(v.maxMs,e.dur/1000);totals.set(key,v)}
 console.log(JSON.stringify({saved:path,tasks:[...totals.values()].sort((a,b)=>b.ms-a.ms).slice(0,25)}));
}finally{stop();page.close()}
