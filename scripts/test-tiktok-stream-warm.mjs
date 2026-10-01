import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-stream.js','utf8');
function fixture({parts=[new Uint8Array(8)],eof=false,type='video/mp4',status=200,batch=false,batchFlag=null}={}){
 const rect=()=>({left:0,top:0,right:400,bottom:800,width:400,height:800});
 const host={dataset:{},style:{},isConnected:true,getBoundingClientRect:rect,appendChild:v=>{v.isConnected=true}};
 const original={isConnected:true,parentElement:host,getBoundingClientRect:rect,paused:false,style:{},dataset:{}};
 const elements=[],sources=[],requests=[],failures=[];let clock=100;
 class MediaSource{static isTypeSupported(){return true}constructor(){this.events={};this.readyState='closed';sources.push(this)}addEventListener(n,f){this.events[n]=f}addSourceBuffer(){return this.buffer={updating:false,events:{},chunks:[],addEventListener(n,f){this.events[n]=f},appendBuffer(b){this.chunks.push(b)}}}endOfStream(){this.readyState='ended'}}
 const context={window:{MediaSource,PongTikTokSwap:{failed:id=>failures.push(id)}},MediaSource,innerWidth:400,innerHeight:800,performance:{now:()=>clock},AbortController,
 URL:{createObjectURL:()=>`blob:${sources.length}`,revokeObjectURL(){}},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
 getComputedStyle:()=>({position:'static',objectFit:'contain'}),
 fetch:async url=>{requests.push(url);let cursor=0;return{ok:status===200,status,headers:{get:()=>type},body:{getReader:()=>({read:async()=>cursor<parts.length?{value:parts[cursor++]}:eof?{done:true}:new Promise(()=>{})})}}},
 document:{documentElement:{classList:{remove(){}}},querySelectorAll:()=>[original],createElement(){
   const v={style:{},events:{},paused:true,readyState:0,addEventListener(n,f){this.events[n]=f},load(){},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},removeAttribute(){},remove(){this.removed=true}};elements.push(v);return v;
 }}};
 if(batch){vm.runInNewContext(readFileSync('android-app/app/src/main/assets/tiktok-fragment-batch.js','utf8'),context);if(batchFlag!==null)context.window.__pongFragmentBatchTrial=batchFlag;}
 vm.runInNewContext(code,context);return{w:context.window,elements,sources,requests,failures,original,advance:ms=>{clock+=ms},open:async index=>{sources[index].readyState='open';await sources[index].events.sourceopen()}};
}
test('a ready callback cannot resurrect the departing decoder; the incoming post releases the gate immediately',()=>{
 const f=fixture(),old='https://www.tiktok.com/@test/video/1',next='https://www.tiktok.com/@test/video/2';
 f.w.__pongDomSwapObserveVideo(old,f.original);f.w.__pongDomSwapAttach('/one','one',0,null,old);
 f.w.__pongDomSwapPrepare('/two','two',next);const warm=f.w.__pongDomSwapWarm;
 f.w.__pongDomSwapDepart();
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,old),false);
 f.w.__pongDomSwapObserveVideo('',null);f.w.__pongDomSwapObserveVideo(old,f.original);
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,old),false);
 assert.equal(f.elements.length,2);
 f.w.__pongDomSwapObserveVideo(next,f.original);
 assert.equal(f.w.__pongDomSwap,warm);assert.equal(f.elements.length,2);
 // A later deliberate back navigation may use the earlier post again.
 f.w.__pongDomSwapObserveVideo(old,f.original);
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,old),true);
});
test('a navigation that never completes does not permanently block the current post',()=>{
 const f=fixture(),old='https://www.tiktok.com/@test/video/1';
 f.w.__pongDomSwapObserveVideo(old,f.original);f.w.__pongDomSwapAttach('/one','one',0,null,old);
 f.w.__pongDomSwapDepart();f.advance(3999);
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,old),false);
 f.advance(1);assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,old),true);
});
test('only one speculative decoder survives and it stays paused and silent',()=>{
 const f=fixture();f.w.__pongDomSwapPrepare('/one?attach=1','one');const old=f.w.__pongDomSwapWarm;
 assert.equal(old.overlay.autoplay,false);assert.equal(old.overlay.muted,true);assert.equal(old.overlay.volume,0);
 f.w.__pongDomSwapPrepare('/two?attach=1','two');assert.equal(old.abort.signal.aborted,true);assert.equal(old.overlay.removed,true);assert.equal(f.w.__pongDomSwapWarm.sessionId,'two');
});
test('retirement cancels reveal and permanent paint callbacks, including id zero',()=>{
 const f=fixture();f.w.__pongDomSwapAttach('/one','one',0);const s=f.w.__pongDomSwap;
 const cancelled=[];s.overlay.cancelVideoFrameCallback=id=>cancelled.push(id);
 s.frameSyncTracking=true;s.frameSyncTrackCallbackId=0;s.frameSyncRevealCallbackId=12;
 f.w.__pongDomSwapClear();
 assert.deepEqual(cancelled,[0,12]);assert.equal(s.frameSyncTracking,false);
 assert.equal(s.frameSyncTrackCallbackId,null);assert.equal(s.frameSyncRevealCallbackId,null);
});

