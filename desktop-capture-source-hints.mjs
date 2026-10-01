import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { rankDesktopCaptureMediaUrls } from './desktop-capture-jobs.mjs';

const MEDIA_EXTENSION = /\.(?:mp4|m4v|mov|webm)$/i;
const NON_MOVIE_NAME = /(?:^|[/_-])(?:preview|trailer|thumb)(?:[/_.-]|$)/i;
const RESERVED_HOST = /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/i;

function publicUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || isIP(host) ||
        !host.includes('.') || RESERVED_HOST.test(host)) return null;
    url.hash = '';
    return url;
  } catch (_) { return null; }
}

function watchId(page) {
  const ids = [...page.pathname.matchAll(/(?:^|\D)(\d{5,18})(?=\D|$)/g)].map(match => match[1]);
  const distinct = [...new Set(ids)];
  return distinct.length === 1 ? distinct[0] : '';
}

function bindsToPage(page, media) {
  const pageHost = page.hostname.toLowerCase();
  const siteHost = pageHost.startsWith('www.') ? pageHost.slice(4) : pageHost;
  const mediaHost = media.hostname.toLowerCase();
  const id = watchId(page);
  return Boolean(id && (mediaHost === siteHost || mediaHost.endsWith(`.${siteHost}`)) &&
    new RegExp(`(?:^|\\D)${id}(?=\\D|$)`).test(media.pathname) &&
    MEDIA_EXTENSION.test(media.pathname) && !NON_MOVIE_NAME.test(media.pathname));
}

export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    // Only ordinary global unicast is eligible. Exclude IANA special-use
    // ranges inside 2000::/3 as well as transition/documentation prefixes.
    const first = Number.parseInt(lower.split(':')[0], 16);
    if (!Number.isInteger(first) || first < 0x2000 || first > 0x3ffe ||
        first === 0x2002 || lower.includes('::ffff:')) return false;
    if (first === 0x2001) {
      const second = Number.parseInt(lower.split(':')[1] || '0', 16);
      if (second <= 0x01ff || second === 0x0db8) return false;
    }
    return true;
  }
  return false;
}

async function bounded(promise, timeoutMs, signal) {
  if (timeoutMs <= 0 || signal?.aborted) return null;
  let timer, onAbort;
  try {
    return await Promise.race([promise, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      onAbort = () => resolve(null);
      signal?.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
}

export async function secureRangeProbe(media, page, timeoutMs, { lookupImpl = lookup, signal } = {}) {
  if (signal?.aborted) return null;
  const deadline = performance.now() + Math.max(0, Number(timeoutMs) || 0);
  const addresses = await bounded(lookupImpl(media.hostname, { all: true }),
    Math.ceil(deadline - performance.now()), signal);
  if (!Array.isArray(addresses)) return null;
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return null;
  const selected = addresses[0];
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0 || signal?.aborted) return null;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      resolve(result);
    };
    const request = https.request(media, {
      method: 'GET', timeout: remaining, signal,
      lookup: (_host, options, callback) => callback(null,
        options?.all ? [selected] : selected.address, selected.family),
      headers: { Range: 'bytes=0-1023', Referer: page.toString(), Accept: 'video/*,*/*;q=0.5' }
    }, response => {
      const result = { status: Number(response.statusCode || 0),
        location: String(response.headers.location || ''),
        type: String(response.headers['content-type'] || '').toLowerCase() };
      response.destroy();
      finish(result);
    });
    const wallTimer = setTimeout(() => { request.destroy(); finish(null); }, remaining);
    request.once('error', () => finish(null));
    request.once('timeout', () => request.destroy());
    request.end();
  });
}

