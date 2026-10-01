// Manual, emulator-only paired diagnostic. Same three observed pages, normal
// TikTok layer first and default layer second. Not a swipe-acceptance pass.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';

const ADB='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const PACKAGE='com.odiac22.pong2';
const POOL='E:/Pong Benchmarks/tiktok-webview-2026-09-29/repeatable-pool-1790770759732.json';
const OUT='E:/Pong Benchmarks/tiktok-webview-2026-09-29';
const REPO_ROOT=fileURLToPath(new URL('../',import.meta.url));
const PAUSE=readFileSync(new URL('./pause-tiktok-audit-owned-sessions.js',import.meta.url),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function validateThreePages(raw){
  const pages=raw?.pages?.slice(0,3);
  if(!Array.isArray(pages)||pages.length!==3||new Set(pages).size!==3)
    throw Error('Expected three distinct observed pages');
  for(const page of pages){
    let url;try{url=new URL(page)}catch{throw Error('Invalid observed page')}
    if(url.origin!=='https://www.tiktok.com'||
       !/^\/@[^/]+\/video\/\d{15,22}\/?$/.test(url.pathname)||url.search||url.hash)
      throw Error('Noncanonical observed page');
  }
  return pages;
}

export function summarizeDiagnostic(raw,pages){
  const cases=Array.isArray(raw?.cases)?raw.cases:[];
  return pages.map((page,index)=>{
    const row=cases[index],id=page.match(/\/video\/(\d+)/)?.[1];
    const same=!!row&&row.videoId===id;
    const last=row?.samples?.at(-1);
    return {index,videoHash:createHash('sha256').update(id).digest('hex').slice(0,16),
      present:same,documentReadyMs:same?row.documentReadyMs??null:null,
      firstPaintUpperMs:same?row.firstPaintUpperMs??null:null,
      firstObservedPaintUpperMs:same?row.firstObservedPaintUpperMs??null:null,
      transformedFrames:same?last?.renderer?.transformedFrames??null:null,
      originalDecoded:same?last?.view?.original?.decoded??null:null,
      sampleCount:same?row.samples?.length??0:0};
  });
}

function shell(...args){return execFileSync(ADB,['-s','emulator-5582',...args],
  {encoding:'utf8',timeout:10000,windowsHide:true}).trim()}
function verifyEmulator(){
  const hardware=shell('shell','getprop','ro.hardware');
  if(!['ranchu','goldfish'].includes(hardware))throw Error('Not verified emulator-5582');
  const serial=shell('get-serialno');
  if(serial!=='emulator-5582')throw Error('ADB serial changed');
  const installed=shell('shell','pm','path',PACKAGE);
  if(!installed.startsWith('package:'))throw Error('Expected Pong2 package absent');
}
function exactAppPid(){
  let value='';
  try{value=shell('shell','pidof',PACKAGE)}catch{return null}
  if(!/^\d+$/.test(value))throw Error('Expected at most one exact Pong2 process');
  return Number(value);
}
async function zeroRendererSessions(){
  const health=await fetch('http://127.0.0.1:8792/health',
    {signal:AbortSignal.timeout(3000)}).then(r=>r.json());
  if(!health.ready||Number(health.activeSessions)!==0)
    throw Error('Renderer not ready or another active session exists');
  return true;
}
async function pauseOwned(){
  let pong;
  try{pong=await connectWebView(60195,'pong');return await pong.read(PAUSE)}
  finally{pong?.close()}
}
async function quiesceOwned(){
  try{await pauseOwned()}catch(error){
    // A failed prepare may have no Pong WebView. Only continue when the
    // renderer independently proves there are zero active sessions.
    await zeroRendererSessions();return;
  }
  for(let i=0;i<20;i++){
    try{await zeroRendererSessions();return}catch{await wait(250)}
  }
  throw Error('Owned renderer sessions did not drain');
}
function stopExactApp(){verifyEmulator();const pid=exactAppPid();
  if(pid!==null)shell('shell','am','force-stop',PACKAGE);
  return pid;
}
function child(script,args=[],env={}){
  return execFileSync(process.execPath,[script,...args],{
    cwd:REPO_ROOT,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,windowsHide:true,
    env:{...process.env,...env}});
}
function readChildDiagnostic(log){
  const tail=log.trim().split(/\r?\n/).at(-1);
  const info=JSON.parse(tail);
  if(!info?.output||!info.output.startsWith(`${OUT}/repeated-pages-`))
    throw Error('Diagnostic output path unrecognized');
  const raw=JSON.parse(readFileSync(info.output,'utf8'));
  return {path:info.output,raw};
}

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--run-emulator-repeatable-layer')
    throw Error('Explicit --run-emulator-repeatable-layer required');
  const pages=validateThreePages(JSON.parse(readFileSync(POOL,'utf8')));
  const report={diagnosticOnly:true,device:'emulator-5582',
    note:'Same three observed pages, separate normal-layer and default launches. Not swipe acceptance; page/network/cache order remains a confound. No aggregate pass claim.',
    arms:[],restoredDefault:false};
  const out=`${OUT}/repeatable-layer-${Date.now()}.json`;
  try{
    verifyEmulator();await zeroRendererSessions();
    // Stop only the verified Pong2 app, never the renderer or another package.
    stopExactApp();
    for(const [name,prepareArgs] of [['normal-layer',['--normal-layer']],
      ['default-layer',[]]]){
      const arm={name,cases:[]};report.arms.push(arm);
      try{
        child('scripts/prepare-tiktok-audit-receiver.mjs',prepareArgs);
        if(exactAppPid()===null)throw Error('Prepared Pong2 app did not start');
        let log;
        try{log=child('scripts/diagnose-tiktok-repeatable-pages.mjs',[POOL,'--mute-original'],{
          PONG_AUDIT_PAGE_LIMIT:'3',PONG_AUDIT_VARIANT:`layer-${name}`});}
        catch(error){log=String(error?.stdout||'');arm.childError=String(error?.message||error);
          if(!log.includes('"output"'))throw error;}
        const diagnostic=readChildDiagnostic(log);
        arm.output=diagnostic.path;
        arm.cases=summarizeDiagnostic(diagnostic.raw,pages);
        arm.error=diagnostic.raw.error||null;
      }catch(error){arm.error=String(error?.message||error).replace(/https?:\/\/\S+/g,'[redacted]')}
      await quiesceOwned();
      stopExactApp();
    }
  }catch(error){report.error=String(error?.message||error).replace(/https?:\/\/\S+/g,'[redacted]');
    process.exitCode=1}
  finally{
    // Even after a failed normal-layer arm, restore ordinary default intent.
    try{
      verifyEmulator();
      if(exactAppPid()!==null)await quiesceOwned();
      else await zeroRendererSessions();
      stopExactApp();
      child('scripts/prepare-tiktok-audit-receiver.mjs');
      if(exactAppPid()===null)throw Error('Default Pong2 app did not start');
      await quiesceOwned();
      report.restoredDefault=true;
    }catch(error){report.restoreError=String(error?.message||error);process.exitCode=1}
    writeFileSync(out,JSON.stringify(report,null,2));
    console.log(JSON.stringify({output:out,restoredDefault:report.restoredDefault,
      arms:report.arms.map(a=>({name:a.name,output:a.output||null,error:a.error||null,
        cases:a.cases})),error:report.error||report.restoreError||null}));
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  await main();