test('active decoder failure restores original, reports once and cannot reattach the dead stream',()=>{
 const f=fixture();f.w.__pongDomSwapAttach('/one','one',0);const old=f.w.__pongDomSwap;
 old.overlay.error={message:'decode failure'};old.overlay.events.error();old.overlay.events.error();
 assert.deepEqual(f.failures,['one']);assert.equal(f.w.__pongDomSwap,null);
 assert.equal(old.abort.signal.aborted,true);assert.equal(f.original.style.opacity,'');
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0),false);
 assert.equal(f.w.__pongDomSwapPrepare('/one','one'),false);
 assert.equal(f.w.__pongDomSwapAttach('/replacement','replacement',0),true);
});

test('warm failure and late retired decoder errors cannot invalidate the active post',()=>{
 const f=fixture();f.w.__pongDomSwapAttach('/one','one',0);const first=f.w.__pongDomSwap;
 f.w.__pongDomSwapPrepare('/two','two');f.w.__pongDomSwapWarm.overlay.events.error();
 assert.equal(f.w.__pongDomSwap,first);assert.deepEqual(f.failures,[]);
 f.w.__pongDomSwapAttach('/three','three',0);first.overlay.events.error();
 assert.equal(f.w.__pongDomSwap.sessionId,'three');assert.deepEqual(f.failures,[]);
});
test('adoption reuses the exact decoded element and held stream without another fetch',async()=>{
 const f=fixture();f.w.__pongDomSwapPrepare('/one?attach=1','one');await f.open(0);const ready=f.w.__pongDomSwapWarm;
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0),true);
 assert.equal(f.w.__pongDomSwap,ready);assert.equal(f.w.__pongDomSwapWarm,null);assert.equal(f.elements.length,1);assert.deepEqual(f.requests,['/one?attach=1']);assert.equal(ready.original,f.original);
});
test('repeated native ready or fallback poll for the same session never reloads its decoder',async()=>{
 const f=fixture(),page='https://www.tiktok.com/@test/video/1';
 f.w.__pongDomSwapObserveVideo(page,f.original);
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,page),true);
 await f.open(0);
 const active=f.w.__pongDomSwap;
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,page),true);
 assert.equal(f.w.__pongDomSwap,active);
 assert.equal(f.elements.length,1);
 assert.deepEqual(f.requests,['/one']);
});
test('late sourceopen from a retired warm stream cannot restart its aborted request',async()=>{
 const f=fixture();f.w.__pongDomSwapPrepare('/one?attach=1','one');const retired=f.w.__pongDomSwapWarm;f.w.__pongDomSwapPrepare('/two?attach=1','two');await f.open(0);assert.equal(f.requests.length,2);assert.equal(retired.abort.signal.aborted,true);assert.equal(f.sources[0].buffer,undefined);
});

const settled=()=>new Promise(resolve=>setImmediate(resolve));
const mp4Box=(kind,size=0)=>{const b=Buffer.alloc(8+size,35);b.writeUInt32BE(b.length);b.write(kind,4);return b;};
test('owned fragment receiver preserves byte identity, sends init immediately and stays silent',async()=>{
 const input=Buffer.concat([mp4Box('ftyp'),mp4Box('moov'),mp4Box('moof'),mp4Box('mdat',16384)]);
 const parts=Array.from({length:Math.ceil(input.length/64)},(_,i)=>input.subarray(i*64,(i+1)*64));
 const f=fixture({parts,batch:true});f.w.__pongDomSwapPrepare('/one','one');await f.open(0);await settled();
 const s=f.w.__pongDomSwapWarm;assert.equal(s.transport.fragmentBatch,true);assert.equal(s.transport.packets,2);
 assert.equal(s.transport.chunks,parts.length);assert.equal(s.transport.appendCalls,2);
 assert.deepEqual(Buffer.concat(f.sources[0].buffer.chunks.map(b=>Buffer.from(b))),input);
 assert.equal(s.overlay.muted,true);assert.equal(s.overlay.volume,0);
});

