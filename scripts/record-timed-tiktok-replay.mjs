// Visual evidence ONLY. Screen recording is not used for performance acceptance.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
const id=process.argv[2],out=process.argv[3];
if(!/^\d{19}$/.test(id||'')||!out)throw Error('Expected benchmark video ID and output folder');
await mkdir(out,{recursive:true});
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const report={videoId:id,kind:'instrumented visual replay; NOT original benchmark footage',recordingOverhead:true,silent:true,events:[],paintEvents:[],firstConfirmedSwapMs:null};
let recorder;
const deviceFile=`/sdcard/pong-timed-${id}.mp4`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
  if(!(await tik.read(`window.__pongTikTokObservedVideo?.pageUrl?.endsWith('/${id}')`)))throw Error('Wrong visible video');
  await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo.video;v.muted=true;v.volume=0;v.pause();v.currentTime=0;return true})()`);
  await tik.read(await readFile('scripts/tiktok-audit-instrument.js','utf8'));
  await tik.read(`(()=>{document.getElementById('pong-timed-replay')?.remove();const e=document.createElement('div');e.id='pong-timed-replay';e.style.cssText='position:fixed;top:150px;left:16px;right:16px;z-index:2147483647;background:#111d32ee;color:#f5c852;padding:12px;border-radius:9px;font:600 17px monospace;pointer-events:none';e.textContent='VISUAL REPLAY (recording adds overhead) — ORIGINAL';document.body.append(e);return true})()`);
  recorder=spawn(adb,['-s','emulator-5582','shell','screenrecord','--time-limit','22','--bit-rate','10000000',deviceFile],{windowsHide:true,stdio:'ignore'});
  const recorded=new Promise(resolve=>recorder.once('exit',resolve));
  await delay(700);
  await tik.read('window.__pongTikTokObservedVideo.video.play().catch(()=>{});true');
  await delay(1600);
  report.requestAt=await tik.read(`(()=>{window.__pongReplayStart=performance.now();window.__pongReplayFirst=null;window.__pongReplayTimer=setInterval(()=>{const e=document.getElementById('pong-timed-replay');if(e)e.textContent='VISUAL REPLAY • recording adds overhead\\nSince swap request: '+Math.round(performance.now()-window.__pongReplayStart)+' ms\\n'+(window.__pongReplayFirst===null?'No confirmed swapped frame yet':'First confirmed swap: '+window.__pongReplayFirst+' ms')},100);return window.__pongReplayStart})()`);
  await pong.read(`(async()=>{const data=await pongFaceSwapControlFetch('/pong-swap/faces',{cache:'no-store'}).then(r=>r.json());const face=data.faces.find(f=>f.name==='Approved 8');if(!face)throw Error('Missing Approved 8');pongFaceSwapState.faces=data.faces;setPongFaceSwapSelection([face.id]);window.PongTikTokLiveEnableSelectedSwap();return true})()`);
  const until=performance.now()+17000;
  while(performance.now()<until){
    const view=await tik.read('window.__pongAuditSnapshot()');
    if(view.challenge)throw Error('Verification required');
    report.paintEvents.push(...(view.paintEvents||[]));
    const owner=await pong.read(`(()=>{const w=pongFaceSwapCurrentWrapper();return {session:w?.dataset.pongFaceSwapSessionId||'',url:pongTikTokLiveState.current}})()`);
    if(owner.session&&owner.url?.endsWith('/'+id)){
      const body=await fetch('http://127.0.0.1:8792/sessions/'+owner.session,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      const s=body.session;
      if(s){
        report.events.push({at:view.at-report.requestAt,mediaTime:view.original?.time,ready:view.original?.ready,frames:s.frames,transformed:s.transformedFrames,ranges:s.transformedFrameRanges});
        for(const p of report.paintEvents){
          const f=Math.round(p.mediaTime*s.fps);
          if(p.videoId===id&&p.session===s.id&&p.at>=report.requestAt&&(s.transformedFrameRanges||[]).some(([a,z])=>f>=a&&f<=z)){
            const ms=Math.round(p.at-report.requestAt);
            if(report.firstConfirmedSwapMs===null||ms<report.firstConfirmedSwapMs){
              report.firstConfirmedSwapMs=ms;
              await tik.read(`window.__pongReplayFirst=${ms};true`);
            }
          }
        }
      }
    }
    await delay(350);
  }
  await recorded;
  const file=path.join(out,`tiktok-${id}-timed-replay.mp4`);
  execFileSync(adb,['-s','emulator-5582','pull',deviceFile,file],{windowsHide:true,stdio:'pipe'});
  report.file=file;
}catch(e){report.error=e.message;process.exitCode=1}
finally{
  await tik.read(`clearInterval(window.__pongReplayTimer);document.getElementById('pong-timed-replay')?.remove();window.__pongAuditStop?.();true`).catch(()=>{});
  await pong.read(await readFile('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
  pong.close();tik.close();
  await writeFile(path.join(out,`replay-${id}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify({file:report.file,error:report.error||null,firstConfirmedSwapMs:report.firstConfirmedSwapMs,benchmark:false}));
}
