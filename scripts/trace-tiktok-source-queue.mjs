// Explicit read-only scheduler attribution around the real 4-second swipe test.
// Only fixed source-stage dictionaries are stored; no credentials/media URLs.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';

const count=Number(process.argv[2]||8);
if(!Number.isSafeInteger(count)||count<1||count>40)throw Error('Expected 1..40 video visits');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/source-queue-${Date.now()}.json`;
const result={diagnosticOnly:true,startedAt:Date.now(),sampleMs:125,rows:[],errors:0};
const pong=await connectWebView(60195,'pong');
const tik=await connectWebView(60195,'tiktok');
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
let running=false,poller=null,child=null;
try{
  // A missing route fails before enabling playback or starting a benchmark.
  const preflight=await fetch('http://127.0.0.1:8792/diagnostics/source-open/00000000000000000000000000000000?include_cache=false');
  const text=await preflight.text();
  if(preflight.status!==404||!text.includes('session not found'))
    throw Error('Source-open diagnostic service is not ready');
  await pong.read(pause);
  await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
  await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
  running=true;
  poller=(async()=>{
    while(running&&result.rows.length<8000){
      const began=performance.now();
      try{
        const sessions=await fetch('http://127.0.0.1:8792/sessions',
          {signal:AbortSignal.timeout(1500)}).then(r=>r.json());
        const eligible=(sessions.sessions||[]).filter(s=>!s.complete&&s.state!=='error').slice(0,8);
        const samples=await Promise.all(eligible.map(async s=>{
          if(!/^[a-f0-9]{32}$/.test(s.id))return null;
          const response=await fetch(`http://127.0.0.1:8792/diagnostics/source-open/${s.id}?include_cache=false`,
            {signal:AbortSignal.timeout(1500)});
          if(response.status===404)return null; // Owner retired normally during a swipe.
          if(!response.ok)throw Error('Diagnostic status failed');
          const body=await response.json();
          return {at:Date.now(),frames:s.frames,transformedFrames:s.transformedFrames,
            active:!!s.active,subscribers:s.subscribers,diagnostic:body.diagnostic};
        }));
        result.rows.push(...samples.filter(Boolean));
      }catch{result.errors++;}
      await new Promise(r=>setTimeout(r,Math.max(1,125-(performance.now()-began))));
    }
  })();
  await new Promise(r=>setTimeout(r,4000));
  child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs',String(count),'--videos'],{
    windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
      PONG_AUDIT_VARIANT:'guest-source-queue-attribution',PONG_AUDIT_SAMPLE_MS:'100'}});
  let log='',stderr='';
  child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
  child.stderr.on('data',b=>{stderr+=b});
  result.exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  try{result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1))}
  catch{result.error='Missing benchmark summary';result.childFailed=!!stderr;}
}catch(e){result.error=String(e.message).replace(/https?:\/\/\S+/g,'[redacted]');process.exitCode=1;}
finally{
  running=false;await poller;
  await pong.read(pause).catch(()=>{});
  await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true').catch(()=>{});
  pong.close();tik.close();result.finishedAt=Date.now();
  writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({saved:output,error:result.error||null,rows:result.rows.length,benchmark:result.benchmark}));
}
