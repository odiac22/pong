import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.env.PORT || 8791);
const secret = String(process.env.PONG_RELAY_SECRET || '');
const workerUpstream = 'https://pong-coomerfans-proxy.arianslade-pong.workers.dev';
const maxBatch = 20;
const sourceCooldownMs = 15 * 60_000;
let coomerCooldownUntil = 0;

function targetUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const catalog = [
      'coomerfans.com', 'www.coomerfans.com',
      'onlyfaphouse.com', 'www.onlyfaphouse.com'
    ].includes(host);
    const structuredApi = host === 'coomer.st' && url.pathname.startsWith('/api/v1/');
    if (url.protocol !== 'https:' || (!catalog && !structuredApi)) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function workerUrl(target, proof = null) {
  const url = new URL(workerUpstream);
  url.searchParams.set('url', target.toString());
  url.searchParams.set('t', String(Date.now()));
  if (proof) {
    url.searchParams.set('proof_token', proof.token);
    url.searchParams.set('proof_nonce', proof.nonce);
  }
  return url.toString();
}

function leadingZeroBits(buffer) {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    return count + Math.clz32(byte) - 24;
  }
  return count;
}

function proofFromHtml(html) {
  const match = String(html || '').match(
    /const\s+token\s*=\s*["']([^"']+)["']\s*,\s*difficulty\s*=\s*(\d+)\s*,\s*url\s*=\s*["']\/__bg\/verify/i
  );
  if (!match) return null;
  const token = match[1];
  const difficulty = Math.max(1, Math.min(24, Number(match[2]) || 15));
  for (let nonce = 0; nonce <= 20_000_000; nonce += 1) {
    const digest = crypto.createHash('sha256').update(`${token}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= difficulty) return { token, nonce: String(nonce) };
  }
  throw new Error('source proof could not be solved');
}

function verificationHtml(html) {
  return /\/__bg\/(?:verify|checkbox)|checking your browser|verifying you are human/i.test(
    String(html || '').slice(0, 12_000)
  );
}

function mirrorTarget(target) {
  const mirror = new URL(target.toString());
  mirror.hostname = 'onlyfaphouse.com';
  if (/^\/u\//i.test(mirror.pathname)) mirror.pathname = mirror.pathname.replace(/^\/u\//i, '/c/');
  return mirror;
}

function rewriteMirrorHtml(html) {
  return String(html || '')
    .replace(/https:\/\/(?:www\.)?onlyfaphouse\.com\/c\//gi, 'https://coomerfans.com/u/')
    .replace(/(["'])\/c\//gi, '$1/u/');
}

async function fetchThroughWorker(target, proof = null) {
  const response = await fetch(workerUrl(target, proof), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(25_000),
  });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

async function fetchOne(target) {
  const directApi = target.hostname.toLowerCase() === 'coomer.st';
  let response;
  let body;
  let usedMirror = false;
  if (directApi) {
    response = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(25_000),
    });
    body = Buffer.from(await response.arrayBuffer());
  } else {
    const coomerTarget = /(?:^|\.)coomerfans\.com$/i.test(target.hostname);
    const selectedTarget = coomerTarget && Date.now() < coomerCooldownUntil
      ? mirrorTarget(target)
      : target;
    usedMirror = selectedTarget.hostname === 'onlyfaphouse.com' && coomerTarget;
    ({ response, body } = await fetchThroughWorker(selectedTarget));
    const proof = proofFromHtml(body.toString('utf8'));
    if (proof) {
      ({ response, body } = await fetchThroughWorker(selectedTarget, proof));
    }
    if (coomerTarget && verificationHtml(body.toString('utf8'))) {
      coomerCooldownUntil = Date.now() + sourceCooldownMs;
      ({ response, body } = await fetchThroughWorker(mirrorTarget(target)));
      usedMirror = true;
    }
  }
  const html = usedMirror ? rewriteMirrorHtml(body.toString('utf8')) : body.toString('utf8');
  return {
    url: target.toString(),
    status: response.status,
    body: html,
    contentType: response.headers.get('content-type') || 'text/html; charset=utf-8',
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

http.createServer(async (req, res) => {
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    writeJson(res, 200, { ok: true, transport: 'worker-proof-relay-v2' });
    return;
  }
  try {
    if (req.method === 'GET' && requestUrl.pathname === '/fetch') {
      const target = targetUrl(requestUrl.searchParams.get('url') || '');
      if (!target) throw new Error('invalid target');
      const row = await fetchOne(target);
      const body = Buffer.from(row.body);
      res.writeHead(row.status, {
        'content-type': row.contentType,
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/fetch-batch') {
      const payload = await readJson(req);
      const urls = [...new Set((Array.isArray(payload?.urls) ? payload.urls : [])
        .map(value => targetUrl(String(value || '')))
        .filter(Boolean)
        .map(url => url.toString()))].slice(0, maxBatch);
      if (!urls.length) throw new Error('no valid targets');
      const rows = await Promise.all(urls.map(async rawUrl => {
        try {
          return await fetchOne(new URL(rawUrl));
        } catch (error) {
          return { url: rawUrl, status: 599, body: '', error: String(error?.message || error) };
        }
      }));
      writeJson(res, 200, { ok: true, rows });
      return;
    }
    res.writeHead(404).end('not found');
  } catch (error) {
    writeJson(res, 400, { ok: false, error: String(error?.message || error) });
  }
}).listen(port, '0.0.0.0');
