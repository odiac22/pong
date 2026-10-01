import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const context={Uint8Array,DataView};vm.runInNewContext(readFileSync('android-app/app/src/main/assets/tiktok-avc-fragments.js','utf8'),context);
const Demux=context.PongAvcFragments;
const fixture=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x240:rate=30','-frames:v','12','-an','-c:v','libx264','-pix_fmt','yuv420p','-bf','0','-g','6','-movflags','frag_every_frame+empty_moov+default_base_moof','-f','mp4','pipe:1']);
for(const chunkSize of [1,97,65536])test(`AVC samples, timestamps and keyframes survive ${chunkSize}-byte input chunks`,async()=>{
 let config;const samples=[],d=new Demux(c=>{config=c},s=>samples.push(s));
 for(let i=0;i<fixture.length;i+=chunkSize)await d.push(fixture.subarray(i,i+chunkSize));
 d.finish();assert.equal(config.codedWidth,160);assert.equal(config.codedHeight,240);assert.match(config.codec,/^avc1\./);
 assert.equal(config.description[0],1);assert.equal(samples.length,12);
 assert.deepEqual(samples.filter(s=>s.type==='key').map((s)=>s.timestamp),[0,200000]);
 samples.forEach((s,i)=>{assert.equal(s.timestamp,Math.round(i*1e6/30));assert.equal(s.duration,33333);assert.ok(s.data.length>0);});
});
test('truncated media cannot be declared complete',async()=>{const d=new Demux(()=>{},()=>{});await d.push(fixture.subarray(0,fixture.length-3));assert.throws(()=>d.finish(),/Truncated/)});
test('unbounded or indefinite boxes are rejected',async()=>{
 for(const size of [0,4,33554433]){const b=Buffer.alloc(8);b.writeUInt32BE(size);b.write('mdat',4);await assert.rejects(new Demux(()=>{},()=>{}).push(b),/box size/);}
});
test('asynchronous sample consumer applies backpressure before the next fragment',async()=>{
 let release,received=0;const blocked=new Promise(r=>{release=r});
 const d=new Demux(()=>{},async()=>{received++;if(received===1)await blocked});
 const p=d.push(fixture);await new Promise(r=>setTimeout(r,0));assert.equal(received,1);release();await p;assert.equal(received,12);
});
