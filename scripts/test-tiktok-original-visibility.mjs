import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./tiktok-original-visibility-trial.js',import.meta.url),'utf8');
function fixture(){
  const values=new Map([['visibility',['visible','important']]]);
  const video={isConnected:true,style:{getPropertyValue:k=>values.get(k)?.[0]||'',getPropertyPriority:k=>values.get(k)?.[1]||'',
    setProperty:(k,v,p)=>values.set(k,[v,p]),removeProperty:k=>values.delete(k)}};
  const state={original:video,overlay:{},visible:false};
  const window={__pongDomSwap:state,__pongDomSwapSync:()=>({visible:state.visible}),__pongDomSwapClear:expected=>{
    if(expected==='stale')return false;window.__pongDomSwap=null;return true;
  }};
  vm.runInNewContext(source,{window});return {window,state,video,values};
}
test('not hidden until aligned swap is actually visible; layout is never modified',()=>{
  const f=fixture();assert.equal(f.values.get('visibility')[0],'visible');
  f.state.visible=true;f.window.__pongDomSwapSync();assert.deepEqual(f.values.get('visibility'),['hidden','important']);
  assert.deepEqual([...f.values.keys()],['visibility']);
});
test('clear restores original visibility and priority synchronously; stale clear retains ownership',()=>{
  const f=fixture();f.state.visible=true;f.window.__pongDomSwapSync();
  f.window.__pongDomSwapClear('stale');assert.equal(f.values.get('visibility')[0],'hidden');
  f.window.__pongDomSwapClear();assert.deepEqual(f.values.get('visibility'),['visible','important']);
});
test('hidden swap, errors, and uninstall restore source without changing its clock or playback',()=>{
  for(const reason of ['hidden','error','uninstall']){
    const f=fixture();f.video.currentTime=7;f.video.paused=false;f.state.visible=true;f.window.__pongDomSwapSync();
    if(reason==='uninstall')f.window.__pongUndoOriginalVisibility();
    else{if(reason==='hidden')f.state.visible=false;else f.state.overlay.error={};f.window.__pongDomSwapSync();}
    assert.deepEqual(f.values.get('visibility'),['visible','important']);
    assert.equal(f.video.currentTime,7);assert.equal(f.video.paused,false);
  }
});
