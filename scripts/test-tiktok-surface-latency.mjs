import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSurfaceLatency} from './lib/tiktok-surface-latency.mjs';
test('surface history excludes pending, zero, duplicate and out-of-window presents',()=>{
 const result=parseSurfaceLatency('16666666\n0 0 0\n0 9223372036854775807 0\n1 90 1\n1 100 1\n1 100 1\n2 200 2\n3 300 3\n',100,300);
 assert.deepEqual(result.presentedBufferTimesNs,['100','200']);
 assert.equal(result.physicalVideoFpsFloorProven,false);
 assert.equal(result.count,2);
 assert.throws(()=>parseSurfaceLatency('oops',0,1),/refresh/);
 assert.throws(()=>parseSurfaceLatency('16666666\n1 nope 2',0,1),/Malformed/);
});
