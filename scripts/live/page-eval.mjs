// Run a JS file in the TikTok or Pong page of Pong 1 and print the JSON result.
// node page-eval.mjs <file.js> [tiktok|pong]   (URLs in results are the caller's job to redact)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ADB = 'C:\\Users\\arian\\Documents\\New project\\ifab-quiz-project\\tools\\android-sdk\\platform-tools\\adb.exe';
const [file, which = 'tiktok'] = process.argv.slice(2);
const adb = (...a) => execFileSync(ADB, a, {encoding: 'utf8'});
const pid = adb('shell', 'pidof', 'com.odiac22.pong1').trim().split(/\s+/)[0];
const port = 9243;
adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find(x => x.type === 'page' && /tiktok\.com/i.test(x.url) === (which === 'tiktok'));
if (!target) { console.log(JSON.stringify({error: `no ${which} page`})); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id !== 1) return;
  const r = m.result;
  console.log(JSON.stringify(r?.exceptionDetails ? {exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text} : r?.result?.value, null, 1));
  process.exit(0);
};
ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate',
  params: {expression: readFileSync(file, 'utf8'), returnByValue: true, awaitPromise: true}}));
