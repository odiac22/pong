import crypto from 'node:crypto';
import net from 'node:net';

const DIRECT_MEDIA = /\.(?:mp4|m4v|mov|webm|mkv|m3u8|mpd|ogv)(?:[?#]|$)/i;
const INLINE_ID = /^inline-video-([1-9]\d{0,3})$/;

export function canonicalInlineMediaUrl(raw, pageUrl) {
  try {
    const url = new URL(String(raw || ''), pageUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !DIRECT_MEDIA.test(url.href)) return '';
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.lan')) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function inlineMediaIdentityHash(raw, pageUrl) {
  const url = canonicalInlineMediaUrl(raw, pageUrl);
  return url ? crypto.createHash('sha256').update(url).digest('hex') : '';
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function decodeHtml(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function videoSources(html, pageUrl) {
  const videos = [];
  // Commented-out fallback sources are not members of the rendered player.
  const activeHtml = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of activeHtml.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video\s*>/gi)) {
    const open = match[1], body = match[2];
    const tags = [open, ...[...body.matchAll(/<source\b[^>]*>/gi)].map(item => item[0])];
    const seen = new Set();
    const sources = tags.map(tag => {
      const url = canonicalInlineMediaUrl(decodeHtml(attribute(tag, 'src')), pageUrl);
      if (!url || seen.has(url)) return null;
      seen.add(url);
      const dimension = name => {
        const value = Number(attribute(tag, `data-${name}`));
        return Number.isInteger(value) && value > 0 && value <= 8192 ? value : null;
      };
      return { url, width: dimension('width'), height: dimension('height'),
        label: attribute(tag, 'data-quality') || attribute(tag, 'label') || '',
        type: attribute(tag, 'type') || '' };
    }).filter(Boolean);
    const duration = Number(attribute(open, 'data-duration'));
    videos.push({sources,durationSeconds:Number.isFinite(duration)&&duration>0?duration:0});
  }
  return videos;
}

/** Resolve only a selected native video's declared sources on this same page.
 * A source hash guards against ads, hydration reordering, and first-video fallbacks.
 * Callers must still verify the returned media bytes and duration before Recall.
 */
export function resolveInlineVideoIdentityFromHtml({ html, pageUrl, logicalVideoId, mediaIdentityHash }) {
  const index = Number(String(logicalVideoId || '').match(INLINE_ID)?.[1] || 0) - 1;
  if (index < 0 || !/^[a-f0-9]{64}$/i.test(mediaIdentityHash || '')) return null;
  const videos = videoSources(html, pageUrl);
  const matches = videos.map((group, i) => ({ ...group, i })).filter(item =>
    item.sources.some(source => inlineMediaIdentityHash(source.url, pageUrl) === mediaIdentityHash));
  if (!matches.length) return null;
  const indexed = matches.find(item => item.i === index);
  const chosen = indexed || (matches.length === 1 ? matches[0] : null);
  if (!chosen?.sources.length) return null;
  // If multiple DOM videos reuse one URL, their selected media is the same;
  // otherwise an order shift is accepted only for a unique source match.
  if (!indexed && matches.length > 1) return null;
  return { videoUrls: chosen.sources.map(source => source.url),
    sources: chosen.sources.map(source => ({ ...source, selectedInline: true })),
    durationSeconds: chosen.durationSeconds, identityEvidence: 'selected-inline-video-source',
    matchedVideoIndex: chosen.i + 1, reordered: chosen.i !== index };
}
