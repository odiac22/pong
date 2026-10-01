import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecallVideoId,recallMediaIdentity,mergeRecallCapturedVideos} from './recall-media-identity.mjs';
const pageUrl='https://fixture.invalid/news/studio-feature';
test('two videos from one article retain individual identity, title and source',()=>{
 const first={pageUrl,logicalVideoId:'inline-video-1',title:'First',videoUrl:'https://media.invalid/one.mp4'};
 const second={pageUrl,logicalVideoId:'inline-video-2',title:'Second',videoUrl:'https://media.invalid/two.mp4'};
 assert.deepEqual(mergeRecallCapturedVideos([first],[second]),[first,second]);
});
test('refreshed rendition replaces only its original player and preserves fallback',()=>{
 const first={pageUrl,logicalVideoId:'inline-video-1',videoUrl:'low',browserRelayUrl:'relay'};
 const second={pageUrl,logicalVideoId:'inline-video-2',videoUrl:'other'};
 const result=mergeRecallCapturedVideos([first,second],[{pageUrl,logicalVideoId:'inline-video-1',videoUrl:'high'}]);
 assert.equal(result.length,2);assert.equal(result[0].videoUrl,'high');assert.equal(result[0].browserRelayUrl,'relay');assert.deepEqual(result[1],second);
 assert.equal(first.videoUrl,'low');
});
test('old clients retain the existing one-video-per-page merge contract',()=>{
 const result=mergeRecallCapturedVideos([{pageUrl,videoUrl:'old'}],[{pageUrl,videoUrl:'new'}]);
 assert.equal(result.length,1);assert.equal(result[0].videoUrl,'new');
});
test('malformed and oversized identities cannot collide with a different page',()=>{
 for(const value of ['bad\nidentity','x'.repeat(101),{},'http://x'])assert.equal(normalizeRecallVideoId(value),'');
 assert.notEqual(recallMediaIdentity(pageUrl,'inline-video-1'),recallMediaIdentity(pageUrl+'/other','inline-video-1'));
});
