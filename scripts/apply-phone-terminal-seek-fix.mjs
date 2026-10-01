import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const c=await connectWebView(60196,'pong');
try {
 for(const name of ['pongFaceSwapAbsoluteTime','seekPongVideoTo']){
  const code=html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];
  await c.read(`${name}=(${code});true`);
 }
 console.log(await c.read(`(async()=>{const w=pongFaceSwapCurrentWrapper(),v=w?.querySelector('video');if(!v)return {ok:false};silenceAllPongAudioExcept();v.muted=true;v.volume=0;v.pause();w.dataset.userPaused='true';w.dataset.playIntent='false';delete w.dataset.userAudioIntent;const target=Number(w.dataset.pongFaceSwapPendingSeek);const seek=Number.isFinite(target)?target:0;await seekPongVideoTo(w,v,seek);return {ok:true,requestedSeconds:seek,muted:v.muted};})()`));
} finally {c.close()}
