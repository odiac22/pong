import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const asset=name=>readFileSync(new URL(`../android-app/app/src/main/assets/${name}`,import.meta.url),'utf8');
const wrapper=asset('tiktok-worker-mse-audit.js');
const workerCode=asset('pong-swap-media-audit.js');
const batchCode=asset('tiktok-fragment-batch.js');
const java=readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/MainActivity.java',import.meta.url),'utf8');
const stream=asset('tiktok-stream.js');

function mainFixture(version=1,binary=false){
  let hits=0;const workers=[],failures=[],messages=[],nativeMessages=[],listeners={};
  class Worker{
    constructor(url,options){this.url=url;this.options=options;workers.push(this)}
    postMessage(value){messages.push(value)}
    terminate(){this.terminated=true}
  }
  const overlay={events:{},load(){this.loaded=true},addEventListener(name,callback){this.events[name]=callback}};
  const context={window:{PongTikTokSwap:{workerAuditStatus:()=>JSON.stringify({version,hits,binaryAvailable:binary})},
    __pongBinaryMediaAuditTrial:binary,
    PongTikTokBinaryAudit:{postMessage:raw=>nativeMessages.push(JSON.parse(raw))},
    addEventListener:(name,callback)=>{listeners[name]=callback},removeEventListener:(name)=>{delete listeners[name]}},
    Worker,AbortController,performance:{timeOrigin:1000,now:()=>10},
    crypto:{getRandomValues:words=>{words.fill(0x12345678);return words}},
    setTimeout:()=>1,clearTimeout:()=>{}};
  vm.runInNewContext(wrapper,context);
  const session={overlay,sessionId:'owned_123',url:'https://www.tiktok.com/__pong_swap/owned_123',
    abort:new AbortController(),transport:{},warm:true};
  const start=()=>context.window.__pongCreateWorkerMseAudit(session,{
    owned:()=>true,fail:reason=>failures.push(reason),sync:()=>{},
  });
  return {start,session,workers,failures,messages,nativeMessages,listeners,setHits:value=>{hits=value}};
}

test('exact emulator-only Java intercept has local 404, narrow origin/path, and numeric receipt',()=>{
  assert.match(java,/TIKTOK_WORKER_AUDIT_PATH\s*=\s*\n?\s*"\/webapp-desktop\/static\/worker\/pong-swap-media-audit\.js"/);
  assert.match(java,/"www\.tiktok\.com"\.equalsIgnoreCase\(requested\.getHost\(\)\)/);
  assert.match(java,/TIKTOK_WORKER_AUDIT_PATH\.equals\(path\)\) return tikTokWorkerAuditResponse\(request\)/);
  assert.match(java,/auditTikTokWorkerMse\(\) && !request\.isForMainFrame\(\)/);
  assert.match(java,/if \(!eligible\) return new WebResourceResponse\("text\/plain", "UTF-8", 404/);
  assert.match(java,/tiktokWorkerAuditInterceptHits\.incrementAndGet\(\)/);
  assert.match(java,/new java\.io\.SequenceInputStream\(batch, source\)/);
  assert.match(java,/getBooleanExtra\("pong_audit_worker_mse", false\)/);
  assert.doesNotMatch(java,/ServiceWorkerController|setServiceWorkerClient/);
  assert.match(stream,/window\.__pongWorkerMseAuditTrial===true/);
});

test('main half never sends session before expected native-hit and version handshake',()=>{
  const bad=mainFixture();bad.start();
  assert.equal(bad.messages.length,0);
  bad.workers[0].onmessage({data:{type:'ready',version:1}});
  assert.equal(bad.messages.some(message=>message.url||message.type==='start'),false);
  assert.equal(bad.workers[0].terminated,true);
  assert.match(bad.failures[0],/handshake/);
  const absent=mainFixture(0);absent.start();
  assert.equal(absent.workers.length,0);
  assert.equal(absent.messages.length,0);
});

