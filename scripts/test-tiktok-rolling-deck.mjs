import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const code=html.slice(html.indexOf('function syncPongTikTokRollingDeck('),html.indexOf('window.PongTikTokLiveFeed ='));
test('rolling feed preserves its active owner and bounds descriptors across sixty posts',()=>{
 const url=i=>`https://www.tiktok.com/@fixture/video/${i}`,wrappers=new Map();let activeIndex=0,removed=0;
 const add=index=>wrappers.set(index,{dataset:{index:String(index)},remove(){wrappers.delete(index)}});add(0);
 const context={videoMetadata:[{source:'tiktok-live',originalVideoUrl:url(0)}],videoUrls:['cache0'],allVideoUrls:['cache0'],allVideoMetadata:[],
  pongCanonicalTikTokVideoPage:x=>x,pongTikTokLivePlaybackUrl:x=>'cache:'+x,pongFaceSwapCurrentWrapper:()=>wrappers.get(activeIndex),
  getDeckWrapper:i=>wrappers.get(i),pongFaceSwapState:{prefetches:new Map()},stopPongFaceSwapPrefetch(){},
  stopPongFaceSwapForWrapper:w=>{assert.notEqual(w,wrappers.get(activeIndex));removed++},detachPongVideosIn(){},
  createVideoElements:({appendIndexes})=>appendIndexes.forEach(add)};
 vm.runInNewContext(code,context);
 for(let i=0;i<60;i++){
  const active=wrappers.get(activeIndex);
  context.syncPongTikTokRollingDeck([url(i),url(i+1),url(i+2)]);
  assert.equal(wrappers.get(activeIndex),active);
  assert.ok(context.videoMetadata.length<=9);assert.ok(wrappers.size<=9);
  activeIndex=context.videoMetadata.findIndex(m=>m.originalVideoUrl===url(i+1));assert.ok(activeIndex>=0);
 }
 assert.ok(removed>40);
 const snapshot=context.videoMetadata.length;context.syncPongTikTokRollingDeck([url(60),url(61)]);assert.equal(context.videoMetadata.length,snapshot);
});
test('rolling handoff cannot modify an ordinary Pong deck',()=>{
 const context={videoMetadata:[{source:'recall'}]};vm.runInNewContext(code,context);
 assert.equal(context.syncPongTikTokRollingDeck([]),false);
});
test('TikTok descriptors do not open duplicate hidden media decoders',()=>{
 const attach=html.slice(html.indexOf('function attachPongFaceSwapPrefetch('),html.indexOf('function attachPongFaceSwapPrefetch(')+250);
 assert.match(attach,/pongExternalPlaybackAuthority === 'true'\) return false/);
 assert.match(html,/const shouldAttachInitially = !appendOnly && !externalTikTok/);
 assert.match(html,/const attachRequested = jobIndex === 0 && !isTikTokDeck/);
});
test('all inline page scripts remain syntactically valid',()=>{
 for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
});
