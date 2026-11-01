// Physical swipe stress test: numeric timing/control geometry only; no pixels,
// page text, URLs, response bodies, audio, or social actions are inspected.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
const [port='60227',transport='10',label='baseline']=process.argv.slice(2);
const c=await connectWebView(Number(port),'tiktok');
const summary=a=>{const b=[...a].sort((x,y)=>x-y);return {count:b.length,p50:b[Math.floor(b.length*.5)]||0,p95:b[Math.floor(b.length*.95)]||0,max:b.at(-1)||0,over50:b.filter(x=>x>50).length}};
let result;
try{
 const size=await c.read(`(()=>{if(!/^\\/(foryou)?\\/?$/.test(location.pathname)||!document.querySelector('[data-e2e="recommend-list-item-container"]'))throw Error('For You feed is not ready');return {w:innerWidth*devicePixelRatio,h:innerHeight*devicePixelRatio}})()`);
 await exec('adb',['-t',transport,'shell','cmd','media_session','volume','--stream','3','--set','0'],{windowsHide:true});
 await c.call('Performance.enable');const before=await c.call('Performance.getMetrics');
 await c.read(`(()=>{
  window.__pongRapidAudit?.stop();
  const gaps=[],tasks=[],steps=[],downs=[],changes=[],samples=[],counts=new Map(),ids=new WeakMap();
  const start=performance.now(),uiStart=window.__pongTikTokNativeUiStats?.(),observerStart={...window.__pongTikTokObserverStats},stepStatsStart=window.__pongTikTokStepStats?.();
  let nextId=0,last=0,handle=0,lastSample=-100,lastCard=null;
  const oldBegin=window.__pongTikTokBeginGesture,oldStep=window.__pongTikTokStep;
  const begin=function(...a){downs.push(performance.now()-start);return oldBegin?.apply(this,a)};
  const step=function(...a){const t=performance.now();const accepted=oldStep?.apply(this,a);steps.push({t:t-start,ms:performance.now()-t,accepted:!!accepted});return accepted};
  window.__pongTikTokBeginGesture=begin;window.__pongTikTokStep=step;
  const frame=t=>{if(last)gaps.push(t-last);last=t;
   if(t-lastSample>=100){lastSample=t;
    const card=document.elementFromPoint(innerWidth*.5,innerHeight*.4)?.closest('[data-e2e="recommend-list-item-container"]');
    if(card&&!ids.has(card))ids.set(card,++nextId);const id=card?ids.get(card):0;
    if(id!==lastCard){changes.push({t:performance.now()-start,id});lastCard=id;}
    const video=card?.querySelector('video:not(.pong-tiktok-swap-stream)');
    samples.push({t:performance.now()-start,id,ready:video?.readyState??-1,paused:video?.paused??true});
    for(const v of document.querySelectorAll('video')){const q=v.getVideoPlaybackQuality?.();if(!q)continue;let a=counts.get(v);if(!a){a={last:q.totalVideoFrames,lastDrop:q.droppedVideoFrames,total:0,dropped:0,resets:0,swap:v.classList.contains('pong-tiktok-swap-stream')};counts.set(v,a)}if(q.totalVideoFrames<a.last)a.resets++;a.total+=q.totalVideoFrames>=a.last?q.totalVideoFrames-a.last:q.totalVideoFrames;a.dropped+=q.droppedVideoFrames>=a.lastDrop?q.droppedVideoFrames-a.lastDrop:q.droppedVideoFrames;a.last=q.totalVideoFrames;a.lastDrop=q.droppedVideoFrames;}
   }handle=requestAnimationFrame(frame)};
  handle=requestAnimationFrame(frame);const observer=new PerformanceObserver(l=>{for(const e of l.getEntries())tasks.push(e.duration)});observer.observe({type:'longtask'});
  window.__pongRapidAudit={stop(){cancelAnimationFrame(handle);observer.disconnect();if(window.__pongTikTokBeginGesture===begin)window.__pongTikTokBeginGesture=oldBegin;if(window.__pongTikTokStep===step)window.__pongTikTokStep=oldStep;return {elapsed:performance.now()-start,gaps,tasks,downs,steps,changes,samples,media:[...counts.values()],uiStart,uiEnd:window.__pongTikTokNativeUiStats?.(),observerStart,observerEnd:window.__pongTikTokObserverStats,stepStatsStart,stepStatsEnd:window.__pongTikTokStepStats?.(),page:document.documentElement.dataset.pongNativePage}}};return true;
 })()`);
 const launches=[],jobs=[],start=performance.now();
 for(let i=0;i<16;i++){
  await delay(Math.max(0,start+i*500-performance.now()));launches.push(performance.now()-start);
  jobs.push(exec('adb',['-t',transport,'shell','input','swipe',String(Math.round(size.w*.45)),String(Math.round(size.h*.66)),String(Math.round(size.w*.45)),String(Math.round(size.h*.31)),'110'],{windowsHide:true,timeout:4000}).then(()=>({ok:true})).catch(()=>({ok:false})));
 }
 const inputs=await Promise.all(jobs);await delay(1000);
 const raw=await c.read('window.__pongRapidAudit.stop()');const after=await c.call('Performance.getMetrics');
 const b=new Map(before.metrics.map(x=>[x.name,x.value]));const metrics=Object.fromEntries(after.metrics.filter(x=>['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount'].includes(x.name)).map(x=>[x.name,x.value-(b.get(x.name)||0)]));
 result={pixelsRead:false,label,requestedIntervalMs:500,launches,inputs,actualGestureInterval:summary(raw.downs.slice(1).map((t,i)=>t-raw.downs[i])),raf:summary(raw.gaps),longTasks:summary(raw.tasks),metrics,...raw};
 writeFileSync(`E:/Pong Benchmarks/perf-audit-20261101/phone/rapid-swipes-${label.replace(/[^a-z0-9-]/gi,'')}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,gaps:undefined,tasks:undefined,samples:undefined,media:raw.media,launches:undefined,inputs:undefined},null,2));
}finally{await c.read('window.__pongRapidAudit?.stop();delete window.__pongRapidAudit;true').catch(()=>{});c.close()}
