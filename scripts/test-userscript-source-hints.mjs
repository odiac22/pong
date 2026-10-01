import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../universal-video-scraper.user.js',import.meta.url),'utf8');
const start=source.indexOf('  function selectedPlayerMediaHints(');
const end=source.indexOf('\n  function collectSelectableTargets(',start);
assert.ok(start>0&&end>start);
function setup({own=['https://media.stock.example/8379044/8379044-hd_1280_720.mp4'],related=[],duration=10}={}){
  const page='https://stock.example/video/people-8379044/';
  const doc={documentElement:{innerHTML:''}};
  const video={tagName:'VIDEO',isConnected:true,ownerDocument:doc,duration,videoWidth:1280,videoHeight:720,
    currentSrc:own[0],getAttribute:()=>own[0],querySelectorAll:()=>own.slice(1).map(url=>({getAttribute:()=>url}))};
  const ctx=vm.createContext({URL,document:doc,location:{href:page},canonicalWatchPageUrl:u=>u,
    primaryVideoEvidence:()=>({videoUrls:related})});
  vm.runInContext(source.slice(start,end),ctx);
  return {hints:ctx.selectedPlayerMediaHints,target:{url:page,kind:'player',durationSeconds:10,element:video},doc,video};
}
test('selected native rendition and same VideoObject alternates are ranked, without fetching',()=>{
  const low='https://media.stock.example/8379044/8379044-hd_1280_720.mp4';
  const high='https://media.stock.example/8379044/8379044-uhd_2160_3840.mp4';
  const f=setup({related:[low,high]});const hints=f.hints(f.target);
  assert.equal(hints[0].url,high);assert.equal(hints[0].width,2160);assert.equal(hints[0].height,3840);
  assert.equal(hints.length,2);assert.equal(hints[0].sourcePageUrl,f.target.url);
  assert.deepEqual(Object.keys(hints[0]).sort(),['durationSeconds','height','sourcePageUrl','url','width']);
});
test('related link and embedded player receive no page-wide hint',()=>{
  const f=setup();for(const kind of ['link','direct','embed'])assert.equal(f.hints({...f.target,kind}).length,0);
  assert.equal(f.hints({...f.target,url:'https://stock.example/other'}).length,0);
  assert.equal(f.hints({...f.target,logicalVideoId:'inline-video-1'}).length,0);
});
test('custom player public source is supported without probing unrelated native previews',()=>{
  const f=setup();f.video.tagName='MUX-PLAYER';f.video.querySelector=()=>null;
  assert.equal(f.hints(f.target).length,1);
  f.video.tagName='DIV';assert.equal(f.hints(f.target).length,0);
});
test('unrelated VideoObject never supplies alternate sources for selected native player',()=>{
  const f=setup({related:['https://media.stock.example/999999/999999-3840_2160.mp4']});
  assert.equal(f.hints(f.target).length,1);
});
test('no credentials, blob, cleartext or unmeasured duration are included',()=>{
  for(const value of ['blob:https://stock.example/id','http://media.stock.example/a.mp4','https://user:pass@media.stock.example/a.mp4']){
    const f=setup({own:[value]});assert.equal(f.hints(f.target).length,0);
  }
  const f=setup({duration:NaN});f.target.durationSeconds=0;assert.equal(f.hints(f.target).length,0);
});
test('hints stay bounded and detached/foreign DOM is rejected',()=>{
  const f=setup({own:Array.from({length:20},(_,i)=>`https://media.stock.example/8379044/a-${100+i}_720.mp4`)});
  assert.equal(f.hints(f.target).length,8);
  f.video.isConnected=false;assert.equal(f.hints(f.target).length,0);
  f.video.isConnected=true;f.video.ownerDocument={};assert.equal(f.hints(f.target).length,0);
});
