// Record only canonical TikTok pages already observed by this test receiver.
// No CDN URLs, cookies, tokens, private messages or account data are recorded.
import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
try {
  const observed=await pong.read('({current:pongTikTokLiveState.current,urls:pongTikTokLiveState.urls})');
  const anchors=await tik.read('[...document.querySelectorAll("a[href]")].map(a=>a.href)');
  // Explicit example supplied by the user in this chat, not an invented route.
  const supplied=process.argv.includes('--user-example')?['https://www.tiktok.com/@spambiebambi/video/7689552051906432270']:[];
  const pages=[...new Set([...supplied,observed.current,...observed.urls,...anchors].flatMap(raw=>{
    try{const u=new URL(raw);return u.hostname==='www.tiktok.com'&&/^\/@[^/]+\/video\/\d{15,22}\/?$/.test(u.pathname)?[u.origin+u.pathname]:[];}catch{return [];}
  }))].slice(0,12);
  if(!pages.length)throw Error('No observed canonical video pages; none invented');
  const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/repeatable-pool-${Date.now()}.json`;
  writeFileSync(output,JSON.stringify({scope:'Observed/user-supplied public video pages for diagnostic replays, not the 40-swipe acceptance test',pages},null,2));
  console.log(JSON.stringify({output,count:pages.length}));
} finally {pong.close();tik.close();}
