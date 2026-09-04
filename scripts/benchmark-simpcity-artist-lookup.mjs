import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENDPOINT = String(process.env.PONG_ENDPOINT || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const rawNames = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts', 'artist-lookup-regression-names.json'), 'utf8'));
const requestedNames = String(process.env.PONG_ARTIST_NAMES || '')
  .split(',').map(value => value.trim()).filter(Boolean);
const inputNames = requestedNames.length ? requestedNames : rawNames;
const names = [...new Map(inputNames.map(name => [
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, ''),
  String(name)
])).values()];

async function jsonRequest(pathname, options = {}, timeoutMs = 120_000) {
  const response = await fetch(`${ENDPOINT}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verifyVideo(rawUrl) {
  if (!rawUrl || /tiktok\.com\//i.test(rawUrl)) return false;
  try {
    const response = await fetch(rawUrl, {
      headers: { Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(20_000)
    });
    return [200, 206].includes(response.status) && (await response.arrayBuffer()).byteLength > 0;
  } catch (_) {
    return false;
  }
}

async function runArtist(name) {
  const startedAt = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const started = await jsonRequest('/simpcity/background/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://simpcity.cr/search/',
          artistQuery: name,
          channel: 3,
          resumeFromSaved: false
        })
      });
      const deadline = Date.now() + 5 * 60_000;
      let terminal = null;
      while (Date.now() < deadline) {
        const status = await jsonRequest('/simpcity/background/status?channel=3', {}, 20_000);
        if (status.run?.id !== started.id) throw new Error('Artist search was replaced');
        if (['complete', 'empty', 'error', 'cancelled'].includes(status.run?.state)) {
          terminal = status.run;
          break;
        }
        await sleep(750);
      }
      if (!terminal) throw new Error('Artist search timed out');
      if (terminal.state === 'error' || terminal.state === 'cancelled') {
        throw new Error(terminal.error || `Search ${terminal.state}`);
      }
      const recall = await jsonRequest('/simpcity/recall?channel=3', {}, 20_000);
      const albums = recall.recall?.albums || [];
      const firstVideo = albums.flatMap(album => album?.videos || [])[0] || '';
      return {
        name,
        state: terminal.state,
        targetUrl: terminal.targetUrl,
        albums: albums.length,
        videos: albums.reduce((sum, album) => sum + Number(album?.videos?.length || 0), 0),
        creatorKeys: [...new Set(albums.map(album => album?.creatorKey).filter(Boolean))],
        firstVideoPlayable: await verifyVideo(firstVideo),
        elapsedMs: Date.now() - startedAt,
        attempts: attempt
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 5000);
    }
  }
  return { name, state: 'error', albums: 0, videos: 0, firstVideoPlayable: false, elapsedMs: Date.now() - startedAt, error: String(lastError?.message || lastError) };
}

const results = [];
for (const [index, name] of names.entries()) {
  const result = await runArtist(name);
  results.push(result);
  process.stdout.write(`${JSON.stringify({
    completed: index + 1,
    total: names.length,
    name,
    state: result.state,
    albums: result.albums,
    videos: result.videos,
    playable: result.firstVideoPlayable,
    seconds: Math.round(result.elapsedMs / 100) / 10,
    error: result.error || ''
  })}\n`);
  await sleep(750);
}

const report = {
  schema: 'pong-simpcity-artist-lookup-v1',
  completedAt: new Date().toISOString(),
  totalArtists: results.length,
  matchedArtists: results.filter(result => result.videos > 0).length,
  playableArtists: results.filter(result => result.firstVideoPlayable).length,
  errors: results.filter(result => result.state === 'error').length,
  results
};
const reportPath = path.join(ROOT, '.pong-local-ai', 'artist-lookup-coverage-simpcity.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify({ reportPath, ...report, results: undefined }, null, 2)}\n`);
