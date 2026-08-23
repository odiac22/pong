const RESERVED_PATHS = new Set([
  '', 'creators', 'feed', 'videos', 'shorts', 'premium', 'login', 'register',
  'user', 'support', 'request-model', 'download', 'm3u8', 'privacy-policy',
  'offer-terms', 'return-and-refund-policy', 'usc2257', 'cdn-cgi'
]);

function decodeHtmlUrl(value = '') {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/g, '/')
    .trim();
}

export function normalizeLeakedZoneUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (url.protocol !== 'https:' || url.hostname.replace(/^www\./i, '').toLowerCase() !== 'leakedzone.com') {
      return '';
    }
    url.hostname = 'leakedzone.com';
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function anchorRecords(html, baseUrl) {
  const records = [];
  const pattern = /<a\b([^>]*)>/gi;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const attrs = match[1] || '';
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch?.[1]) continue;
    try {
      records.push({
        attrs,
        url: new URL(decodeHtmlUrl(hrefMatch[1]), baseUrl).toString()
      });
    } catch (_) {}
  }
  return records;
}

export function leakedZoneNextPageUrl(html, baseUrl) {
  for (const record of anchorRecords(html, baseUrl)) {
    if (
      /\brel=["'][^"']*\bnext\b/i.test(record.attrs) ||
      /\baria-label=["']Next page["']/i.test(record.attrs) ||
      /\btitle=["']Next page["']/i.test(record.attrs)
    ) {
      return normalizeLeakedZoneUrl(record.url);
    }
  }
  return '';
}

export function leakedZoneCreatorUrl(rawUrl) {
  const normalized = normalizeLeakedZoneUrl(rawUrl);
  if (!normalized) return '';
  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length || RESERVED_PATHS.has(parts[0].toLowerCase())) return '';
  if (parts.length === 1 || (parts.length === 3 && /^(?:video|short)$/i.test(parts[1]) && /^\d+$/.test(parts[2]))) {
    url.pathname = `/${parts[0]}`;
    url.search = '';
    return url.toString();
  }
  return '';
}

export function extractLeakedZoneCreatorUrls(html, baseUrl) {
  const output = [];
  const seen = new Set();
  for (const record of anchorRecords(html, baseUrl)) {
    const creatorUrl = leakedZoneCreatorUrl(record.url);
    if (!creatorUrl || seen.has(creatorUrl)) continue;
    const path = new URL(record.url).pathname.split('/').filter(Boolean);
    if (path.length !== 1) continue;
    seen.add(creatorUrl);
    output.push(creatorUrl);
  }
  return output;
}

export function extractLeakedZoneVideoDetailUrls(html, creatorUrl) {
  const creator = leakedZoneCreatorUrl(creatorUrl);
  if (!creator) return [];
  const creatorSlug = new URL(creator).pathname.split('/').filter(Boolean)[0].toLowerCase();
  const output = [];
  const seen = new Set();
  for (const record of anchorRecords(html, creator)) {
    const normalized = normalizeLeakedZoneUrl(record.url);
    if (!normalized) continue;
    const parts = new URL(normalized).pathname.split('/').filter(Boolean);
    if (
      parts.length !== 3 ||
      parts[0].toLowerCase() !== creatorSlug ||
      !/^(?:video|short)$/i.test(parts[1]) ||
      !/^\d+$/.test(parts[2]) ||
      seen.has(normalized)
    ) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function extractLeakedZonePlaylistUrl(html) {
  const encoded = String(html || '').match(/\bfile\s*:\s*f\(["']([^"']+)["']\)/i)?.[1] || '';
  if (!encoded) return '';
  try {
    const decoded = Buffer.from([...encoded].reverse().join(''), 'base64').toString('utf8');
    return decoded.match(/https:\/\/[^\s\x00-\x1f"']+\.m3u8\?[^\s\x00-\x1f"']+/i)?.[0] || '';
  } catch (_) {
    return '';
  }
}
