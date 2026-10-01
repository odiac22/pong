import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = html.match(/function beginPongFaceSwapMediaCallbacks\([^]*?\n}/)[0];
function fixture() {
  const listeners=new Map(), timers=new Map(), frames=new Map();let seq=0;
  const video={
    addEventListener(type,fn) { if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn); },
    removeEventListener(type,fn) { listeners.get(type)?.delete(fn); },
    requestVideoFrameCallback(fn) { const id=++seq;frames.set(id,fn);return id; },
    cancelVideoFrameCallback(id) { frames.delete(id); }
  };
  const context=vm.createContext({Set,setTimeout:fn=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(code,context);
  return {video,listeners,timers,frames,begin:g=>context.beginPongFaceSwapMediaCallbacks(video,g)};
}

test('200 successful scrubs retain one generation, not 200 error closures/timers/frame callbacks',()=>{
  const f=fixture();let fired=0;
  for(let i=0;i<200;i++){
    const scope=f.begin(String(i));scope.listen('error',()=>fired++);
    scope.delay(()=>fired++,20000);scope.frame(()=>fired++);
    assert.equal(f.listeners.get('error').size,1);
    assert.equal(f.timers.size,1);assert.equal(f.frames.size,1);
  }
  for(const fn of f.listeners.get('error'))fn();
  assert.equal(fired,1);
  f.video.__pongFaceSwapMediaCallbacks.dispose();
  assert.equal(f.listeners.get('error').size,0);
  assert.equal(f.timers.size,0);assert.equal(f.frames.size,0);
});

test('a callback already queued before cancellation cannot commit stale work',()=>{
  const f=fixture();let fired=0;
  const old=f.begin('old');old.frame(()=>fired++);old.delay(()=>fired++,160);
  const queued=[...f.frames.values(),...f.timers.values()];
  const current=f.begin('current');old.dispose();
  for(const fn of queued)fn();
  assert.equal(fired,0);assert.equal(f.video.__pongFaceSwapMediaCallbacks,current);
});

test('activation binds callbacks to a scope and stop disposes it',()=>{
  const start=html.match(/async function startPongFaceSwap\([^]*?\n}/)[0];
  assert.match(start,/const mediaCallbacks = beginPongFaceSwapMediaCallbacks\(video, generation\)/);
  assert.doesNotMatch(start,/video\.addEventListener\(/);
  const stop=html.match(/async function stopPongFaceSwapForWrapper\([^]*?\n}/)[0];
  assert.match(stop,/video\.__pongFaceSwapMediaCallbacks\?\.dispose\(\)/);
});
