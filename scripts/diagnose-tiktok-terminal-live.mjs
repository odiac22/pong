import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/terminal-live-${Date.now()}.json`;
const result={diagnosticOnly:true,samples:[]};
const routeForError=error=>{
 try{const value=String(error||'').match(/https?:\/\/[^'\s]+/)?.[0];const u=new URL(value);
  return {host:u.hostname,route:u.pathname.startsWith('/video-cache/media/')?'/video-cache/media/[id]':u.pathname,
   nestedPage:u.pathname==='/video-cache/stream'&&!!u.searchParams.get('url')};
 }catch{return null}
};
try{
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const begin=performance.now();
 while(performance.now()-begin<5000){
  const body=await fetch('http://127.0.0.1:8792/sessions').then(r=>r.json());
  const rows=(body.sessions||[]).map(s=>({id:s.id,state:s.state,errorCode:s.errorCode,
   error:String(s.error||'').replace(/https?:\/\/\S+/g,'[redacted]'),errorRoute:routeForError(s.error),frames:s.frames,transformedFrames:s.transformedFrames,
   startSeconds:s.startSeconds,createdAt:s.createdAt,timing:s.timingTotals}));
  result.samples.push({at:performance.now()-begin,sessions:rows});
  if(rows.some(s=>s.error)){console.log(JSON.stringify(rows));break;}
  await new Promise(r=>setTimeout(r,100));
 }
}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,samples:result.samples.length}));
}
