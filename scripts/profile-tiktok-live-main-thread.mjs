// Real APK, same already-open page. CPU attribution only, not acceptance.
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const pauseOwned=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/main-thread-${Date.now()}.json`;
const result={scope:'CPU-attribution-only-sampling-overhead-not-FPS-qualification',runs:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function summarize(profile){
  const byId=new Map(profile.nodes.map(n=>[n.id,n])),totals=new Map();
  for(let i=0;i<(profile.samples||[]).length;i++){
    const n=byId.get(profile.samples[i]);if(!n)continue;
    const f=n.callFrame;
    let url='';try{const u=new URL(f.url);url=u.origin+u.pathname;}catch{url=f.url||'(anonymous)';}
    const key=JSON.stringify([f.functionName,url,f.lineNumber+1]);
    totals.set(key,(totals.get(key)||0)+(profile.timeDeltas?.[i]||0));
  }
  return [...totals].map(([key,us])=>{const [name,url,line]=JSON.parse(key);return {name,url,line,ms:us/1000};}).sort((a,b)=>b.ms-a.ms).slice(0,50);
}
try{
  await pong.read(pauseOwned);await sleep(1000);
  const valid=await tik.read('({video:!!window.__pongTikTokObservedVideo?.video?.isConnected,challenge:!!document.querySelector("[id^=captcha-verify-container],[class*=captcha-drag-icon]")})');
  if(!valid.video||valid.challenge)throw Error('No playable page or verification required');
  await tik.call('Profiler.enable');await tik.call('Profiler.setSamplingInterval',{interval:1000});
  for(const swap of [false,true]){
    if(swap)await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
    await tik.read('(()=>{window.__pongCpuRaf=[];window.__pongCpuStop=false;let prev=performance.now();const f=n=>{window.__pongCpuRaf.push(n-prev);prev=n;if(!window.__pongCpuStop)requestAnimationFrame(f);};requestAnimationFrame(f);return true;})()');
    await tik.call('Profiler.start');await sleep(8000);
    const {profile}=await tik.call('Profiler.stop');
    const frame=await tik.read('window.__pongCpuStop=true;({raf:window.__pongCpuRaf,visible:!!window.__pongDomSwap?.visible})');
    result.runs.push({swap,elapsedMs:(profile.endTime-profile.startTime)/1000,...frame,top:summarize(profile)});
    console.log(JSON.stringify({swap,visible:frame.visible,top:result.runs.at(-1).top.slice(0,12)}));
  }
}catch(e){result.error=e.message;process.exitCode=1;}
finally{
  await tik.call('Profiler.stop').catch(()=>{});await tik.call('Profiler.disable').catch(()=>{});
  await tik.read('window.__pongCpuStop=true').catch(()=>{});await pong.read(pauseOwned).catch(()=>{});
  pong.close();tik.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,error:result.error||null}));
}
