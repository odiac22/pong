import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync('index.html','utf8');
const warm=html.slice(html.indexOf('function warmPongFaceSwapEngine('),html.indexOf('\nasync function fetchPongFaceSwapFaces('));
const entry=html.slice(html.indexOf('function openPongTikTokLiveMode('),html.indexOf('\nif (tiktokLiveButton)'));
const response={ok:true,json:async()=>({ready:true})};
test('warm requests are single-flight per profile; generic warm cannot mask TikTok warm',async()=>{
  const calls=[];
  const context=vm.createContext({Map,pongFaceSwapControlFetch:(url,opts)=>new Promise(resolve=>calls.push({url,opts,resolve}))});
  vm.runInContext('const pongFaceSwapWarmPromises=new Map();'+warm,context);
  const a=context.warmPongFaceSwapEngine(),b=context.warmPongFaceSwapEngine('tiktok-face-size'),c=context.warmPongFaceSwapEngine('tiktok-gpen512');
  assert.equal(context.warmPongFaceSwapEngine('tiktok-face-size'),b);
  assert.equal(context.warmPongFaceSwapEngine('tiktok-gpen512'),c);
  assert.equal(calls.length,3);
  assert.equal(calls[0].url,'/pong-swap/warm');
  assert.equal(calls[1].url,'/pong-swap/warm?profile=tiktok-face-size');
  assert.equal(calls[2].url,'/pong-swap/warm?profile=tiktok-gpen512');
  calls.forEach(c=>c.resolve(response));await Promise.all([a,b,c]);
  const again=context.warmPongFaceSwapEngine('tiktok-face-size');
  assert.equal(calls.length,4);calls[3].resolve(response);await again;
});
test('TikTok entry starts profile warm without waiting or changing navigation',()=>{
  const calls=[],location={search:'?pongNative=1',href:''};
  const context=vm.createContext({URLSearchParams,location,
    warmPongFaceSwapEngine:profile=>{calls.push(profile);return new Promise(()=>{});},
    hideControls:()=>calls.push('hide'),window:{open:()=>assert.fail('must use native entry')}});
  vm.runInContext(entry,context);context.openPongTikTokLiveMode();
  assert.deepEqual(calls,['tiktok-gpen512','hide']);
  assert.equal(location.href,'pong-native://tiktok/open');
});
test('failed optional warm releases single-flight and does not block later retries',async()=>{
  let calls=0;
  const context=vm.createContext({Map,pongFaceSwapControlFetch:async()=>{calls++;throw Error('offline');}});
  vm.runInContext('const pongFaceSwapWarmPromises=new Map();'+warm,context);
  assert.equal(await context.warmPongFaceSwapEngine('tiktok-face-size'),null);
  assert.equal(await context.warmPongFaceSwapEngine('tiktok-face-size'),null);
  assert.equal(calls,2);
});
