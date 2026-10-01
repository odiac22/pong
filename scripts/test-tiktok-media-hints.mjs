import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeTikTokMediaHint,tikTokHintTarget,streamTikTokMediaHint} from '../tiktok-media-hints.mjs';
const page='https://www.tiktok.com/@fixture/video/1234567890123456789';
const url='https://v16-webapp-prime.us.tiktok.com/video/test?token=fixture';
const base={videoId:'1234567890123456789',urls:[url],codec:'h264',width:720,height:1280,size:2048};
test('hints are tied to one explicit TikTok post and bounded AVC rendition',()=>{
 assert.equal(normalizeTikTokMediaHint(page,base,42).receivedAt,42);
 for(const patch of [{videoId:'1234567890123456790'},{width:0},{height:9000},{size:Infinity},{size:1},{codec:'h265'},{urls:[]}])assert.equal(normalizeTikTokMediaHint(page,{...base,...patch}),null);
 assert.equal(normalizeTikTokMediaHint('https://example.com/@fixture/video/'+base.videoId,base),null);
});
test('CDN allowlist rejects arbitrary targets, credentials, ports and unsafe protocols',()=>{
 for(const u of ['http://v16.tiktok.com/video/x','https://127.0.0.1/video/x','https://localhost/video/x','https://v16.tiktok.com.evil.test/video/x','https://evil.test/video/x','https://x:v@v16.tiktok.com/video/x','https://v16.tiktok.com:8787/video/x','https://www.tiktok.com/api/x','https://v16.tiktok.com/api/x'])assert.equal(tikTokHintTarget(u),null,u);
 assert.ok(tikTokHintTarget(url));assert.ok(tikTokHintTarget('https://v16m-webapp.tiktokcdn-us.com/video/x'));
});
function response(status=200,headers={},chunks=[Buffer.alloc(2048)]){
 const r=Readable.from(chunks);r.statusCode=status;r.headers={'content-type':'video/mp4','content-length':'2048',...headers};return r;
}
const opts=request=>({request,write:async()=>{},onMetadata:()=>{},onBytes:()=>{},maxBytes:10_000,signal:new AbortController().signal});
test('desktop streams exact entity bytes with bounded headers and no transcoding',async()=>{
 let wrote=0,reported=0,total;
 const result=await streamTikTokMediaHint(base,{...opts(async()=>response()),write:async b=>wrote+=b.length,onBytes:(b,n)=>reported=n,onMetadata:n=>total=n});
 assert.equal(result.bytes,2048);assert.equal(wrote,2048);assert.equal(reported,2048);assert.equal(total,2048);
});
test('redirect destinations are revalidated before any follow-up request',async()=>{
 let calls=0;
 await assert.rejects(streamTikTokMediaHint(base,opts(async()=>{calls++;return response(302,{location:'http://127.0.0.1/private'});})),/Untrusted/);
 assert.equal(calls,1);
});
test('expired hint can try the second CDN only before any bytes are written',async()=>{
 let calls=0;const hinted={...base,urls:[url,url.replace('v16','v19')]};
 const result=await streamTikTokMediaHint(hinted,opts(async()=>++calls===1?response(403):response()));
 assert.equal(calls,2);assert.equal(result.bytes,2048);
 calls=0;
 await assert.rejects(streamTikTokMediaHint(hinted,opts(async()=>{calls++;return response(200,{},[Buffer.alloc(10)])})),/truncated/);
 assert.equal(calls,1);
});
test('mismatched size, MIME, content encoding and partial bodies never masquerade as full MP4',async()=>{
 for(const [status,headers] of [[206,{}],[200,{'content-length':'3000'}],[200,{'content-type':'text/html'}],[200,{'content-encoding':'gzip'}]])
  await assert.rejects(streamTikTokMediaHint(base,opts(async()=>response(status,headers))),/matching MP4/);
});
test('browser chooses largest AVC format, not adaptive low quality or HEVC',()=>{
 const code=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 const helper=code.slice(code.indexOf('  const mediaHint ='),code.indexOf('  const scan ='));
 const video={bitrateInfo:[
  {CodecType:'h264',Bitrate:100,PlayAddr:{Width:360,Height:640,DataSize:2048,UrlList:[url]}},
  {CodecType:'h264',Bitrate:200,PlayAddr:{Width:1080,Height:1920,DataSize:4096,UrlList:[url]}},
  {CodecType:'h265',Bitrate:1000,PlayAddr:{Width:2160,Height:3840,DataSize:8192,UrlList:[url]}}
 ]};
 const pick=vm.runInNewContext(`(()=>{${helper}return mediaHint;})()`,{reactVideo:()=>({url:page,item:{id:base.videoId,video}})});
 assert.equal(pick({}).width,1080);assert.equal(pick({}).codec,'h264');
});
test('APK and cache warm path preserve bounded hints without declaring navigation a stall',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const html=readFileSync('index.html','utf8');
 assert.match(java,/validated\.contains\(hint\.optString\("pageUrl"/);
 assert.match(html,/foregroundStalled: false,\s*mediaHints:/);
 assert.match(html,/foregroundStalled: foregroundStalled === true/);
});
test('queue admission, not the media GET handler, owns hint metadata',()=>{
 const source=readFileSync('local-ai-server.mjs','utf8');
 const start=source.indexOf('function queueVideoFileCacheUrl('),end=source.indexOf('\nfunction beginVideoFileCachePriorityEpoch',start);
 const admissionStart=source.indexOf('function tikTokVideoFileCacheHintIdentity(');
 const admissionEnd=source.indexOf('\nconst VIDEO_FILE_CACHE_GENERIC_SEGMENT_MAX_ACTIVE',admissionStart);
 const records=new Map();
 const queue=vm.runInNewContext(`(()=>{${source.slice(admissionStart,admissionEnd)}\n${source.slice(start,end)}return queueVideoFileCacheUrl})()`,{
  URL,VIDEO_FILE_CACHE_TIKTOK_FAILURE_COOLDOWN_MS:30000,
  isTikTokVideoPageUrl:x=>/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/.test(x),
  videoFileCacheHealthy:true,videoFileCacheResetPromise:null,videoFileCacheRecords:records,videoFileCacheOrder:0,
  videoFileCacheGeneration:1,videoFileCachePriorityEpoch:1,VIDEO_FILE_CACHE_ACTIVE_HOLD_MS:3000,
  VIDEO_FILE_CACHE_ENTRY_HOLD_MS:3000,VIDEO_FILE_CACHE_CURRENT_HOLD_MS:3000,
  videoFileCacheCanonical:x=>({id:'abc',identity:'fixture',targetUrl:x}),normalizeTikTokMediaHint,
  currentVideoFileCachePriority:()=>0,enqueueVideoFileCacheRecord:r=>{r.status='queued'}
 });
 const record=queue(page,0,{playbackProfile:'tiktok',tiktokMediaHint:base});
 assert.equal(record.tiktokMediaHint.videoId,base.videoId);
 assert.equal(queue(page,0).tiktokMediaHint.videoId,base.videoId);
 const getStart=source.indexOf('async function serveVideoFileCacheMedia(');
 const getEnd=source.indexOf('\nasync function ',getStart+1);
 assert.doesNotMatch(source.slice(getStart,getEnd),/\bmetadata\??\./);
});

test('unqualified direct-CDN transport and traversal are both opt-in',()=>{
 const server=readFileSync('local-ai-server.mjs','utf8');
 const client=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
 assert.match(server,/process\.env\.PONG_TIKTOK_MEDIA_HINT_TRIAL==='1' && hint/);
 assert.match(client,/const mediaHints=window\.__pongMediaHintTrial===true\?hintCards\.map\(mediaHint\)\.filter\(Boolean\):\[\]/);
});
