// Post-run inspection only: the normal status route refreshes the cache heartbeat.
// Never use this during timing qualification. Do not print signed URLs or titles.
import {readFileSync} from 'node:fs';
const run=JSON.parse(readFileSync(process.argv[2],'utf8'));
const response=await fetch('http://127.0.0.1:8787/video-cache/status',
  {signal:AbortSignal.timeout(5000)});
if(!response.ok)throw Error('Cache status unavailable: '+response.status);
const records=(await response.json()).records||[];
const rows=[];
for(const t of run.trials||[]){
  if(t.photoPost||t.firstPaintUpperMs!=null)continue;
  const view=t.samples?.at(-1)?.view;
  const videoId=view?.postKey?.match(/^video:(\d{15,22})$/)?.[1]||
    view?.path?.match(/\/video\/(\d{15,22})/)?.[1];
  if(!videoId)continue;
  const matches=records.filter(r=>(r.urls||[]).some(raw=>{
    try{const u=new URL(raw);return /(^|\.)tiktok\.com$/i.test(u.hostname)&&
      u.pathname.match(/\/video\/(\d{15,22})/)?.[1]===videoId;}catch{return false;}
  }));
  rows.push({trial:t.index,videoId,records:matches.map(r=>({
    id:r.id,status:r.status,ready:r.ready,bytes:r.bytes,totalBytes:r.totalBytes,
    failure:r.failure||null,transport:r.tiktokSourceTransport||null,
  }))});
}
console.log(JSON.stringify({postRunOnly:true,heartbeatRefreshed:true,rows},null,2));
