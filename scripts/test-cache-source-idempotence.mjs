import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function random40StartServerVideoCacheTimers(');
const end=html.indexOf('\nasync function ',start);
let loads=0;
const video={src:'http://localhost:8787/proxy?url=one',currentSrc:'http://localhost:8787/proxy?url=one',currentTime:0,dataset:{},load(){loads++;}};
const wrapper={dataset:{originalVideoUrl:'one'},classList:{contains:()=>true},querySelector:()=>video};
let desired='/proxy?url=one';
const ctx=vm.createContext({URL,document:{baseURI:'http://localhost:8787/pong',querySelectorAll:()=>[wrapper]},
 random40ServerVideoCacheEndpoint:()=> 'http://localhost:8787',
 isPongFaceSwapManagedMedia:()=>false,foregroundPriorityVideo:video,
 random40ForegroundPlaybackUrl:()=>desired,random40PlaybackUrl:()=>desired,
 random40ServerVideoCachePollTimer:1,random40ServerVideoCacheHeartbeatTimer:1});
vm.runInContext(html.slice(start,end),ctx);
for(let i=0;i<10;i++)ctx.random40StartServerVideoCacheTimers();
assert.equal(loads,0,'relative and absolute same source must never reload');
video.currentSrc='http://localhost:8787/proxy?url=old';
ctx.random40StartServerVideoCacheTimers();
assert.equal(loads,0,'assigned source wins over stale currentSrc');
desired='/proxy?url=two';
ctx.random40StartServerVideoCacheTimers();
assert.equal(loads,1,'different source is attached');
ctx.random40StartServerVideoCacheTimers();
assert.equal(loads,1,'new source is attached only once');
console.log('PASS: 4 cache source idempotence regressions');
