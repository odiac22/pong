const ALLOWED_HOSTS = new Set([
  'coomerfans.com',
  'www.coomerfans.com'
]);

const VIDEO_CACHE_MAX = 6000;
const VIDEO_CACHE_TTL_MS = 15 * 60 * 1000;
const VIDEO_FETCH_CONCURRENCY = 6;
const videoCache = new Map();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Range,If-None-Match,If-Modified-Since',
  'Access-Control-Expose-Headers': 'Accept-Ranges,Content-Length,Content-Range,Content-Type,ETag,Last-Modified',
  'Access-Control-Max-Age': '86400'
};

function responseWithCors(body, init = {}) {
  const headers = new Headers(init.headers || {});
  Object.entries(CORS_HEADERS).forEach(([name, value]) => headers.set(name, value));
  headers.set('Cache-Control', 'no-store');
  return new Response(body, { ...init, headers });
}

function json(payload, status = 200) {
  return responseWithCors(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function validateTarget(rawUrl) {
  let target;
  try {
    target = new URL(String(rawUrl || ''));
  } catch (_) {
    throw new Error('invalid target URL');
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname.toLowerCase()) || target.username || target.password) {
    throw new Error('target host is not allowed');
  }
  return target;
}

function decodeHtmlUrl(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function extractVideoUrls(html, postUrl) {
  const urls = [];
  const seen = new Set();
  const pattern = /(?:src|href)\s*=\s*["']([^"']+\.(?:mp4|m4v|mov|webm)(?:\?[^"']*)?)["']/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    try {
      const videoUrl = new URL(decodeHtmlUrl(match[1]), postUrl).toString();
      if (!seen.has(videoUrl)) {
        seen.add(videoUrl);
        urls.push(videoUrl);
      }
    } catch (_) {}
  }
  return urls;
}

function retryDelay(response) {
  const seconds = Number(response.headers.get('retry-after') || 0);
  return Math.min(5000, Math.max(500, seconds * 1000));
}

async function fetchPostEntries(postUrl, artistInfo) {
  const normalizedPostUrl = validateTarget(postUrl).toString();
  const cached = videoCache.get(normalizedPostUrl);
  if (cached && Date.now() - cached.at < VIDEO_CACHE_TTL_MS) {
    videoCache.delete(normalizedPostUrl);
    videoCache.set(normalizedPostUrl, cached);
    return cached.entries;
  }

  let upstream = await fetch(normalizedPostUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 PongCloudflareVideoVerifier/1.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': `${new URL(normalizedPostUrl).origin}/`
    },
    redirect: 'follow',
    cache: 'no-store'
  });
  if (upstream.status === 429) {
    await new Promise(resolve => setTimeout(resolve, retryDelay(upstream)));
    upstream = await fetch(normalizedPostUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 PongCloudflareVideoVerifier/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': `${new URL(normalizedPostUrl).origin}/`
      },
      redirect: 'follow',
      cache: 'no-store'
    });
  }
  if (!upstream.ok) throw new Error(`video post HTTP ${upstream.status}`);
  validateTarget(upstream.url || normalizedPostUrl);
  const entries = extractVideoUrls(await upstream.text(), normalizedPostUrl).map((videoUrl, postIndex) => ({
    ...artistInfo,
    type: 'video',
    videoUrl,
    mediaKey: videoUrl,
    postUrl: normalizedPostUrl,
    postIndex
  }));
  videoCache.set(normalizedPostUrl, { at: Date.now(), entries });
  while (videoCache.size > VIDEO_CACHE_MAX) videoCache.delete(videoCache.keys().next().value);
  return entries;
}

async function verifyVideos(request) {
  const payload = await request.json();
  const postUrls = [...new Set((Array.isArray(payload?.postUrls) ? payload.postUrls : [])
    .map(value => validateTarget(value).toString()))].slice(0, 500);
  const stopAt = Math.max(1, Math.min(100, Number(payload?.stopAt || 15)));
  const artistInfo = payload?.artistInfo && typeof payload.artistInfo === 'object' ? payload.artistInfo : {};
  const entries = [];
  const seenVideos = new Set();
  let nextIndex = 0;

  async function worker() {
    while (entries.length < stopAt) {
      const index = nextIndex++;
      if (index >= postUrls.length) return;
      const found = await fetchPostEntries(postUrls[index], artistInfo).catch(() => []);
      for (const entry of found) {
        if (!entry?.videoUrl || seenVideos.has(entry.videoUrl)) continue;
        seenVideos.add(entry.videoUrl);
        entries.push(entry);
        if (entries.length >= stopAt) return;
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(VIDEO_FETCH_CONCURRENCY, postUrls.length) },
    () => worker()
  ));
  return json({
    ok: true,
    entries: entries.slice(0, stopAt),
    checked: Math.min(nextIndex, postUrls.length),
    candidates: postUrls.length,
    stopAt,
    storage: 'memory-only',
    cachedPosts: videoCache.size
  });
}

async function proxyRequest(request, url) {
  const target = validateTarget(url.searchParams.get('url') || '');
  const headers = new Headers();
  headers.set('User-Agent', 'Mozilla/5.0 PongCloudflareGateway/1.0');
  headers.set('Accept', request.headers.get('accept') || '*/*');
  headers.set('Referer', `${target.origin}/`);
  for (const name of ['range', 'if-none-match', 'if-modified-since']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(target, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    redirect: 'follow',
    cache: 'no-store'
  });
  validateTarget(upstream.url || target.toString());
  const responseHeaders = new Headers();
  for (const name of ['accept-ranges', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'vary']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return responseWithCors(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return responseWithCors(null, { status: 204 });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && (url.pathname === '/health' || url.searchParams.get('health') === '1')) {
        return json({
          ok: true,
          worker: 'pong-coomerfans-proxy',
          paidBatchVerifier: true,
          storage: 'memory-only',
          cachedPosts: videoCache.size
        });
      }
      if (request.method === 'POST' && url.pathname === '/verify-videos') return await verifyVideos(request);
      if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/proxy')) {
        return await proxyRequest(request, url);
      }
      return json({ ok: false, error: 'not found' }, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, 400);
    }
  }
};
