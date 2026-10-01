const endpoint = process.env.PONG_ANDROID_CDP || 'http://127.0.0.1:9333';
const timeoutMs = Number(process.env.PONG_TIKTOK_TIMEOUT_MS || 60_000);

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) {
        pending.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      } else pending.resolve(message.result?.result?.value);
    };
  }
  evaluate(expression) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true }
    }));
    return result;
  }
  close() { this.socket?.close(); }
}

const targets = await fetch(`${endpoint}/json`).then(response => response.json());
const pongTarget = targets.find(item => /\/pong(?:[?#]|$)/i.test(item.url || ''));
const tiktokTarget = targets.find(item => /tiktok\.com\/@madpricelol\/video\//i.test(item.url || ''));
if (!pongTarget?.webSocketDebuggerUrl || !tiktokTarget?.webSocketDebuggerUrl) {
  throw new Error('Pong and @madpricelol TikTok WebViews must both be open.');
}

const pong = new Cdp(pongTarget.webSocketDebuggerUrl);
const tiktok = new Cdp(tiktokTarget.webSocketDebuggerUrl);
await Promise.all([pong.open(), tiktok.open()]);
try {
  await tiktok.evaluate('window.__pongDomSwapClear?.(); true');
  const before = await tiktok.evaluate(`(()=>{const v=[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].find(v=>!v.paused)||document.querySelector('video:not(.pong-tiktok-swap-stream)');return {url:location.href,currentTime:Number(v?.currentTime||0),readyState:Number(v?.readyState||0),paused:Boolean(v?.paused)}})()`);
  const startedAt = performance.now();
  const activation = await pong.evaluate('window.PongTikTokLiveEnableSelectedSwap?.() || "unavailable"');
  let visible = null;
  let integrated = null;
  while (performance.now() - startedAt < timeoutMs) {
    visible = await tiktok.evaluate('window.__pongDomSwapSync?.() || {active:false,visible:false}');
    integrated = await pong.evaluate(`(()=>{try{return JSON.parse(window.PongTikTokLiveIntegratedState?.()||'{}')}catch(e){return{}}})()`);
    if (visible?.visible) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const after = await tiktok.evaluate(`(()=>{const s=window.__pongDomSwap,v=s?.original,o=s?.overlay;return{overlayCount:document.querySelectorAll('video.pong-tiktok-swap-stream').length,originalOpacity:v?.style?.opacity||'',overlayOpacity:o?.style?.opacity||'',originalPlaying:Boolean(v&&!v.paused),overlayMuted:Boolean(o?.muted),actionControls:document.querySelectorAll('[data-e2e="like-icon"],[data-e2e="comment-icon"],[data-e2e="share-icon"]').length}})()`);
  const result = {
    account: '@madpricelol',
    face: 'Approved 8',
    activation,
    before,
    totalMs: Math.round(performance.now() - startedAt),
    attachedToVisibleMs: visible?.firstVisibleAt && visible?.createdAt
      ? Math.round(visible.firstVisibleAt - visible.createdAt)
      : null,
    visible,
    integrated,
    after,
    passed: Boolean(
      visible?.visible && after?.overlayCount === 1 && after?.originalOpacity === '0' &&
      after?.overlayOpacity === '1' && after?.originalPlaying && after?.overlayMuted &&
      after?.actionControls >= 3
    )
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  pong.close();
  tiktok.close();
}
