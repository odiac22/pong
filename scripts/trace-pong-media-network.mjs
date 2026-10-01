const pages=await(await fetch('http://127.0.0.1:9223/json/list')).json();
const page=pages.find(p=>/Pong/i.test(p.title));
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
const ids=new Map();let index=0;
ws.onmessage=e=>{
 const m=JSON.parse(e.data),p=m.params;
 if(m.method==='Network.requestWillBeSent'){
  const url=new URL(p.request.url);
  if(!/video-cache\/(media|stream)|\/proxy$/.test(url.pathname))return;
  const id=++index;ids.set(p.requestId,id);
  console.log(JSON.stringify({event:'request',id,type:p.type,route:url.pathname.split('/').slice(0,3).join('/'),range:p.request.headers.Range||p.request.headers.range,at:Date.now()}));
 }else if(ids.has(p?.requestId)){
  const id=ids.get(p.requestId);
  if(m.method==='Network.responseReceived')console.log(JSON.stringify({event:'response',id,status:p.response.status,type:p.response.mimeType,length:p.response.headers['Content-Length'],range:p.response.headers['Content-Range'],at:Date.now()}));
  if(m.method==='Network.loadingFailed')console.log(JSON.stringify({event:'failed',id,error:p.errorText,canceled:p.canceled,at:Date.now()}));
  if(m.method==='Network.loadingFinished')console.log(JSON.stringify({event:'finished',id,bytes:p.encodedDataLength,at:Date.now()}));
 }
};
ws.send(JSON.stringify({id:1,method:'Network.enable'}));
await new Promise(r=>setTimeout(r,30000));
ws.close();
