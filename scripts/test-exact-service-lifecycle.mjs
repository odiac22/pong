// Isolated lifecycle qualification. Never targets the live service or saves a preset.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const base=process.env.SWAP_BASE||'http://127.0.0.1:8812';
const url=new URL(base);
assert.equal(url.hostname,'127.0.0.1');
assert.equal(url.port,'8812','Only the owned qualification service is allowed');
const out=process.env.PONG_LIFECYCLE_OUT;
assert.ok(out,'A fresh result directory is required');
const preset=path.resolve(import.meta.dirname,'../Pong Swap/presets/current.json');
const digest=async()=>createHash('sha256').update(await readFile(preset)).digest('hex');
const report={schema:'pong-exact-service-lifecycle-v1',silent:true,startedAt:new Date().toISOString(),steps:[]};
const api=async(route,method='GET',body)=>{
  const t=performance.now();
  const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  const result=await r.json();
  report.steps.push({route,method,status:r.status,elapsedMs:performance.now()-t});
  assert.ok(r.ok,route+': '+JSON.stringify(result));
  return result;
};
const status=h=>h.exactAcceleration?.acceleration||h.exactAcceleration;
let original;
await mkdir(out,{recursive:false});
try {
  report.presetBefore=await digest();
  const sessions=(await api('/sessions')).sessions;
  assert.ok(!sessions.some(s=>!s.complete),'Another session is still active');
  original=(await api('/settings')).config;
  report.before=await api('/health');
  assert.equal(status(report.before).installed,true);
  report.unloaded=await api('/unload','POST');
  assert.equal(report.unloaded.ready,false);
  await api('/warm','POST');
  report.rewarmed=await api('/health');
  assert.equal(report.rewarmed.ready,true);
  assert.equal(status(report.rewarmed).installed,true);
  assert.equal(report.rewarmed.exactAcceleration.restartRequired,false);
  const changed=structuredClone(original);
  changed.runtime.restorerCudaGraph=!original.runtime.restorerCudaGraph;
  report.transition=await api('/settings/preview','PUT',changed);
  assert.equal(report.transition.persisted,false);
  report.fallback=await api('/health');
  assert.equal(status(report.fallback).installed,false);
  assert.equal(status(report.fallback).reason,'original-fallback-after-quiescent-unload');
  assert.equal(report.fallback.exactAcceleration.restartRequired,false);
  await api('/settings/preview','PUT',original);
  await api('/warm','POST');
  report.restored=await api('/health');
  assert.equal(report.restored.ready,true);
  assert.deepEqual((await api('/settings')).config,original);
  report.presetAfter=await digest();
  assert.equal(report.presetAfter,report.presetBefore);
  report.passed=true;
} catch(error) {
  report.passed=false;
  report.error=error.stack;
  process.exitCode=1;
} finally {
  // Restore only this disposable service's in-memory settings on failure.
  if(!report.passed&&original)await api('/settings/preview','PUT',original).catch(()=>{});
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,error:report.error,steps:report.steps},null,2));
}
