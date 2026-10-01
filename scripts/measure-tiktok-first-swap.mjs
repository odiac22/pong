import {execFileSync} from 'node:child_process';
const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
const page=pages.find(p=>p.type==='page'&&new URL(p.url).hostname==='www.tiktok.com');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m.result?.result?.value);pending.delete(m.id);};
const read=()=>new Promise((r,j)=>{const n=++id,t=setTimeout(()=>j(Error('snapshot timeout')),5000);pending.set(n,v=>{clearTimeout(t);r(v)});ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression:`(()=>{const s=window.__pongDomSwap;return {session:s?.sessionId,visible:!!s?.visible,age:s?performance.now()-s.createdAt:0,firstVisible:s?.firstVisibleAt?s.firstVisibleAt-s.createdAt:null,ready:s?.overlay?.readyState,frames:s?.overlay?.getVideoPlaybackQuality?.().totalVideoFrames}})()`,returnByValue:true}}));});
try{const before=await read(),start=performance.now();execFileSync('C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe',['shell','input','swipe','997','1500','997','440','260']);let last;
 for(let i=0;i<100;i++){last=await read();if(last?.session&&last.session!==before.session&&last.visible){console.log(JSON.stringify({swipeToProcessedStreamVisibleMs:Math.round(performance.now()-start),faceTransformationVerified:false,compositorFirstVisibleMs:last.firstVisible,ready:last.ready,decodedFrames:last.frames}));break;}await new Promise(r=>setTimeout(r,250));}
 if(!last?.visible||last.session===before.session)console.log(JSON.stringify({qualified:false,elapsedMs:Math.round(performance.now()-start),ready:last?.ready}));
}finally{ws.close();}
