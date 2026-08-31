const SIMPCITY_HOSTS = new Set(['simpcity.cr', 'www.simpcity.cr']);
const CREATOR_STOP_WORDS = new Set([
  'admin', 'album', 'albums', 'anyone', 'attachment', 'attachments', 'beautiful',
  'bunkr', 'content', 'discussion', 'download', 'downloads', 'enjoy', 'forum',
  'girl', 'girls', 'here', 'image', 'images', 'instagram', 'leak', 'leaked',
  'light skin', 'lightskin', 'link', 'links', 'media', 'mega', 'message', 'model',
  'more', 'new', 'onlyfans', 'photo', 'photos', 'please', 'post', 'posts',
  'quote', 'reddit', 'reply', 'report', 'request', 'repost', 'simpcity', 'source',
  'spoiler', 'telegram', 'thanks', 'thank you', 'thread', 'threads', 'tiktok',
  'twitter', 'update', 'updated', 'video', 'videos'
]);
const SOCIAL_HOSTS = new Set([
  'instagram.com', 'www.instagram.com',
  'onlyfans.com', 'www.onlyfans.com',
  'tiktok.com', 'www.tiktok.com',
  'twitter.com', 'www.twitter.com',
  'x.com', 'www.x.com'
]);
const COMMON_SINGLE_FIRST_NAMES = new Set([
  'abby', 'alice', 'alyssa', 'amanda', 'amber', 'amy', 'ana', 'anna', 'ashley',
  'bella', 'brianna', 'brooke', 'chloe', 'claire', 'danielle', 'ella', 'emily',
  'emma', 'grace', 'hailey', 'hannah', 'isabella', 'jasmine', 'jessica',
  'julia', 'katie', 'kayce', 'kayla', 'lauren', 'lily', 'madison', 'maya', 'mia',
  'molly', 'natalie', 'nicole', 'olivia', 'paige', 'rachel', 'rebecca',
  'samantha', 'sarah', 'sophia', 'taylor', 'victoria', 'zoe'
]);

