import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/renewable-source-${Date.now()}.json`;
const html=readFileSync('index.html','utf8');
const code=html.slice(html.indexOf('function pongFaceSwapPlayableSource('),html.indexOf('const pongSourceDurationByUrl'));
const result={diagnosticOnly:true,note:'Source renewal and renderer-frame verification, not sub-second or forty-video qualification.',samples:[]};
const route='(()=>{const w=pongFaceSwapCurrentWrapper(),v=w?.querySelector("video"),s=pongFaceSwapPlayableSource(w,v);if(!s)return null;const u=new URL(s.source);return {route:u.pathname.startsWith("/video-cache/media/")?"/video-cache/media/[id]":u.pathname,profile:u.searchParams.get("profile"),page:u.pathname==="/video-cache/stream"&&new URL(u.searchParams.get("url")).pathname===new URL(pongTikTokLiveState.current).pathname};})()';
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 result.before=await pong.read(route);
 const doc=await tik.read('({timeOrigin:performance.timeOrigin,path:location.pathname})');
 const settings=await fetch('http://127.0.0.1:8792/settings').then(r=>r.json());
 await pong.read(code+';true');
 result.after=await pong.read(route);
 if(result.after?.route!=='/video-cache/stream'||!result.after?.page)throw Error('Expected renewable route for exact current post');
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const begin=performance.now();
 while(performance.now()-begin<30000){
  const owner=await pong.read('(()=>{const w=pongFaceSwapCurrentWrapper();return {session:w?.dataset.pongFaceSwapSessionId||"",page:pongTikTokWrapperUrl(w)===pongTikTokLiveState.current};})()');
  let r=null;
  if(owner.session){
   const response=await fetch('http://127.0.0.1:8792/sessions/'+encodeURIComponent(owner.session));
   if(response.ok){const s=(await response.json()).session;
    r={id:s.id,state:s.state,frames:s.frames,transformedFrames:s.transformedFrames,
     errorCode:s.errorCode,error:String(s.error||'').replace(/https?:\/\/\S+/g,'[redacted]')};
   }
  }
  result.samples.push({at:performance.now()-begin,owner,r});
  if(r?.error)throw Error(r.error);
  if(owner.page&&r?.transformedFrames>=3){result.renderedAgain=true;break}
  await new Promise(r=>setTimeout(r,150));
 }
 result.sameTikTokDocument=JSON.stringify(doc)===JSON.stringify(await tik.read('({timeOrigin:performance.timeOrigin,path:location.pathname})'));
 result.sameQuality=JSON.stringify(settings.config)===JSON.stringify((await fetch('http://127.0.0.1:8792/settings').then(r=>r.json())).config);
 result.pass=result.renderedAgain===true&&result.sameTikTokDocument&&result.sameQuality;
 if(!result.pass)process.exitCode=1;
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 pong.close();tik.close();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({output,before:result.before,after:result.after,renderedAgain:result.renderedAgain,pass:result.pass,error:result.error}));
}
