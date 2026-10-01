import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const c=await connectWebView(60195,'tiktok');
const result={experimental:true,productionDefaultUnchanged:true,restored:false};let identifier;
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/direct-decoder-${Date.now()}.json`;
try{
 await c.call('Page.enable');
 const code=['tiktok-avc-fragments.js','tiktok-direct-decoder.js'].map(f=>readFileSync('android-app/app/src/main/assets/'+f,'utf8')).join('\n')+'\nwindow.__pongDirectDecoderTrial=true;';
 ({identifier}=await c.call('Page.addScriptToEvaluateOnNewDocument',{source:code}));
 await c.call('Page.reload');
 let ready=false;
 for(let i=0;i<60&&!ready;i++){
   await new Promise(r=>setTimeout(r,500));
   const state=await c.read('({trial:window.__pongDirectDecoderTrial===true,challenge:!!document.querySelector("#captcha-verify-container"),ready:[...document.querySelectorAll("video:not(.pong-tiktok-swap-stream)")].some(v=>!v.paused&&v.readyState>=2)})');
   if(state.challenge)throw Error('Verification shown; no scored run');ready=state.trial&&state.ready;
 }
 if(!ready)throw Error('Direct decoder page not ready');
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','5'],{stdio:['ignore','pipe','inherit'],windowsHide:true});
 let log='';child.stdout.on('data',b=>{const text=b.toString();log+=text;process.stdout.write(text);});
 const exit=await new Promise(r=>child.once('exit',r));
 const lines=log.trim().split(/\r?\n/);result.benchmark=JSON.parse(lines.at(-1));result.exit=exit;
}catch(error){result.error=error.message;process.exitCode=1;}
finally{
 if(identifier)await c.call('Page.removeScriptToEvaluateOnNewDocument',{identifier}).catch(()=>{});
 await c.read('window.__pongDirectDecoderTrial=false;window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.()').catch(()=>{});
 await c.call('Page.reload').catch(()=>{});
 for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,250));if(await c.read('window.__pongDirectDecoderTrial!==true&&!window.__pongCreateDirectDecoder').catch(()=>false)){result.restored=true;break;}}
 c.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
