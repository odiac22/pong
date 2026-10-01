import test from 'node:test';
import assert from 'node:assert/strict';
import {encodePatch,decodePatch,PatchFlightGate,HEADER_BYTES,mediaTimeBits}
  from './patch_transport.mjs';

const nonce=Buffer.alloc(16,0xa5);
const meta=(sequence=1,epoch=7,ptsBits=mediaTimeBits(1.234567),width=32,height=24,channels=3)=>
  ({nonce,epoch,sequence,ptsBits,width,height,channels});
const sourceFor=m=>Buffer.from({length:m.width*m.height*m.channels},(_,i)=>(i*29+i%17)&255);

test('unchanged RGB frame reconstructs exactly without payload',()=>{
  const m=meta(),source=sourceFor(m),packet=encodePatch(m,source,source);
  assert.equal(packet.length,HEADER_BYTES);assert.equal(packet[6],0);
  assert.deepEqual(decodePatch(packet,source,m),source);
});

test('sparse changed pixels use ordered runs and preserve every channel exactly',()=>{
  const m=meta(),source=sourceFor(m),rendered=Buffer.from(source);
  for(const [x,y] of [[3,4],[4,4],[22,17]]){
    const at=(y*m.width+x)*m.channels;rendered[at]^=0xff;rendered[at+2]^=0x53;
  }
  const packet=encodePatch(m,source,rendered);
  assert.equal(packet[6],1);assert.ok(packet.length<source.length);
  assert.deepEqual(decodePatch(packet,source,m),rendered);
});

test('compressible face rectangle keeps all pixels and never enlarges beyond raw frame',()=>{
  const m=meta(1,7,mediaTimeBits(3),720,1280,3),source=Buffer.alloc(m.width*m.height*m.channels);
  for(let y=0;y<m.height;y++)for(let x=0;x<m.width;x++){
    const at=(y*m.width+x)*3;source[at]=x&255;source[at+1]=y&255;source[at+2]=(x+y)&255;
  }
  const rendered=Buffer.from(source);
  for(let y=420;y<760;y++)for(let x=250;x<470;x++){
    const at=(y*m.width+x)*3;rendered[at]=((x-250)>>3)&255;
    rendered[at+1]=((y-420)>>3)&255;rendered[at+2]=127;
  }
  const packet=encodePatch(m,source,rendered);
  assert.equal(packet[6],3);assert.ok(packet.length<source.length);
  assert.deepEqual(decodePatch(packet,source,m),rendered);
});

test('wide high-entropy changes use exact full-frame fallback, not a larger patch',()=>{
  const m=meta(),source=sourceFor(m),rendered=Buffer.from(source);
  let random=0x12345678;
  for(let i=0;i<rendered.length;i++){
    random^=random<<13;random^=random>>>17;random^=random<<5;
    rendered[i]=random&255;
  }
  const packet=encodePatch(m,source,rendered);
  assert.equal(packet[6],2);assert.equal(packet.length,HEADER_BYTES+source.length);
  assert.deepEqual(decodePatch(packet,source,m),rendered);
});

test('foreign scene, out-of-order sequence, exact PTS or source mismatch cannot decode',()=>{
  const m=meta(),source=sourceFor(m),rendered=Buffer.from(source);rendered[40]^=23;
  const packet=encodePatch(m,source,rendered);
  assert.throws(()=>decodePatch(packet,source,{...m,epoch:8}),/foreign/);
  assert.throws(()=>decodePatch(packet,source,{...m,sequence:2}),/foreign/);
  assert.throws(()=>decodePatch(packet,source,{...m,ptsBits:m.ptsBits+1n}),/foreign/);
  const wrong=Buffer.from(source);wrong[99]^=1;
  assert.throws(()=>decodePatch(packet,wrong,m),/source frame mismatch/);
  const corrupt=Buffer.from(packet);corrupt[corrupt.length-1]^=1;
  assert.throws(()=>decodePatch(corrupt,source,m),/integrity mismatch/);
});

test('run geometry cannot overlap or escape the source frame',()=>{
  const m=meta(),source=sourceFor(m),rendered=Buffer.from(source);
  rendered[(4*m.width+3)*3]^=1;rendered[(17*m.width+22)*3]^=1;
  const packet=encodePatch(m,source,rendered);
  assert.equal(packet[6],1);
  const overlap=Buffer.from(packet);overlap.writeUInt16BE(3,HEADER_BYTES+8+3);
  overlap.writeUInt16BE(4,HEADER_BYTES+8+3+2);
  assert.throws(()=>decodePatch(overlap,source,m));
  const outside=Buffer.from(packet);outside.writeUInt16BE(m.width,HEADER_BYTES);
  assert.throws(()=>decodePatch(outside,source,m),/invalid patch run/);
});

test('gate has one in-flight plus latest, copies source, and clears stale scene on reset',()=>{
  const gate=new PatchFlightGate(nonce,7),a=meta(1,7,mediaTimeBits(.1)),
    b=meta(2,7,mediaTimeBits(.2)),c=meta(3,7,mediaTimeBits(.3));
  const first=sourceFor(a),second=sourceFor(b),third=sourceFor(c);
  assert.deepEqual(gate.offer(a,first),{sent:true,replacedLatest:false});
  assert.deepEqual(gate.offer(b,second),{sent:false,replacedLatest:true});
  assert.deepEqual(gate.offer(c,third),{sent:false,replacedLatest:true});
  const retainedFirst=gate.active.source;
  first.fill(0); // Active source is retained by value, not a mutable caller view.
  const original=sourceFor(a),done=gate.complete(encodePatch(a,original,original));
  assert.equal(done.frame,null);assert.equal(done.droppedAsStale,true);
  assert.ok(retainedFirst.every(byte=>byte===0));
  assert.equal(done.next.meta.sequence,3);
  assert.throws(()=>gate.complete(encodePatch(b,second,second)),/foreign/);
  const latest=gate.complete(encodePatch(c,third,third));
  assert.deepEqual(latest.frame,third);assert.equal(latest.droppedAsStale,false);
  const d=meta(4,7,mediaTimeBits(.35)),fourth=sourceFor(d);
  gate.offer(d,fourth);const retainedFourth=gate.active.source;
  assert.throws(()=>gate.reset(7),/newer/);
  gate.reset(8);assert.equal(gate.active,null);assert.equal(gate.pending,null);
  assert.ok(retainedFourth.every(byte=>byte===0));
  assert.throws(()=>gate.complete(encodePatch(c,third,third)),/no frame/);
  assert.throws(()=>gate.offer(c,third),/foreign/);
  assert.deepEqual(gate.offer(meta(1,8,mediaTimeBits(.4)),third),{sent:true,replacedLatest:false});
});

test('source media PTS retains exact float64 bits, not rounded milliseconds',()=>{
  assert.notEqual(mediaTimeBits(1.0000000001),mediaTimeBits(1.0000000002));
  assert.throws(()=>mediaTimeBits(NaN),/invalid/);
  assert.throws(()=>mediaTimeBits(-0),/invalid/);
});
