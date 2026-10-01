import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync('android-app/app/src/main/assets/tiktok-mobile.js','utf8');
const part=code.slice(code.indexOf('  const cinemaViewports ='),code.indexOf('  const scan ='));
const bounds=()=>vm.runInNewContext(`(()=>{${part}return navigationBounds})()`,{innerHeight:850,getComputedStyle:n=>({overflowY:n.overflow||'visible'})});
test('cinema swipe surface remains the playlist viewport when pixels are half offscreen',()=>{
 const expected={top:0,bottom:850,left:0,right:400};
 const cinema={contains:n=>n===viewport};
 const viewport={isConnected:true,clientHeight:850,overflow:'auto',parentElement:cinema,getBoundingClientRect:()=>expected};
 const media={parentElement:viewport,closest:()=>cinema,getBoundingClientRect:()=>({top:-400,bottom:280})};
 assert.equal(bounds()(media),expected);
});
test('comment column and creator grid are not included in the video gesture region',()=>{
 const expected={left:0,right:400,top:0,bottom:850};
 const cinema={contains:()=>true};
 const viewport={isConnected:true,clientHeight:850,overflow:'auto',parentElement:cinema,getBoundingClientRect:()=>expected};
 const media={parentElement:viewport,closest:()=>cinema};
 assert.equal(bounds()(media).right,400);
 const gridMedia={closest:()=>null,getBoundingClientRect:()=>({top:100,bottom:220})};
 assert.equal(bounds()(gridMedia).bottom,220);
});
test('feed letterboxing belongs to its card rather than only the raster pixels',()=>{
 const card={getBoundingClientRect:()=>({top:0,bottom:786})};
 const media={closest:s=>s.includes('Cinema')?null:card,getBoundingClientRect:()=>({top:260,bottom:480})};
 assert.equal(bounds()(media).bottom,786);
});
test('cached viewport geometry remains live and replaced ancestors are rediscovered',()=>{
 const cinema={contains:()=>true};let top=0;
 const first={isConnected:true,clientHeight:850,overflow:'auto',parentElement:cinema,getBoundingClientRect:()=>({top})};
 const second={...first,getBoundingClientRect:()=>({top:30})};
 const media={parentElement:first,closest:()=>cinema};const get=bounds();
 assert.equal(get(media).top,0);top=10;assert.equal(get(media).top,10);
 first.isConnected=false;media.parentElement=second;assert.equal(get(media).top,30);
});
