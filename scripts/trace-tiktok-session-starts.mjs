import {execFileSync} from 'node:child_process';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&new URL(p.url).pathname==='/pong');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Network.requestWillBeSent'){const q=m.params.request;if(q.method==='POST'&&new URL(q.url).pathname.endsWith('/sessions')){try{const d=JSON.parse(q.postData);console.log(JSON.stringify({at:Date.now(),start:d.startSeconds,profile:d.restorationProfile,prefetch:d.prefetch,nav:d.navigationClass,sourcePath:new URL(d.sourceUrl).pathname,alternatePaths:d.sourceUrls?.map(x=>new URL(x).pathname),sourceVideoId:d.sourceUrl?.match(/\d{18,20}/)?.[0]}))}catch{}}}};
ws.send(JSON.stringify({id:1,method:'Network.enable'}));
await new Promise(r=>setTimeout(r,300));
execFileSync('C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe',['shell','input','swipe','950','1550','950','500','300']);
await new Promise(r=>setTimeout(r,20000));ws.close();
