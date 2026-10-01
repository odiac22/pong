// Emulator-only reversible architecture diagnostic. Never touches phone data,
// cookies, production presets or the desktop renderer process. The flag file
// must be absent before starting; do not replace user-owned flags.
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const serial='emulator-5582',pkg='com.odiac22.pong2';
const flag='/data/local/tmp/webview-command-line';
const output='E:/Pong Benchmarks/tiktok-webview-2026-09-29';
const pool=output+'/repeatable-pool-1790770759732.json';
const ownedPause=readFileSync(new URL('./pause-tiktok-audit-owned-sessions.js',import.meta.url),'utf8');
const shell=(...args)=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',timeout:12000}).trim();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={diagnosticOnly:true,claim:'No FPS or latency acceptance from process count',
  flags:'--site-per-process',started:new Date().toISOString()};
let ownsFlag=false,changedApp=false;
async function nodeScript(file,args=[],env={}){
  const child=spawn(process.execPath,[file,...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
  let out='',err='';child.stdout.on('data',data=>{out+=data;process.stdout.write(data)});
  child.stderr.on('data',data=>{err+=data});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  if(code!==0)throw Error(`${file} failed (${code}): ${err.replace(/https?:\/\/\S+/g,'[URL]').slice(-300)}`);
  return out;
}
async function pauseOwned(){
  let p,readError;
  try{p=await connectWebView(60195,'pong');await p.read(ownedPause)}
  catch(error){readError=error}finally{p?.close()}
  for(let i=0;i<30;i++){
    const h=await fetch('http://127.0.0.1:8792/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
    if(Number(h.activeSessions)===0)return;
    await delay(200);
  }
  throw Error(readError?'Pong unavailable and renderer still active; no restart':
    'Renderer did not retire owned sessions; no restart');
}
try{
  if(!['userdebug','eng'].includes(shell('shell','getprop','ro.build.type')))
    throw Error('Only a debuggable test emulator is eligible');
  if(shell('shell','test','-e',flag,';','echo','$?')!=='1')throw Error('Flag file already exists; preserved');
  await pauseOwned();
  report.before=shell('shell','ps','-A','-o','PID,PPID,NAME').split(/\r?\n/).filter(x=>/pong2|webview.*sandboxed/.test(x));
  shell('push','scripts/fixtures/tiktok-site-process-command-line',flag);ownsFlag=true;
  if(shell('shell','cat',flag)!=='_ --site-per-process')throw Error('Flag content verification failed');
  shell('shell','am','force-stop',pkg);changedApp=true;
  await nodeScript('scripts/prepare-tiktok-audit-receiver.mjs',['--worker-mse','--binary-media','--no-swap']);
  report.after=shell('shell','ps','-A','-o','PID,PPID,NAME').split(/\r?\n/).filter(x=>/pong2|webview.*sandboxed/.test(x));
  const p=await connectWebView(60195,'pong');
  try{report.profile=await p.read(`(()=>{window.__pongSaved512AuditProfile=pongFaceSwapRestorationProfile;
    pongFaceSwapRestorationProfile=()=>document.documentElement.classList.contains('pong-tiktok-original-overlay')
      ?'tiktok-gpen512':window.__pongSaved512AuditProfile();return pongFaceSwapRestorationProfile()})()`)}finally{p.close()}
  const t=await connectWebView(60195,'tiktok');
  try{report.worker=await t.read(`({worker:window.__pongWorkerMseAuditTrial===true,
    binary:window.__pongBinaryMediaAuditTrial===true,native:!!window.PongTikTokBinaryAudit})`)}finally{t.close()}
  console.log(JSON.stringify({processes:report.after,profile:report.profile,worker:report.worker}));
  if(report.after.filter(x=>/webview.*sandboxed/.test(x)).length<2)throw Error('Separate rendering processes were not established');
  const log=await nodeScript('scripts/diagnose-tiktok-repeatable-pages.mjs',[pool,'--mute-original'],
    {PONG_AUDIT_PAGE_LIMIT:'3',PONG_AUDIT_VARIANT:'site-process-gpen512-worker-native-binary'});
  report.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}catch(error){report.error=String(error.message).replace(/https?:\/\/\S+/g,'[URL]');process.exitCode=1}
finally{
  if(ownsFlag){
    try{
      await pauseOwned();
      if(shell('shell','cat',flag)!=='_ --site-per-process')throw Error('Flag contents changed; will not delete');
      shell('shell','rm',flag);ownsFlag=false;report.flagsRestored=true;
      shell('shell','am','force-stop',pkg);changedApp=true;
      await nodeScript('scripts/prepare-tiktok-audit-receiver.mjs',['--no-swap']);
      report.appRestored=true;
    }catch(error){report.cleanupError=String(error.message);process.exitCode=1}
  }
  report.changedApp=changedApp;
  const file=output+`/site-process-${Date.now()}.json`;
  writeFileSync(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({file,error:report.error||null,restored:!!report.appRestored,cleanupError:report.cleanupError||null}));
}
