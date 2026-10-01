import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {PhoneTransferStore} from './phone-transfer-store.mjs';

const bytes=Buffer.alloc(1048593,123);bytes.write('ftyp',4); // inert container-shaped fixture, not played
async function setup(t,options={}) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pong-phone-transfer-test-'));
 t.after(async()=>{assert.ok(path.basename(directory).startsWith('pong-phone-transfer-test-'));await fs.rm(directory,{recursive:true,force:true});});
 const store=await new PhoneTransferStore({directory,minFreeBytes:0,chunkBytes:128*1024,...options}).init();
 return{store,directory,id:crypto.randomUUID()};
}
const reader=(fixture=bytes)=>async(range)=>{const [,start,end]=range.match(/bytes=(\d+)-(\d+)/).map(Number);const hi=Math.min(end,fixture.length-1);return{status:206,body:fixture.subarray(start,hi+1),contentRange:`bytes ${start}-${hi}/${fixture.length}`,etag:'"stable"',sourceUrl:'https://fixture.invalid/video.mp4'};};
async function done(store,id){for(let n=0;n<500;n++){const s=store.status(id);if(['ready','error'].includes(s?.state))return s;await new Promise(r=>setTimeout(r,5));}throw Error('test transfer timeout');}
test('complete transfer is byte-identical, idempotent, private on disk and survives restart/browser loss',async t=>{
 const {store,directory,id}=await setup(t);let calls=0;
 store.start(id,async(...args)=>{calls++;return reader()(...args);});store.start(id,()=>{throw Error('duplicate');});
 assert.equal((await done(store,id)).state,'ready');assert.equal(calls,9);
 assert.deepEqual(await fs.readFile(store.file(id,'media')),bytes);
 const manifest=await fs.readFile(store.file(id,'json'),'utf8');assert.doesNotMatch(manifest,/https|fixture|cookie|token/i);
 const restarted=await new PhoneTransferStore({directory,minFreeBytes:0}).init();
 assert.equal(restarted.status(id).state,'ready');
 const server=http.createServer((req,res)=>{restarted.serve(id,req,res).then(ok=>{if(!ok){res.writeHead(425);res.end();}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/media`;
 for(const [range,start,end] of [['bytes=100-200',100,200],['bytes=-17',bytes.length-17,bytes.length-1],['bytes=1048500-',1048500,bytes.length-1]]){
  const r=await fetch(url,{headers:{Range:range}});assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(start,end+1));
 }
 const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes.length);
 const invalid=await fetch(url,{headers:{Range:'bytes=99999999-'}});assert.equal(invalid.status,416);
});
for(const [name,modify,code] of [
 ['wrong offset',r=>({...r,contentRange:r.contentRange.replace('bytes 0-','bytes 1-')}),'invalid_range'],
 ['HTML instead of video',r=>({...r,body:Buffer.alloc(r.body.length,60)}),'not_video'],
 ['ignored range',r=>({...r,status:200}),'invalid_range'],
 ['truncated bytes',r=>({...r,body:r.body.subarray(1)}),'invalid_range']
])test(`${name} cannot be marked ready`,async t=>{const {store,id}=await setup(t);store.start(id,async range=>modify(await reader()(range)));const s=await done(store,id);assert.equal(s.state,'error');assert.equal(s.error,code);assert.deepEqual(await fs.readdir(store.directory),[]);});
test('changed validators or total sizes reject mixed files',async t=>{
 for(const change of ['etag','total']){const {store,id}=await setup(t);let n=0;store.start(id,async range=>{const r=await reader()(range);if(n++){if(change==='etag')r.etag='"changed"';else r.contentRange=r.contentRange.replace(`/${bytes.length}`,`/${bytes.length+1}`);}return r;});assert.equal((await done(store,id)).error,'source_changed');}
});
test('browser loss retries boundedly and cleans partial bytes',async t=>{const {store,id}=await setup(t);let n=0;store.start(id,async range=>{if(n++)throw Error('private URL must not leak');return reader()(range);});const s=await done(store,id);assert.equal(s.error,'browser_unavailable');assert.equal(n,3);assert.deepEqual(await fs.readdir(store.directory),[]);});
test('file, cache, and free-space limits reject without a ready artifact',async t=>{for(const [options,error] of [[{maxFileBytes:20},'file_too_large'],[{maxBytes:20},'cache_full'],[{minFreeBytes:Number.MAX_SAFE_INTEGER},'disk_space_low']]){const {store,id}=await setup(t,options);store.start(id,reader());assert.equal((await done(store,id)).error,error);}});
test('expiry cleanup affects only managed files and incomplete data is not served',async t=>{const {store,id,directory}=await setup(t);await fs.writeFile(path.join(directory,'unrelated.txt'),'keep');store.start(id,reader());assert.equal(await store.serve(id,{headers:{}},{}),false);await done(store,id);store.records.get(id).expiresAt=0;await store.prune();assert.deepEqual(await fs.readdir(directory),['unrelated.txt']);});
test('restart removes only orphaned owned files',async t=>{const {store,id,directory}=await setup(t);await fs.writeFile(store.file(id,'media'),'orphan');await fs.writeFile(store.file(id,'part'),'partial');await fs.writeFile(path.join(directory,'unrelated.txt'),'keep');await new PhoneTransferStore({directory}).init();assert.deepEqual(await fs.readdir(directory),['unrelated.txt']);});
test('userscript waits for complete transfer before reporting ready',async()=>{
 const script=await fs.readFile(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const start=script.indexOf('  async function waitForPhoneTransfer(');const source=script.slice(start,script.indexOf('  function canonicalWatchPageUrl(',start));
 let calls=0;const updates=[];const ctx=vm.createContext({Date,JSON,Error,encodeURIComponent,sleep:async()=>{},browserRelayRequest:async()=>({status:200,responseText:JSON.stringify({transfer:++calls<3?{state:'downloading',percent:calls*30}:{state:'ready',percent:100}})})});vm.runInContext(source,ctx);
 const result=await ctx.waitForPhoneTransfer('https://fixture.invalid','client','source',x=>updates.push(x.percent));assert.equal(result.state,'ready');assert.deepEqual(updates,[30,60]);assert.equal(calls,3);
 ctx.browserRelayRequest=async()=>({status:200,responseText:'{"transfer":{"state":"error","error":"disk_space_low"}}'});
 await assert.rejects(ctx.waitForPhoneTransfer('https://fixture.invalid','client','source'),/disk_space_low/);
});

test('pinned userscript ranges never refresh a page or substitute a different rendition',async()=>{
 const script=await fs.readFile(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const start=script.indexOf('  async function fetchBrowserMediaRelayRange(');const source=script.slice(start,script.indexOf('  async function completeBrowserMediaRelayJob(',start));
 const calls=[];const ctx=vm.createContext({Set,Array,Number,String,Error,location:{href:'https://fixture.invalid/player'},browserMediaRelayPreferredCandidates:new Map([['id','https://fixture.invalid/low.mp4']]),responseHeaderValue:()=>'',
  browserRelayRequest:async options=>{calls.push(options);return{status:403,response:new ArrayBuffer(0)};},fetchDoc:()=>{throw Error('Page refresh must never occur');}});
 vm.runInContext(source,ctx);
 await assert.rejects(ctx.fetchBrowserMediaRelayRange({sourceId:'id',pinCandidate:true,candidates:['https://fixture.invalid/high.mp4','https://fixture.invalid/low.mp4'],validator:'"original"',range:'bytes=10-20'}),/selected file/);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://fixture.invalid/high.mp4');assert.equal(calls[0].headers['If-Range'],'"original"');
});
