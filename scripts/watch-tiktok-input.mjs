const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const peers=[];
for(const page of pages.filter(p=>p.type==='page'&&(new URL(p.url).hostname==='www.tiktok.com'||new URL(p.url).pathname==='/pong'))){
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let seq=0;const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}};
 const evaluate=expression=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}))});
 await evaluate(`(()=>{window.__pongInputAudit={events:[],steps:[]};for(const type of ['touchstart','touchmove','touchend','touchcancel','pointerdown','pointerup'])addEventListener(type,e=>{const a=window.__pongInputAudit;if(a.events.length>150)a.events.shift();const p=e.touches?.[0]||e.changedTouches?.[0]||e;a.events.push({type,x:Math.round(p.clientX),y:Math.round(p.clientY),tag:e.target?.tagName,id:e.target?.id,at:Date.now()});},{capture:true,passive:true});const old=window.__pongTikTokStep;if(old&&!old.audit){const f=d=>{const result=old(d);window.__pongInputAudit.steps.push({d,result,at:Date.now()});return result};f.audit=true;window.__pongTikTokStep=f;}return true})()`);
 peers.push({ws,evaluate,name:new URL(page.url).hostname==='www.tiktok.com'?'tiktok':'pong'});
}
for(let i=0;i<6;i++){
 await new Promise(r=>setTimeout(r,5000));
 for(const p of peers){const v=await p.evaluate(`(()=>{const a=window.__pongInputAudit;const cards=[...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')];const active=cards.reduce((a,b)=>!a||Math.abs(b.getBoundingClientRect().top)<Math.abs(a.getBoundingClientRect().top)?b:a,null);const out={events:a.events.splice(0),steps:a.steps.splice(0),card:cards.indexOf(active),cards:cards.length,overlay:document.documentElement.classList.contains('pong-tiktok-original-overlay')};return out})()`);console.log(JSON.stringify({surface:p.name,...v?.result?.value}));}
}
for(const p of peers)p.ws.close();
