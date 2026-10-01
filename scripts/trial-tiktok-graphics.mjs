// Reversible receiver-only HWUI comparison, no source or saved quality changes.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const device='emulator-5582',pkg='com.odiac22.pong2',sleep=ms=>new Promise(r=>setTimeout(r,ms));
const call=(...args)=>execFileSync(adb,['-s',device,...args],{encoding:'utf8',timeout:15000});
const old=call('shell','getprop','debug.hwui.renderer').trim();
if(!['skiagl','skiavk',''].includes(old))throw Error('Unexpected existing HWUI renderer; left unchanged');
const out=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/graphics-trial-${Date.now()}.json`;
const result={originalRenderer:old,requestedRenderer:'skiavk',experimental:true};let pong,tik;
async function boot(){
 tik?.close();pong?.close();tik=pong=null;call('shell','am','force-stop',pkg);
 call('shell','am','start','-n',`${pkg}/com.odiac22.pong.MainActivity`);
 for(let n=0;n<50;n++){
  await sleep(200);try{
   const pid=call('shell','pidof',pkg).trim();if(!/^\d+$/.test(pid))continue;
   call('forward','tcp:60195',`localabstract:webview_devtools_remote_${pid}`);
   pong=await connectWebView(60195,'pong');break;
  }catch{}
 }
 if(!pong)throw Error('Receiver did not start');
 for(let n=0;n<70;n++){
  if(await pong.read('typeof window.PongTikTokLiveSwapCurrent==="function"'))break;await sleep(200);
 }
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await pong.read(readFileSync('scripts/open-tiktok-emulator.js','utf8'));
 for(let n=0;n<50&&!tik;n++){try{tik=await connectWebView(60195,'tiktok')}catch{await sleep(200)}}
 if(!tik)throw Error('TikTok WebView unavailable');
}
try{
 pong=await connectWebView(60195,'pong');await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 call('shell','setprop','debug.hwui.renderer','skiavk');await boot();
 result.appliedPipeline=call('shell','dumpsys','gfxinfo',pkg).split(/\r?\n/).filter(s=>s.startsWith('Pipeline='));
 if(!result.appliedPipeline.some(s=>s.includes('Vulkan')))throw Error('Vulkan path not applied');
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs',process.env.PONG_AUDIT_COUNT||'8','--videos'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'500',PONG_AUDIT_VARIANT:'29.19-vulkan-graphics-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 try{await pong?.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'))}catch{}
 // adb shell needs an explicit empty quoted value to restore a missing prop.
 try{call('shell','setprop','debug.hwui.renderer',old||'""');await boot();result.restored=call('shell','getprop','debug.hwui.renderer').trim()===old}catch(error){result.restoreError=error.message}
 tik?.close();pong?.close();writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:out,...result}));
}
