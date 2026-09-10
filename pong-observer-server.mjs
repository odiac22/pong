import http from 'node:http';

const HOST = process.env.PONG_OBSERVER_HOST || '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.PONG_OBSERVER_PORT || 8799)));
const INGEST_TOKEN = String(process.env.PONG_OBSERVER_INGEST_TOKEN || '');
const ADMIN_TOKEN = String(process.env.PONG_OBSERVER_ADMIN_TOKEN || '');
const TTL_MS = Math.max(60_000, Number(process.env.PONG_OBSERVER_TTL_MS || 30 * 60_000));
const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENTS = 240;
const instances = new Map();

if (!INGEST_TOKEN || !ADMIN_TOKEN) throw new Error('Pong observer tokens are required');

function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || ''));
}

function corsHeaders(origin = '') {
  const allowed = /^https:\/\/odiac22\.github\.io$/i.test(origin) ||
    /^https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(?::\d+)?$/i.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://odiac22.github.io',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
}

function json(res, status, payload, origin = '') {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    ...corsHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function clean(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 80).map(item => clean(item, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/password|secret|token|authorization|cookie|pasted/i.test(key)) continue;
      output[String(key).slice(0, 100)] = clean(item, depth + 1);
    }
    return output;
  }
  return null;
}

function prune() {
  const now = Date.now();
  for (const [id, record] of instances) {
    if (now - record.lastSeenAt > TTL_MS) instances.delete(id);
  }
}

function publicRecord(record) {
  return {
    instanceId: record.instanceId,
    appName: record.appName,
    online: Date.now() - record.lastSeenAt < 10_000,
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    state: record.state,
    events: record.events
  };
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || '');
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    prune();
    json(res, 200, { ok: true, storage: 'memory-only', instances: instances.size, ttlMs: TTL_MS }, origin);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/ingest') {
    if (bearer(req) !== INGEST_TOKEN) {
      json(res, 401, { ok: false, error: 'unauthorized' }, origin);
      return;
    }
    try {
      const payload = clean(await readJson(req));
      const instanceId = String(payload?.state?.instanceId || '').toLowerCase();
      if (!/^pong[12]$/.test(instanceId)) {
        json(res, 400, { ok: false, error: 'invalid instance' }, origin);
        return;
      }
      const previous = instances.get(instanceId);
      const incomingEvents = Array.isArray(payload.events) ? payload.events : [];
      const events = [...(previous?.events || []), ...incomingEvents].slice(-MAX_EVENTS);
      instances.set(instanceId, {
        instanceId,
        appName: instanceId === 'pong2' ? 'Pong 2' : 'Pong 1',
        lastSeenAt: Date.now(),
        state: payload.state,
        events
      });
      json(res, 200, { ok: true, instanceId, receivedAt: new Date().toISOString() }, origin);
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || error).slice(0, 160) }, origin);
    }
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/instances' || /^\/instances\/pong[12]$/.test(url.pathname))) {
    if (!isLoopback(req.socket.remoteAddress) && bearer(req) !== ADMIN_TOKEN) {
      json(res, 401, { ok: false, error: 'unauthorized' }, origin);
      return;
    }
    prune();
    const id = url.pathname.split('/')[2] || '';
    if (id) {
      const record = instances.get(id);
      json(res, record ? 200 : 404, record ? { ok: true, instance: publicRecord(record) } : { ok: false, error: 'not found' }, origin);
      return;
    }
    json(res, 200, { ok: true, instances: [...instances.values()].map(publicRecord) }, origin);
    return;
  }
  json(res, 404, { ok: false, error: 'not found' }, origin);
});

const cleanup = setInterval(prune, 30_000);
cleanup.unref();
server.listen(PORT, HOST, () => {
  console.log(`Pong observer listening on http://${HOST}:${PORT} (memory-only)`);
});
