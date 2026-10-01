import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalSourceFailureLookup,safeCacheFailureStatus,safeRendererErrorCode,
  terminalSourceFailureOwner} from './lib/tiktok-audit-source-failure.mjs';

const id='7688160203807673614', session='428e4ed725ac4a9792c79bc1a04a26cb';
const sample={view:{postKey:`video:${id}`},pong:{videoId:id,session},
  renderer:{id:session,state:'error',frames:0}};
const trial={beforeVideoId:'7683357752915201294',firstPaintUpperMs:null,
  samples:[sample]};

test('terminal source owner requires exact current post, receipt, session, and zero-frame error',()=>{
 assert.deepEqual(terminalSourceFailureOwner(trial),{videoId:id,sessionId:session});
 for(const altered of [
  {...sample,view:{postKey:'video:9999999999999999999'}},
  {...sample,pong:{videoId:id,session:'a'.repeat(32)}},
  {...sample,renderer:{id:session,state:'streaming',frames:0}},
  {...sample,renderer:{id:session,state:'error',frames:1}}
 ]) assert.equal(terminalSourceFailureOwner({...trial,samples:[altered]}),null);
 assert.equal(terminalSourceFailureOwner({...trial,firstPaintUpperMs:500}),null);
 assert.equal(terminalSourceFailureOwner({...trial,photoPost:true}),null);
 assert.equal(terminalSourceFailureOwner({...trial,beforeVideoId:id}),null);
});

test('cache evidence copies only fixed status and category, never URL or raw failure fields',()=>{
 const secret='private-token-value';
 const record={status:'error',failure:{category:'upstream_http',stderr:`HTTP 503 ${secret}`},
  playbackUrl:`http://127.0.0.1:8787/media?token=${secret}`,
  urls:[`https://www.tiktok.com/@person/video/${id}?token=${secret}`]};
 const safe=safeCacheFailureStatus({ok:true,records:[record]},id);
 assert.deepEqual(safe,{stage:'cache_source_open',status:'error',category:'upstream_http'});
 assert.equal(JSON.stringify(safe).includes(secret),false);
 assert.deepEqual(safeCacheFailureStatus({ok:true,records:[
  {...record,status:'ready'}]},id),{stage:'cache_source_open',status:'ready',category:null});
 assert.deepEqual(safeCacheFailureStatus({ok:true,records:[
  {...record,failure:{category:`upstream_http_${secret}`}}]},id),
  {stage:'cache_source_open',status:'error',category:null});
});

test('ambiguous, missing, and malformed cache records cannot be guessed into an HTTP failure',()=>{
 const base={status:'error',failure:{category:'upstream_http'},
  urls:[`https://m.tiktok.com/@person/video/${id}`]};
 assert.deepEqual(safeCacheFailureStatus({ok:true,records:[
  {...base,urls:[`https://not-tiktok.example/video/${id}`]}]},id),
  {stage:'cache_source_open',status:'missing',category:null});
 assert.deepEqual(safeCacheFailureStatus({ok:true,records:[base,{...base,status:'ready'}]},id),
  {stage:'cache_source_open',status:'ambiguous',category:null});
 assert.deepEqual(safeCacheFailureStatus({ok:false,records:[base]},id),
  {stage:'cache_source_open',status:'unavailable',category:null});
});

test('lookup fetches only once per failed session and never retries unavailable results',async()=>{
 let calls=0;
 const lookup=createTerminalSourceFailureLookup(async()=>{calls++;return {ok:true,records:[{
  status:'error',failure:{category:'access_blocked'},
  urls:[`https://www.tiktok.com/@person/video/${id}`]
 }]};});
 assert.equal(await lookup(null),null);
 assert.equal(await lookup({videoId:id,sessionId:'invalid'}),null);
 const owner={videoId:id,sessionId:session};
 const [first,second]=await Promise.all([lookup(owner),lookup(owner)]);
 assert.deepEqual(first,{stage:'cache_source_open',status:'error',category:'access_blocked'});
 assert.deepEqual(second,first);
 assert.equal(calls,1);
 assert.equal(await lookup({...owner,videoId:'7777777777777777777'}),null);
 assert.equal(calls,1);
 const failed=createTerminalSourceFailureLookup(async()=>{throw Error('secret URL');});
 assert.deepEqual(await failed(owner),{stage:'cache_source_open',status:'unavailable',category:null});
});

test('renderer errors are fixed-format codes only, not raw stderr or URLs',()=>{
 assert.equal(safeRendererErrorCode('SWAP_FAILED'),'SWAP_FAILED');
 assert.equal(safeRendererErrorCode('HTTP 503 https://private.example/?token=abc'),'');
 assert.equal(safeRendererErrorCode('a'.repeat(500)),'');
});
