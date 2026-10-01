// Scoped, silent emulator diagnostic. No URLs, event arguments or frame pixels
// are saved. Trace timings include instrumentation overhead, not acceptance FPS.
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';

export function reduceTrace(events) {
  const names=new Map(),stacks=new Map(),totals=new Map();
  const add=(e,us)=>{
    if(!Number.isFinite(us)||us<0)return;
    const key=JSON.stringify([e.pid,e.tid,e.name]);
    const row=totals.get(key)||{pid:e.pid,tid:e.tid,name:e.name,count:0,totalMs:0,maxMs:0,over50:0};
    row.count++;row.totalMs+=us/1000;row.maxMs=Math.max(row.maxMs,us/1000);if(us>50000)row.over50++;
    totals.set(key,row);
  };
  for(const e of events){
    const key=`${e.pid}:${e.tid}`;
    if(e.ph==='M'&&e.name==='thread_name'&&typeof e.args?.name==='string')names.set(key,e.args.name);
    if(e.ph==='X')add(e,e.dur);
    else if(e.ph==='B'){if(!stacks.has(key))stacks.set(key,[]);stacks.get(key).push(e);}
    else if(e.ph==='E'){const begin=stacks.get(key)?.pop();if(begin)add(begin,e.ts-begin.ts);}
  }
  return [...totals.values()].map(r=>({...r,thread:names.get(`${r.pid}:${r.tid}`)||''}))
    .sort((a,b)=>b.totalMs-a.totalMs).slice(0,120);
}

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--run-emulator-trace')throw Error('Explicit trace flag required');
  const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
  const stop=readFileSync(new URL('./pause-tiktok-audit-owned-sessions.js',import.meta.url),'utf8');
  const enable=readFileSync(new URL('./tiktok-audit-enable-multi.js',import.meta.url),'utf8');
  const result={diagnosticOnly:true,scope:'emulator-5582 renderer scheduling; overlapping inclusive event times, not FPS qualification',runs:[]};
  let removeListener,tracing=false;
  const page=await tik.read('location.origin+location.pathname');
  try{
    if(!/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d{15,22}\/?$/.test(page))throw Error('Need an existing canonical video page');
    await pong.read(stop);
    for(const swap of [false,true]){
      if(swap)await pong.read(enable);
      if(!await tik.read('(()=>{const v=window.__pongTikTokObservedVideo?.video;if(!v?.isConnected)return false;v.muted=true;v.defaultMuted=true;v.volume=0;return true;})()'))throw Error('Observed video missing');
      let completedResolve;
      const completed=new Promise(r=>completedResolve=r);
      removeListener=tik.onEvent(e=>{if(e.method==='Tracing.tracingComplete')completedResolve(e.params)});
      await tik.call('Tracing.start',{categories:'toplevel,cc,gpu,media,blink,renderer.scheduler,devtools.timeline,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'});
      tracing=true;
      await new Promise(r=>setTimeout(r,6000));
      await tik.call('Tracing.end');tracing=false;
      let timer;
      const end=await Promise.race([completed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Trace completion timeout')),10000))]).finally(()=>clearTimeout(timer));
      removeListener();removeListener=null;
      if(!end.stream)throw Error('No trace stream');
      let text='';
      try{
        while(true){const part=await tik.call('IO.read',{handle:end.stream,size:1048576});
          text+=part.base64Encoded?Buffer.from(part.data,'base64').toString('utf8'):part.data;
          if(text.length>64*1024*1024)throw Error('Trace exceeds bounded capture size');if(part.eof)break;}
      }finally{await tik.call('IO.close',{handle:end.stream}).catch(()=>{});}
      const trace=JSON.parse(text);text='';
      if(await tik.read('location.origin+location.pathname')!==page)throw Error('Video page changed during diagnostic');
      const row={swap,eventCount:trace.traceEvents.length,top:reduceTrace(trace.traceEvents)};result.runs.push(row);
      console.log(JSON.stringify({swap,events:row.eventCount,top:row.top.slice(0,12)}));
    }
  }catch(e){result.error=String(e.message).replace(/https?:\/\/\S+/g,'[redacted]');process.exitCode=1;}
  finally{
    if(tracing)await tik.call('Tracing.end').catch(()=>{});removeListener?.();
    await pong.read(stop).catch(()=>{});tik.close();pong.close();
    const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/renderer-scheduling-${Date.now()}.json`;
    writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,error:result.error||null}));
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
