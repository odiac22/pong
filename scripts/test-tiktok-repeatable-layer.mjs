import test from 'node:test';
import assert from 'node:assert/strict';
import {validateThreePages,summarizeDiagnostic} from './trial-tiktok-repeatable-layer.mjs';

const pages=[
 'https://www.tiktok.com/@one/video/1234567890123456789',
 'https://www.tiktok.com/@two/video/2234567890123456789',
 'https://www.tiktok.com/@three/video/3234567890123456789'];

test('only three distinct canonical observed pages are accepted',()=>{
 assert.deepEqual(validateThreePages({pages}),pages);
 assert.throws(()=>validateThreePages({pages:[pages[0],pages[0],pages[2]]}),/distinct/);
 assert.throws(()=>validateThreePages({pages:[pages[0],pages[1]]}),/three/);
 assert.throws(()=>validateThreePages({pages:[pages[0],pages[1],
   pages[2]+'?signed=secret']}),/Noncanonical/);
 assert.throws(()=>validateThreePages({pages:[pages[0],pages[1],
   'http://example.com/video/3234567890123456789']}),/Noncanonical/);
});

test('individual case summary keeps pool order and never invents a missing paint',()=>{
 const raw={cases:[
   {videoId:'1234567890123456789',documentReadyMs:200,
     firstPaintUpperMs:700,samples:[{renderer:{transformedFrames:30}}]},
   {videoId:'2234567890123456789',documentReadyMs:250,
     samples:[{renderer:{transformedFrames:0}}]}]};
 const rows=summarizeDiagnostic(raw,pages);
 assert.equal(rows.length,3);
 assert.equal(rows[0].firstPaintUpperMs,700);
 assert.equal(rows[0].transformedFrames,30);
 assert.equal(rows[1].firstPaintUpperMs,null);
 assert.equal(rows[1].transformedFrames,0);
 assert.equal(rows[2].present,false);
 assert.equal(rows[2].firstPaintUpperMs,null);
 assert.equal(rows[2].sampleCount,0);
 assert.ok(rows.every(row=>!('url' in row)&&!('videoId' in row)));
});
