import {readFile} from 'node:fs/promises';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const pong=pages.find(p=>p.type==='page'&&new URL(p.url).pathname==='/pong');
const tiktok=pages.find(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com');
async function evaluate(page,expression){const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});try{return await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('timeout')),8000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(timer);if(m.result?.exceptionDetails)j(Error(m.result.exceptionDetails.text));else r(m.result?.result?.value);}};ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});}finally{ws.close();}}
const visible=await evaluate(tiktok,'window.__pongDomSwap?.visible ? window.__pongDomSwap.sessionId : null');
const html=await readFile('index.html','utf8');
const start=html.indexOf('window.PongTikTokLiveSwapPresented =');
const end=html.indexOf('// TikTok\'s native overlay uses Swap',start);
if(start<0||end<0)throw Error('Cannot identify bounded handoff functions');
await evaluate(pong,html.slice(start,end));
if(visible)await evaluate(pong,'window.PongTikTokLiveSwapPresented('+JSON.stringify(visible)+')');
console.log(JSON.stringify({patched:true,presentedSessionRetained:!!visible}));
