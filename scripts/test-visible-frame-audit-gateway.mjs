import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createVisibleFrameAuditGateway} from './lib/visible-frame-audit-gateway.mjs';

const CAPABILITY = 'a1'.repeat(32);
const TOKEN = 'renderer-private-token-'.repeat(3);
const FACE = 'Approved 11';
const WIDTH = 16, HEIGHT = 16;

function inputFrame(nonceByte=1, sequence=1, sceneEpoch=4, mediaTime=1.25) {
  const frame = Buffer.alloc(64 + WIDTH * HEIGHT * 4);
  frame.writeUInt32BE(0x50564641, 0);
  frame[4] = 1; frame[5] = 1;
  frame.fill(nonceByte, 8, 24);
  frame.writeUInt32BE(sequence, 24);
  frame.writeInt32BE(sceneEpoch, 28);
  frame.writeDoubleBE(mediaTime, 32);
  frame.writeUInt32BE(2, 40);
  frame.writeUInt16BE(WIDTH, 44); frame.writeUInt16BE(HEIGHT, 46);
  frame.writeFloatBE(0, 48); frame.writeFloatBE(0, 52);
  frame.writeFloatBE(WIDTH, 56); frame.writeFloatBE(HEIGHT, 60);
  for (let i=64; i<frame.length; i+=4) {
    frame[i]=10; frame[i+1]=20; frame[i+2]=30; frame[i+3]=255;
  }
  return frame;
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(predicate) {
  for (let attempt=0; attempt<200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('fixture did not settle');
}

async function rendererFixture({frameStatus=200, delayMs=0, wrongSeq=false,
  largeResponse=false, wrongFaceIds=false, persistent=false,
  largeStatus=false}={}) {
  const calls = {create:0, frame:0, status:0, delete:0, authorized:true, rgb:null,
    frameParams:[]};
  const id = 'owned_fake_renderer_session_1234';
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) calls.authorized=false;
    if (req.method === 'POST' && req.url === '/remote-sessions') {
      calls.create++;
      const body = await new Promise(resolve => {
        const chunks=[];req.on('data', part=>chunks.push(part));
        req.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));
      });
      assert.deepEqual(body.faceIds, [FACE]);
      assert.equal(body.restorationProfile, 'tiktok-face-size');
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ok:true,session:{id,faceId:FACE,
        faceIds:wrongFaceIds?[]:[FACE],
        width:WIDTH,height:HEIGHT,restorationProfile:'tiktok-face-size'}}));
    } else if (req.method === 'PUT' && req.url?.startsWith(`/remote-sessions/${id}/frame?`)) {
      calls.frame++;
      const params=new URL(req.url,'http://127.0.0.1').searchParams;
      calls.frameParams.push({sequence:Number(params.get('seq')),
        cut:params.get('cut'),timestamp:Number(params.get('timestampMs'))});
      if (!persistent) assert.match(req.url, /seq=1&cut=true&timestampMs=1250/);
      const chunks=[];for await (const part of req) chunks.push(part);
      calls.rgb = Buffer.concat(chunks);
      if (delayMs) await new Promise(resolve=>setTimeout(resolve, delayMs));
      if (frameStatus !== 200) {res.writeHead(frameStatus);res.end('unavailable');return;}
      const rgb = Buffer.alloc(largeResponse ? WIDTH*HEIGHT*3+1 : WIDTH*HEIGHT*3);
      for (let i=0;i<rgb.length;i+=3) {rgb[i]=90;rgb[i+1]=80;rgb[i+2]=70;}
      res.writeHead(200, {'Content-Type':'application/octet-stream',
        'X-Pong-Remote-Seq':wrongSeq?'2':params.get('seq'),
        'X-Pong-Remote-Transformed':'1',
        'X-Pong-Remote-Render-Ms':'42.5'});
      res.end(rgb);
    } else if (req.method === 'GET' && req.url === `/remote-sessions/${id}`) {
      calls.status++;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ok:true,session:{id,faceId:FACE,
        width:WIDTH,height:HEIGHT,restorationProfile:'tiktok-face-size',
        faceIds:[FACE],lastSequence:persistent?calls.frameParams.at(-1).sequence:1,
        frames:persistent?calls.frame:1,closed:false,
        transformedFrames:persistent?calls.frame:1,
        restorerModels:['GPEN512','GPEN1024'],
        adaptiveRestoration:{model:'GPEN512',GPEN512Frames:1,
          GPEN1024Frames:0,sourceFaceCropPixels:12345},
        ...(persistent ? {frameDiagnostics:{records:[{frameIndex:calls.frame-1,
          acquisitionAttempted:true,selectionAccepted:true,selectionMs:2.5,
          processingMs:12,totalMs:15,detections:1,matchSelected:true,
          exactDelta:1,reuseDelta:0,unsafeUrl:'SECRET',
          ...(largeStatus ? {untrustedPadding:'x'.repeat(20_000)} : {})}]}} : {})}}));
    } else if (req.method === 'DELETE' && req.url === `/remote-sessions/${id}`) {
      calls.delete++;
      res.setHeader('Content-Type','application/json');res.end('{"ok":true,"deleted":true}');
    } else {res.writeHead(404);res.end();}
  });
  const base = await listen(server);
  return {calls,base,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function fixture(options={}) {
  const renderer=await rendererFixture({...options.renderer,persistent:options.persistentSession});
  const records=[];
  const gateway=createVisibleFrameAuditGateway({capability:CAPABILITY,
    faceIds:[FACE],token:TOKEN,rendererBase:renderer.base,
    onRecord:row=>records.push(row),maxRequests:options.maxRequests||30,
    persistentSession:options.persistentSession||false});
  const base=await listen(gateway.server);
  return {renderer,gateway,base,records,close:async()=>{
    await gateway.close();await renderer.close();
  }};
}

function send(base, body, capability=CAPABILITY, extra={}) {
  return fetch(`${base}/frame`, {method:'POST',headers:{
    'Content-Type':'application/octet-stream',
    'Authorization':`Bearer ${capability}`,...extra},body});
}

test('exact owned frame renders offscreen, preserves header, reports numeric evidence, deletes session', async()=>{
  const f=await fixture();
  try {
    const input=inputFrame();
    const response=await send(f.base,input);
    assert.equal(response.status,200);
    const output=Buffer.from(await response.arrayBuffer());
    assert.equal(output.length,input.length);
    assert.deepEqual(output.subarray(0,6),input.subarray(0,6));
    assert.equal(output[6],1);assert.equal(output[7],1);
    assert.deepEqual(output.subarray(8,64),input.subarray(8,64));
    assert.deepEqual([...output.subarray(64,68)],[90,80,70,255]);
    assert.deepEqual([...f.renderer.calls.rgb.subarray(0,3)],[10,20,30]);
    assert.equal(f.renderer.calls.rgb.length,WIDTH*HEIGHT*3);
    assert.equal(f.renderer.calls.authorized,true);
    await waitFor(()=>f.records.length>0);
    assert.equal(f.renderer.calls.delete,1);
    assert.equal(f.records[0].restoration.modelSize,512);
    assert.equal(f.records[0].restoration.gpen512Frames,1);
    assert.equal(f.records[0].cleanupConfirmed,true);
    assert.equal(f.records[0].responseFinished,true);
    assert.doesNotMatch(JSON.stringify(f.records),/owned_fake|renderer-private|a1a1a1/);
  } finally {await f.close();}
});

test('capability, path, replay, request cap, and content-length are enforced before renderer', async()=>{
  const f=await fixture({maxRequests:1});
  try {
    assert.equal((await send(f.base,inputFrame(), 'b2'.repeat(32))).status,401);
    assert.equal((await fetch(`${f.base}/remote-sessions`,{method:'POST',body:'x'})).status,404);
    assert.equal((await send(f.base,inputFrame())).status,200);
    assert.equal((await send(f.base,inputFrame(2))).status,410);
    assert.equal(f.renderer.calls.create,1);
  } finally {await f.close();}
  const g=await fixture();
  try {
    assert.equal((await send(g.base,inputFrame())).status,200);
    assert.equal((await send(g.base,inputFrame())).status,400);
    const short=inputFrame(3).subarray(0,100);
    assert.equal((await send(g.base,short)).status,400);
    assert.equal(g.renderer.calls.create,1);
  } finally {await g.close();}
});

test('one in flight and failure cleanup including malformed renderer output', async()=>{
  const f=await fixture({renderer:{delayMs:150}});
  try {
    const first=send(f.base,inputFrame(4));
    await new Promise(resolve=>setTimeout(resolve,40));
    const busy=await send(f.base,inputFrame(5));
    assert.equal(busy.status,429);
    assert.equal((await first).status,200);
    assert.equal(f.renderer.calls.create,1);
  } finally {await f.close();}
  for (const renderer of [{frameStatus:500},{wrongSeq:true},{largeResponse:true}]) {
    const g=await fixture({renderer});
    try {
      assert.equal((await send(g.base,inputFrame(6))).status,502);
      await waitFor(()=>g.records.length>0);
      assert.equal(g.renderer.calls.delete,1);
      assert.equal(g.records.some(row=>row.ok===true),false);
    } finally {await g.close();}
  }
  const wrong=await fixture({renderer:{wrongFaceIds:true}});
  try {
    assert.equal((await send(wrong.base,inputFrame(8))).status,502);
    await waitFor(()=>wrong.records.length>0);
    assert.equal(wrong.renderer.calls.frame,0);
    assert.equal(wrong.renderer.calls.delete,1);
    assert.equal(wrong.records[0].cleanupConfirmed,true);
  } finally {await wrong.close();}
});

test('invalid input flags and oversized declared body fail without renderer work', async()=>{
  const f=await fixture();
  try {
    const invalid=inputFrame(7);invalid[6]=1;
    assert.equal((await send(f.base,invalid)).status,400);
    const status=await new Promise(resolve=>{
      const request=http.request(`${f.base}/frame`,{method:'POST',headers:{
        'Content-Type':'application/octet-stream',
        'Authorization':`Bearer ${CAPABILITY}`,
        'Content-Length':String(16*1024*1024+65)}},response=>{
          response.resume();response.on('end',()=>resolve(response.statusCode));
        });
      request.end();
    });
    assert.equal(status,413);
    assert.equal(f.renderer.calls.create,0);
  } finally {await f.close();}
});

test('client abort during render cancels that fetch and still deletes the owned session', async()=>{
  const f=await fixture({renderer:{delayMs:300}});
  try {
    const frame=inputFrame(9);
    const request=http.request(`${f.base}/frame`,{method:'POST',headers:{
      'Content-Type':'application/octet-stream',
      'Authorization':`Bearer ${CAPABILITY}`,
      'Content-Length':String(frame.length)}}, response=>response.resume());
    request.on('error',()=>{});
    request.end(frame);
    await waitFor(()=>f.renderer.calls.frame===1);
    request.destroy();
    await waitFor(()=>f.records.length>0);
    assert.equal(f.renderer.calls.delete,1);
    assert.equal(f.records[0].replySent,false);
    assert.equal(f.records[0].cleanupConfirmed,true);
    assert.equal(f.records[0].responseFinished,false);
  } finally {await f.close();}
});

test('gateway cannot target a nonloopback renderer and can close before listen', async()=>{
  assert.throws(()=>createVisibleFrameAuditGateway({capability:CAPABILITY,
    faceIds:[FACE],token:TOKEN,rendererBase:'http://example.com:8792'}),
    /loopback/);
  const gateway=createVisibleFrameAuditGateway({capability:CAPABILITY,
    faceIds:[FACE],token:TOKEN});
  await gateway.close();
});

test('persistent mode reuses one owned session with monotonic renderer time and cut on seek', async()=>{
  const f=await fixture({persistentSession:true,maxRequests:240,
    renderer:{largeStatus:true}});
  try {
    for (const [sequence, mediaTime] of [[1,1.25],[2,1.3],[4,0.2]]) {
      const input=inputFrame(12,sequence,4,mediaTime);
      const response=await send(f.base,input);
      assert.equal(response.status,200);
      const output=Buffer.from(await response.arrayBuffer());
      assert.deepEqual(output.subarray(8,64),input.subarray(8,64));
    }
    await waitFor(()=>f.records.length===3);
    assert.equal(f.renderer.calls.create,1);
    assert.equal(f.renderer.calls.frame,3);
    assert.equal(f.renderer.calls.delete,0);
    assert.deepEqual(f.renderer.calls.frameParams.map(p=>p.sequence),[1,2,4]);
    assert.deepEqual(f.renderer.calls.frameParams.map(p=>p.cut),['true','false','true']);
    assert.ok(f.renderer.calls.frameParams[0].timestamp<
      f.renderer.calls.frameParams[1].timestamp);
    assert.ok(f.renderer.calls.frameParams[1].timestamp<
      f.renderer.calls.frameParams[2].timestamp);
    assert.deepEqual(f.records.map(r=>r.rendererFrames),[1,2,3]);
    assert.ok(f.records.every(r=>r.cleanupPending===true && r.cleanupConfirmed===null));
    assert.equal(f.records[2].frameDiagnostic.frameIndex,2);
    assert.doesNotMatch(JSON.stringify(f.records),/SECRET/);
    const closed=await f.gateway.close();
    assert.deepEqual(closed,{cleanupConfirmed:true});
    assert.equal(f.renderer.calls.delete,1);
  } finally {await f.close();}
});

test('persistent mode rejects replay and changed owner, then cleans up', async()=>{
  for (const bad of [inputFrame(13,1),inputFrame(14,2),
    inputFrame(13,2,5),inputFrame(13,2,4,2)]) {
    const f=await fixture({persistentSession:true,maxRequests:240});
    try {
      assert.equal((await send(f.base,inputFrame(13,1))).status,200);
      if (bad.readUInt32BE(24)===2 && bad.readInt32BE(28)===4 &&
          bad.subarray(8,24).every(v=>v===13)) bad.writeUInt16BE(17,44);
      assert.equal((await send(f.base,bad)).status,400);
      await waitFor(()=>f.renderer.calls.delete===1);
      assert.equal(f.renderer.calls.create,1);
      assert.equal(f.renderer.calls.frame,1);
      assert.equal((await send(f.base,inputFrame(13,3))).status,410);
    } finally {await f.close();}
  }
  assert.throws(()=>createVisibleFrameAuditGateway({capability:CAPABILITY,
    faceIds:[FACE],token:TOKEN,maxRequests:31}),/bounds/);
});

test('persistent client disconnect during frame deletes session once', async()=>{
  const f=await fixture({persistentSession:true,maxRequests:240,
    renderer:{delayMs:300}});
  try {
    const frame=inputFrame(15);
    const request=http.request(`${f.base}/frame`,{method:'POST',headers:{
      'Content-Type':'application/octet-stream',
      'Authorization':`Bearer ${CAPABILITY}`,
      'Content-Length':String(frame.length)}},response=>response.resume());
    request.on('error',()=>{});
    request.end(frame);
    await waitFor(()=>f.renderer.calls.frame===1);
    request.destroy();
    await waitFor(()=>f.records.length>0);
    assert.equal(f.renderer.calls.delete,1);
    assert.equal(f.records[0].cleanupConfirmed,true);
    assert.equal(f.records[0].cleanupPending,false);
    const closed=await f.gateway.close();
    assert.equal(closed.cleanupConfirmed,true);
    assert.equal(f.renderer.calls.delete,1);
  } finally {await f.close();}
});

test('persistent accepted-frame failure and malformed follow-up prevent all later frames', async()=>{
  const failed=await fixture({persistentSession:true,maxRequests:240,
    renderer:{frameStatus:500}});
  try {
    assert.equal((await send(failed.base,inputFrame(20))).status,502);
    await waitFor(()=>failed.renderer.calls.delete===1);
    assert.equal((await send(failed.base,inputFrame(20,2))).status,410);
    assert.equal(failed.renderer.calls.create,1);
    assert.equal(failed.renderer.calls.frame,1);
  } finally {await failed.close();}
  const malformed=await fixture({persistentSession:true,maxRequests:240});
  try {
    assert.equal((await send(malformed.base,inputFrame(21))).status,200);
    assert.equal((await send(malformed.base,inputFrame(21,2),CAPABILITY,
      {'Content-Type':'text/plain'})).status,413);
    await waitFor(()=>malformed.renderer.calls.delete===1);
    assert.equal((await send(malformed.base,inputFrame(21,3))).status,410);
    assert.equal(malformed.renderer.calls.frame,1);
  } finally {await malformed.close();}
});
