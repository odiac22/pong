import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const names=['hasVideoPlayableData','getVideoReadyPercent','getVideoPlayableBufferTarget','updateVideoReadyLoader'];
const code=names.map(name=>html.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0]).join('\n');
function fixture() {
  const classes=new Set();
  const list={add:s=>classes.add(s),remove:s=>classes.delete(s),toggle:(s,on)=>on?classes.add(s):classes.delete(s)};
  const text={textContent:'8%',classList:list};
  const loader={style:{display:'none'},classList:list};
  const wrapper={dataset:{readyOverlayDismissed:'true',readyPlayable:'false'},style:{setProperty(){}},querySelector:s=>s.includes('percent')?text:loader};
  const video={readyState:3,error:null,duration:60,currentTime:4,ended:false,ahead:1,closest:()=>wrapper};
  const context=vm.createContext({Math,Number,Boolean,String,getVideoBufferedAheadSeconds:v=>v.ahead,pongPlayableBufferSeconds:()=>6,updateVideoBufferedProgressBar(){},updateBatchReadyCounter(){},updateViewedRemainingCounter(){},maybePromoteReadyDeckVideo(){}});
  vm.runInContext(code,context);
  return {video,wrapper,text,loader,classes,update:()=>context.updateVideoReadyLoader(video)};
}
test('growing swap stream with one second available is ready despite six-second reserve',()=>{
  const f=fixture();f.update();assert.equal(f.text.textContent,'Ready');assert.equal(f.wrapper.dataset.readyPlayable,'true');assert.equal(f.loader.style.display,'none');assert.equal(f.classes.has('not-ready'),false);
});
test('a previously playing card updates to neutral buffering when data runs out',()=>{
  const f=fixture();f.update();f.video.readyState=2;f.video.ahead=0;f.update();assert.equal(f.wrapper.dataset.readyPlayable,'false');assert.match(f.text.textContent,/^Buffering /);assert.equal(f.loader.style.display,'');assert.equal(f.classes.has('not-ready'),false);
});
test('a real media error is visible and red even after playback dismissed the loader',()=>{
  const f=fixture();f.video.error={code:3};f.update();assert.equal(f.text.textContent,'Playback error');assert.equal(f.wrapper.dataset.readyPlayable,'false');assert.equal(f.loader.style.display,'');assert.equal(f.classes.has('not-ready'),true);
});
test('duration metadata without decoded data does not count as playable',()=>{
  const f=fixture();f.video.readyState=1;f.video.ahead=0;f.update();assert.equal(f.wrapper.dataset.readyPlayable,'false');assert.match(f.text.textContent,/^Buffering /);
});

test('truncated swapped EOF uses presented frames, not a duration-jumping clock',()=>{
 const fn=html.match(/function pongFaceSwapEndedEarly\([^]*?\n}/)[0];
 const context=vm.createContext({pongFaceSwapProgressState:()=>({currentTime:20,duration:20})});
 vm.runInContext(fn,context);
 const wrapper={dataset:{pongFaceSwapGeneration:'new'}};
 const video={__pongSwapPresentedMediaTime:7.4,__pongSwapPresentedGeneration:'new',__pongSwapOriginal:{startSeconds:0}};
 assert.equal(context.pongFaceSwapEndedEarly(wrapper,video),true);
 video.__pongSwapPresentedMediaTime=19.96;
 assert.equal(context.pongFaceSwapEndedEarly(wrapper,video),false);
 video.__pongSwapPresentedMediaTime=7.4;video.__pongSwapOriginal.startSeconds=12.6;
 assert.equal(context.pongFaceSwapEndedEarly(wrapper,video),false);
 video.__pongSwapOriginal.startSeconds=0;video.__pongSwapPresentedGeneration='old';
 assert.equal(context.pongFaceSwapEndedEarly(wrapper,video),false);
});

test('playback heartbeats also inspect late encoder errors after initial readiness',()=>{
 const fn=html.match(/function reportPongFaceSwapPlayback\([^]*?\n}/)[0];
 assert.match(fn,/payload\?\.session\?\.error/);
 assert.match(fn,/pongFaceSwapGeneration !== generation/);
});
