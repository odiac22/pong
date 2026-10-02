// Records a swipe/swap timeline from the phone (Pong + TikTok pages) and the
// PC renderer every 1 s. Video IDs are shortened; no URLs are written.
// node monitor.mjs <seconds> <out.json>
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = 'C:\\Users\\arian\\Documents\\New project\\ifab-quiz-project\\tools\\android-sdk\\platform-tools\\adb.exe';
const seconds = Number(process.argv[2] || 60), out = process.argv[3] || 'monitor.json';
const adb = (...a) => execFileSync(ADB, a, {encoding: 'utf8'});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(tiktok, port) {
  const pid = adb('shell', 'pidof', 'com.odiac22.pong1').trim().split(/\s+/)[0];
  adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find(x => x.type === 'page' && /tiktok\.com/i.test(x.url) === tiktok);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  return expr => new Promise(res => { const n = ++id; wait.set(n, m => res(m.result?.result?.value)); ws.send(JSON.stringify({id: n, method: 'Runtime.evaluate', params: {expression: expr, returnByValue: true}})); });
}

const pongExpr = `(() => { const s = pongTikTokLiveState, f = pongFaceSwapState, w = pongFaceSwapCurrentWrapper();
  const id = u => String(u || '').match(/video\\/(\\d+)/)?.[1]?.slice(-5) || '';
  return {post: id(s.current), kind: s.postKind, session: String(w?.dataset.pongFaceSwapSessionId || '').slice(0, 8),
    phase: w?.dataset.pongFaceSwapPhase || '', presented: !!w?.dataset.pongTikTokPresentedSession,
    prefetch: [...f.prefetches.values()].map(e => String(e.sessionId || '').slice(0, 8) + (e.ready ? '+' : '-'))}; })()`;
const tiktokExpr = `(() => { const s = window.__pongDomSwap, w = window.__pongDomSwapWarm, v = s?.original, o = s?.overlay;
  return {visible: !!s?.visible, session: String(s?.sessionId || '').slice(0, 8), warm: String(w?.sessionId || '').slice(0, 8),
    lagMs: v && o ? Math.round(((v.currentTime - s.start) - o.currentTime) * 1000) : null, overlayReady: o?.readyState ?? null}; })()`;

const pong = await connect(false, 9241), tiktok = await connect(true, 9242);
const rows = [], t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  const at = Date.now();
  const [p, t, r] = await Promise.all([pong(pongExpr), tiktok(tiktokExpr),
    fetch('http://127.0.0.1:8792/sessions').then(x => x.json()).catch(() => ({sessions: []}))]);
  const sessions = r.sessions.map(s => ({id: s.id.slice(0, 8), prefetch: s.prefetch, state: s.state, frames: s.frames, tx: s.transformedFrames,
    firstTxMs: s.firstTransformedFrameAt ? Math.round((s.firstTransformedFrameAt - s.createdAt) * 1000) : null,
    ageMs: Math.round(at - s.createdAt * 1000), compat: s.compatibilityStatus, face: String(s.selectedFaceId || '').replace(/-[0-9a-f]{12}$/, ''),
    // Where a session spends its startup: ms after creation for each milestone.
    srcOpen: s.sourceOpenedAt ? Math.round((s.sourceOpenedAt - s.createdAt) * 1000) : null,
    models: s.modelsReadyAt ? Math.round((s.modelsReadyAt - s.createdAt) * 1000) : null,
    embed: s.embeddingReadyAt ? Math.round((s.embeddingReadyAt - s.createdAt) * 1000) : null,
    firstSrcFrame: s.firstSourceFrameAt ? Math.round((s.firstSourceFrameAt - s.createdAt) * 1000) : null,
    started: s.startedAt ? Math.round((s.startedAt - s.createdAt) * 1000) : null, error: s.error || ''}));
  rows.push({t: (at - t0) / 1000, pong: p, tiktok: t, sessions});
  await sleep(Math.max(0, 1000 - (Date.now() - at)));
}
writeFileSync(out, JSON.stringify(rows, null, 1));
console.log(`recorded ${rows.length} samples -> ${out}`);
process.exit(0);
