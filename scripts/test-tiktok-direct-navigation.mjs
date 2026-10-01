// Navigate the existing TikTok WebView to the explicitly supplied public video.
const port=Number(process.argv[2]);
const url=new URL(process.argv[3]);
if(url.origin!=='https://www.tiktok.com'||!/^\/@[^/]+\/video\/\d+$/.test(url.pathname))throw Error('Expected a canonical TikTok video URL');
url.search='';url.hash='';
const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
const targets=pages.filter(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com');
if(targets.length!==1)throw Error('Expected exactly one existing TikTok WebView');
const ws=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
const result=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Navigation timed out')),10000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(t);resolve(m.error?{error:m.error.message}:{navigationRequested:true,errorText:m.result?.errorText||null});}};ws.send(JSON.stringify({id:1,method:'Page.navigate',params:{url:url.href}}));});
console.log(JSON.stringify(result));ws.close();
