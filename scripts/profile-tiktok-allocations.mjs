// Stack/size sampling only. Never takes a heap snapshot, reads objects,
// captures cookies, or stores signed resource URLs.
import {writeFileSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const result={diagnosticOnly:true,note:'Allocation sampler changes timing; do not score this run'};
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/allocations-${Date.now()}.json`;
try{
 await tik.call('HeapProfiler.startSampling',{samplingInterval:1048576,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','5'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'1000',PONG_AUDIT_VARIANT:'diagnostic-allocations-not-scored'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}finally{
 try{
  const {profile}=await tik.call('HeapProfiler.stopSampling',{},45000);
  const rows=[];
  const walk=(node,parents=[])=>{
   const f=node.callFrame;let url='';try{const u=new URL(f.url);url=u.origin+u.pathname}catch{}
   const frame={name:f.functionName,url,line:f.lineNumber};
   if(node.selfSize)rows.push({...frame,bytes:node.selfSize,stack:parents.slice(-8)});
   for(const c of node.children||[])walk(c,[...parents,frame]);
  };walk(profile.head);
  result.sampledBytes=rows.reduce((sum,r)=>sum+r.bytes,0);
  result.topAllocations=rows.sort((a,b)=>b.bytes-a.bytes).slice(0,35);
 }catch(e){result.error=e.message}
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,sampledBytes:result.sampledBytes,error:result.error}));
}
