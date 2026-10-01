import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizePlaybackEvents} from './lib/tiktok-playback-events.mjs';
const run=events=>({holdMs:5000,clockCalibration:{minOffset:0,maxOffset:0},
 trials:[{index:1,startedAt:0,beforePostKey:'video:111',samples:[{view:{postKey:'video:222'}}]}],
 paintDrains:[{mediaEvents:events.map(e=>({videoId:'222',visible:true,role:'original',paused:false,seeking:false,...e}))}]});
test('visible waiting interval is counted even for a clip without a face',()=>{
 const [s]=summarizePlaybackEvents(run([{type:'waiting',at:100},{type:'waiting',at:200},{type:'playing',at:400}]));
 assert.equal(s.waitingIntervals.length,1);assert.equal(s.waitingMs,300);
});
test('network stall does not fabricate a playback freeze; outgoing and hidden events excluded',()=>{
 const [s]=summarizePlaybackEvents(run([{type:'stalled',at:100},{type:'waiting',at:100,visible:false},
   {type:'waiting',at:100,videoId:'111'}]));
 assert.equal(s.waitingMs,0);assert.equal(s.networkStalledEvents,1);
});
test('paused or seeking media does not count as unwanted buffering',()=>{
 const [s]=summarizePlaybackEvents(run([{type:'waiting',at:100,paused:true},{type:'waiting',at:200,seeking:true}]));
 assert.equal(s.waitingMs,0);
});
test('unresolved wait counts to the viewing boundary, never disappears',()=>{
 const [s]=summarizePlaybackEvents(run([{type:'waiting',at:4200}]));
 assert.equal(s.waitingMs,800);
});
test('a hidden playing event closes a wait instead of extending it to end of visit',()=>{
 const [s]=summarizePlaybackEvents(run([{type:'waiting',at:100},
  {type:'visibility',at:300,visible:false},{type:'playing',at:400,visible:false}]));
 assert.equal(s.waitingMs,200);assert.equal(s.waitingIntervals[0].endedBy,'hidden');
});
test('buffering original under swapped pixels is not a visible freeze; reveal resumes counting',()=>{
 const [s]=summarizePlaybackEvents(run([{type:'waiting',at:100,visible:false},
  {type:'visibility',at:600,visible:true},{type:'playing',at:800}]));
 assert.equal(s.waitingMs,200);assert.equal(s.hiddenWaitingEvents,1);
});
