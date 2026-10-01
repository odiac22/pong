// Silent synthetic no-face smoke test against the live service, isolated test channel.
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const api=async(route,method='GET',body)=>{
 const r=await fetch(`http://127.0.0.1:8792${route}`,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(`API ${route}: ${r.status}`);return r.json();
};
const config=(await api('/settings')).config;
assert.equal(config.runtime.swapAudioEnabled,false,'Audio must remain disabled');
const face=(await api('/faces')).faces[0];assert.ok(face?.id);
assert.ok(!(await api('/sessions')).sessions.some(s=>s.channel==='test'),'test channel is already occupied');
const dir=await mkdtemp(path.join(os.tmpdir(),'pong-live-standby-'));
const generated=spawnSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=30','-t','12','-an','-c:v','libx264','-preset','ultrafast','-g','30','-f','hls','-hls_time','1','-hls_list_size','0','index.m3u8'],{cwd:dir,windowsHide:true});
assert.equal(generated.status,0);
const server=createServer(async(req,res)=>{
 try{
  const filename=new URL(req.url,'http://localhost').pathname.slice(1);
  if(!/^(index\.m3u8|index\d+\.ts)$/.test(filename)){res.writeHead(404).end();return;}
  const data=await readFile(path.join(dir,filename));res.setHeader('Content-Length',data.length);res.end(data);
 }catch{res.writeHead(500).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const sourceUrl=`http://127.0.0.1:${server.address().port}/index.m3u8`;
let sessionId;const rows=[];
try{
 for(const [i,startSeconds] of [2,5].entries()){
  const started=Date.now();const created=await api('/sessions','POST',{channel:'test',sourceUrl,faceId:face.id,startSeconds,prefetch:false,navigationClass:'seek'});
  sessionId=created.session.id;let s;
  const until=Date.now()+20000;
  while(Date.now()<until){
   s=(await api(`/sessions/${sessionId}`)).session;
   if(s.error)throw Error(String(s.error).replace(/https?:\/\/\S+/g,'[URL]').slice(0,400));
   if(s.mediaFragmentReady && s.frames>0)break;
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(s.mediaFragmentReady);
  if(i===1)assert.equal(s.sourceDecoderReused,true);
  rows.push({run:i,startSeconds,sourceDecoderReused:s.sourceDecoderReused,frames:s.frames,width:s.width,height:s.height,firstSourceMs:Math.round((s.firstSourceFrameAt-s.createdAt)*1000),playableMs:Math.round((s.playableAt-s.createdAt)*1000),elapsedMs:Date.now()-started,error:s.error});
  const untilWarm=Date.now()+15000;
  while(Date.now()<untilWarm){
   if((await api('/health')).standbySources.ready>0)break;
   await new Promise(r=>setTimeout(r,100));
  }
  await api(`/sessions/${sessionId}`,'DELETE');sessionId=null;
 }
 assert.deepEqual((await api('/settings')).config,config,'Quality settings changed unexpectedly');
 await writeFile('artifacts/scrub-30.17/live-service-smoke.json',JSON.stringify({silent:true,fixture:'synthetic-no-face-HLS',rows},null,2));
 console.log(JSON.stringify(rows));
}finally{
 if(sessionId)await api(`/sessions/${sessionId}`,'DELETE').catch(()=>{});
 server.close();server.closeAllConnections();
}
