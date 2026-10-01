// Read-only Android Pong trace. Never navigates, plays media, or records URLs.
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
const out = path.resolve('artifacts', 'phone-handoff-' + Date.now());
await mkdir(out, { recursive: true });
const file = path.join(out, 'trace.jsonl');
const log = async (kind, data) => appendFile(file, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n');
const route = value => {
  try {
    const p = new URL(value).pathname;
    for (const r of ['/media-browser-relay/', '/proxy', '/generic-media/hls', '/simpcity/recall', '/media-page/recall']) if (p.startsWith(r)) return r;
    return 'other';
  } catch { return 'none'; }
};
let ws, nextId = 0;
const pending = new Map();
const requests = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(Error('timeout')); }, 2200);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
async function attach() {
  const pages = await (await fetch('http://127.0.0.1:9226/json', { signal: AbortSignal.timeout(2200) })).json();
  const page = pages.find(p => String(p.url).includes('/pong'));
  if (!page) throw Error('No Pong page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('socket timeout')), 2200);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(Error('socket error')); };
  });
  ws.onmessage = event => {
    const m = JSON.parse(String(event.data));
    const p = pending.get(m.id);
    if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error('CDP error')) : p.resolve(m.result); }
    if (m.method === 'Network.requestWillBeSent') {
      const r = route(m.params.request.url);
      if (r !== 'other' && r !== 'none') { requests.set(m.params.requestId, r); void log('request', { route: r }); }
      if (requests.size > 1000) requests.delete(requests.keys().next().value);
    }
    if (m.method === 'Network.responseReceived') {
      const r = route(m.params.response.url);
      if (r !== 'other' && r !== 'none') void log('response', { route: r, status: m.params.response.status, mime: m.params.response.mimeType });
    }
    if (m.method === 'Network.loadingFailed' && requests.has(m.params.requestId)) void log('requestFailed', { route: requests.get(m.params.requestId), cancelled: !!m.params.canceled, error: /^net::ERR_[A-Z_]+$/.test(m.params.errorText) ? m.params.errorText : 'network_error' });
  };
  await send('Network.enable');
  await log('attached', {});
}
const expression = `(() => ({visibility:document.visibilityState,videos:[...document.querySelectorAll('video')].map(v=>({readyState:v.readyState,networkState:v.networkState,paused:v.paused,ended:v.ended,seeking:v.seeking,muted:v.muted,currentTime:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,width:v.videoWidth,height:v.videoHeight,error:v.error?.code||0,frames:v.getVideoPlaybackQuality?.().totalVideoFrames||0,dropped:v.getVideoPlaybackQuality?.().droppedVideoFrames||0,buffered:[...Array(v.buffered.length)].map((_,i)=>[v.buffered.start(i),v.buffered.end(i)]),route:(v.currentSrc||'').includes('/media-browser-relay/')?'phone-relay':(v.currentSrc||'').includes('/proxy')?'pc-proxy':(v.currentSrc||'').includes('/generic-media/')?'pc-media':'other'}))}))()`;
await attach();
console.log(JSON.stringify({ ready: true, trace: file, durationMinutes: 10 }));
const finish = Date.now() + 600000;
let count = 0;
while (Date.now() < finish) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) await attach();
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    await log('media', result.result?.value || { unavailable: true });
  } catch { await log('media', { unavailable: true }); }
  if (count++ % 3 === 0) {
    for (const channel of [1, 2]) {
      try {
        const s = await (await fetch('http://127.0.0.1:8787/simpcity/recall?channel=' + channel, { signal: AbortSignal.timeout(2000) })).json();
        const videos = s.recall?.genericBundles?.flatMap(bundle => bundle.videos || []) || [];
        await log('receipt', { channel, captureId: s.mediaCapture?.id || null, stage: s.mediaCapture?.state || null, count: videos.length, videos: videos.map(v=>({duration:v.durationSeconds, phoneOnly:v.phoneConnectionOnly===true, hasRelay:!!v.browserRelayUrl, sourceCount:v.videoUrls?.length||0})) });
      } catch { await log('receipt', { channel, unavailable: true }); }
    }
  }
  await new Promise(r => setTimeout(r, 1000));
}
ws?.close();
console.log(JSON.stringify({ complete: true, trace: file }));
