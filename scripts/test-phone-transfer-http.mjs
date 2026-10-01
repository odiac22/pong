// Silent isolated production-route test. Never contacts live Recall or source sites.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PhoneTransferStore} from '../phone-transfer-store.mjs';
const run=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pong-phone-http-test-'));
const fixture=path.join(directory,'synthetic.mp4');
let server;const workers=new AbortController();
try {
 await run('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-t','10','-an','-c:v','libx264','-preset','ultrafast','-movflags','+faststart',fixture],{windowsHide:true,timeout:30000});
 const media=await fs.readFile(fixture);
 const phoneTransfers=await new PhoneTransferStore({directory:path.join(directory,'cache'),minFreeBytes:0,chunkBytes:65536}).init();
 const sourceId=crypto.randomUUID(),clientId=crypto.randomUUID();
 const sources=new Map([[sourceId,{id:sourceId,clientId,phoneConnectionOnly:true,requiresTransfer:true,candidates:['https://fixture.invalid/file.mp4'],expiresAt:Date.now()+3600000}]]);
 const jobs=new Map(),clients=new Map();
 const code=await fs.readFile(path.join(root,'local-ai-server.mjs'),'utf8');
 const queueStart=code.indexOf('function queueBrowserMediaRelayJob(');
 const queueCode=code.slice(queueStart,code.indexOf('function parseBrowserMediaRelayRange(',queueStart));
 const routeStart=code.indexOf("    if (req.method === 'GET' && url.pathname === '/media-browser-relay/capabilities')");
 const routeCode=code.slice(routeStart,code.indexOf("    if (req.method === 'GET' && url.pathname === '/saved-links/state')",routeStart));
 const read=async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks);};
 const ctx=vm.createContext({phoneTransfers,Date,JSON,Error,String,Number,Math,Buffer,crypto,setTimeout,clearTimeout,
  browserMediaRelaySources:sources,browserMediaRelayJobs:jobs,BROWSER_MEDIA_RELAY_TTL_MS:3600000,
  validBrowserMediaRelayId:id=>/^[a-f0-9-]{36}$/i.test(id||'')?id:'',pruneBrowserMediaRelayState(){},
  browserMediaRelayClient(id){if(!clients.has(id))clients.set(id,{jobs:[],waiters:[],lastSeen:Date.now()});return clients.get(id);},
  readBody:async req=>(await read(req)).toString(),readBodyBuffer:read,
  json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));},
  parseBrowserMediaRelayRange:()=>{throw Error('Completed phone file must not use browser-stream fallback');},
 });
 vm.runInContext(`${queueCode}\nasync function handle(req,res,url){${routeCode}\nres.writeHead(404);res.end();}`,ctx);
 server=http.createServer((req,res)=>{ctx.handle(req,res,new URL(req.url,'http://fixture.invalid')).catch(error=>{res.writeHead(500);res.end(error.message);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const stream=`${base}/media-browser-relay/stream/${sourceId}`;
 assert.equal((await fetch(stream)).status,425);
 const bad=await fetch(`${base}/media-browser-relay/transfers`,{method:'POST',body:JSON.stringify({sourceId,clientId:crypto.randomUUID()})});assert.equal(bad.status,409);
 const started=Date.now();
 const accepted=await(await fetch(`${base}/media-browser-relay/transfers`,{method:'POST',body:JSON.stringify({sourceId,clientId})})).json();assert.equal(accepted.ok,true);
 let returnedRanges=0;
 const work=(async()=>{while(!workers.signal.aborted){
  const {job}=await(await fetch(`${base}/media-browser-relay/jobs?clientId=${clientId}`,{signal:workers.signal})).json();if(!job)continue;
  assert.equal(job.pinCandidate,true);assert.equal(job.candidates.length,1);
  const [,a,b]=job.range.match(/bytes=(\d+)-(\d+)/).map(Number);const end=Math.min(b,media.length-1);
  if(a)assert.equal(job.validator,'"fixture-etag"');
  const r=await fetch(`${base}/media-browser-relay/jobs/${job.id}/result`,{method:'POST',headers:{'X-Pong-Relay-Status':'206','X-Pong-Relay-Content-Type':'video/mp4','X-Pong-Relay-Content-Range':`bytes ${a}-${end}/${media.length}`,'X-Pong-Relay-Etag':'"fixture-etag"','X-Pong-Relay-Source-Url':job.candidates[0]},body:media.subarray(a,end+1),signal:workers.signal});assert.equal(r.status,200);returnedRanges++;
 }} )().catch(error=>{if(!workers.signal.aborted)throw error;});
 let transfer;for(let n=0;n<500;n++){transfer=(await(await fetch(`${base}/media-browser-relay/transfers/${sourceId}`)).json()).transfer;if(transfer.state==='ready'||transfer.state==='error')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(transfer.state,'ready');const transferMs=Date.now()-started;
 workers.abort();await work;sources.clear(); // Real disconnection: no worker or source registration remains.
 const downloaded=Buffer.from(await(await fetch(stream)).arrayBuffer());assert.deepEqual(downloaded,media);
 const decodeStart=Date.now();
 const decoded=await run('ffmpeg',['-hide_banner','-nostdin','-v','error','-i',stream,'-t','10','-map','0:v:0','-an','-sn','-dn','-progress','pipe:1','-f','null','-'],{windowsHide:true,timeout:20000});
 assert.match(decoded.stdout,/frame=300/);assert.match(decoded.stdout,/progress=end/);assert.equal(decoded.stderr,'');
 const report={scope:'Synthetic local video; actual production transfer/job/stream routes; source worker disconnected before decode; no audio or displayed video',transferMs,decodeMs:Date.now()-decodeStart,bytes:media.length,returnedRanges,sha256:crypto.createHash('sha256').update(downloaded).digest('hex'),byteIdentical:true,decodedFrames:300,decodedSeconds:10,workerDisconnected:true};
 const out=path.join(root,'artifacts','pong-30.13');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'phone-transfer-http.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {
 workers.abort();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 assert.ok(path.basename(directory).startsWith('pong-phone-http-test-'));await fs.rm(directory,{recursive:true,force:true});
}
