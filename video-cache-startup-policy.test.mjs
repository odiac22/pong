import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startupPreparationUrl, genericCacheRequestMayRetry, startupPrefixRange, STARTUP_PREFIX_BYTES} from './video-cache-startup-policy.mjs';
test('only first two resolved direct videos receive bounded preparation', () => {
  for (const n of [1, 2]) assert.equal(startupPreparationUrl({videoUrl:'https://cdn.example/a.mp4?sig=1'},n),'https://cdn.example/a.mp4?sig=1');
  for (const n of [0,3,50,NaN]) assert.equal(startupPreparationUrl({videoUrl:'https://cdn.example/a.mp4'},n),'');
  for (const videoUrl of ['http://cdn.example/a.mp4','https://cdn.example/a.m3u8','https://www.tiktok.com/@user/video/123','bad']) assert.equal(startupPreparationUrl({videoUrl},1),'');
});
test('a request cannot reset an exhausted failure budget during cooldown', () => {
  const r={status:'error',retries:2,retryNotBefore:100};
  for(let i=0;i<100;i++) assert.equal(genericCacheRequestMayRetry(r,99),false);
  assert.equal(r.retries,2);
  assert.equal(genericCacheRequestMayRetry(r,100),true);
  assert.equal(r.retries,0);
});
test('startup is range-bounded; foreground promotion lifts the bound', () => {
  const r={startupOnly:true};
  assert.equal(startupPrefixRange(r,0),`bytes=0-${STARTUP_PREFIX_BYTES-1}`);
  assert.equal(startupPrefixRange(r,1024),`bytes=1024-${STARTUP_PREFIX_BYTES-1}`);
  assert.equal(startupPrefixRange(r,STARTUP_PREFIX_BYTES),'');
  assert.equal(startupPrefixRange({...r,activeReaders:1},0),'');
  assert.equal(startupPrefixRange({...r,playbackLease:true},0),'');
});
