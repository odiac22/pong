import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=src.indexOf('async function settlePongPrefetchAdmission('),end=src.indexOf('\n}',start)+2;
const ctx=vm.createContext({Promise,setTimeout,clearTimeout});
vm.runInContext(src.slice(start,end),ctx);
test('pending admission returning in the bounded window is reusable',async()=>{
  const entry={};entry.admissionReady=new Promise(resolve=>setTimeout(()=>{entry.sessionId='prepared';resolve(entry)},5));
  await ctx.settlePongPrefetchAdmission(entry,80);
  assert.equal(entry.sessionId,'prepared');
});
test('stuck admission is bounded and does not block new foreground work indefinitely',async()=>{
  const start=performance.now();
  await ctx.settlePongPrefetchAdmission({admissionReady:new Promise(()=>{})},10);
  assert.ok(performance.now()-start<200);
});
test('ready or deleted entry adds no admission timer',async()=>{
  for(const entry of [null,{deleted:true},{sessionId:'ready'}]) await ctx.settlePongPrefetchAdmission(entry);
});
test('new await rechecks navigation ownership before adopting or painting',()=>{
  const pos=src.indexOf('await settlePongPrefetchAdmission(prefetchCandidate)');
  const guard=src.slice(pos,src.indexOf("recordPongRuntimeDiagnostic('swap.prefetch-selection'",pos));
  assert.match(guard,/activationSequence/);assert.match(guard,/pongFaceSwapCurrentWrapper\(\) !== wrapper/);
  assert.match(guard,/return false/);
});
