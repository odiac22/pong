import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {phoneConnectionCaptureRequested,phoneConnectionFileCandidates,phoneConnectionVideoRecord} from './phone-connection-policy.mjs';
const server=readFileSync(new URL('./local-ai-server.mjs',import.meta.url),'utf8');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');

test('phone routing requires explicit boolean consent',()=>{
 for(const payload of [null,{}, {phoneConnectionOnly:false},{phoneConnectionOnly:'true'}]) assert.equal(phoneConnectionCaptureRequested(payload),false);
 assert.equal(phoneConnectionCaptureRequested({phoneConnectionOnly:true}),true);
});
test('only complete video files use this relay; playlists and opaque unknown URLs are not silently substituted',()=>{
 assert.deepEqual(phoneConnectionFileCandidates(['https://cdn.example/a.mp4?sig=x','https://cdn.example/a.webm','https://cdn.example/master.m3u8','https://cdn.example/a.mpd','https://cdn.example/a','file:///a.mp4']),['https://cdn.example/a.mp4?sig=x','https://cdn.example/a.webm']);
});
test('phone-only record contains no direct playback fallbacks',()=>{
 const record=phoneConnectionVideoRecord({videoUrl:'https://cdn.example/a.mp4',videoUrls:['https://cdn.example/b.mp4'],durationSeconds:45},'/media-browser-relay/stream/abcdefgh');
 assert.equal(record.videoUrl,record.browserRelayUrl);assert.deepEqual(record.videoUrls,[]);assert.equal(record.durationSeconds,45);assert.equal(record.phoneConnectionOnly,true);
});
test('actual server stream handler never invokes PC shortcut for phone-only media, preserving range bytes',async()=>{
 const start=server.indexOf("    if ((req.method === 'GET' || req.method === 'HEAD') && /^\\/media-browser-relay\\/stream");
 assert.ok(start>0);
 const source=server.slice(start,server.indexOf("    if (req.method === 'GET' && url.pathname === '/saved-links/state')",start));
 for(const phoneConnectionOnly of [true,false]){
  let phone=0,pc=0,headers,status,body;
  const bytes=Buffer.from('inert-range-bytes');
  const result={status:206,body:bytes,contentType:'video/mp4',contentRange:'bytes 0-16/1000'};
  const context=vm.createContext({Date,Buffer,Error,JSON,req:{method:'GET',headers:{range:'bytes=0-16'}},url:{pathname:'/media-browser-relay/stream/abcdefgh'},
    validBrowserMediaRelayId:v=>v,pruneBrowserMediaRelayState(){},BROWSER_MEDIA_RELAY_TTL_MS:1000,
    browserMediaRelaySources:new Map([['abcdefgh',{id:'abcdefgh',clientId:'client-id',phoneConnectionOnly,pageUrl:'https://example.org/player'}]]),
    parseBrowserMediaRelayRange:v=>v,hqpornerRelayPage:()=>true,
    queueFreshHqpornerRelayRange:async()=>{pc++;return result;},queueBrowserMediaRelayJob:async()=>{phone++;return result;},
    phoneTransfers:{serve:async()=>false},res:{writeHead(s,h){status=s;headers=h;},end(b){body=b;}},json(){throw Error('Unexpected JSON failure');}});
  await vm.runInContext(`(async()=>{${source}})()`,context);
  assert.equal(phone,phoneConnectionOnly?1:0);assert.equal(pc,phoneConnectionOnly?0:1);
  assert.equal(status,206);assert.equal(headers['Content-Range'],'bytes 0-16/1000');assert.deepEqual(body,bytes);
 }
});
test('actual Pong Recall adapter retains phone-only route and no source-recovery alternatives',()=>{
 const start=html.indexOf('function genericRecallVideoRecord(');
 const source=html.slice(start,html.indexOf('\nasync function loadGenericRecallBundles',start));
 const ctx=vm.createContext({random40IsGenericHlsMediaUrl:()=>false});vm.runInContext(source,ctx);
 const video=phoneConnectionVideoRecord({durationSeconds:45},'/media-browser-relay/stream/abcdefgh');
 const record=ctx.genericRecallVideoRecord({},video);
 assert.equal(record.playbackUrl,video.videoUrl);assert.equal(record.metadata.phoneConnectionOnly,true);
 assert.equal(record.metadata.alternateVideoUrls.length,0);assert.equal(record.metadata.videoSources.length,1);
});
test('sources button is positioned immediately after paperclip and TikTok avoids overlap',()=>{
 const fn=html.match(/function positionPongVideoSourceButton\([^]*?\n}/)[0];
 const buttons={ 'paste-nav-button':{getBoundingClientRect:()=>({right:50,top:200,height:38,bottom:238})},'pong-video-source-button':{style:{display:'flex'},getBoundingClientRect:()=>({right:110})},'pong-video-source-panel':{style:{}},'simpcity-tiktok-button':{style:{}} };
 const ctx=vm.createContext({document:{getElementById:id=>buttons[id]}});vm.runInContext(fn,ctx);ctx.positionPongVideoSourceButton();
 assert.equal(buttons['pong-video-source-button'].style.left,'56px');assert.equal(buttons['simpcity-tiktok-button'].style.left,'116px');
 buttons['pong-video-source-button'].style.display='none';ctx.positionPongVideoSourceButton();assert.equal(buttons['simpcity-tiktok-button'].style.left,'56px');
});

test('phone relay workers coexist across Recall channels and stale expiry cannot stop a newer send',async()=>{
 const script=readFileSync(new URL('./universal-video-scraper.user.js',import.meta.url),'utf8');
 const start=script.indexOf('  function startBrowserMediaRelay(');
 const source=script.slice(start,script.indexOf('  function canonicalWatchPageUrl(',start));
 const requests=[]; const runs=new Map();
 const ctx=vm.createContext({browserMediaRelayGeneration:0,browserMediaRelayRuns:runs,JSON,Error,encodeURIComponent,
   location:{pathname:'/fixture'},browserRelayRequest:request=>new Promise(resolve=>requests.push({request,resolve})),
   completeBrowserMediaRelayJob:async()=>{},sleep:async()=>{}});
 vm.runInContext(source,ctx);
 ctx.startBrowserMediaRelay('https://relay.invalid/','first',1);
 ctx.startBrowserMediaRelay('https://relay.invalid','second',2);
 assert.equal(runs.size,2);assert.equal(requests.length,4);
 ctx.startBrowserMediaRelay('https://relay.invalid','replacement',1);
 const latest=runs.get('https://relay.invalid|1');
 for(const item of requests.slice(0,2))item.resolve({status:200,responseText:'{"expired":true}'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runs.get('https://relay.invalid|1'),latest);assert.equal(runs.size,2);
 requests[2].resolve({status:200,responseText:'{}'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.length,7);assert.match(requests.at(-1).request.url,/clientId=second$/);
 for(const item of requests.slice(2))item.resolve({status:200,responseText:'{"expired":true}'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runs.size,0);
});
