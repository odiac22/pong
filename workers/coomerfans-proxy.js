const ALLOWED_HOSTS = new Set([
  'coomerfans.com',
  'www.coomerfans.com'
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function corsResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init.headers || {})
    }
  });
}

function validateTarget(rawUrl) {
  if (!rawUrl) {
    throw new Error('Missing url parameter');
  }

  const target = new URL(rawUrl);

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }

  if (!ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
    throw new Error('Only coomerfans.com URLs are allowed');
  }

  return target;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return corsResponse(null, { status: 204 });
    }

    if (request.method !== 'GET') {
      return corsResponse('Method not allowed', { status: 405 });
    }

    try {
      const requestUrl = new URL(request.url);
      const target = validateTarget(requestUrl.searchParams.get('url') || '');

      const upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      const body = await upstream.text();

      return corsResponse(body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'text/html; charset=utf-8'
        }
      });
    } catch (error) {
      return corsResponse(error && error.message ? error.message : 'Proxy error', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
  }
};
