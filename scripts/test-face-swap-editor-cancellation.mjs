import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
function definition(name,next){const start=html.indexOf(`async function ${name}(`);assert.ok(start>0);return html.slice(start,html.indexOf(`\nasync function ${next}(`,start));}
test('closing during settings fetch cannot create a late editor',async()=>{
  let finish,created=0;
  const state={settingsOpenGeneration:0,faces:[{}]};
  const context=vm.createContext({pongFaceSwapState:state,document:{getElementById:()=>({hidden:true})},loadPongFaceSwapSettings:()=>new Promise(r=>finish=r),beginPongFaceSwapFrameEditor:()=>{created++;}});
  vm.runInContext(definition('openPongFaceSwapSettingsPanel','closePongFaceSwapSettingsPanel'),context);
  const pending=context.openPongFaceSwapSettingsPanel();
  state.settingsOpenGeneration++;
  finish();
  assert.equal(await pending,false);
  assert.equal(created,0);
});
test('a late suspend after close is resumed without allocating a preview',async()=>{
  let finish;
  const calls=[];
  const state={settingsOpenGeneration:1,settingsEditor:null};
  const frame={wrapper:{dataset:{pongFaceSwapSessionId:'test-only'}},video:{pause(){}}};
  const context=vm.createContext({AbortController,pongFaceSwapState:state,clearPongFaceSwapPrefetches(){},capturePongFaceSwapSettingsFrame:()=>frame,createPongFaceSwapFrameEditor:()=>({frame}),setPongFaceSwapSettingsViewControlsVisible(){},renderPongFaceSwapSettingsFaces(){},pongFaceSwapControlFetch:(url)=>{calls.push(url);return url.endsWith('/suspend')?new Promise(r=>finish=r):Promise.resolve({ok:true});}});
  vm.runInContext(definition('beginPongFaceSwapFrameEditor','renderPongFaceSwapSettingsSnapshot'),context);
  const pending=context.beginPongFaceSwapFrameEditor(1);
  state.settingsEditor=null;state.settingsOpenGeneration=2;
  finish({ok:true});
  assert.equal(await pending,false);
  assert.deepEqual(calls,['/pong-swap/sessions/test-only/suspend','/pong-swap/sessions/test-only/resume']);
});
test('late Detect boxes cannot return after closing the owning editor',async()=>{
  let finish;
  const editor={};const state={settingsEditor:editor,settingsPreviewId:'owned-preview'};
  const context=vm.createContext({pongFaceSwapState:state,clearPongFaceSwapDetectedFaces(){},setPongFaceSwapFrameEditorZoom(){},setPongFaceSwapFrameEditorView(){},setPongFaceSwapSettingsStatus(){},fetchPongOriginalDetectedFaces:()=>new Promise(r=>finish=r)});
  const start=html.indexOf('async function togglePongFaceSwapFaceDetect(');
  const ends=[html.indexOf('\nfunction ',start),html.indexOf('\nasync function ',start+1)].filter(i=>i>start);
  vm.runInContext(html.slice(start,Math.min(...ends)),context);
  const pending=context.togglePongFaceSwapFaceDetect();
  state.settingsEditor=null;state.settingsPreviewId='';
  finish([{}]);
  assert.equal(await pending,false);
});
