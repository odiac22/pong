import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const js=readFileSync(new URL('../ui/pong-modern.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../ui/pong-modern.css',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
test('Standalone UI sources exactly match refresh-delivered inline assets',()=>{
 assert.equal(html.match(/<script id="pong-modern-script">\n([\s\S]*?)<\/script>/)[1],js);
 assert.equal(html.match(/<style id="pong-modern-style">\n([\s\S]*?)<\/style>/)[1],css);
});
test('Elapsed clock supports hours and rejects unavailable/nonfinite values',()=>{
 const source=js.slice(js.indexOf('const clock ='),js.indexOf('  const states ='));
 const clock=vm.runInNewContext(source+';clock');
 for(const [input,want] of [[0,'0:00'],[13.9,'0:13'],[61,'1:01'],[3599,'59:59'],[3600,'1:00:00'],[3661,'1:01:01'],[Infinity,'0:00'],[NaN,'0:00'],[-1,'0:00']]) assert.equal(clock(input),want);
});
test('Full-player posters reuse decoded frames without restoring bottom controls or polling',()=>{
 assert.doesNotMatch(js,/requestVideoFrameCallback|pm-first-frame|pm-transport-play|toDataURL|getImageData/);
 assert.match(js,/capturePreview,reconcileSessionPreview,framePresented,holdPreview/);
 assert.match(js,/while \(snapshots.size>3\)/);
 assert.match(html,/PongModernUI\?\.framePresented\(wrapper, video\)/);
});
test('Exact session image is retained without a false swapped claim, then reconciled only for its owner',()=>{
 const fragment=js.slice(js.indexOf('  function capturePreview('),js.indexOf('  function framePresented('));
 const wrapper={isConnected:true,dataset:{pongFaceSwapSessionId:'session-1',pongFaceSwapFaceId:'face-1',canonicalMediaUrl:'media-1'}};
 const state={video:{},poster:{dataset:{},prepend(){}},canvas:null,preview:null};
 const states=new Map([[wrapper,state]]),snapshots=new Map();
 const document={createElement:()=>({setAttribute(){},getContext:()=>({drawImage(){}})})};
 const context={states,snapshots,document,desiredFace:()=> 'face-1',mediaKey:w=>w.dataset.canonicalMediaUrl,
   frameOwner:()=>null,clearPreview:()=>{},syncPreview:w=>{state.poster.dataset.swapped=String(Boolean(states.get(w).preview?.swapped));}};
 const {capturePreview,reconcileSessionPreview}=vm.runInNewContext(`(()=>{${fragment};return {capturePreview,reconcileSessionPreview};})()`,context);
 const image={naturalWidth:640,naturalHeight:360};
 assert.equal(capturePreview(wrapper,image,null,'session-1'),true);
 assert.equal(state.preview.source,'exact-session-image');
 assert.equal(state.poster.dataset.swapped,'false');
 assert.equal(reconcileSessionPreview(wrapper,'session-1',false),true,'passthrough remains a legitimate preview');
 assert.equal(state.poster.dataset.swapped,'false');
 assert.equal(reconcileSessionPreview(wrapper,'session-1',true),true);
 assert.equal(state.poster.dataset.swapped,'true');
 assert.equal(reconcileSessionPreview(wrapper,'session-2',false),false,'foreign metadata cannot relabel the poster');
 wrapper.dataset.pongFaceSwapSessionId='session-2';
 assert.equal(reconcileSessionPreview(wrapper,'session-1',false),false,'superseded session cannot relabel the poster');
 assert.equal(state.poster.dataset.swapped,'true');
});
test('Timeline delegates to the established swap-aware source clock and seek path',()=>{
 assert.match(js,/pongFaceSwapProgressState\(wrapper,video\)/);
 assert.match(js,/seekPongVideoTo\(wrapper,video,target\)/);
 assert.doesNotMatch(js,/video.currentTime\s*=/);
});

test('Reduced-motion preference and visible keyboard focus are supported',()=>{
 assert.match(css,/prefers-reduced-motion: reduce/);
 assert.match(css,/:focus-visible/);
 assert.match(js,/bar.setAttribute\('role','slider'\)/);
 assert.match(js,/overlay.inert = closed/);
});
test('Compact control chrome avoids per-frame backdrop resampling without touching video pixels',()=>{
 const block=css.match(/body\.pong-compact \*\s*\{([^}]+)\}/)?.[1];
 assert.ok(block);
 assert.match(block,/(?:^|\s)backdrop-filter: none !important;/);
 assert.match(block,/-webkit-backdrop-filter: none !important;/);
 assert.doesNotMatch(block,/(?:^|\s)(?:filter|opacity|transform|width|height|display|visibility)\s*:/);
});
test('Compact presentation never relocates existing controls into a dock or drawer',()=>{
 assert.doesNotMatch(js,/function move\(|pm-dock|pm-tools|pm-library-slot/);
 assert.match(js,/pong-compact/);
 assert.doesNotMatch(css,/\.pong-face-swap-wrap\s*\{|\.save-actions-panel\s*\{|\.show-controls-button\s*\{/);
 assert.match(css,/height: 30px/);
});
