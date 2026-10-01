import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync('local-ai-server.mjs','utf8');
const start=source.indexOf('async function proxyPongSwapRequest(');
const end=source.indexOf('\nconst server = http.createServer(',start);
assert.ok(start>=0&&end>start,'actual proxy source can be extracted');

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));

test('actual Pong Swap proxy terminates its downstream response when upstream closes mid-body',async()=>{
  const upstream=http.createServer((_req,res)=>{
    res.writeHead(200,{'Content-Type':'video/mp4','Cache-Control':'no-store'});
    res.write(Buffer.from('partial-media-fragment'));
    setTimeout(()=>res.socket?.destroy(),25);
  });
  const upstreamPort=await listen(upstream);
  const context={http,PONG_SWAP_PORT:upstreamPort,ensurePongSwapService:async()=>{},
    invalidatePongSwapReadiness:()=>{},gatewayCorsHeaders:()=>({}),Promise,Error};
  const proxy=vm.runInNewContext(`${source.slice(start,end)}\nproxyPongSwapRequest`,context);
  const downstream=http.createServer((req,res)=>{
    const requestUrl=new URL(req.url,'http://127.0.0.1');
    void proxy(req,res,requestUrl).catch(error=>{
      if(res.headersSent){if(!res.destroyed)res.destroy(error);}
      else{res.writeHead(502);res.end();}
    });
  });
  const downstreamPort=await listen(downstream);
  let client;
  try{
    let timeout;
    const terminal=await new Promise((resolve,reject)=>{
      const finish=value=>{clearTimeout(timeout);resolve(value);};
      client=http.get(`http://127.0.0.1:${downstreamPort}/pong-swap/sessions/test/stream`,response=>{
        let bytes=0;
        response.on('data',chunk=>{bytes+=chunk.length;});
        response.once('end',()=>finish({kind:'end',bytes}));
        response.once('error',error=>finish({kind:'error',bytes,code:error.code}));
        response.once('aborted',()=>finish({kind:'aborted',bytes}));
      });
      client.once('error',error=>{clearTimeout(timeout);reject(error);});
      timeout=setTimeout(()=>finish({kind:'timeout'}),1000);
    });
    assert.notEqual(terminal.kind,'timeout','downstream HTTP reader must not wait forever');
    assert.ok(terminal.bytes>0,'the proxy delivered initial bytes before upstream broke');
  }finally{
    client?.destroy();
    await close(downstream);
    await close(upstream);
  }
});