export function decodeSimpCityHtmlText(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSimpCityThreadUrl(rawValue) {
  try {
    const url = new URL(String(rawValue || '').trim());
    if (!SIMPCITY_HOSTS.has(url.hostname.toLowerCase())) return '';
    if (!/^\/threads\/[^/?#]+(?:\/(?:page|post)-\d+)?\/?$/i.test(url.pathname)) return '';
    url.protocol = 'https:';
    url.hostname = 'simpcity.cr';
    url.username = '';
    url.password = '';
    url.hash = '';
    url.pathname = url.pathname
      .replace(/\/(?:page|post)-\d+\/?$/i, '/')
      .replace(/\/?$/, '/');
    // Ordering affects which posts appear on each page, but unrelated tracking
    // parameters must not create duplicate import jobs.
    url.search = '';
    // Every SimpCity workflow starts with the community's highest-reaction
    // posts, where the strongest creator links and working mirrors usually are.
    url.searchParams.set('order', 'reaction_score');
    return url.toString();
  } catch (_) {
    return '';
  }
}

export function simpCityThreadPageUrl(rawThreadUrl, pageNumber) {
  const normalized = normalizeSimpCityThreadUrl(rawThreadUrl);
  if (!normalized) return '';
  const page = Math.max(1, Math.floor(Number(pageNumber || 1)));
  if (page === 1) return normalized;
  const url = new URL(normalized);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/page-${page}`;
  return url.toString();
}

export function simpCityThreadPageCount(html, maximum = 250) {
  const source = String(html || '');
  let pageCount = 1;
  const patterns = [
    /\/page-(\d+)(?:[/?#"'&<]|$)/gi,
    /\bdata-page=["'](\d+)["']/gi,
    /\bPage\s+\d+\s+of\s+(\d+)\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      pageCount = Math.max(pageCount, Number(match[1] || 1));
    }
  }
  return Math.max(1, Math.min(Math.max(1, Number(maximum || 250)), pageCount));
}

const SIMPCITY_DIRECT_VIDEO_RE = /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i;

function simpCityUrlCandidates(rawValue) {
  const pending = [decodeSimpCityHtmlText(rawValue)];
  const results = [];
  const seen = new Set();
  while (pending.length && results.length < 20) {
    const value = String(pending.shift() || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    let decoded = value;
    try { decoded = decodeURIComponent(value.replace(/\+/g, '%20')); } catch (_) {}
    if (decoded !== value) pending.push(decoded);
    if (/^[a-z0-9_-]{12,}={0,2}$/i.test(value)) {
      try {
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
        const unwrapped = Buffer.from(base64, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(unwrapped)) pending.push(unwrapped);
      } catch (_) {}
    }
    for (const match of value.matchAll(/https?(?::|%3a)(?:\/\/|%2f%2f)[^\s<>'"\])}]+/gi)) pending.push(match[0]);
    try {
      const url = new URL(value);
      if (/^(?:www\.)?simpcity\.cr$/i.test(url.hostname)) {
        for (const key of ['link', 'url', 'target', 'to', 'u', 'redirect']) {
          const target = url.searchParams.get(key);
          if (target) pending.push(target);
        }
      } else results.push(url.toString());
    } catch (_) {}
  }
  return results;
}

export function classifySimpCityMediaUrl(rawValue) {
  try {
    const url = new URL(simpCityUrlCandidates(rawValue)[0] || decodeSimpCityHtmlText(rawValue));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    let kind = '';
    if (host === 'gofile.io' && /^\/d\/[a-z0-9_-]+$/i.test(path)) kind = 'gofile';
    else if (host === 'pixeldrain.com' && /^\/(?:u|l|d)\/[a-z0-9_-]+$/i.test(path)) kind = 'pixeldrain';
    else if (/^(?:bunkr\.(?:cr|ph|si|ru|su|la|fi|site|black|media)|bunkrrr\.org|xbunkr\.com)$/i.test(host) && /^\/(?:a|f|v)\/[a-z0-9_.-]+$/i.test(path)) kind = 'bunkr';
    else if (/^cyberdrop\.(?:cr|me|to)$/i.test(host) && /^\/(?:a|f)\/[a-z0-9_-]+$/i.test(path)) kind = 'cyberdrop';
    else if (/^(?:[^.]+\.)?cyberfile\.me$/i.test(host) && path !== '/') kind = 'cyberfile';
    else if (/^(?:saint\.to|saint2\.(?:su|cr)|turbo\.cr)$/i.test(host) && /^\/(?:embed|v)\/[a-z0-9_-]+$/i.test(path)) kind = 'saint';
    else if (host === 'tiktok.com' && /^\/@[a-z0-9_.-]+(?:\/(?:video|photo)\/\d+)?$/i.test(path)) kind = 'tiktok';
    else if (SIMPCITY_DIRECT_VIDEO_RE.test(`${path}${url.search}`)) kind = 'direct';
    if (!kind) return null;
    url.hash = '';
    return { kind, url: url.toString() };
  } catch (_) {
    return null;
  }
}

export function extractSimpCityMediaLinks(rawPosts) {
  const results = [];
  const seen = new Set();
  for (const [index, rawPost] of (Array.isArray(rawPosts) ? rawPosts : []).entries()) {
    const postId = String(rawPost?.postId || `post-${index + 1}`).slice(0, 120);
    const candidates = [
      ...(Array.isArray(rawPost?.links) ? rawPost.links.flatMap(link => [link?.url, link?.text]) : []),
      rawPost?.text || '',
      ...(Array.isArray(rawPost?.attachments) ? rawPost.attachments : [])
    ];
    for (const candidate of candidates) {
      for (const rawUrl of simpCityUrlCandidates(candidate)) {
        const classified = classifySimpCityMediaUrl(rawUrl);
        if (!classified || seen.has(classified.url)) continue;
        seen.add(classified.url);
        results.push({ ...classified, postId });
      }
    }
  }
  return results;
}

export function distinctSimpCityProfileCreators(rawCreators) {
  const creators = [];
  const byIdentity = new Map();
  for (const rawCreator of Array.isArray(rawCreators) ? rawCreators : []) {
    if (!rawCreator) continue;
    const threadUrl = normalizeSimpCityThreadUrl(rawCreator.threadUrl || '');
    const primaryName = String(rawCreator.primaryName || '').trim();
    const identity = threadUrl || simpCityCreatorKey(primaryName);
    if (!identity) continue;
    const existing = byIdentity.get(identity);
    if (!existing) {
      const creator = {
        ...rawCreator,
        primaryName,
        threadUrl,
        aliases: [...new Set((rawCreator.aliases || []).map(String).filter(Boolean))],
        usernames: [...new Set((rawCreator.usernames || []).map(String).filter(Boolean))]
      };
      byIdentity.set(identity, creator);
      creators.push(creator);
      continue;
    }
    existing.aliases = [...new Set([
      ...(existing.aliases || []), primaryName, ...(rawCreator.aliases || [])
    ].map(String).filter(Boolean))];
    existing.usernames = [...new Set([
      ...(existing.usernames || []), ...(rawCreator.usernames || [])
    ].map(String).filter(Boolean))];
  }
  return creators;
}

function simpCityCreatorEvidenceLinkIndex(post, creator) {
  const links = Array.isArray(post?.links) ? post.links : [];
  const evidence = String(creator?.evidence || '');
  const threadUrl = normalizeSimpCityThreadUrl(creator?.threadUrl || '');
  return links.findIndex(link => {
    const rawUrl = String(link?.url || '');
    if (evidence && rawUrl === evidence) return true;
    return Boolean(threadUrl && normalizeSimpCityThreadUrl(rawUrl) === threadUrl);
  });
}

function simpCityMediaLinkIndex(post, mediaLink) {
  const links = Array.isArray(post?.links) ? post.links : [];
  return links.findIndex(link => classifySimpCityMediaUrl(link?.url)?.url === mediaLink?.url);
}

export function extractSimpCityMediaLinksForCreator(rawPosts, rawCreators, targetCreator) {
  const posts = Array.isArray(rawPosts) ? rawPosts : [];
  const creators = distinctSimpCityProfileCreators(rawCreators);
  const targetIdentity = normalizeSimpCityThreadUrl(targetCreator?.threadUrl || '') ||
    simpCityCreatorKey(targetCreator?.primaryName);
  return extractSimpCityMediaLinks(posts).filter(mediaLink => {
    const post = posts.find(item => String(item?.postId || '') === String(mediaLink.postId || ''));
    const postCreators = creators.filter(creator => String(creator?.postId || '') === String(mediaLink.postId || ''));
    if (postCreators.length <= 1) return postCreators.length === 0 ||
      (normalizeSimpCityThreadUrl(postCreators[0]?.threadUrl || '') || simpCityCreatorKey(postCreators[0]?.primaryName)) === targetIdentity;

    const mediaIndex = simpCityMediaLinkIndex(post, mediaLink);
    const mediaAnchor = mediaIndex >= 0 ? post?.links?.[mediaIndex] : null;
    const mediaLabel = simpCityCreatorKey(mediaAnchor?.text || '');
    let best = null;
    let bestScore = -Infinity;
    for (const [order, creator] of postCreators.entries()) {
      const creatorIdentity = normalizeSimpCityThreadUrl(creator?.threadUrl || '') || simpCityCreatorKey(creator?.primaryName);
      const identityValues = [
        creator?.primaryName, ...(creator?.aliases || []), ...(creator?.usernames || [])
      ].map(simpCityCreatorKey).filter(value => value.length >= 3);
      const evidenceIndex = simpCityCreatorEvidenceLinkIndex(post, creator);
      let score = creator?.threadUrl ? 20 : 0;
      if (mediaLabel && identityValues.some(value => mediaLabel.includes(value) || value.includes(mediaLabel))) score += 1000;
      if (mediaIndex >= 0 && evidenceIndex >= 0) score += 200 - Math.min(199, Math.abs(mediaIndex - evidenceIndex));
      score -= order / 100;
      if (score > bestScore) {
        bestScore = score;
        best = creatorIdentity;
      }
    }
    return best === targetIdentity;
  });
}

export function simpCityCreatorKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function cleanCreatorName(value) {
  return decodeSimpCityHtmlText(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/^[\s"'`~*#@|:;,.()[\]{}<>+=!?/\\-]+/, '')
    .replace(/[\s"'`~*#@|:;,.()[\]{}<>+=!?/\\-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlausibleCreatorName(value) {
  const name = cleanCreatorName(value);
  const lower = name.toLowerCase();
  const words = name.split(/\s+/).filter(Boolean);
  const key = simpCityCreatorKey(name);
  if (!key || key.length < 4 || name.length > 45 || words.length > 4) return false;
  if (!/[a-z]/i.test(name) || /^\d+$/.test(key)) return false;
  if (CREATOR_STOP_WORDS.has(lower)) return false;
  if (/\b(?:thread|request|discussion|collection|compilation|megathread)\b/i.test(name)) return false;
  if (/\b(?:australian girls?|perfect bodies|professional athletes?|redheads?|gingers?)\b/i.test(name)) return false;
  if (/^(?:page|post|part|update)\s*\d*$/i.test(name)) return false;
  return true;
}

export function isDistinctSimpCityCreatorName(value) {
  const name = cleanCreatorName(value);
  if (!isPlausibleCreatorName(name)) return false;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.length <= 4;
  const lower = name.toLowerCase().replace(/^@/, '');
  const key = simpCityCreatorKey(lower);
  if (COMMON_SINGLE_FIRST_NAMES.has(lower)) return false;
  return key.length >= 7 || /[0-9_.]/.test(lower);
}

function creatorAliasesFromTitle(rawTitle) {
  const cleaned = cleanCreatorName(rawTitle)
    .replace(/\s*(?:\||-)\s*SimpCity.*$/i, '')
    .replace(/^\s*(?:request|discussion)\s*[:|-]\s*/i, '')
    .trim();
  if (!cleaned) return [];
  const aliases = cleaned
    .split(/\s+(?:a\.?k\.?a\.?|aka|also\s+known\s+as)\s+|\s*[|/]\s*/i)
    .map(cleanCreatorName)
    .filter(Boolean);
  return aliases.length > 1 ? aliases : [cleaned];
}

function threadTitleFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://simpcity.cr/');
    const slug = url.pathname.match(/^\/threads\/(.+?)(?:\.\d+)?\/?(?:page-\d+)?$/i)?.[1] || '';
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

export function simpCityCreatorAliases(rawValue) {
  const source = String(rawValue || '');
  const title = /simpcity\.cr\/threads\//i.test(source)
    ? threadTitleFromUrl(source)
    : source;
  return creatorAliasesFromTitle(title).filter(isDistinctSimpCityCreatorName);
}

function anchorParts(anchorHtml) {
  const href = anchorHtml.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
  const title = anchorHtml.match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1] || '';
  const text = cleanCreatorName(anchorHtml.replace(/^<a\b[^>]*>/i, '').replace(/<\/a>\s*$/i, ''));
  return { href: decodeSimpCityHtmlText(href), title: decodeSimpCityHtmlText(title), text };
}

function extractMessageBodies(html) {
  const source = String(html || '');
  const bodies = [];
  const starts = [...source.matchAll(/<div\b[^>]*class=["'][^"']*\bbbWrapper\b[^"']*["'][^>]*>/gi)];
  for (const [index, match] of starts.entries()) {
    const start = Number(match.index || 0) + match[0].length;
    const nextStart = starts[index + 1]?.index ?? source.length;
    const articleEnd = source.indexOf('</article>', start);
    const end = articleEnd >= 0 && articleEnd < nextStart ? articleEnd : nextStart;
    bodies.push(source.slice(start, end));
  }
  return bodies;
}

export function extractSimpCityCreatorCandidates(html, currentThreadUrl = '') {
  const source = String(html || '');
  const candidates = new Map();
  const excludedMemberKeys = new Set();
  const current = normalizeSimpCityThreadUrl(currentThreadUrl);

  const add = (rawName, origin, confidence = 0.7) => {
    const name = cleanCreatorName(rawName);
    const key = simpCityCreatorKey(name);
    if (!isDistinctSimpCityCreatorName(name) || excludedMemberKeys.has(key)) return;
    const prior = candidates.get(key);
    if (!prior || confidence > prior.confidence) {
      candidates.set(key, { name, query: name, key, origin, confidence });
    }
  };

  for (const match of source.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const anchor = anchorParts(match[0]);
    let resolved = '';
    try { resolved = new URL(anchor.href, current || 'https://simpcity.cr/').toString(); }
    catch (_) {}
    if (/\/members\//i.test(resolved)) {
      const key = simpCityCreatorKey(anchor.text || anchor.title);
      if (key) excludedMemberKeys.add(key);
      continue;
    }
  }
  for (const match of source.matchAll(/\bdata-author=["']([^"']+)["']/gi)) {
    const key = simpCityCreatorKey(decodeSimpCityHtmlText(match[1]));
    if (key) excludedMemberKeys.add(key);
  }

  // Creator-thread links are the strongest evidence. Their visible title is
  // preferred, with the XenForo thread slug as a deterministic fallback.
  for (const match of source.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const anchor = anchorParts(match[0]);
    let resolved;
    try { resolved = new URL(anchor.href, current || 'https://simpcity.cr/'); }
    catch (_) { continue; }
    if (!SIMPCITY_HOSTS.has(resolved.hostname.toLowerCase()) || !/^\/threads\//i.test(resolved.pathname)) continue;
    const normalized = normalizeSimpCityThreadUrl(resolved.toString());
    if (!normalized || normalized === current) continue;
    const title = anchor.text || anchor.title || threadTitleFromUrl(normalized);
    simpCityCreatorAliases(title).forEach(alias => add(alias, 'linked-thread', 1));
  }

  for (const bodySource of extractMessageBodies(source)) {
    const withoutQuotes = bodySource
      .replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi, ' ')
      .replace(/<div\b[^>]*class=["'][^"']*\bbbCodeBlock\b[^"']*["'][\s\S]*?<\/div>/gi, ' ');

    for (const match of withoutQuotes.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
      const anchor = anchorParts(match[0]);
      let resolved;
      try { resolved = new URL(anchor.href, current || 'https://simpcity.cr/'); }
      catch (_) { continue; }
      if (!SOCIAL_HOSTS.has(resolved.hostname.toLowerCase())) continue;
      const pathParts = resolved.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const segment = String(pathParts[0] || '').replace(/^@/, '');
      if (/^(?:home|explore|search|share|p|reel|video)$/i.test(segment)) continue;
      add(segment || anchor.text, 'social-link', 0.95);
    }

    for (const match of withoutQuotes.matchAll(/(?:^|[^\w])@([a-z][a-z0-9_.]{3,29})\b/gi)) {
      add(match[1], 'handle', 0.92);
    }
    for (const match of withoutQuotes.matchAll(
      /\b(?:name|model|creator|performer|aka|a\.k\.a\.)\s*[:=-]\s*([a-z0-9_.'-]+(?:\s+[a-z0-9_.'-]+){0,3})/gi
    )) {
      add(match[1], 'label', 0.9);
    }
    for (const match of withoutQuotes.matchAll(/<(?:b|strong|h[1-6])\b[^>]*>([\s\S]*?)<\/(?:b|strong|h[1-6])>/gi)) {
      creatorAliasesFromTitle(match[1]).forEach(alias => add(alias, 'emphasized-text', 0.82));
    }

    const lineSource = withoutQuotes
      .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, ' ');
    for (const rawLine of lineSource.split(/\r?\n/)) {
      const line = cleanCreatorName(rawLine);
      if (!line || line.length > 45 || /https?:\/\//i.test(line)) continue;
      const words = line.split(/\s+/).filter(Boolean);
      if (words.length === 1 && /^[a-z][a-z0-9_.]{3,29}$/i.test(line)) {
        add(line, 'standalone-handle', 0.74);
        continue;
      }
      if (
        words.length >= 2 &&
        words.length <= 3 &&
        words.every(word => /^[A-Z][A-Za-z0-9_.'-]{2,}$/.test(word))
      ) add(line, 'standalone-name', 0.76);
    }
  }

  for (const key of excludedMemberKeys) candidates.delete(key);
  return [...candidates.values()].sort((left, right) =>
    right.confidence - left.confidence || left.name.localeCompare(right.name)
  );
}

export function buildBAlbumsCreatorSearchUrl(rawName) {
  const name = cleanCreatorName(rawName);
  const url = new URL('https://balbums.st/');
  url.searchParams.set('search', name);
  url.searchParams.set('mode', 'fuzzy');
  url.searchParams.set('per', '20');
  url.searchParams.set('sort', 'latest');
  return url.toString();
}

export function bunkrAlbumsMatchingCreator(albums, candidate) {
  const query = cleanCreatorName(candidate?.query || candidate?.name || candidate || '');
  const queryKey = simpCityCreatorKey(query);
  const queryTokens = query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 2);
  if (queryKey.length < 4 || !queryTokens.length) return [];
  return (Array.isArray(albums) ? albums : []).filter(album => {
    const title = cleanCreatorName(album?.title || '');
    const titleKey = simpCityCreatorKey(title);
    if (!titleKey) return false;
    if (titleKey.includes(queryKey)) return true;
    return queryTokens.length >= 2 && queryTokens.every(token => titleKey.includes(token));
  });
}
