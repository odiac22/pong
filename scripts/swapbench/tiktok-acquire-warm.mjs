// Same measurement as tiktok-acquire.mjs, but through the persistent
// extractor worker plus a direct Node download (the candidate design).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import https from 'node:https';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const PY = arg('python', 'C:\\Users\\arian\\Documents\\Codex\\2026-07-15\\files-mentioned-by-the-user-chatgpt\\work\\pong\\.pong-local-ai\\lora-venv\\Scripts\\python.exe');
const urls = readFileSync(arg('urls', 'F:\\pong-claude-bench\\tiktok-public-urls.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const OUT = path.join('F:\\pong-claude-bench\\results', arg('label', 'tiktok-acquire-warm'));
mkdirSync(OUT, {recursive: true});

const worker = spawn(PY, [path.join(here, '..', 'tiktok_extractor_worker.py')], {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
const lines = readline.createInterface({input: worker.stdout});
const waiting = new Map();
let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.ready) return readyResolve();
  waiting.get(message.id)?.(message); waiting.delete(message.id);
});
let nextId = 0;
const resolveMedia = url => new Promise(resolve => {
  const id = ++nextId; waiting.set(id, resolve);
  worker.stdin.write(JSON.stringify({id, url}) + '\n');
});

function download(info) {
  return new Promise(resolve => {
    const started = performance.now();
    let firstByte = null, bytes = 0;
    const headers = {...info.headers, 'accept-encoding': 'identity'};
    if (info.cookies) headers.cookie = info.cookies;
    const request = https.get(info.url, {headers}, response => {
      response.on('data', chunk => { firstByte ??= performance.now() - started; bytes += chunk.length; });
      response.on('end', () => resolve({status: response.statusCode, firstByteMs: firstByte && Math.round(firstByte), totalMs: Math.round(performance.now() - started), bytes}));
    });
    request.on('error', error => resolve({status: 0, error: error.code || 'error'}));
  });
}

const t0 = performance.now();
await ready;
const startupMs = Math.round(performance.now() - t0);
const rows = [];
for (const url of urls) {
  const started = performance.now();
  const info = await resolveMedia(url);
  const resolveMs = Math.round(performance.now() - started);
  const fetched = info.ok ? await download(info) : {status: 0, error: info.error};
  const row = {video: url.split('/').pop(), ok: info.ok && fetched.status === 200, resolveMs, extractorMs: info.ms,
    status: fetched.status, firstByteMs: fetched.firstByteMs != null ? resolveMs + fetched.firstByteMs : null,
    totalMs: fetched.totalMs != null ? resolveMs + fetched.totalMs : null, bytes: fetched.bytes, vcodec: info.vcodec, error: fetched.error};
  rows.push(row); console.log(JSON.stringify(row));
}
worker.stdin.end();
const sorted = key => rows.filter(r => r.ok).map(r => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
const pct = (list, p) => list.length ? list[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)] : null;
const summary = {at: new Date().toISOString(), workerStartupMs: startupMs, n: rows.length, ok: rows.filter(r => r.ok).length,
  firstByteMs: {median: pct(sorted('firstByteMs'), .5), p95: pct(sorted('firstByteMs'), .95)},
  totalMs: {median: pct(sorted('totalMs'), .5), p95: pct(sorted('totalMs'), .95)}, rows};
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({workerStartupMs: startupMs, firstByteMs: summary.firstByteMs, totalMs: summary.totalMs, ok: summary.ok}));
