const port=Number(process.argv[2]);
const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
const targets=pages.filter(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com');
if(targets.length!==1)throw Error('Expected one TikTok WebView');
const ws=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Timed out')),8000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(timer);m.error?reject(Error(m.error.message)):resolve();}};ws.send(JSON.stringify({id:1,method:'Emulation.setPageScaleFactor',params:{pageScaleFactor:1}}));});
console.log('TikTok page zoom reset to 100%; no navigation or cookie changes.');ws.close();
