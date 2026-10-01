// Provision the existing TikTok Remote pairing credential into one authorized
// Pong WebView. No page navigation, service start, or credential output.
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adb = process.env.PONG_ADB_PATH || 'C:/Users/arian/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const expectedOrigin = 'http://192.168.1.124:8787';
const allowedPackages = new Set(['com.odiac22.pong1', 'com.odiac22.pong2']);
const options = {device: 'emulator-5582', package: 'com.odiac22.pong1'};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  if (!value || !['--device', '--package'].includes(flag)) throw Error('Usage: node scripts/pair-pong-remote-device.mjs [--device SERIAL] [--package com.odiac22.pong1|com.odiac22.pong2]');
  options[flag.slice(2)] = value;
}
if (!/^[A-Za-z0-9._:-]{1,80}$/.test(options.device) || !allowedPackages.has(options.package)) {
  throw Error('Select a valid device serial and Pong package');
}

async function adbRun(args) {
  const result = await exec(adb, ['-s', options.device, ...args], {windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024});
  return result.stdout.trim();
}

async function provision() {
  const token = (await readFile(path.join(repo, 'Pong Swap', 'cache', 'tiktok-remote-pairing-token'), 'utf8')).trim();
  if (token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error('PC remote pairing credential is missing or invalid');
  const devices = await adbRun(['devices']);
  if (!devices.split(/\r?\n/).some(line => line.split(/\s+/)[0] === options.device && /\sdevice(?:\s|$)/.test(line))) {
    throw Error('Selected device is not connected and authorized');
  }
  const pids = (await adbRun(['shell', 'pidof', options.package])).split(/\s+/).filter(value => /^\d+$/.test(value));
  if (pids.length !== 1) throw Error('Selected Pong package must have exactly one running WebView process');
  const socket = `webview_devtools_remote_${pids[0]}`;
  const sockets = await adbRun(['shell', 'cat', '/proc/net/unix']);
  if (!sockets.includes(`@${socket}`)) throw Error('Selected Pong WebView debugging socket is unavailable');
  const forwards = await adbRun(['forward', '--list']);
  const existing = forwards.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(parts => parts[0] === options.device && /^tcp:\d+$/.test(parts[1] || '') && parts[2] === `localabstract:${socket}`);
  let port = existing ? Number(existing[1].slice(4)) : 0;
  let temporary = false;
  if (!port) {
    port = Number(await adbRun(['forward', 'tcp:0', `localabstract:${socket}`]));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Could not reserve a local WebView debugging port');
    temporary = true;
  }
  try {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(5000)}).then(response => response.json());
    const targets = pages.filter(page => {
      try { const url = new URL(page.url); return page.type === 'page' && url.origin === expectedOrigin && /^\/pong\/?$/.test(url.pathname); }
      catch (_) { return false; }
    });
    if (targets.length !== 1 || !/^ws:\/\/127\.0\.0\.1:\d+\//.test(targets[0].webSocketDebuggerUrl || '')) {
      throw Error('Expected exactly one Pong page on the fixed local helper origin');
    }
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(Error('WebView debugger connection failed')); });
    try {
      const expression = `(() => {
        if (location.origin !== ${JSON.stringify(expectedOrigin)} || !/^\\/pong\\/?$/.test(location.pathname)) return false;
        localStorage.setItem('pong_remote_pairing', ${JSON.stringify(token)});
        return localStorage.getItem('pong_remote_pairing') === ${JSON.stringify(token)};
      })()`;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('WebView storage verification timed out')), 5000);
        ws.onmessage = event => {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.id !== 1) return;
          clearTimeout(timer);
          if (message.error || message.result?.exceptionDetails) reject(Error('WebView storage verification failed'));
          else resolve(message.result?.result?.value === true);
        };
        ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression, returnByValue: true}}));
      });
      if (!result) throw Error('WebView origin or storage verification failed');
    } finally { ws.close(); }
  } finally {
    if (temporary) await adbRun(['forward', '--remove', `tcp:${port}`]);
  }
  console.log(`TikTok Remote paired with ${options.package} on ${options.device}; no page navigation or refresh.`);
}

provision().catch(error => {
  // Never print debugger expressions, command arguments, or the pairing value.
  console.error(error.message.startsWith('Command failed:') ? 'ADB operation failed' : error.message);
  process.exitCode = 1;
});