test('qualified native-hit handshake starts only exact module worker with omitted credentials',()=>{
  const f=mainFixture();f.start();
  assert.equal(f.workers[0].url,'https://www.tiktok.com/webapp-desktop/static/worker/pong-swap-media-audit.js');
  assert.equal(f.workers[0].options.type,'module');
  assert.equal(f.workers[0].options.credentials,'omit');
  f.setHits(1);f.workers[0].onmessage({data:{type:'ready',version:1}});
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0].type,'challenge');
  assert.match(f.messages[0].nonce,/^[a-f0-9]{32}$/);
  f.workers[0].onmessage({data:{type:'echo',version:1,nonce:f.messages[0].nonce}});
  assert.equal(f.messages.length,2);
  assert.equal(f.messages[1].url,f.session.url);
  f.workers[0].onmessage({data:{type:'handle',handle:{token:1}}});
  assert.equal(f.session.overlay.loaded,true);
  f.session.abort.abort();
  assert.equal(f.workers[0].terminated,true);
});

test('wrong echo terminates before session URL can leave main thread',()=>{
  const f=mainFixture();f.start();f.setHits(1);
  f.workers[0].onmessage({data:{type:'ready',version:1}});
  assert.equal(f.messages[0].type,'challenge');
  f.workers[0].onmessage({data:{type:'echo',version:1,nonce:'0'.repeat(32)}});
  assert.equal(f.messages.some(message=>message.url||message.type==='start'),false);
  assert.equal(f.workers[0].terminated,true);
  assert.match(f.failures[0],/echo/);
});

