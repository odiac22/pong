import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createDesktopCaptureJobs} from '../desktop-capture-jobs.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function source(name){const start=html.search(new RegExp(`(?:async )?function ${name}\\(`));assert.ok(start>=0);const rest=html.slice(start);const end=rest.slice(1).search(/\n(?:async )?function /);return rest.slice(0,end+1);}
const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const job={id,state:'complete',targets:[{state:'ready'},{state:'failed',error:'quality_unverified'},{state:'failed',error:'source_unavailable'}]};
function ctx(extra={}){
 const context=vm.createContext({AbortSignal,Date,encodeURIComponent,pongGenericRangeCacheAvailable:false,sleep:async()=>{},normalizeSimpCityRecallPayload:(names,threadUrl,id,albums,ai,channel,live,genericBundles)=>({id,genericBundles}),...extra});
 for(const name of ['summarizePongDesktopCapture','pongRecallCaptureStatusText','updatePongMediaTransportCapabilities','fetchSharedSimpCityRecall'])vm.runInContext(source(name),context);
 return context;
}
const payload={recall:{genericBundles:[{videos:[{videoUrl:'https://fixture.invalid/clip.mp4'}]}]},mediaCapture:{id,state:'complete',totalPages:3,completedPages:3,deliveredVideos:1}};
const response=value=>({ok:true,json:async()=>value});
test('Pong retries a transient LAN failure then reads PC results without Firefox',async()=>{
 let reads=0;
 const context=ctx({fetch:async(url,options)=>{assert.ok(options.signal);if(!reads++)throw Error('network switched');return response(url.includes('desktop-capture')?{desktopOwned:true,job}:payload);}});
 const result=await vm.runInContext("fetchSharedSimpCityRecall('http://pc',{channel:1})",context);
 assert.equal(reads,3);assert.equal(result.reachable,true);
 assert.equal(result.capture.desktop.ready,1);assert.equal(result.capture.desktop.failed,2);assert.equal(result.capture.desktop.qualityFailed,1);
 context.capture=result.capture;
 assert.match(vm.runInContext('pongRecallCaptureStatusText(capture,1)',context),/1\/3 ready · 0 pending · 2 failed · 1 could not verify highest quality/);
});
test('An optional desktop-status timeout does not hide ready Recall media',async()=>{
 const context=ctx({fetch:async url=>{if(url.includes('desktop-capture'))throw Error('timeout');return response(payload);}});
 const result=await vm.runInContext("fetchSharedSimpCityRecall('http://pc')",context);
 assert.equal(result.reachable,true);assert.equal(result.recall.genericBundles.length,1);
});
test('A mismatched status response cannot attach another job to this Recall',async()=>{
 const context=ctx({fetch:async url=>response(url.includes('desktop-capture')?{desktopOwned:true,job:{...job,id:'other'}}:payload)});
 const result=await vm.runInContext("fetchSharedSimpCityRecall('http://pc')",context);
 assert.equal(result.capture.desktop,undefined);
});
test('Progress watcher survives failed reads and appends later PC results',async()=>{
 let reads=0,added=0;const badges=[];
 const context=ctx({allVideoUrls:[],simpCityRecallStartToken:3,window:{PongActiveSimpCityRecallChannel:1},document:{documentElement:{dataset:{}}},renderPongRecallCaptureStatus:(_c,_channel,offline)=>badges.push(!!offline),appendGenericRecallBundles:()=>++added});
 context.fetchSharedSimpCityRecall=async()=>++reads<4?{reachable:false}:{reachable:true,capture:{id,state:'complete'},recall:{genericBundles:[{}]}};
 vm.runInContext(source('watchGenericRecallCapture'),context);
 await vm.runInContext(`watchGenericRecallCapture('http://pc',1,'${id}',3)`,context);
 assert.equal(reads,4);assert.equal(added,1);assert.deepEqual(badges,[true,true,true,false]);
});
test('Switching Recall while a read is pending prevents stale queue mutation',async()=>{
 let added=0;
 const context=ctx({allVideoUrls:[],simpCityRecallStartToken:3,window:{PongActiveSimpCityRecallChannel:1},appendGenericRecallBundles:()=>++added});
 context.fetchSharedSimpCityRecall=async()=>{context.simpCityRecallStartToken=4;return {reachable:true,capture:{id,state:'complete'},recall:{genericBundles:[{}]}};};
 vm.runInContext(source('watchGenericRecallCapture'),context);
 await vm.runInContext(`watchGenericRecallCapture('http://pc',1,'${id}',3)`,context);
 assert.equal(added,0);
});
test('Desktop job commits without any sender status poll after acceptance',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve});let committed=false;
 const jobs=createDesktopCaptureJobs({resolve:async()=>{await gate;return {video:{durationSeconds:45}}},commit:()=>{committed=true},finish:()=>{},active:()=>true});
 const accepted=jobs.start({id,fingerprint:'fixture',targets:[{}],context:{channel:2}});
 assert.equal(accepted.status.readyCount,0);
 // No get() calls from the sender: closing its connection does not own work.
 release();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(committed,true);assert.equal(jobs.get(id).readyCount,1);
});
