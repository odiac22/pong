import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {primaryVideoEvidence} from './video-source-policy.mjs';
import {createMediaBrowserLimiter} from './media-browser-limiter.mjs';
import {extractGenericVideoUrlsFromHtml,extractGenericWatchPageUrlsFromHtml} from './media-page-resolver.mjs';
const ld=value=>`<script type="application/ld+json">${JSON.stringify(value)}</script>`;
test('uses authoritative video identity, never another visible recommendation',()=>{
 const html='<video src="https://cdn.test/videos/other/360p.mp4"></video>'+ld({'@type':'VideoObject',name:'Correct',contentUrl:'https://cdn.test/videos/asset-44/720p.mp4',duration:'P0Y0M0DT0H0M13S'})+'<script>{"url":"https://cdn.test/videos/asset-44/1080p.mp4"}</script>';
 const e=primaryVideoEvidence(html,'https://site.test/watch/correct');
 assert.equal(e.title,'Correct');assert.equal(e.durationSeconds,13);
 assert.deepEqual(e.videoUrls,['https://cdn.test/videos/asset-44/1080p.mp4','https://cdn.test/videos/asset-44/720p.mp4']);
 assert.deepEqual(extractGenericVideoUrlsFromHtml(html,'https://site.test/watch/correct'),e.videoUrls);
});
test('handles Unicode escaped URLs and ranks dimensions without mistaking FPS for resolution',()=>{
 const html='<script type="application/ld+json">'+JSON.stringify({'@type':'VideoObject',contentUrl:'https://cdn.test/video-files/8379044/a_2560_1440_25fps.mp4'}).replaceAll('/','\\u002F')+'</script> https://cdn.test/video-files/8379044/a_3840_2160_25fps.mp4';
 assert.match(primaryVideoEvidence(html,'https://site.test/video/a').videoUrls[0],/3840_2160/);
});
test('does not treat generic media directory as identity proof',()=>{
 const html=ld({'@type':'VideoObject',contentUrl:'https://cdn.test/assets/video/main.mp4'})+'<video src="https://cdn.test/assets/video/advertisement.mp4"></video>';
 assert.deepEqual(primaryVideoEvidence(html,'https://site.test/').videoUrls,['https://cdn.test/assets/video/main.mp4']);
});
test('selects matching graph identity rather than first recommendation',()=>{
 const html=ld({'@graph':[{'@type':'VideoObject',url:'https://site.test/watch/other',contentUrl:'https://cdn.test/other.mp4'},{'@type':'VideoObject',url:'https://site.test/watch/main',contentUrl:'https://cdn.test/main.mp4'}]});
 assert.deepEqual(primaryVideoEvidence(html,'https://site.test/watch/main').videoUrls,['https://cdn.test/main.mp4']);
 assert.equal(primaryVideoEvidence(html,'https://site.test/list'),null);
});
test('discovers nonstandard public video pages, excludes categories and foreign ads',()=>{
 const html='<a href="/free-stock-video/portrait/">category</a><a href="/free-stock-video/portrait-1234/">clip</a><a href="/talks/person_talk">talk</a><a href="https://ads.test/watch/ad">ad</a>';
 assert.deepEqual(extractGenericWatchPageUrlsFromHtml(html,'https://site.test/list'),['https://site.test/free-stock-video/portrait-1234/','https://site.test/talks/person_talk']);
});
test('standalone userscript contains the identical policy',()=>{
 const s=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 assert.ok(s.includes(primaryVideoEvidence.toString()));
});
test('Recall retains titles and does not retry failed browser captures on another network identity',()=>{
 const s=readFileSync(new URL('./local-ai-server.mjs',import.meta.url),'utf8');
 assert.match(s,/browserRelayClientId \|\| capturePhase === 'append'/);
 assert.ok(s.includes("title: identity?.title || titleByPageUrl.get(pageUrl) || ''"), 'Recall retains per-video title before falling back to page title');
 const ui=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 assert.match(ui,/title: String\(video\?\.title \|\| bundle\?\.title/);
});
test('browser ownership is bounded, releases once, and expires queued work',async()=>{
 const acquire=createMediaBrowserLimiter(1,20);
 const first=await acquire();
 await assert.rejects(acquire(),/deadline/);
 first();first();
 const second=await acquire();let granted=false;
 const waiting=acquire().then(release=>{granted=true;release();});
 assert.equal(granted,false);second();await waiting;assert.equal(granted,true);
});
test('Main and listing caches are isolated and nested listing expansion is disabled',()=>{
 const s=readFileSync(new URL('./local-ai-server.mjs',import.meta.url),'utf8');
 assert.match(s,/resolveGenericMediaPage\(watchUrl, \{ allowListing: false \}\)/);
 assert.match(s,/resolveGenericMediaPage\(pageUrl, \{ allowListing: mode !== 'main' \}\)/);
 assert.match(s,/genericMediaResolutionCache\.set\(cacheKey/);
});

test('large Range-ignoring media succeeds even when abort calls back synchronously',async()=>{
 const s=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('  function probeCapturedMediaUrl('),s.indexOf('  async function probeCapturedDuration('));
 const context=vm.createContext({setTimeout,clearTimeout,VIDEO_EXT_RE:/\.(mp4|ogv)$/,location:{href:'https://site.test/watch/1'},
  diagnosticRequest:()=>({}),finishDiagnosticRequest:()=>{},diagnosticStreamType:()=> 'mp4',diagnosticMime:v=>v,diagnosticNumber:v=>Number(v),
  responseHeaderValue:(headers,key)=>key==='content-type'?'video/mp4':'10000000',
  GM_xmlhttpRequest:options=>{setImmediate(()=>options.onreadystatechange({readyState:2,status:200,responseHeaders:''}));return {abort:()=>options.onabort()};}});
 assert.equal(await vm.runInContext(fn+';probeCapturedMediaUrl("https://cdn.test/main.mp4")',context),true);
});

test('empty HTTP 204 cannot masquerade as playable media',async()=>{
 const s=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('  function probeCapturedMediaUrl('),s.indexOf('  async function probeCapturedDuration('));
 const context=vm.createContext({setTimeout,clearTimeout,VIDEO_EXT_RE:/\.mp4$/,location:{href:'https://site.test/watch/1'},
  diagnosticRequest:()=>({}),finishDiagnosticRequest:()=>{},diagnosticStreamType:()=> 'mp4',diagnosticMime:v=>v,diagnosticNumber:v=>Number(v),
  responseHeaderValue:()=>'',GM_xmlhttpRequest:options=>{setImmediate(()=>options.onload({status:204}));return {};}});
 assert.equal(await vm.runInContext(fn+';probeCapturedMediaUrl("https://cdn.test/empty.mp4")',context),false);
});

