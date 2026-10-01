import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const code=html.slice(html.indexOf('function pongTikTokIdlePhotoPrefetchTarget('),
  html.indexOf('function setPongFaceSwapPersistentEnabled('));
const page=i=>'https://www.tiktok.com/@fixture/video/'+i;
function fixture(){
  const wrappers=[0,1,2].map(i=>({isConnected:true,dataset:{index:String(i)},querySelector:()=>null}));
  const jobs=[],prepared=[];
  let pending,creates=0,clears=0;
  const state={enabled:true,selectedFaceId:'face',prefetchReadyFaceId:'',prefetchGeneration:0,prefetches:new Map()};
  const live={activeVideo:false,postKind:'photo',current:page(0),next:page(1),urls:[page(1),page(2)]};
  const c={pongRemoteMode:false,pongFaceSwapState:state,pongTikTokLiveState:live,
    PONG_FACE_SWAP_PHASES:{PLAYING:'playing'},PONG_FACE_SWAP_PREFETCH_COUNT:2,PONG_FACE_SWAP_PAPERCLIP_PREFETCH_COUNT:1,
    videoMetadata:wrappers.map((_,i)=>({source:'tiktok-live',originalVideoUrl:page(i)})),
    document:{documentElement:{classList:{contains:()=>true}}},
    pongCanonicalTikTokVideoPage:x=>/^https:\/\/www\.tiktok\.com\/@fixture\/video\/\d+$/.test(x)?x:'',
    getDeckWrappers:()=>wrappers,pongFaceSwapCurrentWrapper:()=>wrappers[0],
    pongTikTokWrapperUrl:w=>c.videoMetadata[Number(w.dataset.index)]?.originalVideoUrl||'',
    clearTimeout(){pending=null},setTimeout(f){pending=f;return 1},
    clearPongFaceSwapPrefetches(){clears++},
    ensureDeckOrder(){},pongFaceSwapSchedulerProfile:()=>({nearSeconds:2,farSeconds:2}),
    getPongFaceSwapNextPaperclipSources:()=>[],pongFaceSwapPlayableSource:w=>({source:'source'+w.dataset.index}),
    pongFaceSwapSourceKey:(face,source)=>face+source,stopPongFaceSwapPrefetch(){},
    createPongFaceSwapPrefetch:async(w,face,generation,options)=>{
      creates++;jobs.push({w,face,generation,options});await c.afterCreate?.();
      return {sessionId:'s'+w.dataset.index,streamUrl:'/stream',deleted:false};
    },
    PongNativeSwap:{prepare:raw=>prepared.push(JSON.parse(raw))},
    location:{origin:'http://localhost'},URL};
  vm.runInNewContext(code,c);
  return {c,live,state,wrappers,jobs,prepared,creates:()=>creates,clears:()=>clears,
    schedule:()=>c.schedulePongFaceSwapPrefetch(0),scheduled:()=>!!pending,
    flush:async()=>{const fn=pending;pending=null;await fn?.()}};
}
test('confirmed photo prepares exact next and bounded second without claiming foreground readiness',async()=>{
  const f=fixture();f.schedule();assert.equal(f.scheduled(),true);await f.flush();
  assert.deepEqual(f.jobs.map(x=>x.w.dataset.index),['1','2']);
  assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].requestedUrl,page(1));
  assert.equal(f.state.prefetchReadyFaceId,'');
  for(const j of f.jobs)assert.deepEqual({...j.options},{attachRequested:false,prebufferSeconds:1,navigationClass:'prefetch'});
});
for(const [name,mutate] of [
  ['unknown transition',f=>f.live.postKind='unknown'],
  ['visible video',f=>f.live.activeVideo=true],
  ['overlay closed',f=>f.c.document.documentElement.classList.contains=()=>false],
  ['ordinary Recall',f=>f.c.videoMetadata[0].source='recall'],
  ['empty deck',f=>f.c.videoMetadata=[]],
  ['unvalidated next',f=>f.live.next='https://bad.test/video/1'],
  ['stale outgoing next',f=>f.live.next=page(0)],
  ['detached next',f=>f.wrappers[1].isConnected=false],
  ['next not in deck',f=>f.live.next=page(99)],
  ['priming',f=>f.state.priming=true],
  ['seek pending',f=>f.state.pendingSeekTarget={}],
  ['scrub suspended',f=>f.wrappers[0].dataset.pongFaceSwapScrubSuspendedSessionId='old'],
  ['swap off',f=>f.state.enabled=false]
])test(name+' does not admit photo GPU work',async()=>{const f=fixture();mutate(f);f.schedule();await f.flush();assert.equal(f.creates(),0)});
for(const [name,mutate] of [
  ['video arrived',f=>{f.live.activeVideo=true;f.live.postKind='video'}],
  ['unknown transition',f=>f.live.postKind='unknown'],
  ['new next destination',f=>f.live.next=page(2)],
  ['detached next',f=>f.wrappers[1].isConnected=false],
  ['priming began',f=>f.state.priming=true],
  ['seek began',f=>f.state.pendingSeekTarget={}],
  ['new scheduler generation',f=>f.state.prefetchGeneration++]
])test('queued photo callback revalidates '+name,async()=>{const f=fixture();f.schedule();mutate(f);await f.flush();assert.equal(f.creates(),0)});
test('video arrival during first POST prevents starting a farther speculative job',async()=>{
  const f=fixture();f.c.afterCreate=()=>{f.live.activeVideo=true;f.live.postKind='video'};
  f.schedule();await f.flush();assert.equal(f.creates(),1);
});
test('existing foreground-ready path does not require photo admission',async()=>{
  const f=fixture();f.live.activeVideo=true;f.live.postKind='video';f.state.prefetchReadyFaceId='face';
  f.schedule();await f.flush();assert.equal(f.creates(),2);
});
test('photo exception cannot launch a remembered Recall Paperclip source',async()=>{
  const f=fixture();f.c.getPongFaceSwapNextPaperclipSources=()=>[{source:'recall.mp4',globalIndex:22}];
  f.c.createPongFaceSwapPrefetchForSource=()=>{throw Error('Photo must not admit Recall work')};
  f.schedule();await f.flush();assert.equal(f.creates(),2);
});
test('removed farther URL is not launched after the immediate-next POST completes',async()=>{
  const f=fixture();f.c.afterCreate=()=>{f.live.urls=[page(1)]};
  f.schedule();await f.flush();assert.equal(f.creates(),1);
});
