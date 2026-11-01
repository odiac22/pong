// Read-only Pong page state for TikTok live mode (no URLs/text).
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(Number(process.env.PONG_CDP_PORT||9222),'pong');
const tik=await connectWebView(Number(process.env.PONG_CDP_PORT||9222),'tiktok');
try{
 const p=await pong.read(`(()=>{const s=window.pongTikTokLiveState||{};const w=typeof pongFaceSwapCurrentWrapper==='function'?pongFaceSwapCurrentWrapper():null;
  return {keys:Object.keys(s),current:!!s.current,next:!!s.next,urls:(s.urls||[]).length,generation:s.generation,lastReportAgeMs:s.reportedAt?performance.now()-s.reportedAt:null,
   wrapper:!!w,session:w?.dataset?.pongFaceSwapSessionId?.slice(0,8)||'',active:w?.dataset?.pongFaceSwapActive,
   diag:(window.pongRuntimeDiagnostics||[]).slice(-8).map(d=>({type:d.type,at:Math.round(d.at)})),enabled:window.pongFaceSwapState?.enabled}})()`);
 const t=await tik.read(`(()=>{const s=window.__pongTikTokObserverStats||{};return {stats:{scans:s.scans,fullScans:s.fullScans,maxMs:s.maxMs,errors:s.errors},lastKind:window.__pongTikTokPostEvidence?.kind,
   bridge:typeof window.PongTikTokFeed,report:typeof window.PongTikTokFeed?.report,articles:document.querySelectorAll('[data-e2e="recommend-list-item-container"]').length,
   browse:document.querySelectorAll('[data-e2e="browse-video"]').length,userPost:document.querySelectorAll('[data-e2e="user-post-item"]').length,searchItems:document.querySelectorAll('[data-e2e="search_top-item"]').length}})()`);
 console.log(JSON.stringify({pong:p,tiktok:t}));
}finally{pong.close();tik.close()}
