// Silent original-only evidence collection; NEVER run alongside performance measurements.
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const id=process.argv[2],out=path.resolve(process.argv[3]);
if(!/^\d{19}$/.test(id||''))throw Error('Expected an explicit post ID');
await mkdir(out,{recursive:true});
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const pong=await connectWebView(60195,'pong');let tik;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
  await pong.call('Page.navigate',{url:'http://127.0.0.1:8787/pong'});
  for(let i=0;i<60;i++){
    if(await pong.read("document.readyState==='complete'&&typeof openPongTikTokLiveMode==='function'"))break;
    await sleep(100);
  }
  await pong.read(await readFile('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
  await pong.read('openPongTikTokLiveMode();true');await sleep(1500);
  tik=await connectWebView(60195,'tiktok');
  await tik.call('Page.navigate',{url:`https://www.tiktok.com/@_/video/${id}`});
  let state;
  for(let i=0;i<80;i++){
    state=await tik.read(`({id:window.__pongTikTokObservedVideo?.pageUrl?.match(/video\\/(\\d+)/)?.[1],ready:window.__pongTikTokObservedVideo?.video?.readyState||0,challenge:!!document.querySelector('[id^="captcha-verify-container"]'),url:location.href})`);
    if(state.challenge)throw Error('User verification required');
    if(state.id===id&&state.ready>=2)break;
    await sleep(250);
  }
  if(state.id!==id||state.ready<2)throw Error('Requested video did not load');
  const report={videoId:id,url:state.url,kind:'paused original-only visibility review; not a performance run',samples:[]};
  for(let i=0;i<=10;i++){
    const time=i*.5;
    const actual=await tik.read(`(async()=>{const v=window.__pongTikTokObservedVideo.video;v.muted=true;v.volume=0;v.pause();v.currentTime=${time};await new Promise(resolve=>{let t=setTimeout(resolve,1800);v.addEventListener('seeked',()=>{clearTimeout(t);resolve()},{once:true})});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {time:v.currentTime,ready:v.readyState,width:v.videoWidth,height:v.videoHeight}})()`);
    const file=path.join(out,`original-${String(i).padStart(2,'0')}.png`);
    const png=execFileSync(adb,['-s','emulator-5582','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:12*1024*1024});
    await writeFile(file,png);report.samples.push({requested:time,...actual,file});
  }
  await writeFile(path.join(out,'evidence.json'),JSON.stringify(report,null,2));
  execFileSync('ffmpeg',['-y','-loglevel','error','-i',path.join(out,'original-%02d.png'),'-vf','scale=216:-1,tile=6x2','-frames:v','1',path.join(out,'contact.png')],{windowsHide:true});
  console.log(JSON.stringify({evidence:path.join(out,'evidence.json'),contact:path.join(out,'contact.png')}));
}finally {tik?.close();pong.close();}
