// Emulator-only network attribution, not a phone dependency or production path.
// Route only the existing PC-owned foreground swap stream through ADB reverse.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const port=18787,reverse=`tcp:${port}`;
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/tunnel-${Date.now()}.json`;
const result={diagnosticOnly:true,purpose:'Isolate emulator NAT bottleneck; no production routing or quality change'};
const adbRun=(...args)=>execFileSync(adb,['-s','emulator-5582',...args],{encoding:'utf8',windowsHide:true,timeout:10000});
if(adbRun('reverse','--list').split(/\r?\n/).some(line=>line.split(/\s+/).includes(reverse)))throw Error('Audit reverse port already owned; nothing changed');
const pong=await connectWebView(60195,'pong');let installed=false,reversed=false;
const pauseOwned=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
try{
  await pong.read(pauseOwned);
  adbRun('reverse',reverse,'tcp:8787');reversed=true;
  result.installed=await pong.read(readFileSync('scripts/tiktok-audit-tunnel-state.js','utf8'));installed=true;
  const child=spawn(process.execPath,['scripts/diagnose-tiktok-repeatable-pages.mjs',
    'E:/Pong Benchmarks/tiktok-webview-2026-09-29/repeatable-pool-1790770759732.json'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
      PONG_AUDIT_PAGE_LIMIT:'3',PONG_AUDIT_VARIANT:'worker-batch-adb-tunnel-stable-publisher'}});
  let log='';child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk)});
  result.exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  result.run=JSON.parse(log.trim().split(/\r?\n/).at(-1));
  result.publisherStats=await pong.read('window.__pongAuditTunnelStats');
  const run=JSON.parse(readFileSync(result.run.output,'utf8'));
  const routes=run.cases.flatMap(row=>row.samples).map(sample=>sample.view?.nativeReads)
    .filter(read=>read?.found).map(read=>read.route);
  result.routes=routes;
  result.routeVerified=routes.length>0&&routes.every(route=>route===0);
}finally{
  await pong.read(pauseOwned).catch(()=>{});
  if(installed)result.restored=await pong.read('window.__pongAuditTunnelRestore?.()').catch(()=>false);
  if(reversed)adbRun('reverse','--remove',reverse);
  pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
