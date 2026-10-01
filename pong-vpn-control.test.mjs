import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CaliforniaVpnController,createVpnRouter,requiresCaliforniaVpn,vpnLocalRequest} from './pong-vpn-control.mjs';

const california={protected:true,country:'United States',city:'San Jose'};
const disconnected={protected:false,country:'United States',city:'Chicago'};
const server=(name,city,status='online')=>({name,status,load:5,locations:[{country:{code:'US',city:{name:city}}}]});
function harness(options={}) {
  let time=1000;
  const launches=[];
  const controller=new CaliforniaVpnController({inspect:async()=>disconnected,catalog:async()=>[
    server('United States #1','San Francisco'),server('United States #2','Los Angeles'),server('United States #3','San Jose')],
    launch:async args=>launches.push(args),now:()=>time,sleep:async ms=>{time+=ms;},attemptMs:1600,...options});
  return {controller,launches};
}
test('domain policy is exact and rejects lookalike URLs',()=>{
  assert.equal(requiresCaliforniaVpn('https://m.pornhub.com/watch'),true);
  assert.equal(requiresCaliforniaVpn('https://a.phncdn.com/video.mp4'),true);
  assert.equal(requiresCaliforniaVpn('https://pornhub.com.evil.invalid'),false);
  assert.equal(requiresCaliforniaVpn('https://youtube.com/watch'),false);
});
test('already verified California connection is reused without launching',async()=>{
  const {controller:c,launches}=harness({inspect:async()=>california});
  assert.equal(c.start('connect').busy,true);await c.operation;
  assert.equal(c.snapshot().verified,true);assert.deepEqual(launches,[]);
});
test('failed first server uses California backup and verifies exit',async()=>{
  const h=harness();h.controller.inspect=async()=>h.launches.length>=2?california:disconnected;
  h.controller.start('connect');await h.controller.operation;
  assert.equal(h.controller.snapshot().attempt,2);assert.equal(h.controller.snapshot().verified,true);
  assert.deepEqual(h.launches,[['--connect','--server-name','United States #1'],['--connect','--server-name','United States #2']]);
});
test('all attempts exhausted reports timeout, never success',async()=>{
  const {controller:c,launches}=harness();c.start('connect');await c.operation;
  assert.equal(launches.length,3);assert.equal(c.snapshot().error,'connection_timeout');assert.equal(c.snapshot().verified,false);
});
test('only verified California online server names may reach the CLI',async()=>{
  const {controller:c,launches}=harness({catalog:async()=>[server('United States #1 & bad','San Jose'),server('United States #2','Chicago'),server('United States #3','Los Angeles','offline')]});
  c.start('connect');await c.operation;assert.equal(c.snapshot().error,'catalog_unavailable');assert.deepEqual(launches,[]);
});
test('missing app and launch failures get actionable sanitized errors',async()=>{
  for(const code of ['nord_not_installed','launch_failed']){
    const {controller:c}=harness({launch:async()=>{throw Object.assign(new Error('SECRET'),{code});}});
    c.start('connect');await c.operation;assert.equal(c.snapshot().error,code);assert.equal(JSON.stringify(c.snapshot()).includes('SECRET'),false);
  }
});
test('double requests serialize and cannot change action mid-operation',async()=>{
  const {controller:c,launches}=harness({inspect:async()=>california});
  c.start('connect');const op=c.operation;c.start('disconnect');assert.equal(op,c.operation);await op;assert.deepEqual(launches,[]);
});
test('disconnect requires explicit unprotected evidence',async()=>{
  const {controller:c,launches}=harness();c.start('disconnect');await c.operation;
  assert.deepEqual(launches,[['--disconnect']]);assert.equal(c.snapshot().phase,'disconnected');
  const h=harness({inspect:async()=>{throw Error('network');}});h.controller.start('disconnect');await h.controller.operation;
  assert.equal(h.controller.snapshot().error,'disconnect_timeout');
});
test('unverified location fails closed and snapshots omit IP data',async()=>{
  const {controller:c}=harness({inspect:async()=>({...california,ip:'SECRET',city:'Seattle'})});
  await assert.rejects(c.requireCalifornia(),/vpn_required/);assert.equal(JSON.stringify(c.snapshot()).includes('SECRET'),false);
  c.inspect=async()=>{throw Error('network');};await c.check(true);assert.equal(c.snapshot().error,'verification_unavailable');
});
test('LAN control rejects public addresses, forwarded tunnels and DNS lookalikes',()=>{
  const req=(host,remote='192.168.1.10',headers={})=>({socket:{remoteAddress:remote},headers:{host,...headers}});
  assert.equal(vpnLocalRequest(req('192.168.1.124:8787')),true);
  assert.equal(vpnLocalRequest(req('[::1]:8787','::1')),true);
  assert.equal(vpnLocalRequest(req('10.evil.invalid')),false);
  assert.equal(vpnLocalRequest(req('localhost:8787','8.8.8.8')),false);
  assert.equal(vpnLocalRequest(req('localhost:8787','127.0.0.1',{'x-forwarded-for':'1.2.3.4'})),false);
});
test('router requires pairing, protects key page and retains key on restart',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pong-vpn-test-'));
  try {
    const {controller}=harness({inspect:async()=>california});
    const router=await createVpnRouter({directory,controller});
    const key=await readFile(path.join(directory,'vpn-control-key'),'utf8');
    async function request(method,url,headers={}){
      const result={};const res={writeHead:(status,h)=>Object.assign(result,{status,headers:h}),end:body=>result.body=body};
      await router.handle({method,headers:{host:'127.0.0.1:8787',...headers},socket:{remoteAddress:'127.0.0.1'}},res,new URL(url,'http://127.0.0.1'));
      return result;
    }
    assert.equal((await request('POST','/vpn/connect')).status,401);
    assert.equal((await request('GET','/vpn/setup')).status,403);
    const setup=await request('GET','/vpn/setup',{'sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-user':'?1'});
    assert.equal(setup.status,200);assert.ok(setup.body.includes(key));assert.equal(setup.headers['Access-Control-Allow-Origin'],undefined);
    const lanNavigation=await request('GET','/vpn/setup',{accept:'text/html,application/xhtml+xml'});
    assert.equal(lanNavigation.status,200);assert.equal(lanNavigation.headers['Cross-Origin-Resource-Policy'],'same-origin');
    assert.equal((await request('GET','/vpn/setup',{accept:'text/html',origin:'https://untrusted.invalid'})).status,403);
    assert.equal((await request('GET','/vpn/setup',{accept:'text/html','sec-fetch-mode':'no-cors','sec-fetch-dest':'iframe'})).status,403);
    const status=await request('GET','/vpn/status',{'x-pong-vpn-key':key});
    assert.equal(status.status,200);assert.equal(JSON.parse(status.body).status.verified,true);assert.equal(status.body.includes(key),false);
    assert.equal((await request('POST','/vpn/verify',{'x-pong-vpn-key':key})).status,200);
    assert.equal((await request('OPTIONS','/vpn/connect')).status,401);
    await createVpnRouter({directory,controller});assert.equal(await readFile(path.join(directory,'vpn-control-key'),'utf8'),key);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
