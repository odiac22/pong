import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const install=`(()=>{
 window.__pongInputTraceStop?.();const events=[],restores=[];
 const record=(name,details={})=>{events.push({name,at:performance.now(),...details});if(events.length>60)events.shift()};
 for(const name of ['__pongTikTokStep','__pongTikTokBeginGesture'])if(typeof window[name]==='function'){
  const old=window[name],wrapped=function(...args){record(name,{args});const result=old.apply(this,args);record(name+':return',{result});return result};
  window[name]=wrapped;restores.push(()=>{if(window[name]===wrapped)window[name]=old});
 }
 for(const name of ['scroll','scrollTo','scrollIntoView']){
  const old=Element.prototype[name],wrapped=function(...args){record(name,{args,className:String(this.className).slice(0,60)});return old.apply(this,args)};
  Element.prototype[name]=wrapped;restores.push(()=>{if(Element.prototype[name]===wrapped)Element.prototype[name]=old});
 }
 const scrollTop=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
 if(scrollTop?.set){let recorded=0;Object.defineProperty(Element.prototype,'scrollTop',{...scrollTop,set(value){
   if(recorded++<8)record('scrollTop:set',{value,className:String(this.className).slice(0,60),stack:new Error().stack?.split('\\n').slice(1,5)});
   return scrollTop.set.call(this,value);
 }});restores.push(()=>Object.defineProperty(Element.prototype,'scrollTop',scrollTop));}
 for(const name of ['touchstart','touchmove','touchend','touchcancel','click']){
  const f=e=>record(name,{tag:e.target?.tagName,id:e.target?.id||'',e2e:e.target?.dataset?.e2e||'',eventAt:e.timeStamp});
  document.addEventListener(name,f,{capture:true,passive:true});restores.push(()=>document.removeEventListener(name,f,true));
 }
 window.__pongInputTraceStop=()=>{restores.forEach(f=>f());delete window.__pongInputTraceStop};
 window.__pongInputTrace=events;return{at:performance.now()};
})()`;
try{
 await Promise.all([tik.read(install),pong.read(install)]);
 const start=await tik.read('({at:performance.now(),path:location.pathname})');
 execFileSync(adb,['-s','emulator-5582','shell','input','swipe','650','1550','650','650','150']);
 await new Promise(r=>setTimeout(r,5000));
 const end=await tik.read('({at:performance.now(),path:location.pathname})');
 const result={start,end,tiktok:await tik.read('window.__pongInputTrace'),pong:await pong.read('window.__pongInputTrace')};
 const path=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/gesture-${Date.now()}.json`;
 writeFileSync(path,JSON.stringify(result,null,2));console.log(JSON.stringify({path,...result}));
}finally{
 await Promise.all([tik.read('window.__pongInputTraceStop?.()'),pong.read('window.__pongInputTraceStop?.()')]).catch(()=>{});tik.close();pong.close();
}