test('Worker asset rejects arbitrary routes and only fetches own session without credentials',async()=>{
  const posted=[],requests=[];
  class MediaSource{static isTypeSupported(){return true}constructor(){this.handle={};this.readyState='closed'}
    addEventListener(){} }
  const context={URL,AbortController,MediaSource,performance:{timeOrigin:1000,now:()=>10},
    postMessage:value=>posted.push(value),fetch:(url,options)=>{requests.push({url,options});return Promise.resolve({
      ok:false,status:410,body:null,headers:{get:()=>''}})},
    setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},self:{}};
  vm.runInNewContext(batchCode+'\n'+workerCode,context);
  assert.equal(posted[0].type,'ready');assert.equal(posted[0].version,1);
  context.self.onmessage({data:{type:'start',url:'https://www.tiktok.com/api/user'}});
  assert.equal(requests.length,0);
  const allowed={...context,self:{}};posted.length=0;
  vm.runInNewContext(batchCode+'\n'+workerCode,allowed);
  allowed.self.onmessage({data:{type:'start',url:'https://www.tiktok.com/__pong_swap/owned_123?attach=1'}});
  assert.equal(requests.length,0);
  allowed.self.onmessage({data:{type:'challenge',nonce:'abcdef0123456789abcdef0123456789'}});
  assert.equal(posted.at(-1).type,'echo');
  allowed.self.onmessage({data:{type:'start',url:'https://www.tiktok.com/__pong_swap/owned_123?attach=1'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://www.tiktok.com/__pong_swap/owned_123?attach=1');
  assert.equal(requests[0].options.credentials,'omit');
  assert.equal(requests[0].options.cache,'no-store');
  assert.doesNotMatch(workerCode,/importScripts\(|document\.|Cookie|localStorage|sessionStorage/);
});

const box=(kind,payload=0)=>{
  const bytes=Buffer.alloc(8+payload,37);bytes.writeUInt32BE(bytes.length);bytes.write(kind,4);return bytes;
};
const settled=()=>new Promise(resolve=>setImmediate(resolve));
function mediaFixture(chunks,native=false){
  const posted=[],appended=[];let reads=0,source,readerSignal;
  class MediaSource{
    static isTypeSupported(){return true}
    constructor(){source=this;this.handle={};this.readyState='closed';this.events={}}
    addEventListener(name,callback){this.events[name]=callback}
    addSourceBuffer(){
      this.buffer={updating:false,events:{},mode:'',addEventListener(name,callback){this.events[name]=callback},
        appendBuffer(bytes){appended.push(Buffer.from(bytes));this.updating=true}};
      return this.buffer;
    }
    endOfStream(){this.readyState='ended'}
  }
  const context={URL,ArrayBuffer,Uint8Array,AbortController,MediaSource,performance:{timeOrigin:1000,now:()=>10},
    postMessage:value=>posted.push(value),setInterval:()=>1,clearInterval:()=>{},
    setTimeout:()=>1,clearTimeout:()=>{},self:{},fetch:async(_url,options)=>{
      readerSignal=options.signal;let index=0;
      return {ok:true,status:200,headers:{get:()=> 'video/mp4'},body:{getReader:()=>({read:async()=>{
        reads++;return index<chunks.length?{done:false,value:chunks[index++]}:{done:true};
      }})}};
    }};
  vm.runInNewContext(batchCode+'\n'+workerCode,context);
  const send=value=>context.self.onmessage({data:value});
  const start=()=>{
    send({type:'challenge',nonce:'abcdef0123456789abcdef0123456789'});
    send({type:'start',url:'https://www.tiktok.com/__pong_swap/owned_123?attach=1',native});
  };
  return {posted,appended,start,send,reads:()=>reads,signal:()=>readerSignal,
    source:()=>source,open:()=>{source.readyState='open';source.events.sourceopen()},
    drain:()=>{source.buffer.updating=false;source.buffer.events.updateend()}};
}

test('worker emits byte-identical init and complete fragments across split reads and EOF',async()=>{
  const init=Buffer.concat([box('ftyp',12),box('moov',15)]);
  const first=Buffer.concat([box('moof',11),box('mdat',199)]);
  const second=Buffer.concat([box('moof',13),box('mdat',127)]);
  const input=Buffer.concat([init,first,second]);
  const chunks=[];for(let offset=0;offset<input.length;offset+=7)chunks.push(input.subarray(offset,offset+7));
  const f=mediaFixture(chunks);f.start();await settled();
  assert.equal(f.appended.length,0);
  f.open();await settled();
  for(let i=0;i<8&&f.source().readyState==='open';i++){f.send({type:'metadata'});f.drain();await settled()}
  assert.deepEqual(f.appended,[init,first,second]);
  assert.equal(f.source().readyState,'ended');
  const stats=f.posted.filter(message=>message.type==='transport').at(-1).stats;
  assert.equal(stats.chunks,chunks.length);
  assert.equal(stats.packets,3);
  assert.equal(stats.appendCalls,3);
  assert.equal(stats.bytes,input.length);
});

test('worker backpressures complete packets and close aborts a still-warm reader',async()=>{
  const packet=Buffer.concat([box('moof'),box('mdat',1024*1024)]);
  const chunks=[Buffer.concat([box('ftyp'),box('moov')]),...Array.from({length:8},()=>packet)];
  const f=mediaFixture(chunks);f.start();await settled();
  assert.ok(f.reads()<=4,`read count exceeded bounded queue: ${f.reads()}`);
  assert.equal(f.appended.length,0);
  f.send({type:'close'});await settled();
  assert.equal(f.signal().aborted,true);
  f.open();await settled();
  assert.equal(f.appended.length,0);
});

test('worker truncated fragment fails at EOF without endOfStream or late append',async()=>{
  const truncated=Buffer.concat([box('ftyp'),box('moov'),box('moof'),box('mdat',128).subarray(0,12)]);
  const f=mediaFixture([truncated]);f.start();await settled();
  assert.equal(f.posted.some(message=>message.type==='failure'&&message.reason==='Worker media transport failed'),true);
  f.open();await settled();
  assert.equal(f.appended.length,0);
  assert.notEqual(f.source().readyState,'ended');
});

test('native channel is gated and port transfer requires matching nonce/session; retirement cancels startup',()=>{
  const f=mainFixture(1,true);f.session.warm=false;f.start();f.setHits(1);
  f.workers[0].onmessage({data:{type:'ready',version:1}});
  const nonce=f.messages[0].nonce;
  f.workers[0].onmessage({data:{type:'echo',version:1,nonce}});
  assert.equal(f.messages[1].native,true);
  assert.deepEqual(f.nativeMessages,[{type:'open',sessionId:'owned_123',nonce}]);
  const port={};
  f.listeners.message({data:JSON.stringify({type:'pong-native-media-port',sessionId:'other',nonce}),ports:[port]});
  assert.equal(f.messages.length,2);
  f.listeners.message({data:JSON.stringify({type:'pong-native-media-port',sessionId:'owned_123',nonce}),ports:[port]});
  assert.equal(f.messages[2].port,port);
  assert.equal(f.listeners.message,undefined);
  f.session.abort.abort();
  assert.deepEqual(f.nativeMessages.at(-1),{type:'close',sessionId:'owned_123',nonce});
});

function nativePortFixture(f){
  const messages=[];
  const port={postMessage:raw=>messages.push(JSON.parse(raw)),start(){this.started=true},close(){this.closed=true}};
  f.start();f.send({type:'native-port',port});
  return {port,messages,send:data=>port.onmessage({data:typeof data==='string'?data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)})};
}
test('native binary delivery is byte-identical, never fetches, credits each accepted chunk and closes',async()=>{
  const f=mediaFixture([],true),n=nativePortFixture(f);
  assert.deepEqual(n.messages,[{type:'ready'}]);assert.equal(f.reads(),0);
  f.open();
  n.send(JSON.stringify({type:'headers',status:200,contentType:'video/mp4'}));
  const init=Buffer.concat([box('ftyp'),box('moov')]);
  const packet=Buffer.concat([box('moof'),box('mdat',200)]),bytes=Buffer.concat([init,packet]);
  for(let offset=0;offset<bytes.length;offset+=17)n.send(bytes.subarray(offset,offset+17));
  n.send(JSON.stringify({type:'end'}));await settled();
  for(let i=0;i<5;i++){f.send({type:'metadata'});f.drain();await settled()}
  assert.deepEqual(Buffer.concat(f.appended),bytes);
  assert.equal(n.messages.filter(x=>x.type==='ack').reduce((sum,x)=>sum+x.bytes,0),bytes.length);
  assert.equal(f.source().readyState,'ended');assert.equal(f.reads(),0);
  f.send({type:'close'});assert.equal(n.port.closed,true);
});
test('native binary rejects unannounced or oversized data and cancels without acknowledging it',async()=>{
  for(const announced of [false,true]){
    const f=mediaFixture([],true),n=nativePortFixture(f);
    if(announced)n.send(JSON.stringify({type:'headers',status:200,contentType:'video/mp4'}));
    n.send(Buffer.alloc(announced?65537:16));await settled();
    assert.equal(n.messages.some(x=>x.type==='ack'),false);
    assert.equal(n.port.closed,true);
    assert.equal(f.posted.some(x=>x.type==='failure'),true);
  }
});
test('native credit waits on bounded decoder queue and cancellation releases it without late credits',async()=>{
  const f=mediaFixture([],true),n=nativePortFixture(f);
  n.send(JSON.stringify({type:'headers',status:200,contentType:'video/mp4'}));
  n.send(Buffer.concat([box('ftyp'),box('moov')]));
  const packet=Buffer.concat([box('moof'),box('mdat',65520)]);
  assert.equal(packet.length,65536);
  // Mimic an unresponsive decoder. Native itself will permit at most 256 KiB
  // beyond its last credit, even if a burst reaches the port callback at once.
  for(let i=0;i<36;i++)n.send(packet);
  await settled();
  const credited=()=>n.messages.filter(x=>x.type==='ack').reduce((sum,x)=>sum+x.bytes,0);
  assert.ok(credited()>=2*1024*1024&&credited()<=2*1024*1024+65536);
  const before=credited();f.send({type:'close'});await settled();
  assert.equal(credited(),before);assert.equal(n.port.closed,true);
  f.open();await settled();assert.equal(f.appended.length,0);
});
