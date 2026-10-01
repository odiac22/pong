// Silent server-side decoding only: no window, speakers, frames or URLs logged.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
const recall=await(await fetch('http://127.0.0.1:8787/simpcity/recall?channel=2')).json();
const videos=(recall.recall?.genericBundles||[]).flatMap(b=>b.videos||[]);
const rows=[];
const report=`artifacts/live-recall-start/server-decode-${Date.now()}.json`;
await fs.mkdir('artifacts/live-recall-start',{recursive:true});
for(const [index,video] of videos.entries()){
 const started=performance.now();
 const result=await new Promise(resolve=>{
  let progress='',stderr='',firstMs=null,timedOut=false;
  const child=spawn('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-rw_timeout','10000000',
   '-threads','2','-i',`http://127.0.0.1:8787/video-cache/stream?url=${encodeURIComponent(video.videoUrl)}`,
   '-t','3','-map','0:v:0','-an','-sn','-dn','-threads','2','-progress','pipe:1','-f','null','NUL'],{windowsHide:true});
  const timer=setTimeout(()=>{timedOut=true;child.kill();},20000);
  child.stdout.on('data',b=>{progress+=b;if(firstMs===null&&/frame=\s*[1-9]/.test(progress))firstMs=performance.now()-started});
  child.stderr.on('data',b=>{stderr+=b});
  child.on('error',()=>{clearTimeout(timer);resolve({pass:false,error:'decoder_launch_failed'})});
  child.on('close',code=>{
   clearTimeout(timer);
   const frames=Number([...progress.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1]||0);
   const mediaSeconds=Number([...progress.matchAll(/^out_time_us=(\d+)/gm)].at(-1)?.[1]||0)/1e6;
   resolve({pass:code===0&&frames>0&&mediaSeconds>=2.9,exit:code,timedOut,
    firstProgressMs:firstMs===null?null:Math.round(firstMs),frames,mediaSeconds,
    error:code?stderr.replace(/https?:\/\/\S+/g,'[URL]').slice(0,160):null});
  });
 });
 const row={index,elapsedMs:Math.round(performance.now()-started),...result};
 rows.push(row);console.log(JSON.stringify(row));
 await fs.writeFile(report,JSON.stringify({scope:'PC silent decode, not Android playback or wall-clock playback',rows},null,2));
}
console.log(JSON.stringify({report,passed:rows.filter(r=>r.pass).length,total:rows.length}));
