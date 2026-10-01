// Same-page ABBA decoder diagnostic; not the 40-swipe acceptance test.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pool=process.argv[2];if(!pool)throw Error('Observed page pool required');
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/direct-credit-${Date.now()}.json`;
const result={diagnosticOnly:true,qualityChanged:false,order:['mse','direct','direct','mse'],runs:[]};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
try{
  await pong.read(pause);
  await tik.read(`(()=>{if(window.__pongUndoDirectCreditTrial)throw Error('Trial already active');
    const oldFlag=window.__pongDirectDecoderTrial,oldFactory=window.__pongCreateDirectDecoder,oldParser=window.PongAvcFragments;
    window.__pongUndoDirectCreditTrial=()=>{window.__pongDirectDecoderTrial=oldFlag;
      window.__pongCreateDirectDecoder=oldFactory;window.PongAvcFragments=oldParser;delete window.__pongUndoDirectCreditTrial;};return true;})()`);
  for(const f of ['tiktok-avc-fragments.js','tiktok-direct-decoder.js'])
    await tik.read(readFileSync('android-app/app/src/main/assets/'+f,'utf8'));
  for(const mode of result.order){
    await pong.read(pause);
    await tik.read(`window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();window.__pongDirectDecoderTrial=${mode==='direct'};true`);
    const record=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['scripts/diagnose-tiktok-repeatable-pages.mjs',pool,'--current-page'],{
        windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_PAGE_LIMIT:'1',
          PONG_AUDIT_DIAGNOSTIC_MS:'4000',PONG_AUDIT_VARIANT:`direct-credit-${mode}`}});
      let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
      child.once('error',reject);child.once('exit',code=>{
        try{const record=JSON.parse(log.trim().split(/\r?\n/).at(-1));
          if(code||record.error)reject(Error(record.error||`Replay failed ${code}`));else resolve(record);
        }catch(e){reject(e)}
      });
    });
    result.runs.push({mode,...record});writeFileSync(output,JSON.stringify(result,null,2));
  }
}catch(error){result.error=String(error.message).replace(/https?:\/\/\S+/g,'[redacted]');process.exitCode=1;}
finally{
  await pong.read(pause).catch(()=>{});
  result.restored=await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();window.__pongUndoDirectCreditTrial?.();!window.__pongUndoDirectCreditTrial').catch(()=>false);
  pong.close();tik.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
