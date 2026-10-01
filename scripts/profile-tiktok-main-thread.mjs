import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const surface=process.argv.includes('--pong')?'pong':'tiktok';
const p=await connectWebView(60195,surface);
const navigation=surface==='pong'?await connectWebView(60195,'tiktok'):p;
try{
 await p.call('Profiler.enable');await p.call('Profiler.setSamplingInterval',{interval:1000});await p.call('Profiler.start');
 await navigation.read('window.__pongTikTokStep(1)');await new Promise(r=>setTimeout(r,5000));
 const {profile}=await p.call('Profiler.stop');
 const saved=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/${surface}-${Date.now()}.cpuprofile`;
 writeFileSync(saved,JSON.stringify(profile));
 const total=new Map();profile.samples?.forEach((id,i)=>total.set(id,(total.get(id)||0)+(profile.timeDeltas?.[i]||0)));
 console.log(JSON.stringify({saved,top:profile.nodes.map(n=>({fn:n.callFrame.functionName,url:n.callFrame.url.split('?')[0].slice(-110),line:n.callFrame.lineNumber,ms:(total.get(n.id)||0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,30)}));
}finally{p.close();if(navigation!==p)navigation.close()}
