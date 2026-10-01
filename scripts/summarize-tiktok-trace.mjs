import {readFileSync} from 'node:fs';
const events=JSON.parse(readFileSync(process.argv[2],'utf8')).traceEvents;
const threads=new Map(events.filter(e=>e.name==='thread_name').map(e=>[`${e.pid}:${e.tid}`,e.args.name]));
const safeUrl=raw=>{try{const u=new URL(raw);return u.hostname+u.pathname}catch{return String(raw||'').slice(0,70)}};
console.log(JSON.stringify({top:events.filter(e=>['FunctionCall','TimerFire','EvaluateScript','EventDispatch','UpdateLayoutTree'].includes(e.name)&&e.dur>10000)
 .sort((a,b)=>b.dur-a.dur).slice(0,30).map(e=>({name:e.name,ms:e.dur/1000,pid:e.pid,tid:e.tid,thread:threads.get(`${e.pid}:${e.tid}`),fn:e.args?.data?.functionName,url:safeUrl(e.args?.data?.url),line:e.args?.data?.lineNumber}))},null,2));
