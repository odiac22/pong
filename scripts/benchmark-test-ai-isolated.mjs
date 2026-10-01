import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';

const args = new Map(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=') || '1'];
}));
const target = Math.max(1, Number(args.get('target') || 10));
const seconds = Math.max(10, Number(args.get('seconds') || 60));
const artistConcurrency = Math.max(1, Number(args.get('artists') || 2));
const requestConcurrency = Math.max(1, Number(args.get('requests') || 20));
const requestGapMs = Math.max(0, Number(args.get('gap') || 0));
const transport = String(args.get('transport') || 'direct');
const structuredTransport = String(args.get('structured-transport') || 'direct');
const qualification = String(args.get('qualification') || 'html');
const firefoxPort = Math.max(1, Number(args.get('firefox-port') || 18801));
const initialVideos = Math.max(1, Number(args.get('initial') || 5));
const fixedStartPage = Number(args.get('page') || 0);
const listingPageCount = Math.max(1, Number(args.get('listing-pages') || 4));
const deadline = Date.now() + seconds * 1000;
let nextRequestAt = 0;
let activeRequests = 0;
const requestWaiters = [];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function acquire() {
  if (activeRequests < requestConcurrency) { activeRequests++; return; }
  await new Promise(resolve => requestWaiters.push(resolve));
  activeRequests++;
}
function release() {
  activeRequests--;
  requestWaiters.shift()?.();
}

async function configuration() {
  if (transport !== 'vps' && structuredTransport !== 'vps') return {};
  const file = path.join(process.cwd(), '.pong-local-ai', 'vps-scraper-config.json');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  return { url: String(parsed.url || '').replace(/\/+$/, ''), secret: String(parsed.secret || '') };
}
const config = await configuration();

async function fetchStructured(targetUrl, timeoutMs = 10000) {
  let url = targetUrl;
  const headers = { Accept: 'text/css', 'User-Agent': 'Mozilla/5.0' };
  if (structuredTransport === 'vps') {
    url = `${config.url}/fetch?url=${encodeURIComponent(targetUrl)}`;
    headers.Authorization = `Bearer ${config.secret}`;
  }
  return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
}

