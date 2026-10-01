import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineMediaIdentityHash,resolveInlineVideoIdentityFromHtml,canonicalInlineMediaUrl} from './inline-video-identity.mjs';

const page='https://player.example.org/examples.html';
const html=`<video data-duration="42" poster="/main.jpg">
  <source src="/clips/main-720.mp4?token=abc&amp;v=1" type="video/mp4" data-width="1280" data-height="720" data-quality="720p">
  <source src="/clips/main-1080.mp4?token=abc&amp;v=1" type="video/mp4" data-width="1920" data-height="1080" data-quality="1080p">
</video><video><source src="/clips/related.mp4" type="video/mp4"></video>`;

test('selected inline video returns only its own explicit sources and metadata',()=>{
  const hash=inlineMediaIdentityHash('https://player.example.org/clips/main-720.mp4?token=abc&v=1',page);
  const result=resolveInlineVideoIdentityFromHtml({html,pageUrl:page,logicalVideoId:'inline-video-1',mediaIdentityHash:hash});
  assert.equal(result.identityEvidence,'selected-inline-video-source');
  assert.deepEqual(result.videoUrls,[
    'https://player.example.org/clips/main-720.mp4?token=abc&v=1',
    'https://player.example.org/clips/main-1080.mp4?token=abc&v=1']);
  assert.deepEqual(result.sources[1],{url:result.videoUrls[1],width:1920,height:1080,label:'1080p',type:'video/mp4',selectedInline:true});
  assert.equal(result.durationSeconds,42);
  assert.equal(result.matchedVideoIndex,1);
});

test('unique source hash can survive DOM order change without using first-video fallback',()=>{
  const hash=inlineMediaIdentityHash('/clips/related.mp4',page);
  const result=resolveInlineVideoIdentityFromHtml({html,pageUrl:page,logicalVideoId:'inline-video-1',mediaIdentityHash:hash});
  assert.equal(result.reordered,true);
  assert.equal(result.matchedVideoIndex,2);
  assert.deepEqual(result.videoUrls,['https://player.example.org/clips/related.mp4']);
  assert.equal(result.durationSeconds,0);
});

test('missing hash, wrong media, repeated ambiguous source, and invalid IDs fail closed',()=>{
  const inputs=[
    {logicalVideoId:'inline-video-1',mediaIdentityHash:''},
    {logicalVideoId:'inline-video-1',mediaIdentityHash:inlineMediaIdentityHash('/clips/other.mp4',page)},
    {logicalVideoId:'inline-video-0',mediaIdentityHash:inlineMediaIdentityHash('/clips/related.mp4',page)}
  ];
  for(const input of inputs)assert.equal(resolveInlineVideoIdentityFromHtml({html,pageUrl:page,...input}),null);
  const repeated='<video src="/same.mp4"></video><video src="/same.mp4"></video>';
  assert.equal(resolveInlineVideoIdentityFromHtml({html:repeated,pageUrl:page,logicalVideoId:'inline-video-3',
    mediaIdentityHash:inlineMediaIdentityHash('/same.mp4',page)}),null);
});

test('unsafe or nonmedia URLs are never identity evidence',()=>{
  for(const url of ['http://127.0.0.1/a.mp4','http://192.168.1.2/a.mp4','http://[::1]/a.mp4',
    'http://helper.local/a.mp4','file:///tmp/a.mp4','https://player.example.org/picture.jpg']) {
    assert.equal(canonicalInlineMediaUrl(url,page),'');
    assert.equal(inlineMediaIdentityHash(url,page),'');
  }
});

test('selected trailer source is valid but commented-out alternatives are not',()=>{
  const marked=`<video><!-- <source src="/not-rendered/trailer.mp4"> -->
    <source src="/clips/trailer.mp4" type="video/mp4"></video>`;
  const result=resolveInlineVideoIdentityFromHtml({html:marked,pageUrl:page,
    logicalVideoId:'inline-video-1',mediaIdentityHash:inlineMediaIdentityHash('/clips/trailer.mp4',page)});
  assert.deepEqual(result?.videoUrls,['https://player.example.org/clips/trailer.mp4']);
  assert.equal(result?.sources[0].selectedInline,true);
  assert.equal(resolveInlineVideoIdentityFromHtml({html:marked,pageUrl:page,
    logicalVideoId:'inline-video-1',mediaIdentityHash:inlineMediaIdentityHash('/not-rendered/trailer.mp4',page)}),null);
});
