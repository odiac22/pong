import {createHash} from 'node:crypto';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const p=await connectWebView(60195,'pong');
try {
 const pages=await p.read('pongTikTokLiveState.urls');
 const ids=pages.map(page=>{const u=new URL(page);return createHash('sha256').update(u.hostname.toLowerCase()+u.pathname).digest('hex').slice(0,32)});
 const data=await fetch('http://127.0.0.1:8787/video-cache/status?ids='+ids.join(',')).then(r=>r.json());
 console.log(JSON.stringify({feed:pages.length,records:(data.records||[]).map(({id,status,bytes,totalBytes,tiktokSourceTransport})=>({id,status,bytes,totalBytes,tiktokSourceTransport}))}));
} finally {p.close()}
