const ALLOWED_HOSTS = new Set([
  'coomerfans.com',
  'www.coomerfans.com',
  'onlyfaphouse.com',
  'www.onlyfaphouse.com',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function response(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: { ...CORS_HEADERS, ...(init.headers || {}) },
  });
}

function validateTarget(rawUrl) {
  if (!rawUrl) throw new Error('Missing url parameter');
  const target = new URL(rawUrl);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }
  if (!ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
    throw new Error('Only approved catalog URLs are allowed');
  }
  return target;
}

function validateProof(requestUrl) {
  const token = requestUrl.searchParams.get('proof_token') || '';
  const nonce = requestUrl.searchParams.get('proof_nonce') || '';
  if (!token && !nonce) return null;
  if (token.length < 32 || token.length > 2048 || !/^\d{1,16}$/.test(nonce)) {
    throw new Error('Invalid proof parameters');
  }
  return { token, nonce };
}

function cookieRequestHeader(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie') || ''];
  return values
    .map(value => value.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return response(null, { status: 204 });
    if (request.method !== 'GET') return response('Method not allowed', { status: 405 });
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.searchParams.get('health') === '1') {
        return response(JSON.stringify({ ok: true, worker: 'pong-coomerfans-proxy', now: new Date().toISOString() }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      const target = validateTarget(requestUrl.searchParams.get('url') || '');
      const proof = validateProof(requestUrl);
      let cookie = '';
      if (proof) {
        const origin = target.origin;
        const verification = await fetch(new URL('/__bg/verify', origin), {
          method: 'POST',
          redirect: 'manual',
          headers: {
            ...UPSTREAM_HEADERS,
            Accept: 'application/json,text/plain,*/*',
            'Content-Type': 'application/json',
            Origin: origin,
            Referer: `${origin}/`,
          },
          body: JSON.stringify({
            token: proof.token,
            nonce: proof.nonce,
            env: { wd: false, tz: 'America/Chicago', hc: 8, w: 1280, h: 800 },
          }),
        });
        if (!verification.ok) {
          return response('Upstream proof rejected', {
            status: 503,
            headers: { 'X-Pong-Proof-Status': String(verification.status) },
          });
        }
        cookie = cookieRequestHeader(verification.headers);
      }
      const upstream = await fetch(target.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          ...UPSTREAM_HEADERS,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      return response(await upstream.text(), {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Pong-Proxy-Version': '2',
        },
      });
    } catch (error) {
      return response(error?.message || 'Proxy error', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