test('explicit batching rollback preserves the legacy immediate byte path',async()=>{
 const input=Buffer.concat([mp4Box('ftyp'),mp4Box('moov'),mp4Box('moof'),mp4Box('mdat',4096)]);
 const parts=Array.from({length:Math.ceil(input.length/64)},(_,i)=>input.subarray(i*64,(i+1)*64));
 const f=fixture({parts,batch:true,batchFlag:false});f.w.__pongDomSwapPrepare('/one','one');await f.open(0);await settled();
 assert.equal(f.w.__pongFragmentBatchTrial,false);
 assert.equal(f.w.__pongDomSwapWarm.transport.fragmentBatch,undefined);
 assert.deepEqual(Buffer.concat(f.sources[0].buffer.chunks.map(b=>Buffer.from(b))),input);
});
test('a fragment larger than queue credit completes and then backpressures until retirement',async()=>{
 const init=Buffer.concat([mp4Box('ftyp'),mp4Box('moov')]);
 const media=Buffer.concat([mp4Box('moof'),mp4Box('mdat',3*1024*1024)]);
 const input=Buffer.concat([init,media,media]);
 const parts=Array.from({length:Math.ceil(input.length/65536)},(_,i)=>input.subarray(i*65536,(i+1)*65536));
 const f=fixture({parts,batch:true});f.w.__pongDomSwapPrepare('/one','one');await settled();
 const s=f.w.__pongDomSwapWarm;assert.equal(s.transport.packets,2);assert.ok(s.transport.bytes<input.length);
 f.w.__pongDomSwapWarmClear();await settled();assert.equal(s.queue.length,0);assert.equal(s.abort.signal.aborted,true);
});
test('fragment EOF truncation fails its owner but aborting a partial fragment is not an error',async()=>{
 const f=fixture({parts:[mp4Box('moof')],batch:true,eof:true});f.w.__pongDomSwapAttach('/one','one',0);await settled();
 assert.deepEqual(f.failures,['one']);assert.equal(f.w.__pongDomSwap,null);
 const retired=fixture({parts:[mp4Box('mdat',100).subarray(0,15)],batch:true});retired.w.__pongDomSwapAttach('/two','two',0);await settled();
 retired.w.__pongDomSwapClear();await settled();assert.deepEqual(retired.failures,[]);
});
test('one oversized network read cannot fill the emitted queue with every fragment',async()=>{
 const init=Buffer.concat([mp4Box('ftyp'),mp4Box('moov')]);
 const media=Buffer.concat([mp4Box('moof'),mp4Box('mdat',768*1024)]);
 const input=Buffer.concat([init,...Array(10).fill(media)]);
 const f=fixture({parts:[input],batch:true});f.w.__pongDomSwapPrepare('/one','one');await settled();
 const s=f.w.__pongDomSwapWarm,queued=s.queue.reduce((sum,b)=>sum+b.byteLength,0);
 assert.equal(s.transport.chunks,1);assert.equal(s.transport.packets,4);
 assert.ok(queued>=2*1024*1024);assert.ok(queued<3*1024*1024);
 f.w.__pongDomSwapWarmClear();await settled();assert.equal(s.queue.length,0);
 assert.equal(s.transport.packets,4);
});
test('network starts before sourceopen and received bytes drain once decoder opens',async()=>{
 const f=fixture();f.w.__pongDomSwapPrepare('/one','one');await settled();
 const s=f.w.__pongDomSwapWarm;assert.deepEqual(f.requests,['/one']);assert.equal(s.transport.bytes,8);
 assert.equal(s.queue.length,1);assert.equal(s.transport.sourceOpenAt,undefined);
 await f.open(0);assert.equal(f.sources[0].buffer.chunks.length,1);assert.equal(s.queue.length,0);
});
test('pre-decoder queue is bounded and retirement releases its backpressure wait',async()=>{
 const f=fixture({parts:Array.from({length:8},()=>new Uint8Array(1024*1024))});
 f.w.__pongDomSwapPrepare('/one','one');await settled();const s=f.w.__pongDomSwapWarm;
 assert.equal(s.transport.bytes,2*1024*1024);assert.equal(s.queue.length,2);
 f.w.__pongDomSwapWarmClear();await settled();assert.equal(s.transport.bytes,2*1024*1024);assert.equal(s.abort.signal.aborted,true);
});
test('coalescing queued network reads preserves every byte in order and adds no startup wait',async()=>{
 const parts=Array.from({length:30},(_,i)=>new Uint8Array(4096).fill(i));
 const f=fixture({parts});f.w.__pongDomSwapPrepare('/one','one');await settled();
 const s=f.w.__pongDomSwapWarm;assert.equal(s.queue.length,30);
 await f.open(0);
 const appended=f.sources[0].buffer.chunks;
 assert.equal(appended.length,1);assert.equal(s.transport.appendCalls,1);assert.equal(s.transport.coalescedReads,29);
 assert.deepEqual(Buffer.from(appended[0]),Buffer.concat(parts.map(p=>Buffer.from(p))));
 assert.equal(s.queue.length,0);
});
test('an append batch never drains more than 256 KiB of small queued reads',async()=>{
 const f=fixture({parts:Array.from({length:100},()=>new Uint8Array(4096))});
 f.w.__pongDomSwapPrepare('/one','one');await settled();await f.open(0);
 assert.equal(f.sources[0].buffer.chunks[0].byteLength,256*1024);
 assert.equal(f.w.__pongDomSwapWarm.queue.length,36);
 f.sources[0].buffer.events.updateend();
 assert.equal(f.sources[0].buffer.chunks[1].byteLength,36*4096);
 assert.equal(f.w.__pongDomSwapWarm.queue.length,0);
});
test('HTTP errors, HTML and empty 200 responses fail without closing an uninitialized MediaSource',async()=>{
 for(const options of [{status:410},{type:'text/html'},{parts:[],eof:true}]){
  const f=fixture(options);f.w.__pongDomSwapAttach('/one','one',0);await settled();
  assert.deepEqual(f.failures,['one']);assert.equal(f.w.__pongDomSwap,null);assert.equal(f.sources[0].readyState,'closed');
  assert.equal(f.w.__pongDomSwapLastFailure.readyState,0);
 }
});
test('older APK duplicate MP4 MIME is accepted but mixed HTML is rejected',async()=>{
 const f=fixture({type:'video/mp4, video/mp4'});f.w.__pongDomSwapPrepare('/one','one');await settled();
 assert.equal(f.w.__pongDomSwapWarm.transport.bytes,8);
 const bad=fixture({type:'video/mp4, text/html'});bad.w.__pongDomSwapPrepare('/one','one');await settled();
 assert.equal(bad.w.__pongDomSwapWarm,null);
});
test('finite valid response waits for metadata then ends, not before demuxer initialization',async()=>{
 const f=fixture({eof:true});f.w.__pongDomSwapPrepare('/one','one');await f.open(0);await settled();
 assert.equal(f.sources[0].readyState,'open');assert.ok(f.w.__pongDomSwapWarm);
 f.elements[0].readyState=1;f.elements[0].events.loadedmetadata();assert.equal(f.sources[0].readyState,'ended');
});
test('native internal swap route errors never fall through to TikTok',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const start=java.indexOf('String upstream = integratedSwapStreams.get');
 const end=java.indexOf('return super.shouldInterceptRequest(view, request)',start);
 assert.ok(start>=0&&end>start,'native swap route must exist');
 const route=java.slice(start,end);
 const failure=route.match(/\} catch \(Exception ignored\) \{([\s\S]*?)\n {10}\}/)?.[1];
 assert.ok(failure,'native swap failure handler must exist');
 assert.doesNotMatch(route,/return null/);
 assert.match(failure,/return tikTokSwapTransportError\(502\)/);
 assert.match(route,/return tikTokSwapTransportError\(410\)/);
});
test('clearing the active stream on swipe preserves only the single next reader',()=>{
 const f=fixture();f.w.__pongDomSwapAttach('/one','one',0);f.w.__pongDomSwapPrepare('/two?attach=1','two');const next=f.w.__pongDomSwapWarm;
 f.w.__pongDomSwapClear();assert.equal(f.w.__pongDomSwap,null);assert.equal(f.w.__pongDomSwapWarm,next);assert.equal(next.abort.signal.aborted,false);
 f.w.__pongDomSwapWarmClear();assert.equal(next.abort.signal.aborted,true);
});
test('removing visible swap pixels immediately revokes only that session receipt',()=>{
 const f=fixture(),hidden=[];f.w.PongTikTokSwap.hidden=id=>hidden.push(id);
 f.w.__pongDomSwapAttach('/one','one',0);f.w.__pongDomSwapPrepare('/two','two');
 assert.equal(f.w.__pongDomSwapClear('', 'retired'),false);
 assert.deepEqual(hidden,[]);
 f.w.__pongDomSwapDepart();f.w.__pongDomSwapClear();f.w.__pongDomSwapWarmClear();
 assert.deepEqual(hidden,['one']);
});
test('local adoption requires exact video identity but retains an undecoded reader',()=>{
 const f=fixture();f.w.__pongDomSwapPrepare('/two?attach=1','two','https://www.tiktok.com/@test/video/2');
 const next=f.w.__pongDomSwapWarm;next.overlay.readyState=1;
 assert.equal(f.w.__pongDomSwapObserveVideo('https://www.tiktok.com/@test/video/1',f.original),false);
 assert.equal(f.w.__pongDomSwapObserveVideo(next.pageUrl,f.original),true);
 assert.equal(f.w.__pongDomSwap,next);
 assert.equal(next.visible,false);
 f.w.__pongDomSwapPrepare('/three?attach=1','three','https://www.tiktok.com/@test/video/3');
 assert.equal(next.abort.signal.aborted,false);
 assert.equal(f.w.__pongDomSwapWarm.sessionId,'three');
 assert.equal(f.w.__pongDomSwapClear(next.pageUrl),false);
 assert.equal(next.abort.signal.aborted,false);
 f.w.__pongDomSwapClear('https://www.tiktok.com/@test/video/3');
 assert.equal(next.abort.signal.aborted,true);
});
test('queued native attach and clear cannot retire a locally adopted newer post',()=>{
 const f=fixture(),old='https://www.tiktok.com/@test/video/1',next='https://www.tiktok.com/@test/video/2';
 f.w.__pongDomSwapObserveVideo(old,f.original);
 f.w.__pongDomSwapAttach('/one','one',0,null,old);
 f.w.__pongDomSwapPrepare('/two?attach=1','two',next);
 f.w.__pongDomSwapObserveVideo(next,f.original);
 const adopted=f.w.__pongDomSwap;
 assert.equal(adopted.sessionId,'two');
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,old),false);
 assert.equal(f.w.__pongDomSwapClear('', 'one'),false);
 assert.equal(f.w.__pongDomSwap,adopted);assert.equal(adopted.abort.signal.aborted,false);
 assert.equal(f.w.__pongDomSwapAttach('/two','two',0,null,next),true);
 f.w.__pongDomSwapObserveVideo('',null);
 assert.equal(f.w.__pongDomSwap,null);assert.equal(adopted.abort.signal.aborted,true);
 assert.equal(f.w.__pongDomSwapAttach('/two','two',0,null,next),false);
});
test('a reused original on a new post retires outgoing pixels even without a warm replacement',()=>{
 const f=fixture(),old='https://www.tiktok.com/@test/video/1',next='https://www.tiktok.com/@test/video/2',hidden=[];
 f.w.PongTikTokSwap.hidden=id=>hidden.push(id);
 f.w.__pongDomSwapObserveVideo(old,f.original);
 f.w.__pongDomSwapAttach('/one','one',0,null,old);
 const retired=f.w.__pongDomSwap;retired.visible=true;f.original.style.opacity='0';
 assert.equal(f.w.__pongDomSwapObserveVideo(next,f.original),false);
 assert.equal(f.w.__pongDomSwap,null);assert.equal(retired.abort.signal.aborted,true);
 assert.equal(f.original.style.opacity,'');assert.deepEqual(hidden,['one']);
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,old),false);
 assert.equal(f.w.__pongDomSwapAttach('/two','two',0,null,next),true);
});
test('a same-post DOM replacement cannot leave an overlay attached to its retired element',()=>{
 const f=fixture(),page='https://www.tiktok.com/@test/video/1';
 f.w.__pongDomSwapObserveVideo(page,f.original);f.w.__pongDomSwapAttach('/one','one',0,null,page);
 const prior=f.w.__pongDomSwap,replacement={...f.original,style:{},dataset:{}};
 f.w.__pongDomSwapObserveVideo(page,replacement);
 assert.equal(prior.abort.signal.aborted,true);assert.equal(f.w.__pongDomSwap,null);
 assert.equal(f.w.__pongDomSwapAttach('/one','one',0,null,page),true);
 assert.equal(f.w.__pongDomSwap.original,replacement);
});
