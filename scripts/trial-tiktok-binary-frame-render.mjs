// Private, temporary emulator transport trial. Never exposes the renderer's
// bearer, never adds a production route, and never persists captured pixels.
import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {createVisibleFrameAuditGateway} from './lib/visible-frame-audit-gateway.mjs';

const count=Number(process.argv[2]??12);
const reverse=process.argv.includes('--reverse');
const series=process.argv.includes('--series');
const steady=process.argv.includes('--steady');
if(steady&&!series)throw Error('Steady diagnostic requires series mode');
if(!Number.isInteger(count)||count<1||count>(series?120:30))throw Error('Invalid render sample count');
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/binary-frame-render-pc-${Date.now()}.json`;
const capability=randomBytes(32).toString('hex');
const token=readFileSync(new URL('../Pong Swap/cache/remote-bridge-token',import.meta.url),'utf8').trim();
if(token.length<32)throw Error('Private renderer key is unavailable');
const records=[];
const configHash=async()=>createHash('sha256').update(JSON.stringify(
  (await fetch('http://127.0.0.1:8792/settings').then(r=>r.json())).config)).digest('hex');
const before=await configHash();
const approved=await fetch('http://127.0.0.1:8792/faces').then(r=>r.json());
const faceIds=(approved.faces??[]).map(f=>f.id);
if(!faceIds.length||faceIds.length>16)throw Error('Audit needs 1..16 existing approved faces');
let targetPage=null;
try {
  const current=await connectWebView(60195,'tiktok');
  try {
    const observed=await current.read('window.__pongTikTokObservedVideo?.pageUrl??null');
    if(typeof observed==='string'){
      const page=new URL(observed);
      if(page.origin==='https://www.tiktok.com'&&/^\/@[^/]+\/video\/\d+$/.test(page.pathname))
        targetPage=page.origin+page.pathname;
    }
  }finally{current.close()}
}catch{}
let failure=null,after=null,receiverRestored=false,reverseInstalled=false,reverseRemoved=!reverse;
let gatewayCleanupConfirmed=false;
const child=async(script,args=[],env=process.env)=>new Promise((resolve,reject)=>{
  const processChild=spawn(process.execPath,[script,...args],{
    windowsHide:true,stdio:['ignore','pipe','pipe'],env});
  let out='',err='';
  processChild.stdout.on('data',chunk=>{if(out.length<16000)out+=chunk;});
  processChild.stderr.on('data',chunk=>{if(err.length<16000)err+=chunk;});
  processChild.on('error',()=>reject(Error('Audit subprocess could not start')));
  processChild.on('exit',code=>{
    // Do not print child stderr: launch arguments could contain ephemeral keys.
    if(out)console.log(out.trim());
    if(code!==0)reject(Error(`Audit subprocess failed (${script}; exit ${code})`));
    else resolve();
  });
});
const gateway=createVisibleFrameAuditGateway({capability,faceIds,token,
  persistentSession:series,maxRequests:count,onRecord:record=>records.push(record)});
try {
  await new Promise((resolve,reject)=>{
    gateway.server.once('error',reject);
    gateway.server.listen(17941,'127.0.0.1',resolve);
  });
  if(reverse) {
    const mappings=execFileSync(adb,['-s','emulator-5582','reverse','--list'],
      {encoding:'utf8',timeout:10000,windowsHide:true});
    if(mappings.split(/\r?\n/).some(line=>line.split(/\s+/).includes('tcp:17941')))
      throw Error('Audit reverse mapping already exists; left unchanged');
    execFileSync(adb,['-s','emulator-5582','reverse','tcp:17941','tcp:17941'],
      {stdio:'ignore',timeout:10000,windowsHide:true});
    reverseInstalled=true;
  }
  // Only the signed test receiver is restarted. App data and login are retained.
  execFileSync(adb,['-s','emulator-5582','shell','am','force-stop','com.odiac22.pong2'],
    {stdio:'ignore',timeout:10000});
  await child('scripts/prepare-tiktok-audit-receiver.mjs',
    ['--visible-frame-binary','--visible-frame-render','--no-swap',
      ...(reverse?['--visible-frame-reverse']:[])],
    {...process.env,PONG_AUDIT_FRAME_CAPABILITY:capability});
  if(targetPage) {
    const tik=await connectWebView(60195,'tiktok');
    try {await tik.call('Page.navigate',{url:targetPage});}
    finally{tik.close()}
  }
  await child(series?'scripts/measure-tiktok-binary-frame-series.mjs':
    'scripts/measure-tiktok-binary-frame-echo.mjs',[String(count),'--render',...(steady?['--steady']:[])]);
} catch(error) {
  failure=error.message;
} finally {
  gatewayCleanupConfirmed=(await gateway.close())?.cleanupConfirmed===true;
  if(reverseInstalled) {
    try{execFileSync(adb,['-s','emulator-5582','reverse','--remove','tcp:17941'],
      {stdio:'ignore',timeout:10000,windowsHide:true});reverseRemoved=true;}catch{}
  }
  // Remove the audit key/bridge by replacing the activity Intent and WebView.
  try {
    execFileSync(adb,['-s','emulator-5582','shell','am','force-stop','com.odiac22.pong2'],
      {stdio:'ignore',timeout:10000});
    await child('scripts/prepare-tiktok-audit-receiver.mjs',['--no-swap']);
    const pong=await connectWebView(60195,'pong');
    try {
      receiverRestored=await pong.read(`(()=>{setPongFaceSwapSelection(${JSON.stringify(faceIds)});
        return !pongFaceSwapState.enabled&&pongFaceSwapState.selectedFaceIds.length===${faceIds.length};})()`);
    }finally{pong.close()}
  }catch{receiverRestored=false;}
  after=await configHash().catch(()=>null);
  const cleanupConfirmed=gatewayCleanupConfirmed&&records.every(record=>
    record.cleanupConfirmed===true||(series&&record.cleanupPending===true));
  writeFileSync(output,JSON.stringify({diagnosticOnly:true,
    scope:'original_visible_frames_offscreen_render_not_visible_paint_or_continuous_fps',
    transport:reverse?'adb_reverse_diagnostic_not_normal_phone_network':'emulator_host_alias_direct',
    sourcePageHash:targetPage?createHash('sha256').update(targetPage).digest('hex'):null,
    persistentSession:series,steadyDiagnostic:steady,
    selectedApprovedFaceCount:faceIds.length,failure,receiverRestored,reverseRemoved,
    qualityUnchanged:before===after,cleanupConfirmed,records},null,2));
  console.log(JSON.stringify({output,failure,receiverRestored,
    qualityUnchanged:before===after,cleanupConfirmed,requests:records.length}));
  if(failure||!receiverRestored||!reverseRemoved||!cleanupConfirmed||before!==after)process.exitCode=1;
}
