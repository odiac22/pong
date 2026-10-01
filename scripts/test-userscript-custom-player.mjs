import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../universal-video-scraper.user.js',import.meta.url),'utf8');
const start=source.indexOf('  function collectSelectableTargets(');
const end=source.indexOf('\n  function targetElementVisible(',start);
assert.ok(start>0&&end>start);
const functionSource=source.slice(start,end);

test('visible custom player is the current watch page red-box target, ahead of related preview video',()=>{
  const page='https://stock.example/video/main-123/';
  const mux={tagName:'MUX-PLAYER',isConnected:true,getBoundingClientRect:()=>({width:900,height:500})};
  const cardVideo={tagName:'VIDEO',isConnected:true,getBoundingClientRect:()=>({width:220,height:125})};
  const document={
    querySelectorAll(selector){
      if(selector==='video')return [cardVideo];
      if(selector==='mux-player,video-js,.video-js,media-player')return [mux];
      return [];
    },querySelector(){return null;}
  };
  const context=vm.createContext({document,location:{href:page},
    canonicalWatchPageUrl:u=>u,independentVideoGroupsFromDoc:()=>[],
    embeddedPlayerPageUrls:()=>[],collectLogicalWatchPageTargets:()=>[{url:page,durationSeconds:45}],
    primaryMediaEntriesFromDoc:()=>[{videoUrl:'https://cdn.example/main-1080.mp4'}],
    targetElementVisible:()=>true,youtubeVideoId:()=>null,
    extractPageDurationSeconds:()=>45,absUrl:u=>u});
  vm.runInContext(functionSource,context);
  const result=context.collectSelectableTargets('all');
  assert.equal(result.length,1);
  assert.equal(result[0].url,page);
  assert.equal(result[0].kind,'player');
  assert.equal(result[0].element,mux);
});

test('visible Video.js class surface wins over hidden native decoder and related card',()=>{
  const page='https://watch.example.org/video/moon-update/';
  const related='https://watch.example.org/video/other/';
  const surface={tagName:'DIV',getBoundingClientRect:()=>({width:1066,height:815})};
  const hiddenVideo={tagName:'VIDEO',getBoundingClientRect:()=>({width:1066,height:815})};
  const card={tagName:'A',getBoundingClientRect:()=>({width:318,height:179}),contains:()=>false};
  const document={querySelectorAll(selector){
      if(selector==='video')return [hiddenVideo];
      if(selector==='mux-player,video-js,.video-js,media-player')return [surface];
      if(selector==='a[href],[role="link"][data-href],[data-video-url],[data-watch-url]')return [card];
      return [];
    },querySelector(){return null;}};
  const context=vm.createContext({document,location:{href:page},URL,
    canonicalWatchPageUrl:u=>u,independentVideoGroupsFromDoc:()=>[],
    embeddedPlayerPageUrls:()=>[],collectLogicalWatchPageTargets:()=>[
      {url:page,durationSeconds:620},{url:related,durationSeconds:800}],
    primaryMediaEntriesFromDoc:()=>[{videoUrl:'https://cdn.example.org/moon.m3u8'}],
    targetElementVisible:element=>element!==hiddenVideo,
    selectableLinkUrl:()=>related,videoLinkEvidence:()=> 'path',
    youtubeVideoId:()=>null,extractPageDurationSeconds:()=>620,absUrl:u=>u});
  vm.runInContext(functionSource,context);
  const result=context.collectSelectableTargets('all');
  assert.equal(result[0].url,page);
  assert.equal(result[0].element,surface);
  assert.equal(result[0].kind,'player');
  assert.equal(result[1].url,related);
});

test('a visible native trailer gets same-element identity without admitting page-wide previews',()=>{
  const page='https://demo.example.org/watch';
  const trailer='https://media.example.org/clips/trailer.mp4';
  const unrelated='https://media.example.org/other/trailer.mp4';
  const video={tagName:'VIDEO',clientWidth:420,clientHeight:240,isConnected:true,
    currentSrc:'',getClientRects:()=>[{}],getAttribute:()=>'',
    getBoundingClientRect:()=>({width:420,height:240}),
    querySelectorAll:selector=>selector==='source[src]'?[{getAttribute:()=>trailer}]:[]};
  const doc={documentElement:{innerHTML:`<script>const unrelated='${unrelated}'</script>`},
    querySelectorAll(selector){
      if(selector==='video')return [video];
      if(selector==='script')return [{textContent:''}];
      return [];
    }};
  const extraction=source.slice(source.indexOf('  function primaryMediaEntriesFromDoc('),source.indexOf('\n  // Enrich only identity-admitted renditions.'));
  const context=vm.createContext({document:{},location:{href:page},URL,
    primaryVideoEvidence:()=>null,extractPageDurationSeconds:()=>40,
    literalSourceRecordsFromText:()=>[{value:unrelated}],
    enrichRenditionQuality:(_doc,_url,entries)=>entries,
    absUrl:(value,base)=>value?new URL(value,base).href:'',
    VIDEO_EXT_RE:/\.(?:mp4|webm)(?:[?#]|$)/i});
  vm.runInContext(extraction,context);
  const entries=context.primaryMediaEntriesFromDoc(doc,page);
  assert.deepEqual(Array.from(entries,entry=>entry.videoUrl),[trailer]);

  const playerContext=vm.createContext({document:{querySelectorAll(selector){
      if(selector==='video')return [video];
      if(selector==='mux-player,video-js,media-player')return [];
      return [];
    },querySelector(){return null;}},location:{href:page},URL,
    canonicalWatchPageUrl:u=>u,
    independentVideoGroupsFromDoc:()=>[{logicalVideoId:'inline-video-1',durationSeconds:40,entries}],
    embeddedPlayerPageUrls:()=>[],collectLogicalWatchPageTargets:()=>[],
    primaryMediaEntriesFromDoc:()=>entries,targetElementVisible:()=>true,
    youtubeVideoId:()=>null,extractPageDurationSeconds:()=>40,absUrl:u=>u});
  vm.runInContext(functionSource,playerContext);
  const selected=playerContext.collectSelectableTargets('all')[0];
  assert.equal(selected.logicalVideoId,'inline-video-1');
  assert.equal(selected.element,video);
});
