import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENDPOINT = String(process.env.PONG_ENDPOINT || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const requestedSources = new Set(
  String(process.env.PONG_ARTIST_SOURCES || 'leakedzone,coomer,tiktok')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
);
const concurrency = Math.max(1, Math.min(6, Number(process.env.PONG_ARTIST_CONCURRENCY || 2)));
const EROME_PROXY = 'https://pong-erome-proxy.arianslade-pong.workers.dev';
const rawNames = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts', 'artist-lookup-regression-names.json'), 'utf8'));
const onlyNames = new Set(
  String(process.env.PONG_ARTIST_NAMES || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
);
const names = [...new Map(rawNames.map(name => [
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, ''),
  String(name)
])).values()].filter(name => !onlyNames.size || onlyNames.has(name.toLowerCase()));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function externalJson(url, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(400 * attempt);
    }
  }
  throw lastError || new Error('external JSON request failed');
}

async function postJson(pathname, body, timeoutMs = 180_000) {
  const response = await fetch(`${ENDPOINT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function verifyLeakedZone(detailUrl) {
  const response = await fetch(
    `${ENDPOINT}/leakedzone/media?url=${encodeURIComponent(detailUrl)}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  const playlist = await response.text();
  const segment = playlist.split(/\r?\n/).find(line => /^https:\/\//i.test(line.trim()))?.trim() || '';
  if (!response.ok || !/^#EXTM3U/m.test(playlist) || !segment) return false;
  const media = await fetch(segment, {
    headers: { Range: 'bytes=0-1023', Referer: detailUrl },
    signal: AbortSignal.timeout(30_000)
  });
  return [200, 206].includes(media.status) && (await media.arrayBuffer()).byteLength > 0;
}

async function checkArtist(name) {
  const started = Date.now();
  const sources = {};
  if (requestedSources.has('leakedzone')) {
    try {
      const data = await postJson('/artist-lookup/leakedzone', { username: name });
      const first = data.matches?.[0];
      sources.leakedzone = {
        matched: Boolean(first?.videos?.length),
        videos: first?.videos?.length || 0,
        pages: first?.pages || 0,
        playable: first?.videos?.[0] ? await verifyLeakedZone(first.videos[0]) : false,
        url: first?.creatorUrl || ''
      };
    } catch (error) {
      sources.leakedzone = { matched: false, videos: 0, playable: false, error: String(error?.message || error) };
    }
  }
  if (requestedSources.has('coomer')) {
    try {
      const data = await postJson('/artist-lookup/coomer', { username: name });
      sources.coomer = {
        matched: (data.matches || []).some(match => match?.videos?.length),
        videos: (data.matches || []).reduce((sum, match) => sum + Number(match?.videos?.length || 0), 0),
        matches: data.matches?.length || 0
      };
    } catch (error) {
      sources.coomer = { matched: false, videos: 0, error: String(error?.message || error) };
    }
  }
  if (requestedSources.has('tiktok')) {
    try {
      const data = await postJson('/tiktok/profile', { username: name }, 90_000);
      sources.tiktok = { matched: Boolean(data.videos?.length), videos: data.videos?.length || 0, profileUrl: data.profileUrl || '' };
    } catch (error) {
      sources.tiktok = { matched: false, videos: 0, error: String(error?.message || error) };
    }
  }
  if (requestedSources.has('erome')) {
    try {
      await sleep(300);
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const searchUrl = `https://www.erome.com/search?q=${encodeURIComponent(name)}`;
      const listing = await externalJson(
        `${EROME_PROXY}/albums?fast=1&u=${encodeURIComponent(searchUrl)}`
      );
      let match = null;
      for (const album of (listing.albums || []).slice(0, 4)) {
        const data = await externalJson(
          `${EROME_PROXY}/scrape?fast=1&u=${encodeURIComponent(album.url)}`
        );
        const titleKey = String(data.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const videos = Array.isArray(data.videos) ? data.videos : [];
        if (titleKey.includes(key) && videos.length) {
          const media = await fetch(videos[0], {
            headers: { Range: 'bytes=0-1023', Referer: album.url },
            signal: AbortSignal.timeout(20_000)
          });
          match = { albumUrl: album.url, videos: videos.length, playable: [200, 206].includes(media.status) && (await media.arrayBuffer()).byteLength > 0 };
          break;
        }
      }
      sources.erome = {
        matched: Boolean(match),
        videos: match?.videos || 0,
        playable: match?.playable === true,
        albumUrl: match?.albumUrl || ''
      };
    } catch (error) {
      sources.erome = { matched: false, videos: 0, playable: false, error: String(error?.message || error) };
    }
  }
  return {
    name,
    matched: Object.values(sources).some(source => source.matched),
    playable: Object.values(sources).some(source => source.playable || (source.matched && !('playable' in source))),
    elapsedMs: Date.now() - started,
    sources
  };
}

let completed = 0;
const startedAt = new Date().toISOString();
const results = await mapLimit(names, concurrency, async name => {
  const result = await checkArtist(name);
  completed++;
  if (completed === 1 || completed % 10 === 0 || completed === names.length) {
    process.stdout.write(`${JSON.stringify({ completed, total: names.length, name, matched: result.matched, seconds: Math.round(result.elapsedMs / 100) / 10 })}\n`);
  }
  return result;
});

const sourceSummary = {};
for (const source of requestedSources) {
  sourceSummary[source] = {
    matchedArtists: results.filter(result => result.sources[source]?.matched).length,
    playableArtists: results.filter(result => result.sources[source]?.playable).length,
    videos: results.reduce((sum, result) => sum + Number(result.sources[source]?.videos || 0), 0),
    errors: results.filter(result => result.sources[source]?.error).length
  };
}
const report = {
  schema: 'pong-artist-lookup-coverage-v1',
  startedAt,
  completedAt: new Date().toISOString(),
  endpoint: ENDPOINT,
  sources: [...requestedSources],
  totalArtists: names.length,
  matchedArtists: results.filter(result => result.matched).length,
  noMatchArtists: results.filter(result => !result.matched).map(result => result.name),
  sourceSummary,
  results
};
await fs.mkdir(path.join(ROOT, '.pong-local-ai'), { recursive: true });
const reportPath = path.join(ROOT, '.pong-local-ai', 'artist-lookup-coverage-latest.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const sourceReportPath = path.join(
  ROOT,
  '.pong-local-ai',
  `artist-lookup-coverage-${[...requestedSources].sort().join('-') || 'none'}.json`
);
await fs.writeFile(sourceReportPath, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify({ reportPath, totalArtists: report.totalArtists, matchedArtists: report.matchedArtists, noMatchArtists: report.noMatchArtists, sourceSummary }, null, 2)}\n`);
