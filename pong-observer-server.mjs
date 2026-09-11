import http from 'node:http';

const HOST = process.env.PONG_OBSERVER_HOST || '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.PONG_OBSERVER_PORT || 8799)));
const INGEST_TOKEN = String(process.env.PONG_OBSERVER_INGEST_TOKEN || '');
const ADMIN_TOKEN = String(process.env.PONG_OBSERVER_ADMIN_TOKEN || '');
const TEST_TOKEN = String(process.env.PONG_OBSERVER_TEST_TOKEN || '');
const TTL_MS = Math.max(60_000, Number(process.env.PONG_OBSERVER_TTL_MS || 30 * 60_000));
const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS = 240;
const instances = new Map();
const testInstances = new Map();

if (!INGEST_TOKEN || !ADMIN_TOKEN) throw new Error('Pong observer tokens are required');

function corsHeaders(origin = '') {
  const allowed = /^https:\/\/odiac22\.github\.io$/i.test(origin) ||
    /^https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(?::\d+)?$/i.test(origin);
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
  for (const store of [instances, testInstances]) {
    for (const [id, record] of store) {
      if (now - record.lastSeenAt > TTL_MS) store.delete(id);
    }
  }
}

function publicRecord(record) {
  return {
    instanceId: record.instanceId,
    sessionId: record.state.sessionId,
    appName: record.appName,
    online: Date.now() - record.lastSeenAt < 10_000,
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    state: record.state,
    screenshot: record.screenshot ? {
      capturedAt: record.screenshot.capturedAt,
      width: record.screenshot.width,
      height: record.screenshot.height,
      bytes: record.screenshot.data.length
    } : null,
    events: record.events
  };
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || '');
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const testing = url.pathname.startsWith('/test/');
  const path = testing ? url.pathname.slice(5) : url.pathname;
  const store = testing ? testInstances : instances;
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
  if (req.method === 'POST' && path === '/ingest') {
    const requiredToken = testing ? TEST_TOKEN : INGEST_TOKEN;
    if (!requiredToken || bearer(req) !== requiredToken) {
      json(res, 401, { ok: false, error: 'unauthorized' }, origin);
      return;
    }
    try {
      const incoming = await readJson(req);
      const rawFrame = incoming?.frame;
      let frame = null;
      if (rawFrame?.jpegBase64 && String(rawFrame.jpegBase64).length <= 190_000) {
        const data = Buffer.from(String(rawFrame.jpegBase64), 'base64');
        if (data.length >= 4 && data.length <= 145_000 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
          frame = {
            capturedAt: String(rawFrame.capturedAt || new Date().toISOString()).slice(0, 80),
            width: Math.max(1, Math.min(2000, Number(rawFrame.width || 0))),
            height: Math.max(1, Math.min(3000, Number(rawFrame.height || 0))),
            data
          };
        }
      }
      if (incoming && typeof incoming === 'object') delete incoming.frame;
      const payload = clean(incoming);
      const instanceId = String(payload?.state?.instanceId || '').toLowerCase();
      if (!/^pong[12]$/.test(instanceId)) {
        json(res, 400, { ok: false, error: 'invalid instance' }, origin);
        return;
      }
      const sessionId = String(payload?.state?.sessionId || '').slice(0, 160);
      if (!sessionId || payload?.state?.page?.topFrame === false || payload?.state?.page?.bridge === true) {
        json(res, 400, { ok: false, error: 'player session required' }, origin);
        return;
      }
      prune();
      const key = `${instanceId}:${sessionId}`;
      if (!store.has(key) && store.size >= 100) {
        json(res, 429, { ok: false, error: 'too many sessions' }, origin);
        return;
      }
      const previous = store.get(key);
      const incomingEvents = Array.isArray(payload.events) ? payload.events : [];
      const events = [...(previous?.events || []), ...incomingEvents].slice(-MAX_EVENTS);
      store.set(key, {
        instanceId,
        appName: instanceId === 'pong2' ? 'Pong 2' : 'Pong 1',
        lastSeenAt: Date.now(),
        state: payload.state,
        screenshot: frame || previous?.screenshot || null,
        events
      });
      json(res, 200, { ok: true, instanceId, receivedAt: new Date().toISOString() }, origin);
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || error).slice(0, 160) }, origin);
    }
    return;
  }
  if (req.method === 'GET' && /^\/screenshots\/pong[12]$/.test(path)) {
    if (bearer(req) !== ADMIN_TOKEN) {
      json(res, 401, { ok: false, error: 'unauthorized' }, origin);
      return;
    }
    prune();
    const id = path.split('/')[2];
    const records = [...store.values()].filter(record => record.instanceId === id && record.screenshot);
    records.sort((a, b) => Number(Boolean(b.state.client?.native)) - Number(Boolean(a.state.client?.native)) || b.lastSeenAt - a.lastSeenAt);
    const record = records[0];
    if (!record) {
      json(res, 404, { ok: false, error: 'not found' }, origin);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': record.screenshot.data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(record.screenshot.data);
    return;
  }
  if (req.method === 'GET' && (path === '/instances' || /^\/instances\/pong[12]$/.test(path))) {
    // A reverse proxy also connects from loopback. Never use its address as authentication.
    if (bearer(req) !== ADMIN_TOKEN) {
      json(res, 401, { ok: false, error: 'unauthorized' }, origin);
      return;
    }
    prune();
    const id = path.split('/')[2] || '';
    const records = [...store.values()].filter(record => !id || record.instanceId === id);
    // Retain all sessions, and prefer the actual native app over a desktop preview.
    records.sort((a, b) => Number(Boolean(b.state.client?.native)) - Number(Boolean(a.state.client?.native)) || b.lastSeenAt - a.lastSeenAt);
    if (id) {
      const record = records[0];
      json(res, record ? 200 : 404, record ? { ok: true, instance: publicRecord(record), sessions: records.map(publicRecord) } : { ok: false, error: 'not found' }, origin);
      return;
    }
    json(res, 200, { ok: true, instances: ['pong1', 'pong2'].map(id => records.find(record => record.instanceId === id)).filter(Boolean).map(publicRecord), sessions: records.map(publicRecord) }, origin);
    return;
  }
  json(res, 404, { ok: false, error: 'not found' }, origin);
});

const cleanup = setInterval(prune, 30_000);
cleanup.unref();
server.listen(PORT, HOST, () => {
  console.log(`Pong observer listening on http://${HOST}:${PORT} (memory-only)`);
});