export function normalizeSourceMediaHints(pageUrl, rawHints, targetDurationSeconds = 0) {
  const page = publicUrl(pageUrl);
  if (!page || !Array.isArray(rawHints) || rawHints.length > 8) return [];
  const knownDuration = Number(targetDurationSeconds);
  const result = [];
  const seen = new Set();
  for (const raw of rawHints) {
    const media = publicUrl(raw?.url);
    const sourcePage = publicUrl(raw?.sourcePageUrl);
    const durationSeconds = Number(raw?.durationSeconds);
    const width = raw?.width == null ? 0 : Number(raw.width);
    const height = raw?.height == null ? 0 : Number(raw.height);
    const filenameQuality = /(?:^|[_-])\d{3,4}[_x]\d{3,4}(?:[_./-]|$)|(?:^|[_-])\d{3,4}p(?:[_./-]|$)/i.test(
      media?.pathname.split('/').at(-1) || ''
    );
    if (!media || !sourcePage || sourcePage.toString() !== page.toString() ||
        !bindsToPage(page, media) || !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 || durationSeconds > 86400 ||
        (knownDuration > 0 && Math.abs(durationSeconds - knownDuration) > Math.max(2, knownDuration * .05)) ||
        !Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 ||
        width > 16384 || height > 16384 || Boolean(width) !== Boolean(height) ||
        (!width && !filenameQuality) ||
        seen.has(media.toString())) continue;
    seen.add(media.toString());
    result.push({ url: media.toString(), sourcePageUrl: page.toString(), durationSeconds, width, height });
  }
  return result;
}

export function shouldTrySourceMediaHints(resolved, resolutionError) {
  if (resolutionError?.code === 'quality_unverified') return false;
  return Boolean(resolutionError || !Array.isArray(resolved?.videoUrls) || !resolved.videoUrls.length);
}

export function planSourceMediaHints(resolved, resolutionError, hints) {
  const none = { mode: 'none', candidates: [] };
  if (['quality_unverified', 'identity_unverified'].includes(resolutionError?.code)) return none;
  const validHints = (Array.isArray(hints) ? hints : []).filter(hint => {
    const duration = Number(resolved?.durationSeconds || 0);
    return !(duration > 0) || Math.abs(hint.durationSeconds - duration) <= Math.max(2, duration * .05);
  });
  const rankedHints = rankDesktopCaptureMediaUrls(validHints.map(hint => hint.url), validHints);
  const best = rankedHints[0];
  if (!best?.known) return none;
  const candidates = rankedHints.filter(item => item.score === best.score)
    .map(item => validHints.find(hint => hint.url === item.mediaUrl));
  if (shouldTrySourceMediaHints(resolved, resolutionError)) return { mode: 'fallback', candidates };
  // A manifest/unknown PC source may contain a higher rendition not measured
  // here. Only a strictly better, comparable progressive source can upgrade it.
  const rankedPc = rankDesktopCaptureMediaUrls(resolved.videoUrls, resolved.sources);
  if (!rankedPc.length || rankedPc.some(item => !item.known || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(item.mediaUrl))) return none;
  return best.score > rankedPc[0].score ? { mode: 'upgrade', candidates } : none;
}

export async function verifySourceMediaHint(hint, { probeImpl = secureRangeProbe, timeoutMs = 8000, signal } = {}) {
  const page = publicUrl(hint?.sourcePageUrl);
  const media = publicUrl(hint?.url);
  if (signal?.aborted || !page || !media || !bindsToPage(page, media)) return { playable: false };
  const deadline = performance.now() + Math.max(0, Number(timeoutMs) || 0);
    try {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) return { playable: false };
      const response = await bounded(probeImpl(media, page, remaining, { signal }), remaining, signal);
      if (!response) return { playable: false };
      if (response.status >= 300 && response.status < 400) {
        // Browser dimensions describe the exact submitted rendition, not a
        // redirect destination. Even the same asset ID can redirect from 4K
        // to a 360p rendition. A header-only probe cannot transfer that quality
        // evidence. Leave redirected sources to the normal desktop resolver;
        // never advertise them as a verified higher-quality hint.
        return { playable: false };
      }
      const playable = (response.status === 200 || response.status === 206) &&
        (/^video\//.test(response.type) || /^(?:application\/octet-stream)(?:;|$)/.test(response.type));
      return playable ? { playable: true, mediaUrl: media.toString() } : { playable: false };
    } catch (_) {
      return { playable: false };
    }
}
