// CPU attribution only. No cookies, page text, media URLs, screenshots or pixels.
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const client=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/ui-cpu-${Date.now()}.json`;
let enabled=false,recording=false;
try {
  const preflight=await client.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
    return {original:!window.__pongDomSwap&&!window.__pongDomSwapWarm,
      video:!!v,playing:!!v&&!v.paused,muted:v?.muted===true,
      challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')}})()`);
  if(!preflight.original||!preflight.video||!preflight.playing||!preflight.muted||preflight.challenge)
    throw Error('CPU attribution needs muted original video and no challenge');
  await client.call('Profiler.enable');enabled=true;
  await client.call('Profiler.setSamplingInterval',{interval:500});
  await client.call('Profiler.start');recording=true;
  await new Promise(resolve=>setTimeout(resolve,5000));
  const {profile}=await client.call('Profiler.stop');recording=false;
  const self=new Map(),hits=new Map();
  for(let index=0;index<(profile.samples??[]).length;index++){
    const id=profile.samples[index];self.set(id,(self.get(id)??0)+(profile.timeDeltas?.[index]??0));
    hits.set(id,(hits.get(id)??0)+1);
  }
  const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
  const parents=new Map();
  for(const node of profile.nodes)for(const child of node.children??[])parents.set(child,node.id);
  const location=node=>{
    const frame=node.callFrame;let source='injected-or-runtime';
    try{const u=new URL(frame.url);source=u.hostname==='www.tiktok.com'?'tiktok-document':u.hostname;}catch{}
    return {function:String(frame.functionName||'(anonymous)').slice(0,160),source,
      scriptId:frame.scriptId,line:frame.lineNumber,column:frame.columnNumber};
  };
  const rows=[...self].map(([id,microseconds])=>({id,...location(nodes.get(id)),
    sampledSelfMs:microseconds/1000,hits:hits.get(id),
    parent:parents.has(id)?location(nodes.get(parents.get(id))):null})).sort((a,b)=>b.sampledSelfMs-a.sampledSelfMs);
  const summary={cpuAttributionOnly:true,notFpsQualification:true,preflight,
    sampledMs:(profile.endTime-profile.startTime)/1000,samples:profile.samples.length,rows};
  writeFileSync(output,JSON.stringify(summary,null,2));
  console.log(JSON.stringify({output,sampledMs:summary.sampledMs,top:rows.slice(0,16)}));
}finally {
  if(recording)await client.call('Profiler.stop').catch(()=>{});
  if(enabled)await client.call('Profiler.disable').catch(()=>{});
  client.close();
}
