// Measures how fast the PC can get a TikTok video's first bytes and whole
// file with Baseline 1.0's exact downloader command (cold yt-dlp per video).
// Prints timings only; page URLs are public, media links are never logged.
// node tiktok-acquire.mjs --urls F:\pong-claude-bench\tiktok-public-urls.txt --label baseline-1.0
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const PY = arg('python', 'C:\\Users\\arian\\Documents\\Codex\\2026-07-15\\files-mentioned-by-the-user-chatgpt\\work\\pong\\.pong-local-ai\\lora-venv\\Scripts\\python.exe');
const urls = readFileSync(arg('urls', 'F:\\pong-claude-bench\\tiktok-public-urls.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const OUT = path.join('F:\\pong-claude-bench\\results', arg('label', 'tiktok-acquire'));
mkdirSync(OUT, {recursive: true});

function acquire(url) {
  return new Promise(resolve => {
    const started = performance.now();
    let firstByte = null, bytes = 0;
    const child = spawn(PY, ['-m', 'yt_dlp', '--no-warnings', '--impersonate', 'chrome', '--no-playlist', '-f',
      'best[vcodec^=h264][ext=mp4]/best[vcodec^=avc1][ext=mp4]/download/best[ext=mp4]/best', '-o', '-', url],
      {windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
    child.stdout.on('data', chunk => { firstByte ??= performance.now() - started; bytes += chunk.length; });
    child.on('close', code => resolve({video: url.split('/').pop(), code, firstByteMs: firstByte && Math.round(firstByte),
      totalMs: Math.round(performance.now() - started), bytes}));
  });
}

const rows = [];
for (const url of urls) { const row = await acquire(url); rows.push(row); console.log(JSON.stringify(row)); }
const sorted = key => rows.map(r => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
const pct = (list, p) => list.length ? list[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)] : null;
const summary = {at: new Date().toISOString(), n: rows.length, ok: rows.filter(r => r.code === 0).length,
  firstByteMs: {median: pct(sorted('firstByteMs'), .5), p95: pct(sorted('firstByteMs'), .95)},
  totalMs: {median: pct(sorted('totalMs'), .5), p95: pct(sorted('totalMs'), .95)}, rows};
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({firstByteMs: summary.firstByteMs, totalMs: summary.totalMs, ok: summary.ok}));
