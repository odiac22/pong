export async function connectWebView(port, kind) {
  const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  const matches=pages.filter(p=>p.type==='page'&&(kind==='pong'?new URL(p.url).pathname==='/pong':new URL(p.url).hostname==='www.tiktok.com'));
  if(matches.length!==1)throw Error(`Expected one ${kind} WebView`);
  const ws=new WebSocket(matches[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  let sequence=0;const pending=new Map(),listeners=new Set();
  ws.onmessage=e=>{const message=JSON.parse(e.data);pending.get(message.id)?.(message);if(message.method)listeners.forEach(f=>f(message))};
  const call=(method,params={},timeoutMs=10000)=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`${method} timed out`))},timeoutMs);
    pending.set(id,message=>{clearTimeout(timer);pending.delete(id);message.error?reject(Error(message.error.message)):resolve(message.result)});
    ws.send(JSON.stringify({id,method,params}));
  });
  return {call,onEvent:f=>{listeners.add(f);return()=>listeners.delete(f)},close:()=>ws.close(),read:async expression=>{
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result?.value;
  }};
}
