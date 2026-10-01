import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60196,'pong');
try {
 console.log(JSON.stringify(await c.read(`JSON.parse(JSON.stringify(window.PongRuntimeDiagnostics?.snapshot?.(),(k,v)=>/url|path|image|title|name/i.test(k)?undefined:v))`)));
 console.log(JSON.stringify(await c.read(`(() => ({videos:Array.from(document.querySelectorAll('video')).map(v=>({id:v.id,time:v.currentTime,duration:v.duration,ended:v.ended,paused:v.paused,ready:v.readyState,network:v.networkState,error:v.error&&{code:v.error.code,message:v.error.message},path:(()=>{try{return new URL(v.currentSrc).pathname}catch{return ''}})(),seekable:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)]),buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])})),diagnosticKeys:Object.keys(window).filter(k=>/pong.*(debug|state|diag)/i.test(k))}))()`)));
} finally { c.close(); }
