import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync('android-app/app/src/main/assets/tiktok-direct-decoder.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(outputDepth){
  let pending=[],submitted=0,closed=0,decoderClosed=false,finished=false;
  const window={},s={overlay:{getContext:()=>({drawImage(){}}),style:{}},warm:true,
    abort:new AbortController(),transport:{bytes:0,chunks:0},url:'http://fixture.invalid/swap'};
  class Decoder {
    constructor(options){this.output=options.output;this.decodeQueueSize=0;}
    configure(){}
    addEventListener(){}
    decode(sample){
      submitted++;pending.push(sample);
      if(pending.length>=outputDepth)for(const entry of pending.splice(0))
        this.output({timestamp:entry.timestamp,duration:33333,close(){closed++;}});
    }
    flush(){return Promise.resolve();}
    close(){decoderClosed=true;}
  }
  class Parser {
    constructor(config,onSample){config({codedWidth:720,codedHeight:1280});this.onSample=onSample;}
    async push(){for(let n=0;n<80;n++)await this.onSample({timestamp:n*33333,type:'key',data:new Uint8Array(1)});finished=true;}
    finish(){}
  }
  let reads=0;
  vm.runInNewContext(source,{window,document:{documentElement:{classList:{remove(){}}}},performance,
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},VideoDecoder:Decoder,PongAvcFragments:Parser,
    EncodedVideoChunk:class{constructor(sample){Object.assign(this,sample);}},
    fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>++reads===1?{done:false,value:new Uint8Array(1)}:{done:true}})}})});
  const errors=[];
  const direct=window.__pongCreateDirectDecoder(s,{owned:()=>true,fail:e=>errors.push(e)});
  return {s,direct,errors,stats:()=>({submitted,closed,decoderClosed,finished})};
}
test('buffered decoder can receive twelve inputs before its first output',async()=>{
  const f=fixture(12);try{
    await tick();await tick();
    assert.equal(f.stats().submitted,12);
    assert.equal(f.direct.sync().decodedFrames,12);
    assert.equal(f.direct.sync().queuedFrames,12);
    assert.equal(f.stats().finished,false);
  }finally{f.direct.close();await tick();}
  assert.equal(f.stats().closed,12);assert.equal(f.stats().decoderClosed,true);
  assert.equal(f.stats().finished,true);assert.deepEqual(f.errors,[]);
});
test('immediate decoder backpressures at eight ready frames',async()=>{
  const f=fixture(1);try{await tick();assert.equal(f.stats().submitted,8);}
  finally{f.direct.close();await tick();}
  assert.equal(f.stats().closed,8);assert.deepEqual(f.errors,[]);
});
test('decoder with no outputs remains bounded and retirement releases credit',async()=>{
  const f=fixture(100);try{await tick();assert.equal(f.stats().submitted,24);assert.equal(f.stats().finished,false);}
  finally{f.direct.close();await tick();}
  assert.equal(f.stats().submitted,24);assert.equal(f.stats().finished,true);
  assert.equal(f.stats().decoderClosed,true);assert.deepEqual(f.errors,[]);
});
