import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function random40ServerVideoCacheEndpoint(');
const end=html.indexOf('\nfunction ',start+1);
function endpoint(origin,path='/pong',gateway='') {
  const u=new URL(origin);
  const ctx=vm.createContext({location:{origin,pathname:path,protocol:u.protocol,hostname:u.hostname},
    random40GatewayEndpoint:gateway,random40State:{},random40NormalizeLocalEndpoint:x=>x});
  vm.runInContext(html.slice(start,end),ctx);
  return ctx.random40ServerVideoCacheEndpoint();
}
assert.equal(endpoint('http://192.168.1.2:8787'),'http://192.168.1.2:8787');
assert.equal(endpoint('https://pong.example'),'https://pong.example');
assert.equal(endpoint('https://odiac22.github.io'),'');
assert.equal(endpoint('https://pong.example','/unrelated'),'');
assert.equal(endpoint('https://pong.example','/pong','http://192.168.1.2:8787'),'');
assert.equal(endpoint('http://192.168.1.2:8787','/pong','http://192.168.1.3:8787'),'http://192.168.1.3:8787');
console.log('PASS: 6 cache endpoint fallback checks');
