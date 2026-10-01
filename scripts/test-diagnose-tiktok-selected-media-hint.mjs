import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Script, runInNewContext } from 'node:vm';
import {
  boundedSelectedRangeProbe,buildSelectedSnapshotExpression,planSelectedMediaProbes,
  sameSelectedSnapshot,sanitizedSelectedMetadata,tiktokMediaHostClass
} from './lib/tiktok-selected-hint-probe.mjs';

const page='https://www.tiktok.com/@valid.user/video/7669969941596032287';
const cdn='https://v16.tiktokcdn.com/video/object?token=SECRET';
const playing='https://v16.tiktokcdn.com/video/other?token=SECRET2';
const snapshot={id:'7669969941596032287',pageUrl:page,locationHref:'https://www.tiktok.com/foryou',
  currentSrc:playing,currentSrcBound:true,width:720,height:1280,readyState:4,
  hint:{pageUrl:page,videoId:'7669969941596032287',codec:'h264',width:1080,height:1920,
    size:123456,urls:[cdn]}};

test('uses actual observer parser anchors and compiles without enabling hint flow',()=>{
  const source=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
  const expression=buildSelectedSnapshotExpression(source);
  new Script(expression);
  assert.match(expression,/reactVideo\(card,true\)/);
  assert.match(expression,/const postCard =/);
  assert.match(expression,/found\.url!==pageUrl/);
  assert.match(expression,/card\.contains\(video\)/);
  assert.doesNotMatch(expression,/__pongMediaHintTrial\s*=/);
  assert.throws(()=>buildSelectedSnapshotExpression('changed'),/anchors changed/);
});

test('actual parser binds a visible video to its own React post and rejects an ad',()=>{
  const source=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
  const expression=buildSelectedSnapshotExpression(source);
  const item={id:snapshot.id,author:'valid.user',video:{bitrateInfo:[{
    CodecType:'h264',Bitrate:1000,PlayAddr:{UrlList:[cdn,playing],Width:1080,Height:1920,DataSize:123456}
  }]}};
  const card={isConnected:true,__reactProps$test:{children:{item}},
    contains:node=>node===video,querySelector:()=>null,closest:()=>null,getAttribute:()=>null};
  const video={isConnected:true,paused:false,currentSrc:playing,videoWidth:720,videoHeight:1280,
    readyState:4,getBoundingClientRect:()=>({left:0,top:0,right:1000,bottom:1000}),
    closest:selector=>selector.includes('recommend-list-item-container')?card:null,querySelector:()=>null};
  const document={hidden:false,querySelectorAll:selector=>selector.startsWith('video:')?[video]:[]};
  const context={document,location:{href:snapshot.locationHref},URL,WeakMap,WeakSet,
    innerWidth:1000,innerHeight:1000,getComputedStyle:()=>({display:'block'})};
  const selected=runInNewContext(expression,context);
  assert.equal(selected.id,snapshot.id);
  assert.equal(selected.hint.videoId,snapshot.id);
  assert.equal(selected.currentSrc,playing);
  assert.equal(selected.currentSrcBound,true);
  item.isAd=true;
  assert.equal(runInNewContext(expression,context),null);
});

test('only probes selected matching highest and distinct current CDN URL',()=>{
  assert.deepEqual(planSelectedMediaProbes(snapshot).map(x=>x.kind),
    ['advertised-highest-h264','current-playing']);
  assert.equal(planSelectedMediaProbes({...snapshot,currentSrc:cdn}).length,1);
  assert.deepEqual(planSelectedMediaProbes({...snapshot,currentSrcBound:false}).map(x=>x.kind),
    ['advertised-highest-h264']);
  assert.deepEqual(planSelectedMediaProbes({...snapshot,currentSrc:'blob:https://www.tiktok.com/id'}).map(x=>x.kind),
    ['advertised-highest-h264']);
  assert.deepEqual(planSelectedMediaProbes({...snapshot,hint:{...snapshot.hint,videoId:'9999999999999999999'}})
    .map(x=>x.kind),['current-playing']);
  assert.deepEqual(planSelectedMediaProbes({...snapshot,id:'9999999999999999999'}),[]);
  assert.equal(tiktokMediaHostClass(cdn),'tiktokcdn');
  assert.equal(tiktokMediaHostClass('https://127.0.0.1/video/x'),'rejected');
});

test('selection change and output never disclose URL, token, or post ID',()=>{
  assert.equal(sameSelectedSnapshot(snapshot,{...snapshot}),true);
  for(const changed of [{id:'9999999999999999999'},{pageUrl:page+'x'},
    {locationHref:page},{currentSrc:cdn}]) {
    assert.equal(sameSelectedSnapshot(snapshot,{...snapshot,...changed}),false);
  }
  const output=JSON.stringify(sanitizedSelectedMetadata(snapshot));
  assert.doesNotMatch(output,/SECRET|valid\.user|7669969941596032287|https:/);
  assert.match(output,/1080/);
});

function fakeRequest({status=206,headers={},chunks=[Buffer.alloc(1024)],hang=false}={}) {
  const calls=[];
  const requestImpl=(url,options,onResponse)=>{
    calls.push({url,options});
    const request=new EventEmitter();
    request.end=()=>queueMicrotask(()=>{
      if(hang)return;
      const response=new EventEmitter();response.statusCode=status;
      response.headers={'content-type':'video/mp4','content-range':'bytes 0-1023/123456',...headers};
      onResponse(response);
      for(const chunk of chunks)response.emit('data',chunk);
      response.emit('end');
    });
    request.destroy=()=>{request.destroyed=true};
    return request;
  };
  return {calls,requestImpl};
}

test('range probe pins public DNS, caps body, and never forwards credentials',async()=>{
  const fake=fakeRequest({chunks:[Buffer.alloc(900),Buffer.alloc(200)]});
  const result=await boundedSelectedRangeProbe(cdn,{expectedSize:123456,
    lookupImpl:async()=>[{address:'8.8.8.8',family:4}],requestImpl:fake.requestImpl});
  assert.equal(result.httpStatus,206);
  assert.equal(result.byteCount,1100);
  assert.equal(result.rangeSatisfied,true);
  assert.equal(result.matchesDeclaredSize,true);
  assert.equal(fake.calls[0].options.headers.range,'bytes=0-1023');
  assert.equal(Object.keys(fake.calls[0].options.headers).some(k=>/cookie|authorization/i.test(k)),false);
  assert.equal(fake.calls[0].options.lookup('unused',{},()=>{}),undefined);
  const large=fakeRequest({status:200,chunks:[Buffer.alloc(100000)]});
  const capped=await boundedSelectedRangeProbe(cdn,{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],
    requestImpl:large.requestImpl});
  assert.equal(capped.byteCount,4096);
  assert.equal(capped.rangeSatisfied,false);
});

test('private DNS and redirects cannot be followed',async()=>{
  const fake=fakeRequest();
  const rejected=await boundedSelectedRangeProbe(cdn,{lookupImpl:async()=>[{address:'127.0.0.1',family:4}],
    requestImpl:fake.requestImpl});
  assert.equal(rejected.outcome,'dns-rejected');
  assert.equal(fake.calls.length,0);
  const redirect=fakeRequest({status:302,headers:{location:'http://127.0.0.1/private'}});
  const result=await boundedSelectedRangeProbe(cdn,{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],
    requestImpl:redirect.requestImpl});
  assert.equal(result.httpStatus,302);
  assert.equal(redirect.calls.length,1);
  assert.equal(JSON.stringify(result).includes('127.0.0.1'),false);
});
