import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('    let pendingProgressSeek = null;');
const block=html.slice(start,html.indexOf("    const tapArea = document.createElement('div');",start));
function fixture(managed=true){
 let clock=1000;
 const barEvents=new Map(),docEvents=new Map(),calls={seek:[],suspend:0,resume:0};
 const classes={add(){},remove(){},contains(){return false;}};
 const progressBar={getBoundingClientRect:()=>({left:0,width:400}),matches:()=>false,
   addEventListener:(type,fn)=>barEvents.set(type,fn)};
 const video={currentTime:7};
 const context=vm.createContext({Date:{now:()=>clock},Math,Number,window:{},video,wrapper:{},progressBar,
   progressFill:{style:{},classList:classes},scrubberHandle:{style:{}},setTimeout:()=>0,
   document:{activeElement:null,body:{classList:classes},
     addEventListener:(type,fn)=>docEvents.set(type,fn),removeEventListener:(type)=>docEvents.delete(type)},
   pongFaceSwapFullDuration:()=>100,isPongFaceSwapManagedMedia:()=>managed,
   suspendPongFaceSwapForScrub:()=>calls.suspend++,resumePongFaceSwapAfterScrub:()=>calls.resume++,
   seekPongVideoTo:(_w,_v,t)=>calls.seek.push(t)});
 vm.runInContext(block,context);
 const event=(x,y=20)=>({clientX:x,clientY:y,touches:[{clientX:x,clientY:y}],changedTouches:[{clientX:x,clientY:y}],preventDefault(){},stopPropagation(){}});
 const touch=(x,delay=100)=>{clock+=delay;barEvents.get('touchstart')(event(x));clock+=30;docEvents.get('touchend')(event(x));};
 const mouse=(x,delay=100)=>{clock+=delay;barEvents.get('mousedown')(event(x));clock+=30;docEvents.get('mouseup')?.(event(x));barEvents.get('click')(event(x));};
 return{calls,video,touch,mouse,event,barEvents,docEvents,tick:n=>clock+=n};
}
test('single touch does not move timeline or suspend playback',()=>{const f=fixture(false);f.touch(200);assert.deepEqual(f.calls.seek,[]);assert.equal(f.video.currentTime,7);assert.equal(f.calls.suspend,0);});
test('nearby double touch commits once to the second position',()=>{const f=fixture();f.touch(200);f.touch(208);assert.deepEqual(f.calls.seek,[52]);assert.equal(f.calls.suspend,1);});
test('distant taps and expired taps cannot jump the timeline',()=>{const f=fixture();f.touch(100);f.touch(300);f.touch(300,500);assert.deepEqual(f.calls.seek,[]);});
test('sliding a finger on the bar cannot scrub ordinary media',()=>{const f=fixture(false);f.barEvents.get('touchstart')(f.event(80));f.docEvents.get('touchmove')(f.event(200));assert.equal(f.video.currentTime,7);f.docEvents.get('touchend')(f.event(200));assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.suspend,0);f.touch(200);assert.deepEqual(f.calls.seek,[]);});
test('sliding on the bar cannot suspend or seek a managed swap',()=>{const f=fixture();f.barEvents.get('touchstart')(f.event(80));f.docEvents.get('touchmove')(f.event(200));assert.equal(f.video.currentTime,7);f.docEvents.get('touchend')(f.event(200));assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.suspend,0);});
test('small finger jitter stays a tap',()=>{const f=fixture();f.barEvents.get('touchstart')(f.event(200));f.docEvents.get('touchmove')(f.event(203));f.docEvents.get('touchend')(f.event(203));assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.suspend,0);});
test('synthetic mouse events after touch cannot bypass double-tap rule',()=>{const f=fixture();f.touch(200);f.barEvents.get('mousedown')(f.event(200));f.barEvents.get('click')(f.event(200));assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.suspend,0);});
test('every mouse seek requires a fresh pair, including clicks after a double click',()=>{const f=fixture();f.mouse(200);assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.suspend,0);f.mouse(208);assert.deepEqual(f.calls.seek,[52]);f.mouse(210);assert.deepEqual(f.calls.seek,[52]);f.mouse(216);assert.deepEqual(f.calls.seek,[52,54]);});
test('every touch seek requires a fresh pair, including third and later taps',()=>{const f=fixture();f.touch(200);f.touch(208);f.touch(210);assert.deepEqual(f.calls.seek,[52]);f.touch(216);assert.deepEqual(f.calls.seek,[52,54]);f.touch(220,800);assert.deepEqual(f.calls.seek,[52,54]);});
test('delayed compatibility clicks cannot bypass a consumed touch pair',()=>{const f=fixture();f.touch(200);f.touch(208);f.tick(1200);f.barEvents.get('click')(f.event(300));f.barEvents.get('mousedown')({...f.event(300),sourceCapabilities:{firesTouchEvents:true}});assert.deepEqual(f.calls.seek,[52]);f.touch(300);assert.deepEqual(f.calls.seek,[52]);});
test('mouse dragging on the bar is ignored and cannot arm a following single click',()=>{const f=fixture(false);f.barEvents.get('mousedown')(f.event(80));f.docEvents.get('mousemove')(f.event(200));assert.equal(f.video.currentTime,7);f.docEvents.get('mouseup')(f.event(200));f.barEvents.get('click')(f.event(200));assert.deepEqual(f.calls.seek,[]);f.mouse(210);assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.suspend,0);});
test('mouse and touch cannot form a mixed accidental pair',()=>{const f=fixture();f.mouse(200);f.touch(200);assert.deepEqual(f.calls.seek,[]);f.tick(800);f.mouse(200);assert.deepEqual(f.calls.seek,[]);});
test('expired or distant mouse pairs cannot seek',()=>{const f=fixture();f.mouse(100);f.mouse(300);f.mouse(300,800);assert.deepEqual(f.calls.seek,[]);});
test('a double tap followed immediately by a far-away single tap cannot seek again',()=>{const f=fixture();f.touch(100);f.touch(108);f.touch(350,0);assert.deepEqual(f.calls.seek,[27]);assert.equal(f.docEvents.has('touchend'),false);});
test('interrupted contact cancels old release ownership before accepting another touch',()=>{const f=fixture();f.barEvents.get('touchstart')(f.event(100));f.docEvents.get('touchmove')(f.event(200));f.barEvents.get('touchstart')(f.event(350));f.docEvents.get('touchend')(f.event(350));assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.resume,0);});
test('ending another finger cannot consume the active contact release',()=>{const f=fixture();const start=f.event(100);start.touches[0].identifier=1;f.barEvents.get('touchstart')(start);const other=f.event(300);other.changedTouches[0].identifier=2;f.docEvents.get('touchend')(other);assert.equal(f.docEvents.has('touchend'),true);const own=f.event(100);own.changedTouches[0].identifier=1;f.docEvents.get('touchend')(own);assert.equal(f.docEvents.has('touchend'),false);assert.deepEqual(f.calls.seek,[]);});
test('cancelled bar slide never takes swap ownership',()=>{const f=fixture();f.barEvents.get('touchstart')(f.event(100));f.docEvents.get('touchmove')(f.event(200));f.docEvents.get('touchcancel')(f.event(200));assert.deepEqual(f.calls.seek,[]);assert.equal(f.calls.resume,0);assert.equal(f.calls.suspend,0);});

