import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const script=readFileSync('android-app/app/src/main/assets/tiktok-stable-handoff.js','utf8');
function fixture({start=0,time=3,error=null}={}){
 const style=()=>({setProperty(k,v){this[k]=v;}});
 const original={currentTime:time,isConnected:true,style:style(),dataset:{pongDomOriginalOpacity:''}};
 const overlay={currentTime:1,readyState:2,seeking:false,error,style:style(),pause(){},buffered:{length:0}};
 const s={original,overlay,start,visible:true,sessionId:'test',createdAt:0};
 const window={__pongDomSwap:s,__pongDomSwapSync(){s.visible=false;original.style.opacity='';overlay.style.opacity='0';return {visible:false};}};
 vm.runInNewContext(script,{window,performance:{now:()=>100},document:{documentElement:{classList:{add(){},remove(){}}}}});
 return {window,s};
}
test('buffer recovery retains the swapped layer for the same video',()=>{const {window,s}=fixture();const r=window.__pongDomSwapSync();assert.equal(r.visible,true);assert.equal(s.original.style.opacity,'0');assert.equal(s.overlay.style.opacity,'1');});
test('future-offset stream is not shown over an earlier source timestamp',()=>{const {window,s}=fixture({start:4,time:0});assert.equal(window.__pongDomSwapSync().visible,false);assert.equal(s.overlay.style.opacity,'0');});
test('decoder errors do not resurrect invalid transformed media',()=>{const {window}=fixture({error:{code:3}});assert.equal(window.__pongDomSwapSync().visible,false);});
test('cold load and reopen install stable handoff after the synchronizer it wraps',()=>{
 const java=readFileSync('android-app/app/src/main/java/com/odiac22/pong/MainActivity.java','utf8');
 const calls=[...java.matchAll(/evaluateJavascript\(bundledJavascript\("(tiktok-(?:frame-sync|stable-handoff)\.js)"\)/g)].map(m=>m[1]);
 assert.deepEqual(calls,['tiktok-frame-sync.js','tiktok-stable-handoff.js','tiktok-frame-sync.js','tiktok-stable-handoff.js']);
});
