import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const clients={pong:await connectWebView(60195,'pong'),tiktok:await connectWebView(60195,'tiktok')};
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/cpu-profile-${Date.now()}.json`;
const result={diagnosticOnly:true,note:'CPU profiler changes timing; child swipe metrics are not acceptance scores',profiles:{}};
try{
 for(const c of Object.values(clients)){await c.call('Profiler.enable');await c.call('Profiler.setSamplingInterval',{interval:1000});await c.call('Profiler.start');}
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','5'],{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_VARIANT:'diagnostic-cpu-profile-not-scored'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(r=>child.once('exit',r));result.swipes=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}finally{
 for(const [name,c] of Object.entries(clients)){
  try{
   const {profile}=await c.call('Profiler.stop');
   const nodes=new Map(profile.nodes.map(n=>[n.id,n]));const totals=new Map();
   profile.samples.forEach((id,i)=>{const node=nodes.get(id),f=node.callFrame;
    let url='';try{const u=new URL(f.url);url=u.origin+u.pathname}catch{}
    const key=JSON.stringify({function:f.functionName,url,line:f.lineNumber});totals.set(key,(totals.get(key)||0)+profile.timeDeltas[i]);});
   result.profiles[name]={durationMs:(profile.endTime-profile.startTime)/1000,topSelf: [...totals].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([k,v])=>({...JSON.parse(k),selfMs:v/1000}))};
   await c.call('Profiler.disable');
  }catch(e){result.profiles[name]={error:e.message}}
  c.close();
 }
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
