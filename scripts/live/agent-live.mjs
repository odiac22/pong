// Claude's live session with the Pong app over wireless debugging.
//   node agent-live.mjs start [pong1|pong2]   connect + keep the LIVE dot on (runs until stopped)
//   node agent-live.mjs eval "<js>" [app]     run JS in the Pong page, print JSON result
//   node agent-live.mjs shot <file.png>       phone screenshot (what the owner sees)
//   node agent-live.mjs stop                  stop the heartbeat (dot goes out within ~6 s)
// URLs printed by diagnostics are redacted; tokens/cookies are never read.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADB = process.env.PONG_ADB || 'C:\\Users\\arian\\Documents\\New project\\ifab-quiz-project\\tools\\android-sdk\\platform-tools\\adb.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(here, '.agent-live.pid');
const PORT = 9231;
const adb = (...args) => execFileSync(ADB, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pongSocket(app) {
  const pid = adb('shell', 'pidof', `com.odiac22.${app}`).trim().split(/\s+/)[0];
  if (!pid) throw new Error(`${app} is not running on the phone - open Pong first`);
  const sockets = adb('shell', 'cat', '/proc/net/unix').split('\n')
    .map(line => line.trim().split(/\s+/).pop()).filter(name => name && name.startsWith('@webview_devtools_remote_'));
  const exact = sockets.find(name => name === `@webview_devtools_remote_${pid}`);
  if (!exact) throw new Error(`no WebView debug socket for ${app} (pid ${pid})`);
  return exact.slice(1);
}

async function pongTarget(app) {
  adb('forward', `tcp:${PORT}`, `localabstract:${pongSocket(app)}`);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  // The Pong WebView carries the PongAgentLive bridge; TikTok's does not.
  const pages = targets.filter(t => t.type === 'page' && !/tiktok\.com/i.test(t.url));
  if (!pages.length) throw new Error('Pong page not found in WebView targets');
  return pages[0];
}

async function cdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const waiting = new Map();
  socket.onmessage = event => { const m = JSON.parse(event.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); socket.send(JSON.stringify({id: n, method, params})); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluation failed');
    return r.result?.result?.value;
  };
  return {send, evaluate, close: () => socket.close()};
}

const [command, arg1, arg2] = process.argv.slice(2);
if (command === 'start') {
  const app = arg1 || 'pong1';
  if (process.env.AGENT_LIVE_CHILD !== '1') {
    if (existsSync(PID_FILE)) { try { process.kill(Number(readFileSync(PID_FILE, 'utf8')), 0); console.log('already live'); process.exit(0); } catch {} }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', app], {detached: true, stdio: 'ignore', env: {...process.env, AGENT_LIVE_CHILD: '1'}});
    child.unref(); writeFileSync(PID_FILE, String(child.pid));
    console.log(`live session started for ${app} (pid ${child.pid})`);
    process.exit(0);
  }
  // Child: heartbeat every 2 s with a 6 s expiry; reconnect if the page reloads.
  for (;;) {
    try {
      const page = await cdp(await pongTarget(app));
      for (;;) { await page.evaluate('window.PongAgentLive && window.PongAgentLive.ping(6), true'); await sleep(2000); }
    } catch { await sleep(2000); }
  }
} else if (command === 'stop') {
  if (existsSync(PID_FILE)) { try { process.kill(Number(readFileSync(PID_FILE, 'utf8'))); } catch {} unlinkSync(PID_FILE); }
  try { const page = await cdp(await pongTarget(arg1 || 'pong1')); await page.evaluate('window.PongAgentLive && window.PongAgentLive.stop()'); page.close(); } catch {}
  console.log('live session stopped');
} else if (command === 'eval') {
  const page = await cdp(await pongTarget(arg2 || 'pong1'));
  const value = await page.evaluate(arg1);
  console.log(JSON.stringify(value, null, 1).replace(/https?:\/\/[^\s"]+/g, '<url>'));
  page.close();
} else if (command === 'shot') {
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], {maxBuffer: 64 * 1024 * 1024});
  writeFileSync(arg1 || 'phone.png', png);
  console.log(`saved ${arg1 || 'phone.png'} (${png.length} bytes)`);
} else {
  console.log('usage: node agent-live.mjs start|stop|eval|shot');
}
