// Silent input demux diagnostic. Never generates swaps or displays media.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const snapshotArgument=process.argv.find(v=>v.startsWith('--snapshot='));
let source;
if(snapshotArgument){
 const snapshot=JSON.parse(await readFile(snapshotArgument.slice(11),'utf8'));
 const channel=Number(process.argv.find(v=>v.startsWith('--channel='))?.slice(10)||2);
 const captured=snapshot.channels.find(c=>c.channel===channel)?.recall?.genericBundles?.[0]?.videos?.[0]?.videoUrl;
 if(!captured)throw Error('No saved Recall video');
 const target=new URL(captured,'http://127.0.0.1:8787');
 source=target.pathname==='/generic-media/hls'?target.href:`http://127.0.0.1:8787/generic-media/hls?url=${encodeURIComponent(target.href)}`;
}else{
const pages = await (await fetch('http://127.0.0.1:9226/json', {signal:AbortSignal.timeout(3000)})).json();
const page = pages.find(p => String(p.url).includes('/pong'));
if (!page) throw Error('Pong not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
source = await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('CDP timeout')),3000);
  ws.onmessage=event=>{const m=JSON.parse(String(event.data));if(m.id===1){clearTimeout(timer);resolve(m.result?.result?.value);}};
  ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'(()=>{const w=document.querySelector(".video-wrapper");return pongFaceSwapPlayableSource(w,w?.querySelector("video"))?.source})()',returnByValue:true}}));
});
ws.close();
}
const u=new URL(source);
if(u.port!=='8787'||u.pathname!=='/generic-media/hls'||!(/^(192\.168\.|127\.0\.0\.1$)/.test(u.hostname)))throw Error('Unexpected source route');
const python = 'Pong Swap/runtime/venv/Scripts/python.exe';
const code = `import sys,json,time,av,re
av.logging.set_level(av.logging.DEBUG)
u=json.load(sys.stdin)['url']
started=time.monotonic()
r={}
try:
 with av.logging.Capture() as logs:
  try:
   with av.open(u,timeout=(10.,5.)) as c:
    s=next(s for s in c.streams if s.type=='video')
    r={'ok':True,'width':s.codec_context.width,'height':s.codec_context.height,'format':c.format.name}
    f=next(c.decode(s))
    r['firstVideoFrameDecoded']=True
    r['decodedWidth']=f.width
    r['decodedHeight']=f.height
  except Exception as e:
   r={'ok':False,'type':type(e).__name__,'errno':getattr(e,'errno',None),'message':re.sub(r'https?://[^\\s\\x27\\x22]+','[URL]',str(e))[:500]}
 r['logs']=[re.sub(r'https?://[^\\s\\x27\\x22]+','[URL]',str(x[2]))[:400] for x in logs[-8:] if 'request:' not in str(x[2])]
except Exception as e:r={'ok':False,'type':type(e).__name__}
r['elapsedMs']=round((time.monotonic()-started)*1000)
print(json.dumps(r))`;
const report=[];
for(const [label,url] of [['phone-address',source],['loopback',source.replace(u.host,'127.0.0.1:8787')]]){
 const began=Date.now();let response;
 try{const r=await fetch(url,{signal:AbortSignal.timeout(3500)});response={status:r.status,type:r.headers.get('content-type'),elapsedMs:Date.now()-began};await r.body?.cancel();}catch(e){response={error:e.name,elapsedMs:Date.now()-began};}
 const result=await new Promise(resolve=>{
  const p=spawn(python,['-c',code],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';
  const timer=setTimeout(()=>{p.kill();resolve({timeout:true});},18000);
  p.stdout.on('data',d=>out+=d);p.stderr.on('data',()=>{});
  p.on('exit',()=>{clearTimeout(timer);try{resolve(JSON.parse(out));}catch{resolve({invalidResult:true});}});
  p.stdin.end(JSON.stringify({url}));
 });
 report.push({label,sourceOrigin:snapshotArgument?'saved-recall':'phone-live',response,demux:result});console.log(JSON.stringify(report.at(-1)));
}
const output=process.argv.includes('--after')?'artifacts/swap-input-30.16':'artifacts/swap-input-30.15';
await mkdir(output,{recursive:true});
await writeFile(`${output}/diagnosis.json`,JSON.stringify(report,null,2));
