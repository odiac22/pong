// Swap benchmark server: stock clips, the phone's real TikTok overlay
// assets, the harness page, and a /pong-swap proxy to an isolated renderer.
// Usage: node server.mjs [--port 18800] [--renderer 18792] [--stock DIR]
import http from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const PORT = Number(arg('port', 18800));
const RENDERER = Number(arg('renderer', 18792));
const STOCK = arg('stock', 'F:\\pong-claude-bench\\stock');
const ASSETS = path.join(repo, 'android-app', 'app', 'src', 'main', 'assets');

const types = { '.mp4': 'video/mp4', '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };

function serveFile(req, res, file) {
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const size = statSync(file).size;
  const type = types[path.extname(file)] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${size}`, 'cache-control': 'no-store' });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

function proxy(req, res, url) {
  const upstream = http.request({
    hostname: '127.0.0.1', port: RENDERER, method: req.method,
    path: `${url.pathname.replace(/^\/pong-swap/, '') || '/'}${url.search}`,
    headers: { ...req.headers, host: `127.0.0.1:${RENDERER}`, 'x-pong-proxy': '1' }
  }, response => {
    res.writeHead(response.statusCode || 502, { ...response.headers, 'cache-control': 'no-store' });
    response.pipe(res);
  });
  upstream.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(String(error.message)); });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/pong-swap/')) return proxy(req, res, url);
  if (url.pathname.startsWith('/stock/')) return serveFile(req, res, path.join(STOCK, path.basename(decodeURIComponent(url.pathname))));
  if (url.pathname.startsWith('/assets/')) return serveFile(req, res, path.join(ASSETS, path.basename(url.pathname)));
  if (url.pathname === '/' || url.pathname === '/bench.html') return serveFile(req, res, path.join(here, 'bench.html'));
  if (url.pathname === '/bench.js') return serveFile(req, res, path.join(here, 'bench.js'));
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`swapbench on http://127.0.0.1:${PORT} -> renderer ${RENDERER}`));
