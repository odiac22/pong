import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function tuneVideoPreloadAround(');
const end=html.indexOf('\nfunction ',start+1);
let loads=0,restored=false;
const video={readyState:0,networkState:2,preload:'auto',dataset:{lastLoadKick:'1'},load(){loads++;this.networkState=2}};
const wrapper={dataset:{},querySelector:()=>video};
const c=vm.createContext({document:{querySelectorAll:()=>[wrapper]},getDeckNetworkWarmIndexes:()=>new Set([0]),
  getDeckIndex:()=>0,DECK_MODE_ENABLED:true,isPongFaceSwapManagedMedia:()=>false,
  suspendDeckVideoNetwork:()=>{throw Error('active card suspended')},
  restoreDeckVideoNetwork:()=>{if(restored)video.networkState=2},pongGenericRecallCaptureActive:()=>true});
vm.runInContext(html.slice(start,end),c);
for(let i=0;i<20;i++)c.tuneVideoPreloadAround(wrapper);
assert.equal(loads,0,'repeated tuning never aborts NETWORK_LOADING');
video.networkState=0;c.tuneVideoPreloadAround(wrapper);
assert.equal(loads,1,'empty media still gets a load kick');
video.networkState=0;video.dataset.lastLoadKick='1';restored=true;c.tuneVideoPreloadAround(wrapper);
assert.equal(loads,1,'restore owns its new request without an immediate second load');
console.log('PASS: preload in-flight ownership regressions');
