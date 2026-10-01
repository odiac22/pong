import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const body=html.slice(html.indexOf('function random40ApplyServerVideoCacheRecords('),html.indexOf('\nfunction random40StartServerVideoCacheTimers('));
function fixture(){
 const wrappers=[0,1,2].map(i=>({key:'video:'+i,dataset:{networkSuspended:'true'},querySelector:()=>({})}));
 const calls=[],overrides=new Map(),tracked=new Map();let scans=0,identities=0;
 const context={Date,Map,Number,String,Array,allVideoUrls:wrappers.map(w=>w.key),allVideoMetadata:[{},{},{}],
 document:{querySelectorAll:()=>{scans++;return wrappers},querySelector:()=>wrappers[0]},
 pongCanonicalMediaUrlForGlobalIndex:(_i,url)=>url,pongCanonicalRawMediaUrl:url=>url,
 pongCanonicalMediaUrlForWrapper:w=>{identities++;return w.key},
 random40ServerVideoCacheEndpoint:()=>'/cache',random40ServerVideoCacheTracked:tracked,
 pongLocal22TurboPlaybackActive:()=>false,random40RememberPlaybackOverride:(key,url)=>overrides.set(key,url),
 random40ApplyServerCachePlaybackUrl:(key,url,{candidates})=>{calls.push({key,owners:candidates.map(w=>w.key)});return false},
 random40KeepReadyCacheCardAttached:()=>false,restoreDeckVideoNetwork:()=>false,
 random40PlaybackOverrideFor:key=>overrides.get(key),random40PlaybackUrlsMatch:(a,b)=>a===b,
 random40ForgetPlaybackOverride:key=>overrides.delete(key),tuneVideoPreloadAround(){},
 random40MaybeAcknowledgePlaybackReady(){},updatePasteNavigationButton(){}};
 vm.runInNewContext(body,context);
 return{context,wrappers,calls,overrides,tracked,cost:()=>({scans,identities})};
}
const ready=(id,key)=>({id,urls:[key],ready:true,status:'ready',bytes:1200,playbackPath:'/file/'+id});
test('a large cache response matches mounted owners once, including absent files',()=>{
 const f=fixture();f.context.random40ApplyServerVideoCacheRecords(Array.from({length:240},(_,i)=>ready('id'+i,'video:'+i)));
 assert.deepEqual(f.cost(),{scans:1,identities:3});
 assert.equal(f.calls.length,240);assert.equal(f.calls[1].owners[0],'video:1');
 assert.equal(f.calls[239].owners.length,0);assert.equal(f.tracked.size,240);
});
test('the next response rebuilds ownership after a wrapper is recycled',()=>{
 const f=fixture();f.context.random40ApplyServerVideoCacheRecords([ready('a','video:0')]);
 f.wrappers[0].key='video:new';f.context.random40ApplyServerVideoCacheRecords([ready('b','video:new'),ready('a','video:0')]);
 assert.equal(f.calls[1].owners[0],'video:new');assert.equal(f.calls[2].owners.length,0);
 assert.deepEqual(f.cost(),{scans:2,identities:6});
});
test('revocation restores only the matching suspended owner',()=>{
 const f=fixture(),owner=f.wrappers[1];owner.dataset.serverCachePlaybackSrc='/cache/file/a';owner.dataset.suspendedVideoSrc='/cache/file/a';owner.dataset.originalVideoUrl=owner.key;
 f.overrides.set(owner.key,'/cache/file/a');
 f.context.random40ApplyServerVideoCacheRecords([{...ready('a',owner.key),ready:false,status:'error'}]);
 assert.equal(owner.dataset.serverCachePlaybackSrc,undefined);assert.equal(owner.dataset.suspendedVideoSrc,owner.key);
 assert.equal(f.wrappers[0].dataset.suspendedVideoSrc,undefined);assert.equal(f.overrides.has(owner.key),false);
});