test('empty resolutions are retried, successful Main resolutions stay cached',async()=>{
 const s=readFileSync(new URL('./local-ai-server.mjs',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('async function resolveGenericMediaPage('),s.indexOf('function gatewayMediaReferer('));
 for(const hasMedia of [false,true]){
  let fetches=0;
  const context=vm.createContext({URL,Date,genericMediaResolutionCache:new Map(),requireMediaVpn:async()=>{},
   publicMediaPageUrl:u=>new URL(u),authorizeGenericMediaUrl:u=>new URL(u),
   fetchPublicMediaPage:async url=>{fetches++;return {html:'',url};},
   extractGenericMediaPageMetadata:()=>({title:'Public fixture',videoUrls:hasMedia?['https://cdn.test/main.mp4']:[]}),
   extractGenericEmbedUrlsFromHtml:()=>[],extractGenericMediaWithYtDlp:async()=>[],
   extractGenericMediaWithBrowser:async()=>({videoUrls:[]}),looksLikeGenericHlsResource:()=>false});
  await vm.runInContext(fn+';resolveGenericMediaPage("https://stock.test/watch/a",{allowListing:false})',context);
  await vm.runInContext('resolveGenericMediaPage("https://stock.test/watch/a",{allowListing:false})',context);
  assert.equal(fetches,hasMedia?1:2);
 }
});

test('strict desktop capture keeps the highest accessible rendition when a higher advertised URL is dead',async()=>{
 const s=readFileSync(new URL('./local-ai-server.mjs',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('async function resolveGenericMediaPage('),s.indexOf('function gatewayMediaReferer('));
 const high='https://cdn.test/videos/2026/09/123456789/movie_2160P.mp4';
 const full='https://cdn.test/videos/2026/09/123456789/movie_1080P.m3u8';
 const context=vm.createContext({URL,Date,genericMediaResolutionCache:new Map(),requireMediaVpn:async()=>{},
  publicMediaPageUrl:u=>new URL(u),authorizeGenericMediaUrl:u=>new URL(u),
  fetchPublicMediaPage:async url=>({html:'',url}),
  extractGenericMediaPageMetadata:()=>({title:'Fixture',videoUrls:[high,full],durationSeconds:60}),
  extractGenericEmbedUrlsFromHtml:()=>[],extractGenericWatchPageUrlsFromHtml:()=>[],
  extractGenericMediaWithYtDlp:async()=>[],extractGenericMediaWithBrowser:async()=>({videoUrls:[]}),
  looksLikeGenericHlsResource:u=>/\.m3u8/.test(u),
  inspectGenericMediaPlayback:async u=>({playable:u===full,durationSeconds:60})});
 const result=await vm.runInContext(fn+';resolveGenericMediaPage("https://pornhub.com/view_video.php?viewkey=fixture",{allowListing:false,requireHighestQuality:true})',context);
 assert.deepEqual([...result.videoUrls],[full]);
});

test('gateway preserves full, open-ended, bounded and suffix ranges for every reader',async()=>{
 const s=readFileSync(new URL('./local-ai-server.mjs',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('function gatewayRequest('),s.indexOf('async function readBrowserSecrets('));
 for(const ua of ['Lavf/62.3','Firefox/143','Android Chrome/150','']){
  for(const range of [undefined,'bytes=0-','bytes=5000000-','bytes=2-9000000','bytes=-4096']){
   let sent;
   const context=vm.createContext({GATEWAY_TIMEOUT_MS:1000,GATEWAY_AGENT:{},gatewayMediaReferer:()=>'',
    https:{request:(_url,options,callback)=>{sent=options.headers;const req=new EventEmitter();req.end=()=>setImmediate(()=>callback({}));return req;}}});
   const req={method:'GET',headers:{'user-agent':ua,...(range?{range}:{})}};
   context.req=req;context.target=new URL('https://cdn.test/asset.mp4');context.controller=new AbortController();
   await vm.runInContext(fn+';gatewayRequest(target,req,controller)',context);
   assert.equal(sent.range,range,`${ua}: ${range}`);
  }
 }
});

test('userscript declares known Pong destinations explicitly for manager permissions',()=>{
 const s=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 for(const host of ['localhost','127.0.0.1','192.168.1.124']) assert.ok(s.includes('// @connect      '+host));
});

test('media probe cannot hang indefinitely behind a manager permission prompt',async()=>{
 const s=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('  function probeCapturedMediaUrl('),s.indexOf('  async function probeCapturedDuration('));
 let fire,aborted=false;
 const context=vm.createContext({setTimeout:f=>{fire=f;return 1;},clearTimeout:()=>{},
  diagnosticRequest:()=>({}),finishDiagnosticRequest:()=>{},diagnosticStreamType:()=> 'mp4',diagnosticMime:v=>v,diagnosticNumber:v=>Number(v),
  VIDEO_EXT_RE:/\.mp4$/,location:{href:'https://site.test/watch/1'},responseHeaderValue:()=>'',
  GM_xmlhttpRequest:o=>({abort(){aborted=true;o.onabort();}})});
 const pending=vm.runInContext(fn+';probeCapturedMediaUrl("https://cdn.test/main.mp4")',context);
 fire();assert.equal(await pending,false);assert.equal(aborted,true);
});

test('Pong capture has a wall deadline even when manager permission stalls the request',async()=>{
 const s=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('  function postRecallCapturePayload('),s.indexOf('  async function postRecallCapturePayloadWithRetry('));
 let fire,aborted=false,cleared=false;
 const context=vm.createContext({setTimeout:f=>{fire=f;return 1;},clearTimeout:()=>{cleared=true;},
  diagnosticRequest:()=>({}),finishDiagnosticRequest:()=>{},
  GM_xmlhttpRequest:options=>({abort(){aborted=true;options.onabort();}})});
 const pending=vm.runInContext(fn+';postRecallCapturePayload("http://127.0.0.1:8787",{},10)',context);
 const rejection=assert.rejects(pending,/Tampermonkey permission/);fire();await rejection;
 assert.equal(aborted,true);assert.equal(cleared,true);
});

test('successful Pong handoff clears deadline and ignores late callbacks',async()=>{
 const s=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const fn=s.slice(s.indexOf('  function postRecallCapturePayload('),s.indexOf('  async function postRecallCapturePayloadWithRetry('));
 let options,cleared=false;
 const context=vm.createContext({setTimeout:()=>1,clearTimeout:()=>{cleared=true;},diagnosticRequest:()=>({}),finishDiagnosticRequest:()=>{},GM_xmlhttpRequest:o=>{options=o;return {};}});
 const pending=vm.runInContext(fn+';postRecallCapturePayload("http://127.0.0.1:8787",{})',context);
 options.onload({status:200,responseText:'{"ok":true}'});options.onabort();
 assert.equal((await pending).ok,true);assert.equal(cleared,true);
});
