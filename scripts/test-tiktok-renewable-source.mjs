import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=html.slice(html.indexOf('function pongFaceSwapPlayableSource('),html.indexOf('const pongSourceDurationByUrl'));
const page='https://www.tiktok.com/@fixture/video/1234567890123456789';
const stable='http://127.0.0.1:8787/video-cache/stream?url='+encodeURIComponent(page)+'&profile=tiktok';
function fixture(external=true){
 const wrapper={dataset:{serverCachePlaybackSrc:'http://127.0.0.1:8787/video-cache/media/expired',
  originalVideoUrl:page,...(external?{pongExternalPlaybackAuthority:'true'}:{})}};
 const video={currentTime:2,src:'',currentSrc:''};
 const context={URL,location:{href:'http://127.0.0.1:8787/pong'},
  pongTikTokWrapperUrl:()=>page,pongTikTokLivePlaybackUrl:value=>value===page?stable:'',
  pongFaceSwapAlternateSources:()=>[]};
 vm.runInNewContext(fn,context);return {wrapper,video,context,get:()=>context.pongFaceSwapPlayableSource(wrapper,video)};
}
test('external TikTok never uses an expired cache ID as its new session source',()=>{
 const f=fixture();assert.equal(f.get().source,stable);assert.equal(f.get().startSeconds,2);
 assert.equal(f.get().original,null);assert.equal(f.get().sourceUrls.length,0);
});
test('retry/seek renews a saved source while preserving timeline and original metadata',()=>{
 const f=fixture();const original={source:f.wrapper.dataset.serverCachePlaybackSrc,startSeconds:4,
  fullDuration:20,muted:true,wasPlaying:true};f.video.__pongSwapOriginal=original;
 const r=f.get();assert.equal(r.source,stable);assert.equal(r.startSeconds,6);
 assert.equal(r.original.source,stable);assert.equal(r.original.fullDuration,20);
 assert.equal(r.original.wasPlaying,true);assert.equal(original.source,f.wrapper.dataset.serverCachePlaybackSrc);
});
test('preloaded identity stays on its own start time and is not mutated',()=>{
 const f=fixture();f.video.__pongSwapPreloadedOriginal={source:f.wrapper.dataset.serverCachePlaybackSrc,startSeconds:.4,fullDuration:20};
 const r=f.get();assert.equal(r.source,stable);assert.equal(r.startSeconds,.4);
 assert.equal(r.original.fullDuration,20);assert.notEqual(r.original,f.video.__pongSwapPreloadedOriginal);
});
test('ordinary Recall keeps its existing cache selection and original identity',()=>{
 const f=fixture(false);assert.equal(f.get().source,f.wrapper.dataset.serverCachePlaybackSrc);
 const original={source:'https://fixture.invalid/video.mp4',startSeconds:3};f.video.__pongSwapOriginal=original;
 assert.equal(f.get().source,original.source);assert.equal(f.get().startSeconds,5);assert.equal(f.get().original,original);
});
test('unknown TikTok page or missing cache endpoint does not fabricate a new source',()=>{
 const f=fixture();f.context.pongTikTokLivePlaybackUrl=()=>'';
 assert.equal(f.get().source,f.wrapper.dataset.serverCachePlaybackSrc);
 delete f.wrapper.dataset.serverCachePlaybackSrc;delete f.wrapper.dataset.originalVideoUrl;
 assert.equal(f.get(),null);
});