async function fetchHtmlOnce(targetUrl) {
  await acquire();
  try {
    const startAt = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = startAt + requestGapMs;
    if (startAt > Date.now()) await sleep(startAt - Date.now());
    let url = targetUrl;
    const headers = { Accept: 'text/html,application/xhtml+xml' };
    if (transport === 'firefox') url = `http://127.0.0.1:${firefoxPort}/fetch?url=${encodeURIComponent(targetUrl)}`;
    if (transport === 'vps') {
      url = `${config.url}/fetch?url=${encodeURIComponent(targetUrl)}`;
      headers.Authorization = `Bearer ${config.secret}`;
    }
    if (transport === 'worker') {
      url = `https://pong-coomerfans-proxy.odiac22-pong-repair.workers.dev?url=${encodeURIComponent(targetUrl)}`;
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (/checking your browser|verifying you are human|service unavailable/i.test(html.slice(0, 20000))) {
      throw new Error('interstitial');
    }
    return html;
  } finally { release(); }
}

async function fetchHtml(targetUrl) {
  try {
    return await fetchHtmlOnce(targetUrl);
  } catch (primaryError) {
    try {
      const mirror = new URL(targetUrl);
      if (!mirror.hostname.endsWith('coomerfans.com')) throw primaryError;
      mirror.hostname = 'onlyfaphouse.com';
      return await fetchHtmlOnce(mirror.toString());
    } catch {
      throw primaryError;
    }
  }
}

function artistIdentity(profile) {
  try {
    const parts = new URL(profile).pathname.split('/').filter(Boolean);
    if (parts[0] !== 'u' || !parts[1] || !parts[3]) return null;
    return { service: parts[1].toLowerCase(), username: decodeURIComponent(parts[3]) };
  } catch { return null; }
}

async function structuredVideoCount(profile) {
  const identity = artistIdentity(profile);
  if (!identity) return 0;
  const media = new Set();
  for (let offset = 0; offset <= 950 && Date.now() < deadline && media.size < 15; offset += 50) {
    const endpoint = `https://coomer.st/api/v1/${encodeURIComponent(identity.service)}/user/${encodeURIComponent(identity.username)}/posts?o=${offset}`;
    const response = await fetchStructured(endpoint);
    if (response.status === 404) return 0;
    if (!response.ok) throw new Error(`structured HTTP ${response.status}`);
    const posts = await response.json();
    if (!Array.isArray(posts) || !posts.length) break;
    for (const post of posts) {
      for (const item of [post?.file, ...(Array.isArray(post?.attachments) ? post.attachments : [])]) {
        const mediaPath = String(item?.path || '');
        if (/\.(?:mp4|m4v|mov|webm)(?:\?|$)/i.test(mediaPath)) media.add(mediaPath);
      }
    }
    if (posts.length < 50) break;
  }
  return media.size;
}

function profileUrls(html) {
  return [...new Set([...html.matchAll(/href=["']([^"']*\/u\/(?:onlyfans|fansly)\/\d+\/[^"'?#/]+)["']/gi)]
    .map(match => new URL(match[1], 'https://coomerfans.com/').toString()))];
}
function pageUrl(profile, page) {
  const url = new URL(profile);
  if (page > 1) url.searchParams.set('page', String(page));
  else url.searchParams.delete('page');
  return url.toString();
}
function videoPostUrls(html) {
  const blocks = html.split(/<div\s+class=["'][^"']*\bpost\b[^"']*["'][^>]*>/i).slice(1);
  const urls = [];
  for (const block of blocks) {
    const body = block.split(/<div\s+class=["'][^"']*\bpost\b/i)[0];
    if (/<img\b/i.test(body)) continue;
    const match = body.match(/<a[^>]+class=["'][^"']*\bview-post\b[^"']*["'][^>]+href=["']([^"']+)/i)
      || body.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*\bview-post\b/i);
    if (match) urls.push(new URL(match[1], 'https://coomerfans.com/').toString());
  }
  return [...new Set(urls)];
}
function videos(html, base) {
  const output = [];
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:mp4|m4v|mov|webm)(?:\?[^"']*)?)["']/gi)) {
    try { output.push(new URL(match[1].replaceAll('&amp;', '&'), base).toString()); } catch {}
  }
  return [...new Set(output)];
}

async function qualify(profile) {
  const foundPosts = new Set();
  const foundVideos = new Set();
  for (let page = 1; page <= 100 && Date.now() < deadline && foundVideos.size < 15; page += page === 1 ? 1 : 8) {
    const pages = page === 1 ? [1] : Array.from({ length: 8 }, (_, index) => page + index);
    const rows = await Promise.allSettled(pages.map(value => fetchHtml(pageUrl(profile, value))));
    const successfulListings = rows.filter(row => row.status === 'fulfilled').length;
    if (!successfulListings) throw new Error('profile transport unavailable');
    let any = false;
    const newPosts = [];
    for (const row of rows) {
      if (row.status !== 'fulfilled') continue;
      const posts = videoPostUrls(row.value);
      if (posts.length) any = true;
      for (const post of posts) if (!foundPosts.has(post)) { foundPosts.add(post); newPosts.push(post); }
    }
    for (let offset = 0; offset < newPosts.length && foundVideos.size < 15; offset += 20) {
      const batch = newPosts.slice(offset, offset + 20);
      const postRows = await Promise.allSettled(batch.map(fetchHtml));
      const successfulPosts = postRows.filter(row => row.status === 'fulfilled').length;
      if (!successfulPosts && batch.length) throw new Error('post transport unavailable');
      postRows.forEach((row, index) => {
        if (row.status !== 'fulfilled') return;
        videos(row.value, batch[index]).forEach(url => foundVideos.add(url));
      });
    }
    if (!any) break;
  }
  return { profile, videos: foundVideos.size };
}

async function qualifyInitial(profile, availableVideos) {
  const foundPosts = new Set();
  for (let page = 1; page <= 100 && Date.now() < deadline && foundPosts.size < 15; page++) {
    const html = await fetchHtml(pageUrl(profile, page));
    const posts = videoPostUrls(html);
    for (const post of posts) foundPosts.add(post);
    if (!posts.length) break;
  }
  if (foundPosts.size < 15) return { profile, videos: 0, availableVideos: foundPosts.size };
  const selected = [...foundPosts].slice(0, initialVideos);
  const rows = await Promise.allSettled(selected.map(fetchHtml));
  const resolved = new Set();
  rows.forEach((row, index) => {
    if (row.status !== 'fulfilled') return;
    videos(row.value, selected[index]).forEach(url => resolved.add(url));
  });
  return { profile, videos: Math.min(resolved.size, initialVideos), availableVideos };
}

async function catalogFastBenchmark(start) {
  const creatorsResponse = await fetchStructured('https://coomer.st/api/v1/creators', 30000);
  if (!creatorsResponse.ok) throw new Error(`creator catalog HTTP ${creatorsResponse.status}`);
  const creators = (await creatorsResponse.json()).filter(item =>
    item?.service === 'onlyfans' && item?.id && Number(item?.favorited || 0) > 0);
  for (let index = creators.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [creators[index], creators[swap]] = [creators[swap], creators[index]];
  }
  const eligible = [];
  let prefilterCursor = 0;
  async function prefilterWorker() {
    while (Date.now() < deadline && eligible.length < target * 6 && prefilterCursor < creators.length) {
      const creator = creators[prefilterCursor++];
      const pseudoProfile = `https://coomerfans.com/u/onlyfans/0/${encodeURIComponent(creator.id)}`;
      try {
        const count = await structuredVideoCount(pseudoProfile);
        if (count >= 15) eligible.push({ username: creator.id, count });
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: 8 }, prefilterWorker));
  eligible.sort((left, right) => right.count - left.count);
  const accepted = [];
  const rejected = [];
  const errors = [];
  let cursor = 0;
  async function playbackWorker() {
    while (Date.now() < deadline && accepted.length < target && cursor < eligible.length) {
      const candidate = eligible[cursor++];
      try {
        const searchHtml = await fetchHtml(`https://coomerfans.com/?q=${encodeURIComponent(candidate.username)}`);
        const profiles = profileUrls(searchHtml);
        const wanted = candidate.username.toLowerCase();
        const profile = profiles.find(value => {
          try {
            const parts = new URL(value).pathname.split('/').filter(Boolean);
            return parts[1]?.toLowerCase() === 'onlyfans' && decodeURIComponent(parts.at(-1)).toLowerCase() === wanted;
          }
          catch { return false; }
        });
        if (!profile) { rejected.push({ username: candidate.username, stage: 'search' }); continue; }
        const result = await qualifyInitial(profile, candidate.count);
        if (result.videos >= initialVideos) {
          accepted.push(result);
          process.stdout.write(`accepted ${accepted.length}/${target} ${result.videos} initial/${result.availableVideos} available ${profile}\n`);
        } else rejected.push(result);
      } catch (error) {
        errors.push(String(error?.message || error));
      }
    }
  }
  await Promise.all(Array.from({ length: artistConcurrency }, playbackWorker));
  const output = {
    pass: accepted.length >= target && Date.now() - start <= seconds * 1000 + 2000,
    transport, structuredTransport, qualification, elapsedMs: Date.now() - start,
    discovered: creators.length, prequalified: eligible.length,
    accepted: accepted.length, rejected: rejected.length, errors: errors.length,
    results: accepted.slice(0, target),
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

const start = Date.now();
if (qualification === 'catalog-fast') {
  const output = await catalogFastBenchmark(start);
  process.exit(output.pass ? 0 : 1);
}
const pages = Array.from({ length: listingPageCount }, (_, index) => fixedStartPage ? fixedStartPage + index : randomInt(1, 3501));
const listings = await Promise.allSettled(pages.map(page => fetchHtml(`https://coomerfans.com/?page=${page}`)));
const candidates = [...new Set(listings.flatMap(row => row.status === 'fulfilled' ? profileUrls(row.value) : []))];
const structuredByProfile = new Map();
let workCandidates = candidates;
if (qualification === 'hybrid-fast') {
  let prefilterCursor = 0;
  const eligible = [];
  async function prefilterWorker() {
    while (Date.now() < deadline && eligible.length < target * 6 && prefilterCursor < candidates.length) {
      const profile = candidates[prefilterCursor++];
      try {
        const count = await structuredVideoCount(profile);
        structuredByProfile.set(profile, count);
        if (count >= 15) eligible.push(profile);
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: 8 }, prefilterWorker));
  workCandidates = eligible.sort((left, right) =>
    (structuredByProfile.get(right) || 0) - (structuredByProfile.get(left) || 0));
}
let cursor = 0;
const accepted = [];
const rejected = [];
const errors = [];
async function artistWorker() {
  while (Date.now() < deadline && accepted.length < target && cursor < workCandidates.length) {
    const profile = workCandidates[cursor++];
    try {
      if (qualification === 'hybrid-fast') {
        const result = await qualifyInitial(profile, structuredByProfile.get(profile) || 15);
        if (result.videos >= initialVideos) {
          accepted.push(result);
          process.stdout.write(`accepted ${accepted.length}/${target} ${result.videos} initial/${result.availableVideos} available ${profile}\n`);
        } else {
          rejected.push(result);
        }
        continue;
      }
      if (qualification === 'hybrid' || qualification === 'structured') {
        const structuredVideos = await structuredVideoCount(profile);
        if (structuredVideos < 15) {
          rejected.push({ profile, videos: structuredVideos, stage: 'structured' });
          continue;
        }
        if (qualification === 'structured') {
          const result = { profile, videos: structuredVideos };
          accepted.push(result);
          process.stdout.write(`accepted ${accepted.length}/${target} ${result.videos} ${profile}\n`);
          continue;
        }
        if (qualification === 'hybrid') {
          const result = await qualifyInitial(profile, structuredVideos);
          if (result.videos >= initialVideos) {
            accepted.push(result);
            process.stdout.write(`accepted ${accepted.length}/${target} ${result.videos} initial/${result.availableVideos} available ${profile}\n`);
          } else {
            rejected.push(result);
          }
          continue;
        }
      }
      const result = await qualify(profile);
      (result.videos >= 15 ? accepted : rejected).push(result);
      if (result.videos >= 15) process.stdout.write(`accepted ${accepted.length}/${target} ${result.videos} ${profile}\n`);
    } catch (error) {
      errors.push(String(error?.message || error));
      await sleep(1000);
    }
  }
}
await Promise.all(Array.from({ length: artistConcurrency }, artistWorker));
console.log(JSON.stringify({
  pass: accepted.length >= target && Date.now() - start <= seconds * 1000 + 2000,
  transport, qualification, elapsedMs: Date.now() - start, pages, discovered: candidates.length,
  accepted: accepted.length, rejected: rejected.length, errors: errors.length,
  results: accepted.slice(0, target)
}, null, 2));
process.exitCode = accepted.length >= target ? 0 : 1;
