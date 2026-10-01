import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
function definition(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start > 0);
  const end = html.slice(start + 1).search(/\n(?:async )?function /);
  return html.slice(start, end < 0 ? undefined : start + 1 + end);
}
const box = {x: .2, y: .2, width: .2, height: .3};
const face = {...box, index: 3, identityEmbedding: [0.2, .3]};

test('original association ignores detector ordering, not identity evidence', () => {
  const c = vm.createContext({}); vm.runInContext(definition('matchPongDetectedOriginalFace'), c);
  assert.equal(c.matchPongDetectedOriginalFace(box, [{...face, x:.7, index:0}, face]), face);
  assert.equal(c.matchPongDetectedOriginalFace(box, [{...face, geometryOnly:true}]), null);
  assert.equal(c.matchPongDetectedOriginalFace(box, [{...face, identityEmbedding:[]}]), null);
  assert.equal(c.matchPongDetectedOriginalFace(box, [{...face, identityEmbedding:[NaN]}]), null);
});
test('ambiguous overlapping or moved original faces are rejected', () => {
  const c = vm.createContext({}); vm.runInContext(definition('matchPongDetectedOriginalFace'), c);
  assert.equal(c.matchPongDetectedOriginalFace(box, [face, {...face, x:.21}]), null);
  assert.equal(c.matchPongDetectedOriginalFace(box, [{...face, x:.6}]), null);
});
test('legacy helper descriptors from display captures are stripped and temporary preview deleted', async () => {
  const editor = {canvas:{toDataURL:()=>'data:image/jpeg;base64,x'},frame:{faceId:'f',startSeconds:2}};
  const deleted=[]; const requests=[];
  const c=vm.createContext({AbortController,setTimeout,clearTimeout,pongFaceSwapState:{settingsEditor:editor},
    pongFaceSwapPrimaryFaceId:x=>x, pongFaceSwapBackgroundFetch:async url=>deleted.push(url),
    pongFaceSwapControlFetch:async (url,options)=>{
      requests.push({url,options});
      return {ok:true,json:async()=>url.endsWith('/faces')?{faces:[face]}:{preview:{id:'owned'}}};
    }});
  vm.runInContext(definition('fetchPongQuickFaceBoxes'),c);
  const result=await c.fetchPongQuickFaceBoxes(editor);
  assert.equal(result[0].geometryOnly,true);
  assert.equal(result[0].identityEmbedding,undefined);
  assert.equal(JSON.parse(requests[0].options.body).geometryOnly,true);
  assert.deepEqual(deleted,['/pong-swap/frame-previews/owned']);
});
test('closing while original identity resolves cannot apply a late face selection', async () => {
  let resolve,selected=0; const editor={}; const state={settingsEditor:editor};
  const c=vm.createContext({pongFaceSwapState:state,setPongFaceSwapSettingsStatus(){},
    fetchPongOriginalDetectedFaces:()=>new Promise(r=>resolve=r),matchPongDetectedOriginalFace:()=>face,
    selectPongFaceSwapDetectedFace(){selected++;}});
  vm.runInContext(definition('confirmPongFaceDetectSelection'),c);
  const pending=c.confirmPongFaceDetectSelection(editor,{...box,geometryOnly:true});
  state.settingsEditor=null; resolve([face]);
  assert.equal(await pending,false); assert.equal(selected,0);
});
test('settings callers share the in-flight refresh, so a second caller really waits', async () => {
  let finish,requests=0; const state={};
  const c=vm.createContext({pongFaceSwapState:state,Date,setPongFaceSwapSettingsStatus(){},
    renderPongFaceSwapSettings(){},clonePongFaceSwapConfig:x=>x,
    pongFaceSwapControlFetch:()=>{requests++;return new Promise(r=>finish=r);}});
  vm.runInContext(definition('loadPongFaceSwapSettings'),c);
  const one=c.loadPongFaceSwapSettings(); let secondDone=false;
  const two=c.loadPongFaceSwapSettings().then(()=>secondDone=true);
  await Promise.resolve(); assert.equal(secondDone,false); assert.equal(requests,1);
  finish({ok:true,json:async()=>({config:{parameters:{}}})});
  await Promise.all([one,two]); assert.equal(secondDone,true); assert.equal(state.settingsLoadPromise,null);
});
test('quick editor returns boxes while source suspension is still pending', async () => {
  let suspended, boxesRequested=0;
  const frame={wrapper:{dataset:{pongFaceSwapSessionId:'own'}},video:{pause(){}}};
  const state={settingsOpenGeneration:1,settingsEditor:null};
  const c=vm.createContext({AbortController,pongFaceSwapState:state,clearPongFaceSwapPrefetches(){},
    capturePongFaceSwapSettingsFrame:()=>frame,createPongFaceSwapFrameEditor:()=>({frame}),
    setPongFaceSwapSettingsViewControlsVisible(){},renderPongFaceSwapSettingsFaces(){},
    fetchPongQuickFaceBoxes:async()=>{boxesRequested++;return [box];},
    pongFaceSwapControlFetch:url=>url.endsWith('/suspend')?new Promise(r=>suspended=r):Promise.resolve({ok:true})});
  vm.runInContext(definition('beginPongFaceSwapFrameEditor'),c);
  assert.equal(await c.beginPongFaceSwapFrameEditor(1,{renderPreview:false}),true);
  assert.equal(boxesRequested,1);
  const pending=state.settingsEditor.sourcePreparationPromise;
  state.settingsEditor=null;state.settingsOpenGeneration++;
  suspended({ok:true});assert.equal(await pending,false);
});
test('unhydrated display pixels are never labeled as the original', () => {
  const editor={sourceFace:{},canvas:{},image:{},originalReady:false};
  const c=vm.createContext({updatePongFaceSwapSettingsViewControls(){}});
  vm.runInContext(definition('setPongFaceSwapFrameEditorView'),c);
  c.setPongFaceSwapFrameEditorView(editor,'original');
  assert.equal(editor.viewMode,'swap');
  assert.equal(editor.requestedViewMode,'original');
  assert.equal(editor.canvas.hidden,false);
  editor.originalReady=true;
  c.setPongFaceSwapFrameEditorView(editor,editor.requestedViewMode);
  assert.equal(editor.viewMode,'original');
});
test('failed original preparation removes dead boxes and closes only its owning editor', async () => {
  const editor={frame:{wasPlaying:false}};const state={settingsEditor:editor};
  let cleared=0,closed=0;
  const c=vm.createContext({pongFaceSwapState:state,pongFaceSwapFriendlyError:e=>e.message,
    clearPongFaceSwapDetectedFaces(){cleared++;},setPongFaceSwapSettingsStatus(){},showSortingIndicator(){},
    closePongFaceSwapSettingsPanel:async()=>{closed++;state.settingsEditor=null;}});
  vm.runInContext(definition('recoverPongQuickFaceDetectFailure'),c);
  await c.recoverPongQuickFaceDetectFailure(editor,Error('original failed'));
  assert.equal(editor.sourcePreparationError,'original failed');
  assert.equal(editor.frame.wasPlaying,false,'failure must not force user-paused playback on');
  assert.equal(cleared,1);assert.equal(closed,1);
  state.settingsEditor={};
  await c.recoverPongQuickFaceDetectFailure(editor,Error('late failure'));
  assert.equal(closed,1,'an old response must not close a replacement editor');
});
test('a failed original cannot be selected even while error recovery is closing', async () => {
  const editor={sourcePreparationError:'failed'};let selected=0;
  const c=vm.createContext({pongFaceSwapState:{settingsEditor:editor},
    selectPongFaceSwapDetectedFace(){selected++;}});
  vm.runInContext(definition('confirmPongFaceDetectSelection'),c);
  assert.equal(await c.confirmPongFaceDetectSelection(editor,face),false);
  assert.equal(selected,0);
});
test('a red-box tap waits for successful original hydration before changing the target', async () => {
  let hydrate,selected=0;
  const editor={sourcePreparationPromise:new Promise(r=>hydrate=r),originalReady:false};
  const state={settingsEditor:editor};
  const c=vm.createContext({pongFaceSwapState:state,setPongFaceSwapSettingsStatus(){},
    pongFaceSwapFriendlyError:e=>e.message,selectPongFaceSwapDetectedFace(){selected++;return true;}});
  vm.runInContext(definition('confirmPongFaceDetectSelection'),c);
  const pending=c.confirmPongFaceDetectSelection(editor,face);
  await Promise.resolve();assert.equal(selected,0);
  hydrate(false);assert.equal(await pending,false);assert.equal(selected,0);
  editor.sourcePreparationPromise=Promise.resolve(true);editor.originalReady=true;
  assert.equal(await c.confirmPongFaceDetectSelection(editor,face),true);assert.equal(selected,1);
});
test('immediate Detect restart preserves original identity, independently of stored coordinates', () => {
  const target={x:.2,y:.4,identityEmbedding:[.1,.2,.3],presentation:{label:'unknown',confidence:.7,appearance:[.3,.4]}};
  const c=vm.createContext({});vm.runInContext(definition('copyPongFaceSwapManualTarget'),c);
  const copy=c.copyPongFaceSwapManualTarget(target);
  assert.equal(JSON.stringify(copy),JSON.stringify(target));
  copy.identityEmbedding[0]=.9;copy.presentation.appearance[0]=.9;
  assert.equal(target.identityEmbedding[0],.1);assert.equal(target.presentation.appearance[0],.3);
  assert.match(definition('startPongFaceSwap'),/copyPongFaceSwapManualTarget\(options\.manualTarget \|\| storedManualTarget\)/);
  assert.match(definition('startPongFaceSwap'),/targetEmbedding: manualTarget\?\.identityEmbedding/);
});
test('corrupt explicit identity is rejected, never silently downgraded to coordinate lock', () => {
  const c=vm.createContext({});vm.runInContext(definition('copyPongFaceSwapManualTarget'),c);
  for (const embedding of [[NaN],[Infinity],['0.2'],new Array(1025).fill(.2),{}]) {
    assert.throws(()=>c.copyPongFaceSwapManualTarget({x:.2,y:.4,identityEmbedding:embedding}),/identity is invalid/);
  }
  assert.equal(c.copyPongFaceSwapManualTarget(null),null);
  assert.throws(()=>c.copyPongFaceSwapManualTarget({x:NaN,y:.4}),/position is invalid/);
});
test('quick original hydration failure invokes recovery instead of claiming readiness', async () => {
  let recover;
  const frame={wrapper:{dataset:{}},video:{pause(){}}};
  const state={settingsOpenGeneration:1,settingsEditor:null};
  const recovered=new Promise(r=>recover=r);
  const c=vm.createContext({AbortController,pongFaceSwapState:state,clearPongFaceSwapPrefetches(){},
    capturePongFaceSwapSettingsFrame:()=>frame,createPongFaceSwapFrameEditor:()=>({frame}),
    setPongFaceSwapSettingsViewControlsVisible(){},renderPongFaceSwapSettingsFaces(){},
    fetchPongQuickFaceBoxes:async()=>[box],setPongFaceSwapSettingsStatus(){},
    pongFaceSwapPlayableSource:()=>({source:'https://example.invalid/stock.mp4'}),pongFaceSwapPrimaryFaceId:x=>x,
    pongFaceSwapControlFetch:async()=>({ok:true,json:async()=>({preview:{id:'own'}})}),
    fetchPongOriginalDetectedFaces:async()=>[face],hydratePongFaceSwapOriginalFrame:async()=>false,
    recoverPongQuickFaceDetectFailure:(editor,error)=>{recover({editor,error});}});
  vm.runInContext(definition('beginPongFaceSwapFrameEditor'),c);
  assert.equal(await c.beginPongFaceSwapFrameEditor(1,{renderPreview:false}),true);
  const result=await recovered;
  assert.equal(result.editor,state.settingsEditor);
  assert.match(result.error.message,/Original frame could not be loaded/);
});
test('no-face quick Detect restores playback instead of leaving a hidden paused editor', async () => {
  const editor={frame:{wasPlaying:true}};let closed=0;
  const state={settingsOpenGeneration:0,settingsEditor:editor};
  const c=vm.createContext({performance,document:{getElementById:()=>null},pongFaceSwapState:state,
    pongFaceSwapCurrentWrapper:()=>({dataset:{pongFaceSwapActive:'true'}}),
    openPongFaceSwapSettingsPanel:async()=>{state.settingsOpenGeneration++;},
    togglePongFaceSwapFaceDetect:async()=>false,showSortingIndicator(){},
    closePongFaceSwapSettingsPanel:async()=>{closed++;state.settingsEditor=null;}});
  vm.runInContext(definition('openQuickPongFaceDetect'),c);
  assert.equal(await c.openQuickPongFaceDetect(),false);
  assert.equal(closed,1);assert.equal(editor.frame.wasPlaying,true);
  assert.equal(state.lastDetectTimings.found,false);
});
test('entire Pong inline script parses after fast-path changes', () => {
  let count=0;
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if(m[1].trim() && !m[0].includes('application/ld+json')) {new vm.Script(m[1]);count++;}
  }
  assert.ok(count>0);
});
