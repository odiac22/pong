// CPU-profile the TikTok (or Pong) page of Pong 1 and attribute time by script.
// node profile-page.mjs <seconds> [tiktok|pong] [out.json]
// Script URLs are reduced to host + file name; query strings are dropped.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = 'C:\\Users\\arian\\Documents\\New project\\ifab-quiz-project\\tools\\android-sdk\\platform-tools\\adb.exe';
const [seconds = '40', which = 'tiktok', out = 'F:\\pong-claude-bench\\live\\profile.json'] = process.argv.slice(2);
const adb = (...a) => execFileSync(ADB, a, {encoding: 'utf8'});
const pid = adb('shell', 'pidof', 'com.odiac22.pong1').trim().split(/\s+/)[0];
const port = 9244;
adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find(x => x.type === 'page' && /tiktok\.com/i.test(x.url) === (which === 'tiktok'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const wait = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({id: n, method, params})); });
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', {interval: 1000});
await send('Profiler.start');
await new Promise(r => setTimeout(r, Number(seconds) * 1000));
const {result} = await send('Profiler.stop');
const p = result.profile;
const short = url => { if (!url) return '(injected/eval: Pong scripts)'; try { const u = new URL(url); return u.host + '/' + u.pathname.split('/').pop(); } catch { return url.slice(0, 40); } };
const byNode = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const dt = new Map();
p.samples.forEach((s, i) => dt.set(s, (dt.get(s) || 0) + (p.timeDeltas[i] || 0)));
const special = ['(idle)', '(program)', '(garbage collector)', '(root)'];
// Built-ins (get cookie, getBoundingClientRect, fetch...) have no script URL:
// charge them to the nearest JS caller. Pong's evaluateJavascript code has no
// URL either but does have line numbers.
const owner = nodeId => {
  for (let id = nodeId; id !== undefined; id = parent.get(id)) {
    const f = byNode.get(id).callFrame;
    if (special.includes(f.functionName)) return f.functionName;
    if (f.url) return short(f.url);
    if (f.lineNumber >= 0) return '(Pong injected script)';
  }
  return '(unknown)';
};
const byScript = {}, byFn = {}, callers = {};
for (const [nodeId, us] of dt) {
  const n = byNode.get(nodeId), f = n.callFrame;
  const script = owner(nodeId);
  byScript[script] = (byScript[script] || 0) + us;
  const key = `${f.functionName || '(anon)'} @ ${f.url ? short(f.url) : script}:${f.lineNumber}`;
  byFn[key] = (byFn[key] || 0) + us;
  if (!f.url && f.lineNumber < 0 && !special.includes(f.functionName)) {
    // For built-ins, record the calling function too.
    const pid = parent.get(nodeId), pf = pid !== undefined ? byNode.get(pid).callFrame : null;
    const ck = `${f.functionName} <- ${pf ? (pf.functionName || '(anon)') + ' @ ' + (pf.url ? short(pf.url) : '(no url)') + ':' + pf.lineNumber : '?'}`;
    callers[ck] = (callers[ck] || 0) + us;
  }
}
const ms = o => Object.entries(o).map(([k, v]) => [k, Math.round(v / 1000)]).sort((a, b) => b[1] - a[1]);
const summary = {seconds: Number(seconds), byScript: ms(byScript).slice(0, 15), topFunctions: ms(byFn).slice(0, 25),
  builtinCallers: ms(callers).slice(0, 15)};
writeFileSync(out, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
