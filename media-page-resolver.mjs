import { primaryVideoEvidence } from './video-source-policy.mjs';
const VIDEO_EXTENSION_RE = /\.(?:mp4|m4v|mov|webm|mkv|m3u8|ogv)(?:\/?[?#]|$)/i;
const VIDEO_ENDPOINT_RE = /\/(?:get_video)(?:[/?#]|$)/i;

function decodeHtmlValue(value) {
  return String(value || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

function addCandidate(output, seen, rawValue, pageUrl) {
  const value = decodeHtmlValue(rawValue);
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return;
  try {
    const resolved = new URL(value, pageUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) return;
    // Never promote player advertising to Recall media. These hosts commonly
    // return a perfectly playable 8-15 second MP4 before the nested movie
    // player loads, so MIME/range verification alone cannot distinguish them.
    if (/(?:^|\.)(?:adtng\.com|exoclick\.com|doubleclick\.net|googlesyndication\.com|trafficjunky\.net)$/i.test(resolved.hostname)) return;
    if (!VIDEO_EXTENSION_RE.test(resolved.pathname + resolved.search) && !VIDEO_ENDPOINT_RE.test(resolved.pathname)) return;
    resolved.hash = '';
    const normalized = resolved.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  } catch (_) {}
}

function addEmbedCandidate(output, seen, rawValue, pageUrl) {
  const value = decodeHtmlValue(rawValue);
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return;
  try {
    const resolved = new URL(value, pageUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) return;
    resolved.hash = '';
    const normalized = resolved.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  } catch (_) {}
}

function metaValues(html, keyPattern) {
  const values = [];
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!keyPattern.test(name)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (content) values.push(content);
  }
  return values;
}

export function extractGenericVideoUrlsFromHtml(html, pageUrl) {
  const primary = primaryVideoEvidence(html, pageUrl);
  if (primary) return primary.videoUrls;
  const source = decodeHtmlValue(html);
  const urls = [];
  const seen = new Set();
  const candidates = [];

  // Playerjs/KVS pages often put every rendition in one labelled `file`
  // string.  Preserve those labels long enough to put HD/1080p/720p ahead of
  // the site's usually-low default (commonly 240p or 360p).  Once converted
  // to plain URLs the label is otherwise lost and filename suffixes such as
  // `_7.mp4` provide no reliable quality information.
  const labelledPlayerSources = [];
  for (const match of source.matchAll(/\bfile\s*:\s*["']([^"']+)["']/gi)) {
    for (const item of match[1].split(',')) {
      const labelled = item.match(/^\s*\[([^\]]+)]\s*(https?:\/\/.+)\s*$/i);
      if (!labelled) continue;
      const label = labelled[1].toLowerCase();
      const numeric = Number(label.match(/(\d{3,4})/)?.[1] || 0);
      const score = numeric || (/\b(?:full\s*hd|fhd)\b/i.test(label) ? 1080 : /\bhd\b/i.test(label) ? 720 : 0);
      labelledPlayerSources.push({ url: labelled[2], score });
    }
  }
  labelledPlayerSources.sort((left, right) => right.score - left.score);
  candidates.push(...labelledPlayerSources.map(item => item.url));

  candidates.push(...metaValues(source, /^(?:og:video(?::url|:secure_url)?|twitter:player:stream|contentUrl)$/i));
  for (const match of source.matchAll(/<(?:video|source)\b[^>]*\b(?:src|data-src|data-file|data-video|data-url)\s*=\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  for (const match of source.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  for (const match of source.matchAll(/["'](?:contentUrl|videoUrl|file|src|source)["']\s*:\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  // Kernel Video Sharing pages expose their real, short-lived URLs through
  // unquoted snake_case flashvars. Preserve the v-acctoken query; without it
  // the apparent MP4 is only an anti-hotlink placeholder.
  for (const match of source.matchAll(/\b(?:video_url|video_alt_url|video_url_\d+)\s*:\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  for (const match of source.matchAll(/(?:https?:)?\\?\/\\?\/[^\s"'<>]+?\.(?:mp4|m4v|mov|webm|mkv|m3u8)(?:\/?\?[^\s"'<>\\]*)?/gi)) {
    candidates.push(match[0].startsWith('//') ? `https:${match[0]}` : match[0]);
  }
  // Streamtape deliberately splits its signed media endpoint across constant
  // strings and substring calls. Reconstruct that deterministic expression
  // without evaluating page JavaScript (and without opening its ad popups).
  for (const match of source.matchAll(/getElementById\(\s*["']robotlink["']\s*\)\.innerHTML\s*=\s*(["'])(\/\/[^"']*)\1\s*\+\s*(?:["']{2}\s*\+\s*)?\(\s*(["'])([^"']+)\3\s*\)((?:\.substring\(\s*\d+\s*\))+)/gi)) {
    let suffix = match[4];
    for (const operation of match[5].matchAll(/\.substring\(\s*(\d+)\s*\)/gi)) {
      suffix = suffix.substring(Number(operation[1]) || 0);
    }
    candidates.push(`https:${match[2]}${suffix}`);
  }
  for (const candidate of candidates) addCandidate(urls, seen, candidate, pageUrl);
  const signedKvsUrls = urls.filter(value => /[?&]v-acctoken=/i.test(value));
  if (signedKvsUrls.length) {
    const quality = value => {
      const match = String(value).match(/[_-](\d{3,4})p?\.(?:mp4|m4v|mov|webm|mkv)(?:[/?#]|$)/i);
      return match ? Number(match[1]) : 0;
    };
    signedKvsUrls.sort((left, right) => quality(right) - quality(left));
    return [signedKvsUrls[0]];
  }
  const nonPreviewUrls = urls.filter(value => !/(?:^|\/)preview(?:[_-][^/?#]*)?\.(?:mp4|m4v|mov|webm|mkv)(?:[?#]|$)/i.test(new URL(value).pathname));
  // Preview clips are never promoted merely because no full source was found
  // in the same document. The embed/yt-dlp/browser stages must keep resolving
  // until they obtain the real media instead of returning a ten-second card.
  return nonPreviewUrls;
}

export function extractGenericEmbedUrlsFromHtml(html, pageUrl) {
  const source = decodeHtmlValue(html);
  const urls = [];
  const seen = new Set();
  const candidates = [];
  candidates.push(...metaValues(source, /^(?:og:video|twitter:player|embedURL)$/i));
  for (const match of source.matchAll(/<(?:iframe|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  for (const match of source.matchAll(/["'](?:embedUrl|embedURL|embed_url|playerUrl|playerURL)["']\s*:\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  // Some galleries keep every mirror in a click handler and leave the iframe
  // at about:blank until a player button is pressed.
  for (const match of source.matchAll(/\b(?:playEmbed|loadEmbed)\s*\(\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  for (const candidate of candidates) addEmbedCandidate(urls, seen, candidate, pageUrl);
  return urls.filter(url => !VIDEO_EXTENSION_RE.test(new URL(url).pathname));
}

export function extractGenericWatchPageUrlsFromHtml(html, pageUrl, limit = 40) {
  const source = decodeHtmlValue(html);
  const output = [];
  const seen = new Set();
  let page;
  try { page = new URL(pageUrl); } catch (_) { return output; }
  const watchPath = value => (
    /\/(?:free-stock-video|free-video|premium-video)\/[^/?#]*[-_]\d+\/?$/i.test(value.pathname) ||
    /\/[^/]+\/\d+-[^/]+\/?$/.test(value.pathname) ||
    /\/wiki\/File:[^/]+\.(?:webm|mp4|ogv)$/i.test(value.pathname) ||
    (/^(?:www\.)?vimeo\.com$/.test(value.hostname) && /^\/\d+$/.test(value.pathname)) ||
    (/(?:^|\.)youtube\.com$/.test(value.hostname) && value.pathname === '/watch' && !!value.searchParams.get('v')) ||
    /\/view_video\.php\?[^#]*\bviewkey=[^&#]+/i.test(value.pathname + value.search) ||
    /\/(?:watch|videos?|scene|post|talks|details)\/(?!search(?:[/?#]|$)|category(?:[/?#]|$)|tags?(?:[/?#]|$))[^/?#]+/i.test(value.pathname)
  );
  for (const match of source.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const target = new URL(decodeHtmlValue(match[1]), page);
      target.hash = '';
      if (!['http:', 'https:'].includes(target.protocol)) continue;
      if (target.hostname.toLowerCase() !== page.hostname.toLowerCase()) continue;
      if (!watchPath(target)) continue;
      // Drop tracking-only noise while retaining identity-bearing query keys.
      for (const key of [...target.searchParams.keys()]) {
        if (/^(?:utm_.+|ref|src|source|track|click)$/i.test(key)) target.searchParams.delete(key);
      }
      const normalized = target.toString();
      if (normalized === page.toString() || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
      if (output.length >= Math.max(1, Number(limit || 40))) break;
    } catch (_) {}
  }
  return output;
}

export function extractGenericMediaPageMetadata(html, pageUrl) {
  const primary = primaryVideoEvidence(html, pageUrl);
  if (primary) return { pageUrl: String(pageUrl || ''), title: primary.title,
    videoUrls: primary.videoUrls, durationSeconds: primary.durationSeconds,
    identityEvidence: primary.identityEvidence };
  const source = decodeHtmlValue(html);
  const title = decodeHtmlValue(
    metaValues(source, /^(?:og:title|twitter:title)$/i)[0] ||
    source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    ''
  ).replace(/<[^>]+>/g, '').trim();
  let durationSeconds = Number(source.match(/["']video_duration["']\s*:\s*(\d+(?:\.\d+)?)/i)?.[1] || 0);
  if (!durationSeconds) {
    const written = source.match(/\b(?:video\s+)?duration\s+(?:is\s+)?(?:(\d{1,2})\s*(?:h|hours?)\s*)?(?:(\d{1,3})\s*(?:m|min|minutes?)\s*)?(?:(\d{1,2})\s*(?:s|sec|seconds?))\b/i);
    if (written) durationSeconds = Number(written[1] || 0) * 3600 + Number(written[2] || 0) * 60 + Number(written[3] || 0);
  }
  return {
    pageUrl: String(pageUrl || ''),
    title,
    videoUrls: extractGenericVideoUrlsFromHtml(source, pageUrl),
    ...(durationSeconds > 0 ? { durationSeconds } : {})
  };
}
