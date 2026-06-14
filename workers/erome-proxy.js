// Cloudflare Worker: Erome proxy for Pong
// ----------------------------------------
// Erome's CDN hotlink-protects its MP4s: a request only succeeds when it
// carries `Referer: https://www.erome.com/`. Browsers forbid JS from forging
// that header, so GitHub Pages cannot play raw Erome MP4s in a <video>. This
// Worker sits in the middle, re-issues the request WITH the erome referer, and
// streams the bytes back (with HTTP Range support so seeking works).
//
// Endpoints:
//   GET /scrape?u=<erome album OR profile URL>
//       -> JSON { count, title, videos: [<raw mp4 url>...], albums: [...] }
//   GET /<anything>.mp4?u=<raw erome mp4 url>
//       -> the video bytes, Range-aware (200 or 206), CORS-open
//
// Only *.erome.com targets are allowed (this is not an open proxy).

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const EROME_HEADERS = {
  Referer: 'https://www.erome.com/',
  Origin: 'https://www.erome.com',
  'User-Agent': BROWSER_UA,
};

const MAX_ALBUMS_PER_PROFILE = 15; // cap subrequests on a profile scrape

function isEromeHost(hostname) {
  return /(^|\.)erome\.com$/i.test(hostname);
}

function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    ...(extra || {}),
  };
}

function extractMp4s(html) {
  const set = new Set();
  const re = /https:\/\/[a-z0-9.-]*erome\.com\/[^\s"'\\<>]+?\.mp4/gi;
  let m;
  while ((m = re.exec(html)) !== null) set.add(m[0]);
  return [...set];
}

function extractAlbumUrls(html) {
  const set = new Set();
  const re = /\/a\/([A-Za-z0-9]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) set.add('https://www.erome.com/a/' + m[1]);
  return [...set];
}

async function fetchText(url) {
  const resp = await fetch(url, { headers: EROME_HEADERS, redirect: 'follow' });
  if (!resp.ok) return '';
  return await resp.text();
}

async function handleScrape(target) {
  const html = await fetchText(target.href);
  if (!html) {
    return json({ error: 'Could not load Erome page', count: 0, videos: [] }, 502);
  }

  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Direct MP4s on this page (album page case).
  let videos = extractMp4s(html);
  const albums = extractAlbumUrls(html);

  // Profile / listing page: no direct videos, but album links. Expand them.
  if (!videos.length && albums.length) {
    const chosen = albums.slice(0, MAX_ALBUMS_PER_PROFILE);
    const lists = await Promise.all(chosen.map(a => fetchText(a).then(extractMp4s)));
    const merged = new Set();
    for (const list of lists) for (const v of list) merged.add(v);
    videos = [...merged];
  }

  return json({ count: videos.length, title, videos, albums }, 200);
}

async function handleVideo(request, target) {
  const range = request.headers.get('Range');
  const headers = { ...EROME_HEADERS };
  if (range) headers.Range = range;

  const upstream = await fetch(target.href, { headers, redirect: 'follow' });

  const out = new Headers(corsHeaders());
  const passthrough = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ];
  for (const name of passthrough) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  if (!out.has('content-type')) out.set('content-type', 'video/mp4');
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: corsHeaders({ 'content-type': 'application/json; charset=utf-8' }),
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const targetRaw = url.searchParams.get('u');
    if (!targetRaw) {
      return json({ error: "missing 'u' query parameter" }, 400);
    }

    let target;
    try {
      target = new URL(targetRaw);
    } catch (_) {
      return json({ error: "bad 'u' URL" }, 400);
    }

    if (target.protocol !== 'https:' || !isEromeHost(target.hostname)) {
      return json({ error: 'only https://*.erome.com targets are allowed' }, 403);
    }

    if (url.pathname.startsWith('/scrape')) {
      return handleScrape(target);
    }
    return handleVideo(request, target);
  },
};
