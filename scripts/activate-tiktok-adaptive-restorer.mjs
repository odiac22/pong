// Hot-apply session admission only: retain the user's page, login and selection.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync('index.html','utf8');
const slice=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);if(a<0||b<a)throw Error('Function boundary missing');return html.slice(a,b)};
const code=slice('function pongFaceSwapRestorationProfile(', 'function cleanupPongFaceSwapAttachmentListeners(')
 +slice('async function createPongFaceSwapPrefetchForSource(', 'async function createPongFaceSwapPrefetch(')
 +slice('async function preparePongFaceSwapSeek(', 'function flushPendingPongFaceSwapSeek(')
 +slice('async function startPongFaceSwap(', 'function renderPongFaceSwapPicker(');
new vm.Script(code);
if(process.argv.includes('--check')){console.log('Adaptive session admission syntax checked.');process.exit(0);}
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const matches=pages.filter(p=>p.type==='page'&&new URL(p.url).pathname==='/pong');
if(matches.length!==1)throw Error('Expected exactly one Pong WebView');
const ws=new WebSocket(matches[0].webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
try{await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('timeout')),10000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(t);m.result?.exceptionDetails?j(Error(m.result.exceptionDetails.text)):r()}};ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:code}}));});}
finally{ws.close();}
console.log('TikTok adaptive session admission installed live; ordinary Pong profile unchanged.');
