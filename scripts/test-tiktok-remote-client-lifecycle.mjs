import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('./tiktok_remote/client.html',import.meta.url),'utf8');
const code=html.match(/<script>([^]*?)<\/script>/)[1];
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function fixture({holdSwaps=false}={}){
  const elements=new Map(),peers=[],requests=[],offers=[],swaps=[],listeners={};
  const parent={postMessage(){}};
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:id==='#token'?'fixture-pairing-key':'',disabled:false,
      appendChild(){},play:async()=>{},srcObject:null,style:{}});
    return elements.get(id);
  };
  class Peer {
    constructor(){this.connectionState='new';this.iceGatheringState='complete';this.remoteDescriptions=0;peers.push(this);}
    addTransceiver(){}
    createDataChannel(){return this.channel={readyState:'connecting',bufferedAmount:0,send(){}};}
    async createOffer(){return {type:'offer',sdp:'synthetic'};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(){this.remoteDescriptions++;}
    close(){this.closed=true;this.connectionState='closed';this.onconnectionstatechange?.();}
  }
  const context=vm.createContext({
    document:{querySelector:element,createElement:()=>({}),addEventListener(){}},
    location:{pathname:'/pong-tiktok-remote.html',origin:'http://fixture.invalid'},
    localStorage:{getItem:()=> 'fixture-pairing-key',setItem(){}},
    sessionStorage:{getItem:()=>null,setItem(){}},window:{parent,addEventListener:(type,fn)=>listeners[type]=fn},
    RTCPeerConnection:Peer,MediaStream:class{},performance,AbortSignal,
    setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},
    fetch:async url=>{
      requests.push(url);
      if(holdSwaps&&url.endsWith('/swap'))return new Promise(resolve=>swaps.push(()=>resolve({ok:true,status:200,json:async()=>({ok:true})})));
      if(url.endsWith('/offer'))return new Promise(resolve=>offers.push(status=>resolve({
        ok:status===200,status,json:async()=>({type:'answer',sdp:'synthetic-answer'})})));
      return {ok:true,status:200,json:async()=>url.endsWith('/faces')?{faces:[]}:{ok:true,automaticVideoRegion:true}};
    },
  });
  vm.runInContext(code,context);
  element('#token').value='fixture-pairing-key';
  return {context,element,peers,offers,swaps,requests,parent,listeners,
    connect:()=>element('#connect').onclick(),stop:()=>context.stop()};
}

test('swap status uses the current scene, not historical transformed frames',()=>{
  const f=fixture();
  const status=f.context.remoteStatusMessage;
  assert.equal(status({swap:{enabled:true,transformedFrames:500,firstSwappedFrameMs:null}}),'Waiting for a matching face');
  assert.equal(status({swap:{enabled:true,transformedFrames:501,firstSwappedFrameMs:0}}),'Face swap on');
  assert.equal(status({swap:{enabled:false,firstSwappedFrameMs:50}}),'Live');
});

test('retired swap request cannot block or clear a replacement connection request',async()=>{
  const f=fixture({holdSwaps:true});
  const connect=async()=>{const p=f.connect();await tick();f.offers.shift()(200);await p;f.element('#screen').videoWidth=1080;};
  const command=faceId=>f.listeners.message({origin:'http://fixture.invalid',source:f.parent,data:{type:'pong-remote-command',action:'face',faceId}});
  await connect();command('first');await tick();assert.equal(f.swaps.length,1);
  await f.stop();await connect();command('second');await tick();assert.equal(f.swaps.length,2);
  f.swaps.shift()();await tick();
  command('third');await tick();assert.equal(f.swaps.length,1,'new active operation stays serialized');
  f.swaps.shift()();await tick();assert.equal(f.swaps.length,1,'latest selection runs after active request');
  f.swaps.shift()();await tick();await f.stop();
});

test('closing during an offer releases a late accepted controller before reconnect',async()=>{
  const f=fixture();const connecting=f.connect();await tick();
  assert.equal(f.offers.length,1);
  const stopping=f.stop();await tick();
  assert.equal(f.element('#connect').disabled,true);
  f.offers.shift()(200);
  await Promise.all([connecting,stopping]);
  assert.equal(f.peers[0].remoteDescriptions,0);
  assert.equal(f.requests.filter(r=>r.endsWith('/disconnect')).length,1);
  assert.equal(f.element('#connect').disabled,false);
});

test('embedded mode auto-connects once and rejects messages from unrelated frames',async()=>{
  const f=fixture();
  const data={type:'pong-remote-command',action:'initialize',faceId:''};
  f.listeners.message({origin:'http://fixture.invalid',source:{},data});await tick();
  assert.equal(f.offers.length,0);
  f.listeners.message({origin:'https://elsewhere.invalid',source:f.parent,data});await tick();
  assert.equal(f.offers.length,0);
  f.listeners.message({origin:'http://fixture.invalid',source:f.parent,data});await tick();
  assert.equal(f.offers.length,1);
  f.listeners.message({origin:'http://fixture.invalid',source:f.parent,data});await tick();
  assert.equal(f.offers.length,1);
  f.offers.shift()(200);await tick();await f.stop();
});

test('ordinary panel does not expose token entry or manual region controls',()=>{
  assert.doesNotMatch(html,/<input|<select|id="mark"|Paste PC pairing token/);
  assert.match(html,/automaticRegion:true/);
});

test('a rejected second-controller offer never disconnects the existing owner',async()=>{
  const f=fixture();const connecting=f.connect();await tick();
  f.offers.shift()(409);await connecting;
  assert.equal(f.requests.filter(r=>r.endsWith('/disconnect')).length,0);
  assert.equal(f.element('#connect').disabled,false);
});

test('late callbacks from a retired peer cannot attach media or close a replacement',async()=>{
  const f=fixture();const first=f.connect();await tick();f.offers.shift()(200);await first;
  await f.stop();
  const second=f.connect();await tick();f.offers.shift()(200);await second;
  f.peers[0].connectionState='failed';f.peers[0].onconnectionstatechange();
  f.peers[0].ontrack({track:{stale:true}});await tick();
  assert.equal(f.peers[1].closed,undefined);
  assert.equal(f.element('#screen').srcObject,null);
  assert.equal(f.requests.filter(r=>r.endsWith('/disconnect')).length,1);
  await f.stop();
});
