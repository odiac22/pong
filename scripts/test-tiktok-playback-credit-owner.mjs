import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const begin=html.indexOf('  // The authenticated TikTok WebView');
const end=html.indexOf('  // This is a complete-file warm request',begin);
assert.ok(begin>0&&end>begin);
const block=html.slice(begin,end);
function fixture(wrapperPage='old',current='new'){
  const requests=[];
  let remembered=0;
  const wrapper={dataset:{pongFaceSwapSessionId:'session-a',pongFaceSwapActive:'true',
    pongExternalPlaybackAuthority:'true',pongFaceSwapGeneration:'1',
    pongFaceSwapClientEpoch:'epoch-a'},
    querySelector:()=>({__pongSwapOriginal:{startSeconds:0}}),page:wrapperPage};
  const state={current,activeVideo:true,timelineSeconds:3,requestedStartSeconds:0,
    paused:false,lastPlaybackReportAt:Date.now(),lastPlaybackReportPaused:false,
    lastPlaybackReportSessionId:'session-a'};
  const context=vm.createContext({Date,JSON,Math,Number,String,Map,encodeURIComponent,
    pongTikTokLiveState:state,pongFaceSwapCurrentWrapper:()=>wrapper,
    pongFaceSwapState:{clientEpoch:'epoch-a'},pongTikTokPlaybackSequenceBySession:new Map(),
    pongTikTokPlaybackSequence:0,
    pongTikTokWrapperUrl:w=>w.page,pongFaceSwapBackgroundFetch:(url,options)=>{
      requests.push({url,...JSON.parse(options.body)});
      return Promise.resolve({ok:true,status:200,json:async()=>({session:{}})});
    },rememberPongSwapTransformation:()=>{remembered++},handlePongFaceSwapTerminalFailure:()=>{}});
  const helperStart=html.indexOf('function pongTikTokPlaybackCreditPayload(');
  const helperEnd=html.indexOf('function pongCanonicalTikTokVideoPage(',helperStart);
  vm.runInContext(html.slice(helperStart,helperEnd),context);
  return {requests,wrapper,state,remembered:()=>remembered,run:()=>vm.runInContext(block,context)};
}
test('new post clock pauses outgoing external producer once instead of refreshing it',()=>{
  const f=fixture();f.run();f.run();
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].paused,true);
  assert.equal(f.requests[0].positionSeconds,0);
  assert.equal(f.requests[0].playbackSequence,1);
  assert.equal(f.requests[0].clientEpoch,'epoch-a');
  assert.equal(f.state.lastPlaybackReportSessionId,'session-a');
});
test('new current session receives its own credit immediately despite global throttle',()=>{
  const f=fixture('new');f.wrapper.dataset.pongFaceSwapSessionId='session-b';f.run();
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].paused,false);
  assert.equal(f.requests[0].positionSeconds,3);
  assert.equal(f.requests[0].playbackSequence,1);
  assert.equal(f.state.lastPlaybackReportSessionId,'session-b');
});
test('same current session keeps the 500ms throttle',()=>{
  const f=fixture('new');f.run();assert.equal(f.requests.length,0);
  f.state.lastPlaybackReportAt=0;f.run();assert.equal(f.requests.length,1);
});
test('returning to a previously paused session allows a future departure pause again',()=>{
  const f=fixture();f.run();f.wrapper.page='new';f.run();
  f.wrapper.page='old';f.run();assert.deepEqual(f.requests.map(x=>x.paused),[true,false,true]);
});
test('non-TikTok wrapper never receives a TikTok playback clock',()=>{
  const f=fixture('new');f.wrapper.dataset.pongExternalPlaybackAuthority='false';
  f.state.lastPlaybackReportAt=0;f.run();assert.equal(f.requests.length,0);
});
test('late heartbeat response for a departed post cannot update transformed evidence',async()=>{
  const f=fixture('new');f.state.lastPlaybackReportAt=0;f.run();f.state.current='next';
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.remembered(),0);
});
test('owned current heartbeat response still updates transformed evidence',async()=>{
  const f=fixture('new');f.state.lastPlaybackReportAt=0;f.run();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.remembered(),1);
});
test('older same-session heartbeat response cannot roll back newer evidence',async()=>{
  const f=fixture('new');f.state.lastPlaybackReportAt=0;f.run();
  f.state.lastPlaybackReportAt=0;f.run();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.requests.map(r=>r.playbackSequence),[1,2]);
  assert.equal(f.remembered(),1);
});
test('server sequence makes reordered heartbeat and departure pause last-intent-wins',()=>{
  const f=fixture('old','old');f.state.lastPlaybackReportAt=0;f.run();
  f.state.current='new';f.run();
  assert.deepEqual(f.requests.map(r=>r.playbackSequence),[1,2]);
  let last=0,paused=null;
  for(const request of [f.requests[1],f.requests[0]]){
    if(request.playbackSequence>last){last=request.playbackSequence;paused=request.paused;}
  }
  assert.equal(paused,true);
});
test('fast A to B to A resume outranks a delayed departure pause',()=>{
  const f=fixture('old','old');f.state.lastPlaybackReportAt=0;f.run();
  f.state.current='new';f.run();
  f.state.current='old';f.run();
  assert.deepEqual(f.requests.map(r=>r.playbackSequence),[1,2,3]);
  let last=0,paused=null;
  for(const request of [f.requests[2],f.requests[1],f.requests[0]]){
    if(request.playbackSequence>last){last=request.playbackSequence;paused=request.paused;}
  }
  assert.equal(paused,false);
});
test('revisited live session retains order after response-cache eviction by 128 other IDs',()=>{
  const f=fixture('old','old');f.state.lastPlaybackReportAt=0;f.run();
  for(let index=0;index<130;index++){
    f.wrapper.dataset.pongFaceSwapSessionId=`session-${index}`;
    f.state.lastPlaybackReportAt=0;
    f.run();
  }
  f.wrapper.dataset.pongFaceSwapSessionId='session-a';
  f.state.lastPlaybackReportAt=0;f.run();
  assert.equal(f.requests.at(-1).playbackSequence,132);
  assert.equal(f.requests.at(-1).clientEpoch,'epoch-a');
});
