import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
const code=html.split('<script id="pong-tiktok-toolbar-approved">')[1].split('</script>')[0];
function fixture(){
 const mutations=[],sizes=[],raf=[];let active=true,reads=0;
 const button={closest:()=>null,getBoundingClientRect:()=>({left:12,top:650}),get offsetWidth(){reads++;return 40},get offsetHeight(){reads++;return 40}};
 const context={window:{dispatchEvent(){}},document:{documentElement:{classList:{contains:()=>active}},body:{},
  head:{append(){}},createElement:()=>({textContent:'',remove(){}}),querySelector:()=>button},
  MutationObserver:class{constructor(callback){mutations.push(callback)}observe(){}disconnect(){}},
  ResizeObserver:class{constructor(callback){sizes.push(callback)}observe(){}disconnect(){}},
  requestAnimationFrame:fn=>{raf.push(fn);return raf.length},cancelAnimationFrame(){},addEventListener(){},removeEventListener(){},
  innerWidth:393,innerHeight:851,Event:class{}};
 vm.runInNewContext(code,context);
 return {mutations,sizes,raf,reads:()=>reads,setActive:v=>{active=v},window:context.window};
}
test('playback text and unrelated root status classes do not force toolbar measurement',()=>{
 const f=fixture(),initial=f.reads();
 for(let i=0;i<100;i++){
  f.mutations[1]([{addedNodes:[{nodeType:3}],removedNodes:[]}]);
  f.mutations[0]();
 }
 assert.equal(f.raf.length,0);assert.equal(f.reads(),initial);
});
test('actual size, toolbar replacement and TikTok mode transitions still schedule layout',()=>{
 const f=fixture();f.sizes[0]();assert.equal(f.raf.length,1);f.raf.pop()();
 f.mutations[1]([{addedNodes:[{nodeType:1,matches:()=>true}],removedNodes:[]}]);
 assert.equal(f.raf.length,1);f.raf.pop()();
 f.setActive(false);f.mutations[0]();assert.equal(f.raf.length,1);f.raf.pop()();
 f.setActive(true);f.mutations[0]();assert.equal(f.raf.length,1);
});
test('unrelated inserted markup does not force layout and cleanup remains available',()=>{
 const f=fixture();f.mutations[1]([{addedNodes:[{nodeType:1,matches:()=>false,querySelector:()=>null}],removedNodes:[]}]);
 assert.equal(f.raf.length,0);f.window.PongTikTokToolbarLayout.dispose();assert.equal(f.window.PongTikTokToolbarLayout,undefined);
});
