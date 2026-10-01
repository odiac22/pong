import test from 'node:test';
import assert from 'node:assert/strict';
import {reduceTrace} from './trace-tiktok-renderer-scheduling.mjs';
test('trace reduction preserves nested and independent thread timings without event arguments',()=>{
  const rows=reduceTrace([
    {ph:'M',pid:1,tid:2,name:'thread_name',args:{name:'CrRendererMain'}},
    {ph:'B',pid:1,tid:2,name:'outer',ts:0,args:{url:'secret'}},
    {ph:'B',pid:1,tid:3,name:'other',ts:10000},
    {ph:'B',pid:1,tid:2,name:'inner',ts:20000},
    {ph:'E',pid:1,tid:2,ts:30000},
    {ph:'E',pid:1,tid:3,ts:40000},
    {ph:'E',pid:1,tid:2,ts:100000},
    {ph:'X',pid:1,tid:2,name:'inner',dur:5000,args:{token:'secret'}},
  ]);
  assert.equal(rows[0].name,'outer');assert.equal(rows[0].totalMs,100);assert.equal(rows[0].over50,1);
  assert.equal(rows[0].thread,'CrRendererMain');assert.equal(rows.find(r=>r.name==='other').totalMs,30);
  assert.equal(rows.find(r=>r.name==='inner').totalMs,15);assert.equal(rows.find(r=>r.name==='inner').count,2);
  assert.ok(!JSON.stringify(rows).includes('secret'));
});
