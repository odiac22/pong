import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {normalizeRecallVideoId,recallMediaIdentity,mergeRecallCapturedVideos} from '../recall-media-identity.mjs';
const source=readFileSync(new URL('../local-ai-server.mjs',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('      const rawEntries = Array.isArray(payload?.entries)'),source.indexOf("      if (!videos.length && capturePhase === 'append')"));
async function ingest(entries){
 const context=vm.createContext({URL,normalizeRecallVideoId,recallMediaIdentity,
  payload:{entries,pageUrls:['https://fixture.invalid/news/example']},sourceUrl:'https://fixture.invalid/news/example',mode:'all',capturePhase:'append',browserRelayClientId:'',phoneConnectionOnly:false,reportedDurationSeconds:0,ignoreUnder30:true,
  publicMediaPageUrl:url=>new URL(url),authorizeGenericMediaUrl:url=>new URL(url),
  inspectRecallMediaSource:async()=>({playable:true,durationSeconds:45}),genericMediaResolutionCache:new Map()});
 return JSON.parse(JSON.stringify(await vm.runInContext('(async()=>{'+handler+';return videos;})()',context)));
}
test('production Recall handler carries separate identities through source grouping and incremental merge',async()=>{
 const pageUrl='https://fixture.invalid/news/example';
 const entries=[1,2].map(i=>({pageUrl,logicalVideoId:`inline-video-${i}`,title:`Clip ${i}`,durationSeconds:45,videoUrl:`https://media.invalid/${i}.mp4`}));
 const videos=await ingest(entries);
 assert.equal(videos.length,2);assert.deepEqual(videos.map(v=>v.title),['Clip 1','Clip 2']);
 const merged=mergeRecallCapturedVideos([],videos);
 assert.equal(merged.length,2);
 const replay=mergeRecallCapturedVideos(merged,await ingest([entries[1]]));
 assert.equal(replay.length,2);assert.deepEqual(replay.map(v=>[v.logicalVideoId,v.videoUrl,v.title]),merged.map(v=>[v.logicalVideoId,v.videoUrl,v.title]));
});
test('production Recall still groups alternate resolutions without duplicating a logical video',async()=>{
 const videos=await ingest([{pageUrl:'https://fixture.invalid/news/example',logicalVideoId:'inline-video-1',durationSeconds:45,
  videoUrl:'https://media.invalid/1080p.mp4',videoUrls:['https://media.invalid/1080p.mp4','https://media.invalid/720p.mp4']}]);
 assert.equal(videos.length,1);assert.equal(videos[0].videoUrls.length,2);
});
