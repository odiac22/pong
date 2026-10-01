// Emulator-only A/B: ordinary accelerated WebView versus its forced extra
// full-screen hardware texture. No image resolution, model or codec changes.
import {execFileSync,spawn} from 'node:child_process';
import {writeFileSync,readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/native-compositor-${Date.now()}.json`;
const result={experimental:true,restored:false};
const shell=(...args)=>execFileSync(adb,['-s','emulator-5582',...args],{encoding:'utf8',timeout:10000});
const run=async(args,env={})=>{
 const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,...env}});
 let log='';child.stdout.on('data',data=>{log+=data;process.stdout.write(data)});
 const code=await new Promise(resolve=>child.once('exit',resolve));
 if(code!==0)throw Error(`Scoped test command failed (${code})`);
 return log;
};
const pause=async()=>{
 const c=await connectWebView(60195,'pong');
 try{await c.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'))}finally{c.close()}
};
try{
 const hardware=shell('shell','getprop','ro.hardware').trim();
 if(!['ranchu','goldfish'].includes(hardware))throw Error('Not the test emulator');
 await pause();
 shell('shell','am','force-stop','com.odiac22.pong2');
 await run(['scripts/prepare-tiktok-audit-receiver.mjs','--normal-layer']);
 const log=await run(['scripts/trial-tiktok-nearest-prefetch.mjs'],{
  PONG_AUDIT_COUNT:'8',PONG_AUDIT_VARIANT:'29.21-normal-accelerated-compositor-nearest'});
 result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 await pause().catch(()=>{});
 shell('shell','am','force-stop','com.odiac22.pong2');
 try{
  await run(['scripts/prepare-tiktok-audit-receiver.mjs']);
  await pause();result.restored=true;
 }catch(error){result.restoreError=error.message;process.exitCode=1}
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
