// Chrome trace of the Pong 1 WebView renderer for N seconds; totals the
// renderer main thread's top-level work by event name.
// node trace-page.mjs <seconds> [tiktok|pong]
import { execFileSync } from 'node:child_process';

const ADB = 'C:\\Users\\arian\\Documents\\New project\\ifab-quiz-project\\tools\\android-sdk\\platform-tools\\adb.exe';
const [seconds = '10', which = 'tiktok'] = process.argv.slice(2);
const adb = (...a) => execFileSync(ADB, a, {encoding: 'utf8'});
const pid = adb('shell', 'pidof', 'com.odiac22.pong1').trim().split(/\s+/)[0];
const port = 9245;
adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find(x => x.type === 'page' && /tiktok\.com/i.test(x.url) === (which === 'tiktok'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const wait = new Map(); const events = []; let done;
const finished = new Promise(r => { done = r; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
  else if (m.method === 'Tracing.tracingComplete') done();
  else if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
};
const send = (method, params = {}) => new Promise(r => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({id: n, method, params})); });
await send('Tracing.start', {transferMode: 'ReportEvents',
  traceConfig: {includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'media', 'v8']}});
await new Promise(r => setTimeout(r, Number(seconds) * 1000));
await send('Tracing.end');
await finished;
// Renderer main thread = the thread carrying the most RunTask time.
const runTask = events.filter(e => e.name === 'RunTask' && e.ph === 'X');
const byThread = {};
for (const e of runTask) byThread[`${e.pid}:${e.tid}`] = (byThread[`${e.pid}:${e.tid}`] || 0) + (e.dur || 0);
const main = Object.entries(byThread).sort((a, b) => b[1] - a[1])[0]?.[0];
const [mp, mt] = main.split(':').map(Number);
const onMain = events.filter(e => e.pid === mp && e.tid === mt && e.ph === 'X' && e.dur);
const tasks = onMain.filter(e => e.name === 'RunTask');
const busyMs = tasks.reduce((a, e) => a + e.dur, 0) / 1000;
// Self time per event name (subtract direct children) for a clean split.
onMain.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const self = {}, stack = [];
for (const e of onMain) {
  while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
  if (stack.length) stack.at(-1).childDur = (stack.at(-1).childDur || 0) + e.dur;
  stack.push(e);
}
for (const e of onMain) self[e.name] = (self[e.name] || 0) + (e.dur - (e.childDur || 0));
const top = Object.entries(self).map(([k, v]) => [k, Math.round(v / 1000)]).sort((a, b) => b[1] - a[1]).slice(0, 25);
const long = tasks.filter(e => e.dur > 50000).length;
console.log(JSON.stringify({seconds: Number(seconds), mainThreadBusyMs: Math.round(busyMs), longTasks: long, selfMsByEvent: top}, null, 1));
process.exit(0);
