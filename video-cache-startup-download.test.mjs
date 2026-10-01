import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {startupPrefixRange,STARTUP_PREFIX_BYTES} from './video-cache-startup-policy.mjs';
const source=await fs.readFile(new URL('./local-ai-server.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function downloadVideoFileCacheRecord('),source.indexOf('\nfunction pumpVideoFileCache()'));
async function fixture(t,{ignoreRange=false,validator=true,promote=false,size=STARTUP_PREFIX_BYTES+4096}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pong-prefix-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const data=Buffer.alloc(size,0x51),requests=[];
  const record={id:'test',sourceUrl:'https://cdn.example/a.mp4',startupOnly:true,bytes:0};
  const sandbox={URL,AbortController,Promise,Date,Number,String,Math,Error,setTimeout,clearTimeout,
    fs,createWriteStream,STARTUP_PREFIX_BYTES,startupPrefixRange,
    videoFileCacheControllers:new Set(),VIDEO_FILE_CACHE_DIR:dir,
    VIDEO_FILE_CACHE_MAX_FILE_BYTES:16*1024*1024,VIDEO_FILE_CACHE_BACKGROUND_QUANTUM_BYTES:32*1024*1024,
    GATEWAY_MAX_REDIRECTS:5,GATEWAY_TIMEOUT_MS:1000,GATEWAY_AGENT:null,
    videoFileCacheGeneration:1,videoFileCacheBytes:0,videoFileCacheQueue:[],
    videoFileCachePathFor:(_id,ext)=>path.join(dir,'media'+ext),
    videoFileCacheCanUseGenericSegments:()=>false,videoFileCacheCanUseLocal22Segments:()=>false,
    isTikTokVideoPageUrl:()=>false,refreshBunkrCdnSignedUrl:async u=>u,
    gatewayTargetUrl:u=>new URL(u),gatewayMediaReferer:()=>'',
    currentVideoFileCachePriority:()=>record.startupOnly?2:0,
    rebalanceVideoFileCacheDownloads(){},validateCompletedVideoCacheFile:async()=>{},
    evictVideoFileCacheIfNeeded:async()=>{},enqueueVideoFileCacheRecord:r=>{r.status='queued'},
    videoFileCacheShouldRetryAfterFailure:()=>false,noteVideoFileCacheFailure:()=>{},GENERIC_FAILURE_COOLDOWN_MS:30000,
    https:{request(_url,options,callback){
      const req=new EventEmitter();
      req.end=()=>queueMicrotask(()=>{
        requests.push(options.headers);
        const m=/bytes=(\d+)-(\d*)/.exec(options.headers.range||'');
        const start=m&&!ignoreRange?Number(m[1]):0,end=m?.[2]&&!ignoreRange?Math.min(Number(m[2]),data.length-1):data.length-1;
        const res=Readable.from([data.subarray(start,end+1)]);
        res.statusCode=m&&!ignoreRange?206:200;
        res.headers={'content-type':'video/mp4','content-length':String(end-start+1),
          ...(m&&!ignoreRange?{'content-range':`bytes ${start}-${end}/${data.length}`}:{ }),
          ...(validator?{etag:'"fixture-a"'}:{})};
        if(promote) {record.startupOnly=false;record.activeReaders=1;}
        callback(res);
      });
      return req;
    }}
  };
  vm.createContext(sandbox);vm.runInContext(body+'\nglobalThis.download=downloadVideoFileCacheRecord',sandbox);
  await sandbox.download(record,1);
  return {sandbox,record,data,requests,dir};
}
test('preparation retains exactly 4MiB; foreground resumes with If-Range to identical full bytes',async t=>{
  const f=await fixture(t);
  assert.equal(f.record.status,'idle');assert.equal(f.record.startupPrepared,true);
  assert.equal((await fs.stat(path.join(f.dir,'media.part'))).size,STARTUP_PREFIX_BYTES);
  f.record.startupOnly=false;
  await f.sandbox.download(f.record,1);
  assert.equal(f.requests[1].range,`bytes=${STARTUP_PREFIX_BYTES}-`);
  assert.equal(f.requests[1]['if-range'],'"fixture-a"');
  assert.equal(f.record.status,'ready');
  assert.deepEqual(await fs.readFile(path.join(f.dir,'media.cache')),f.data);
});
test('Range-ignoring origin does not become an unbounded speculative download',async t=>{
  const f=await fixture(t,{ignoreRange:true});
  assert.equal(f.record.status,'idle');assert.equal(f.record.bytes,0);
  assert.equal(await fs.stat(path.join(f.dir,'media.part')).catch(()=>null),null);
});
test('unvalidated prefix is not retained or served',async t=>{
  const f=await fixture(t,{validator:false});
  assert.equal(f.record.status,'idle');assert.equal(f.record.bytes,0);
});
test('foreground promotion during prefix I/O queues a continuation without a second writer',async t=>{
  const f=await fixture(t,{promote:true});
  assert.equal(f.record.status,'queued');assert.equal(f.record.downloadPromise,null);
  assert.equal(f.requests.length,1);assert.equal(f.record.bytes,STARTUP_PREFIX_BYTES);
});
test('a complete small prepared clip is reusable, not downloaded again by the proxy',async t=>{
  const f=await fixture(t,{size:4096});
  assert.equal(f.record.status,'ready');assert.equal(f.record.startupPrepared,true);
  assert.deepEqual(await fs.readFile(f.record.filePath),f.data);
  assert.equal(f.requests.length,1);
});
