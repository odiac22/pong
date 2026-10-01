import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-worker-mse.js','utf8');
const core=code.slice(code.indexOf('  function workerMain()'),code.indexOf('  window.__pongCreateWorkerMse='));
const settled=()=>new Promise(r=>setImmediate(r));
function fixture({parts=[new Uint8Array([1,2,3])],eof=false,type='video/mp4',status=200}={}){
 const messages=[],requests=[],sources=[],timers=new Map();let reads=0,timer=0;
 class MediaSource{
  static isTypeSupported(){return true}
  constructor(){this.handle={};this.readyState='closed';this.events={};sources.push(this)}
  addEventListener(n,f){this.events[n]=f}
  addSourceBuffer(){return this.buffer={updating:false,events:{},chunks:[],addEventListener(n,f){this.events[n]=f},appendBuffer(data){this.chunks.push(data)}}}
  endOfStream(){this.readyState='ended'}
 }
 const context={MediaSource,URL,AbortController,Uint8Array,performance:{timeOrigin:1000000,now:()=>50},
  postMessage:message=>messages.push(message),setInterval:f=>{timers.set(++timer,f);return timer},clearInterval:id=>timers.delete(id),setTimeout:f=>{timers.set(++timer,f);return timer},clearTimeout:id=>timers.delete(id),
  fetch:async(url,options)=>{requests.push({url,options});let index=0;return{ok:status===200,status,headers:{get:()=>type},body:{getReader:()=>({read:async()=>{reads++;return index<parts.length?{value:parts[index++]}:eof?{done:true}:new Promise(()=>{})}})}}}};
 context.self=context;vm.runInNewContext('('+core+')()',context);
 return{messages,requests,sources,timers,reads:()=>reads,send:data=>context.onmessage({data}),
  start:()=>context.onmessage({data:{type:'start',url:'https://www.tiktok.com/__pong_swap/fixture?attach=1'}}),
  open:()=>{sources[0].readyState='open';sources[0].events.sourceopen()}};
}
test('worker network begins before sourceopen and only transfers its handle once',async()=>{
 const f=fixture();f.start();f.start();await settled();
 assert.equal(f.requests.length,1);assert.equal(f.messages.filter(m=>m.type==='handle').length,1);
 assert.equal(f.sources[0].buffer,undefined);
 f.open();assert.deepEqual(Array.from(f.sources[0].buffer.chunks[0]),[1,2,3]);
});
test('worker queue remains bounded before attachment',async()=>{
 const f=fixture({parts:Array.from({length:8},()=>new Uint8Array(1024*1024))});f.start();await settled();
 assert.equal(f.reads(),2);
 f.open();await settled();assert.ok(f.reads()>2);
});
test('worker coalescing retains exact byte offsets and order',async()=>{
 const f=fixture({parts:[new Uint8Array([99,1,2,88]).subarray(1,3),new Uint8Array([3,4])]});
 f.start();await settled();f.open();
 assert.deepEqual(Array.from(f.sources[0].buffer.chunks[0]),[1,2,3,4]);
});
test('worker accepts only the existing native-owned internal route',async()=>{
 for(const url of ['https://evil.example/__pong_swap/x','https://www.tiktok.com/api/x','https://www.tiktok.com/__pong_swap/x?other=1']){
  const f=fixture();f.send({type:'start',url});await settled();assert.equal(f.requests.length,0);assert.equal(f.messages.at(-1).type,'failure');
 }
});
test('worker rejects HTTP errors, HTML and empty 200 without claiming playable media',async()=>{
 for(const options of [{status:404},{type:'text/html'},{parts:[],eof:true}]){
  const f=fixture(options);f.start();f.open();await settled();
  assert.equal(f.messages.filter(m=>m.type==='failure').length,1);assert.equal(f.requests[0].options.signal.aborted,true);
  assert.equal(f.sources[0].readyState,'open');
 }
});
test('finite worker media waits for actual element metadata before EOF',async()=>{
 const f=fixture({eof:true});f.start();f.open();await settled();
 assert.equal(f.sources[0].readyState,'open');f.send({type:'metadata'});
 assert.equal(f.sources[0].readyState,'ended');
});
test('main receiver retires worker and ignores late handles or status',()=>{
 const workers=[],revoked=[],overlay={events:{},load(){this.loaded=true},addEventListener(n,f){this.events[n]=f}};
 class Worker{constructor(url){this.url=url;workers.push(this)}postMessage(message){this.sent=message}terminate(){this.closed=true}}
 const context={window:{},Worker,Blob:class{},URL:{createObjectURL:()=>'/blob',revokeObjectURL:x=>revoked.push(x)},performance:{timeOrigin:1000000,now:()=>50}};
 vm.runInNewContext(code,context);
 const s={overlay,abort:new AbortController(),url:'https://www.tiktok.com/__pong_swap/x',transport:{},warm:true};
 context.window.__pongCreateWorkerMse(s,{owned:()=>true,fail:()=>assert.fail(),sync(){}});
 const worker=workers[0],handle={};worker.onmessage({data:{type:'handle',handle}});assert.equal(overlay.srcObject,handle);
 worker.onmessage({data:{type:'transport',stats:{firstChunkAt:1000200,bytes:12}}});assert.equal(s.transport.firstChunkAt,200);
 assert.equal(worker.url,'/blob');
 s.abort.abort();assert.equal(worker.closed,true);assert.deepEqual(revoked,['/blob']);
 worker.onmessage({data:{type:'handle',handle:{}}});assert.equal(overlay.srcObject,handle);
});

test('rejected fixed-worker experiment leaves no resource interceptor behind',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 assert.doesNotMatch(java,/__pong_worker_mse.js/);
});
