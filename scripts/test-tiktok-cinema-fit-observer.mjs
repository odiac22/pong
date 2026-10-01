import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync('android-app/app/src/main/assets/tiktok-phone-fit.js','utf8');
function fixture(){
 let observer,root=null,queries=0,clicks=0,serial=0,disconnected=false;
 const tasks=new Map();
 const node=(kind='unrelated')=>({nodeType:1,kind,isConnected:true,parent:null,
  matches:s=>kind==='root'?s.includes('DivCinemaModeRoot'):kind==='close'?s.includes('DivSidePanelSection'):false,
  querySelector:()=>null,contains:n=>n.parent===root,click:()=>clicks++});
 const w={};
 vm.runInNewContext(source,{window:w,innerWidth:400,WeakSet,
  document:{querySelector:s=>{queries++;return s.includes('DivCinemaModeRoot')?root:null;},querySelectorAll:()=>[],head:{appendChild(){}},body:{},createElement:()=>({remove(){}})},
  MutationObserver:class{constructor(cb){observer=cb}observe(){}disconnect(){disconnected=true}},
  requestAnimationFrame:cb=>{tasks.set(++serial,cb);return serial;},cancelAnimationFrame:id=>tasks.delete(id),setTimeout(){}});
 return {w,node,setRoot:r=>root=r,mutate:n=>observer([{addedNodes:[n]}]),
  flush:()=>{const copy=[...tasks.values()];tasks.clear();copy.forEach(f=>f());},
  pending:()=>tasks.size,clicks:()=>clicks,queries:()=>queries,disconnected:()=>disconnected};
}
test('unrelated React mutation storm schedules no cinema fit callbacks',()=>{
 const f=fixture(),initial=f.queries();for(let i=0;i<1000;i++)f.mutate(f.node());
 assert.equal(f.pending(),0);assert.equal(f.queries(),initial);
});
test('late close button fits once, then ignores playback changes and respects manual reopen',()=>{
 const f=fixture(),root=f.node('root');f.setRoot(root);f.mutate(root);f.flush();assert.equal(f.clicks(),0);
 const close=f.node('close');close.parent=root;root.querySelector=()=>close;
 f.mutate(close);f.mutate(close);assert.equal(f.pending(),1);f.flush();assert.equal(f.clicks(),1);
 for(let i=0;i<10;i++)f.mutate(close);assert.equal(f.pending(),0);assert.equal(f.clicks(),1);
});
test('a replacement cinema can fit once and undo cancels queued work',()=>{
 const f=fixture(),first=f.node('root'),close=f.node('close');first.querySelector=()=>close;f.setRoot(first);f.mutate(first);f.flush();
 assert.equal(f.clicks(),1);first.isConnected=false;
 const next=f.node('root');next.querySelector=()=>close;f.setRoot(next);f.mutate(next);assert.equal(f.pending(),1);
 f.w.__pongUndoPhoneFit();assert.equal(f.pending(),0);assert.equal(f.clicks(),1);assert.equal(f.disconnected(),true);
});
