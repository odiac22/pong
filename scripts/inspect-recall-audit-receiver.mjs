import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(9235,'pong');
try {
 const r=await c.call('Runtime.evaluate',{expression:`JSON.stringify({origin:location.origin,state:document.readyState,body:document.body.innerText.slice(-800),videos:[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,time:v.currentTime,duration:v.duration,paused:v.paused,error:v.error?.code}))})`,returnByValue:true},5000);
 console.log(r.result.value);
}finally{c.close();}
