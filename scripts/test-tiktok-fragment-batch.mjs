import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync('scripts/tiktok-fragment-batch-trial.js','utf8');
const production=readFileSync('android-app/app/src/main/assets/tiktok-fragment-batch.js','utf8');
const context={window:{}};vm.runInNewContext(source,context);
const productionContext={window:{}};vm.runInNewContext(production,productionContext);
const box=(kind,payload=0,wide=false)=>{const b=Buffer.alloc((wide?16:8)+payload,37);b.writeUInt32BE(wide?1:b.length);b.write(kind,4);if(wide){b.writeUInt32BE(0,8);b.writeUInt32BE(b.length,12)}return b;};
test('every arbitrary network boundary preserves bytes and batches at complete fragments',()=>{
 const init=Buffer.concat([box('ftyp',16),box('moov',32)]),first=Buffer.concat([box('moof',24),box('mdat',8192)]),second=Buffer.concat([box('moof',19,true),box('mdat',1234,true)]);
 const input=Buffer.concat([init,first,second]);
 for(const stride of [1,7,8,15,128,4096,input.length]){
  for(const owner of [context,productionContext]){
  const out=[],p=owner.window.__pongCreateFragmentBatch(x=>out.push(Buffer.from(x)));
  for(let i=0;i<input.length;i+=stride)p.push(input.subarray(i,i+stride));p.finish();
  assert.deepEqual(out,[init,first,second]);assert.deepEqual(Buffer.concat(out),input);
  }
 }
});

test('production rejects logical fragment truncation and releases retained bytes on failure',()=>{
 for(const input of [box('moof',30),Buffer.concat([box('moof'),box('emsg',8)]),box('mdat',32).subarray(0,10)]){
  const p=productionContext.window.__pongCreateFragmentBatch(()=>{});
  p.push(input);assert.throws(()=>p.finish(),/Truncated/);assert.equal(p.retainedBytes,0);
 }
 const p=productionContext.window.__pongCreateFragmentBatch(()=>{});
 assert.throws(()=>p.push(Buffer.concat([box('moof'),box('moof')])),/missing media/);
 assert.equal(p.retainedBytes,0);
});
test('retirement drops a partial fragment without EOF errors or any late emission',()=>{
 const out=[],p=productionContext.window.__pongCreateFragmentBatch(b=>out.push(b));
 p.push(box('mdat',100).subarray(0,50));assert.equal(p.retainedBytes,50);
 p.dispose();assert.equal(p.retainedBytes,0);p.finish();p.push(box('mdat'));
 assert.equal(out.length,0);
});
test('first production initialization and media emit synchronously without replacing fetch',()=>{
 const out=[],p=productionContext.window.__pongCreateFragmentBatch(b=>out.push(Buffer.from(b)));
 const init=Buffer.concat([box('ftyp'),box('moov')]),media=Buffer.concat([box('moof'),box('mdat',100)]);
 p.push(init);assert.deepEqual(out,[init]);p.push(media);assert.deepEqual(out,[init,media]);
 assert.equal(p.retainedBytes,0);p.finish();assert.equal(productionContext.window.fetch,undefined);
});
test('first init and media fragment emit synchronously as soon as complete, with no timer',()=>{
 const out=[],p=context.window.__pongCreateFragmentBatch(x=>out.push(Buffer.from(x)));
 const init=Buffer.concat([box('ftyp'),box('moov')]),fragment=Buffer.concat([box('moof'),box('mdat',4)]);
 p.push(init);assert.equal(out.length,1);
 p.push(fragment.subarray(0,-1));assert.equal(out.length,1);
 p.push(fragment.subarray(-1));assert.equal(out.length,2);p.finish();
});
test('invalid, oversized, truncated and unbounded boxes fail instead of accumulating indefinitely',()=>{
 for(const bad of [Buffer.alloc(8),Buffer.from([0,0,0,4,109,100,97,116]),Buffer.from([255,255,255,255,109,100,97,116])]){
  const p=context.window.__pongCreateFragmentBatch(()=>{});assert.throws(()=>p.push(bad));
 }
 const p=context.window.__pongCreateFragmentBatch(()=>{});p.push(box('mdat',20).subarray(0,15));assert.throws(()=>p.finish());
 const small=context.window.__pongCreateFragmentBatch(()=>{},32);assert.throws(()=>small.push(box('mdat',40)));
});

test('fetch adapter matches only the actual native APK stream route and preserves every byte',async()=>{
 const input=Buffer.concat([box('ftyp'),box('moov'),box('moof'),box('mdat',2048)]);
 const original=async()=>new Response(new ReadableStream({start(c){for(let i=0;i<input.length;i+=64)c.enqueue(input.subarray(i,i+64));c.close()}}),{headers:{'content-type':'video/mp4'}});
 const c={window:{fetch:original},ReadableStream,Response,URL};vm.runInNewContext(source,c);
 const wrapped=await c.window.fetch('https://www.tiktok.com/__pong_swap/abc123?attach=1');
 assert.deepEqual(Buffer.from(await wrapped.arrayBuffer()),input);
 assert.equal(c.window.__pongFragmentBatchStats.streams,1);
 assert.equal(c.window.__pongFragmentBatchStats.packets,2);
 assert.ok(c.window.__pongFragmentBatchStats.reads>2);
 for(const url of ['https://www.tiktok.com/api/feed','https://other.test/__pong_swap/abc123','https://www.tiktok.com/real-video'])await c.window.fetch(url);
 assert.equal(c.window.__pongFragmentBatchStats.streams,1);
 c.window.__pongUndoFragmentBatch();assert.equal(c.window.fetch,original);
});
