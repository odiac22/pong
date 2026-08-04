import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = '0.0.0.0';
const PORT = Number(process.env.PONG_CONTROL_PORT || 8788);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOGGLE_SCRIPT = path.join(ROOT, 'scripts', 'toggle-pong.ps1');
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const PONG_PORTS = [8787, 8790, 8791];
let activeAction = null;

function normalizeAddress(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function isPrivateAddress(value) {
  const address = normalizeAddress(value);
  if (address === '127.0.0.1' || address === '::1') return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = address.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function originAllowed(rawOrigin) {
  if (!rawOrigin) return true;
  try {
    const origin = new URL(rawOrigin);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    if (origin.hostname === 'odiac22.github.io') return true;
    return origin.hostname === 'localhost' || isPrivateAddress(origin.hostname);
  } catch (_) {
    return false;
  }
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || '');
  return {
    'access-control-allow-origin': originAllowed(origin) && origin ? origin : 'null',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-pong-control',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    vary: 'Origin'
  };
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...corsHeaders(req),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function portOpen(port, timeoutMs = 450) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Boolean(value));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function pongStatus() {
  const ports = await Promise.all(PONG_PORTS.map(async port => [port, await portOpen(port)]));
  const listening = Object.fromEntries(ports);
  let ready = false;
  let health = null;
  if (listening[8787]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch('http://127.0.0.1:8787/health', {
        cache: 'no-store',
        signal: controller.signal
      });
      if (response.ok) {
        health = await response.json();
        ready = health?.ready === true;
      }
    } catch (_) {
      // A listening server can still be warming or restarting.
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    running: ports.some(([, open]) => open),
    ready,
    action: activeAction,
    ports: listening,
    health
  };
}

function runToggle(action) {
  if (activeAction) {
    return Promise.reject(new Error(`Pong is already ${activeAction.toLowerCase()}.`));
  }
  activeAction = action === 'Start' ? 'Starting' : 'Stopping';
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', TOGGLE_SCRIPT,
      '-Action', action,
      '-Quiet'
    ], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errorOutput += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      activeAction = null;
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      activeAction = null;
      if (code === 0) resolve(output.trim());
      else reject(new Error(errorOutput.trim() || output.trim() || `Pong ${action.toLowerCase()} failed.`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  const remoteAddress = normalizeAddress(req.socket.remoteAddress);
  const origin = String(req.headers.origin || '');
  if (!isPrivateAddress(remoteAddress) || !originAllowed(origin)) {
    sendJson(req, res, 403, { ok: false, error: 'Pong control is limited to this PC and its private LAN.' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/status')) {
    sendJson(req, res, 200, { ok: true, ...(await pongStatus()) });
    return;
  }
  if (req.method === 'POST' && (requestUrl.pathname === '/start' || requestUrl.pathname === '/stop')) {
    if (String(req.headers['x-pong-control'] || '') !== '1') {
      sendJson(req, res, 403, { ok: false, error: 'Missing Pong control header.' });
      return;
    }
    try {
      const action = requestUrl.pathname === '/start' ? 'Start' : 'Stop';
      const message = await runToggle(action);
      sendJson(req, res, 200, { ok: true, message, ...(await pongStatus()) });
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || String(error), ...(await pongStatus()) });
    }
    return;
  }
  sendJson(req, res, 404, { ok: false, error: 'Not found.' });
});

server.on('error', error => {
  if (error?.code !== 'EADDRINUSE') console.error(error);
  process.exit(error?.code === 'EADDRINUSE' ? 0 : 1);
});

server.listen(PORT, HOST, () => {
  console.log(`Pong control listening on http://127.0.0.1:${PORT}`);
});
