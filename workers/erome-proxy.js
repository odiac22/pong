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
//   GET /albums?u=<erome profile URL>
//       -> JSON { title, albums: [{ url, title }], albumCount, profilePageCount }
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

const ALBUM_FETCH_CONCURRENCY = 3;
const MAX_FETCH_RETRIES = 4;
const FETCH_TIMEOUT_MS = 15000;
const FAST_FETCH_RETRIES = 0;
const FAST_FETCH_TIMEOUT_MS = 7000;

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

function decodeHtmlText(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanTitle(text) {
  return decodeHtmlText(String(text || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHtml(html) {
  return String(html || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/&amp;/gi, '&');
}

function extractMp4s(html) {
  const set = new Set();
  const re = /(?:https?:)?\/\/[a-z0-9.-]*erome\.com\/[^\s"'\\<>]+?\.mp4(?:\?[^ \s"'\\<>]*)?/gi;
  let m;
  const normalized = normalizeHtml(html);

  while ((m = re.exec(normalized)) !== null) {
    const raw = m[0].startsWith('//') ? 'https:' + m[0] : m[0];
    set.add(raw);
  }

  return [...set];
}

function absolutizeEromeUrl(raw) {
  try {
    return new URL(raw, 'https://www.erome.com/').href.replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function extractAlbumEntries(html) {
  const entries = [];
  const set = new Set();
  const normalized = String(html || '');

  function add(rawUrl, rawTitle) {
    const url = absolutizeEromeUrl(rawUrl);
    if (!url || set.has(url)) return;

    set.add(url);
    entries.push({
      url,
      title: cleanTitle(rawTitle || ''),
    });
  }

  const specific =
    /<a\b[^>]*class=["'][^"']*album-(?:link|title)[^"']*["'][^>]*href=["']([^"']*\/a\/[A-Za-z0-9_-]+\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = specific.exec(normalized)) !== null) {
    add(m[1], m[2]);
  }

  const fallback = /href=["']([^"']*\/a\/[A-Za-z0-9_-]+\/?)["']/gi;

  while ((m = fallback.exec(normalized)) !== null) {
    add(m[1], '');
  }

  return entries;
}

function extractAlbumUrls(html) {
  return extractAlbumEntries(html).map(album => album.url);
}

function extractProfilePageCount(html) {
  let maxPage = 1;
  const re = /[?&]page=(\d+)/gi;
  let m;

  while ((m = re.exec(String(html || ''))) !== null) {
    const page = Number(m[1] || 0);
    if (Number.isFinite(page) && page > maxPage) maxPage = page;
  }

  return maxPage;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  return Math.min(5000, 500 * Math.pow(2, Math.max(0, attempt - 1)));
}

async function fetchText(url, options = {}, attempt = 1) {
  let resp;
  const maxRetries = Number.isFinite(Number(options.maxRetries))
    ? Math.max(0, Number(options.maxRetries))
    : MAX_FETCH_RETRIES;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    resp = await fetch(url, {
      headers: EROME_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (_) {
    clearTimeout(timeoutId);

    if (attempt <= maxRetries) {
      await sleep(retryDelay(attempt));
      return fetchText(url, options, attempt + 1);
    }

    return '';
  }

  clearTimeout(timeoutId);

  if (!resp.ok && resp.status !== 404 && attempt <= maxRetries) {
    await sleep(retryDelay(attempt));
    return fetchText(url, options, attempt + 1);
  }

  if (!resp.ok) return '';
  return await resp.text();
}

async function handleAlbums(target, options = {}) {
  const html = await fetchText(target.href, options);
  if (!html) {
    return json({
      error: 'Could not load Erome page',
      title: '',
      albums: [],
      albumCount: 0,
      profilePageCount: 1,
    }, 502);
  }

  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const albums = extractAlbumEntries(html);

  return json({
    title,
    albums,
    albumCount: albums.length,
    profilePageCount: extractProfilePageCount(html),
  }, 200);
}

async function pool(items, limit, task) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;

      try {
        results[i] = await task(items[i], i);
      } catch (_) {
        results[i] = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );

  return results;
}

async function handleScrape(target, options = {}) {
  const html = await fetchText(target.href, options);
  if (!html) {
    return json({ error: 'Could not load Erome page', count: 0, videos: [] }, 502);
  }

  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Direct MP4s on this page (album page case).
  let videos = extractMp4s(html);
  const albumEntries = extractAlbumEntries(html);
  const albums = albumEntries.map(album => album.url);
  const profilePageCount = extractProfilePageCount(html);
  let albumGroups = [];
  let failedAlbumCount = 0;
  let emptyAlbumCount = 0;

  // Profile / listing page: no direct videos, but album links. Expand them.
  if (!videos.length && albumEntries.length) {
    const albumResults = await pool(albumEntries, ALBUM_FETCH_CONCURRENCY, async album => {
      const albumHtml = await fetchText(album.url, options);

      if (!albumHtml) {
        return {
          url: album.url,
          title: album.title,
          count: 0,
          videos: [],
          failed: true,
        };
      }

      const albumVideos = extractMp4s(albumHtml);

      return {
        url: album.url,
        title: album.title,
        count: albumVideos.length,
        videos: albumVideos,
      };
    });

    const groups = albumResults.filter(Boolean);

    failedAlbumCount = groups.filter(group => group.failed).length;
    emptyAlbumCount = groups.filter(group => !group.failed && !group.videos.length).length;
    albumGroups = groups.filter(group => !group.failed && group.videos.length);

    const merged = new Set();

    for (const group of albumGroups) {
      for (const v of group.videos) merged.add(v);
    }

    videos = [...merged];
  } else if (videos.length) {
    albumGroups = [{
      url: target.href.replace(/\/$/, ''),
      title,
      count: videos.length,
      videos,
    }];
  }

  return json({
    count: videos.length,
    title,
    videos,
    albums,
    albumCount: albums.length,
    scrapedAlbumCount: albumGroups.length,
    failedAlbumCount,
    emptyAlbumCount,
    profilePageCount,
    albumGroups,
  }, 200);
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

    const scrapeOptions = url.searchParams.get('fast') === '1'
      ? {
          maxRetries: FAST_FETCH_RETRIES,
          timeoutMs: FAST_FETCH_TIMEOUT_MS,
        }
      : {};

    if (url.pathname.startsWith('/albums')) {
      return handleAlbums(target, scrapeOptions);
    }

    if (url.pathname.startsWith('/scrape')) {
      return handleScrape(target, scrapeOptions);
    }
    return handleVideo(request, target);
  },
};
