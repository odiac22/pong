import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const slice=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);if(a<0||b<a)throw Error('Function boundary missing');return html.slice(a,b)};
const code=slice('function pongSwapHasPresentedEvidence(', 'function ensurePongFaceSwapButton(')+slice('function updatePongFaceSwapLoading(', 'function cancelPongFaceSwapRecovery(')+slice('window.PongTikTokLiveFeed =', 'window.PongTikTokLiveIntegratedState =')+'\nupdatePongFaceSwapButton();hidePongFaceSwapLoading();';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());const page=pages.find(p=>p.type==='page'&&new URL(p.url).pathname==='/pong');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('timeout')),8000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(t);m.result?.exceptionDetails?j(Error(m.result.exceptionDetails.text)):r()}};ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:code}}))});ws.close();console.log('Live status panel patched; no reload or selection change.');
