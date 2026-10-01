import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installShortDepartureTrial} from './lib/tiktok-short-departure-trial.mjs';

function fixture(){
  const events=[],timers=new Map();let seq=0;
  const w={__pongDomSwap:{sessionId:'old',pageUrl:'old-page'},
    __pongTikTokObservedVideo:{pageUrl:'old-page'},
    __pongAuditDeparture:raw=>events.push(JSON.parse(raw))};
  w.__pongDomSwapDepart=()=>{w.__pongDomSwap=null;return 'existing-result'};
  const original=w.__pongDomSwapDepart;
  vm.runInNewContext(`(${installShortDepartureTrial.toString()})()`,{
    window:w,performance:{now:()=>100},setTimeout:f=>{timers.set(++seq,f);return seq},
    clearTimeout:id=>timers.delete(id)});
  return {w,events,timers,original,tick:()=>{for(const f of [...timers.values()])f()}};
}
test('only an actually cleared old owner yields; same-page no-op returns exact owner',()=>{
  const f=fixture();assert.equal(f.w.__pongDomSwapDepart(),'existing-result');
  assert.equal(f.events[0].kind,'depart');assert.equal(f.events[0].sessionId,'old');
  f.tick();assert.equal(f.events[1].kind,'return');
  assert.equal(f.events[1].requestId,f.events[0].requestId);
  f.w.__pongDomSwapDepart();assert.equal(f.events.length,2);
});
test('incoming post never returns or yields its own session',()=>{
  const f=fixture();f.w.__pongDomSwapDepart();
  f.w.__pongTikTokObservedVideo.pageUrl='incoming-page';
  f.w.__pongDomSwap={sessionId:'new'};f.tick();assert.equal(f.events.length,1);
});
test('cleanup cancels outstanding recovery timer and restores only its own wrapper',()=>{
  const f=fixture();f.w.__pongDomSwapDepart();f.w.__pongUndoShortDeparture();
  assert.equal(f.timers.size,0);assert.equal(f.w.__pongDomSwapDepart,f.original);
  const g=fixture();g.w.__pongDomSwapDepart=()=>123;g.w.__pongUndoShortDeparture();
  assert.equal(g.w.__pongDomSwapDepart(),123);
});