test('bar slide with missing move events still cannot form a tap pair',()=>{for(const type of ['touch','mouse']){const f=fixture();f[type](200);f.barEvents.get(type==='touch'?'touchstart':'mousedown')(f.event(80));f.docEvents.get(type==='touch'?'touchend':'mouseup')(f.event(200));assert.deepEqual(f.calls.seek,[]);f[type](200);assert.deepEqual(f.calls.seek,[]);}});
test('cancelled resting touch never resumes a paused video',()=>{const f=fixture();f.barEvents.get('touchstart')(f.event(100));f.docEvents.get('touchcancel')(f.event(100));assert.equal(f.calls.resume,0);});
test('touch held for a long time does not arm a tap',()=>{const f=fixture();f.barEvents.get('touchstart')(f.event(200));f.tick(800);f.docEvents.get('touchend')(f.event(200));f.touch(200);assert.deepEqual(f.calls.seek,[]);});
test('progress strip moves eight pixels upward without relocating buttons',()=>{assert.match(html,/\.pong-compact \.video-progress-container[^}]*bottom: 8px/);});
const declaration=name=>html.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0];
test('HLS level choice uses resolution, FPS and bitrate rather than manifest order',()=>{
 const ctx=vm.createContext({});vm.runInContext(declaration('pongHighestHlsLevelIndex'),ctx);
 assert.equal(ctx.pongHighestHlsLevelIndex([{width:426,height:240},{width:1920,height:1080,bitrate:4e6},{width:1280,height:720},{width:1920,height:1080,bitrate:5e6}]),3);
 assert.equal(ctx.pongHighestHlsLevelIndex([]),-1);
});
test('swap takeover retires the old HLS controller before source assignment',()=>{
 let destroys=0;const ctx=vm.createContext({});vm.runInContext(declaration('releasePongHlsController'),ctx);
 const video={dataset:{pongHlsQuality:'426x240'},__pongHls:{destroy(){destroys++;}}};
 ctx.releasePongHlsController(video);ctx.releasePongHlsController(video);assert.equal(destroys,1);assert.equal(video.__pongHls,null);
 assert.match(html,/releasePongHlsController\(video\);\s+video.src = foregroundStreamUrl/);
 assert.match(html,/releasePongHlsController\(video\);\s+video.src = attachedStreamHref/);
});
