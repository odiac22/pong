const VIDEO_FILE_PATTERN = /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i;

function canonicalPostKey(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    if ((parts[0] === 'p' || parts[0] === 'post') && parts.length >= 4) {
      return `${parts[3].toLowerCase()}:${parts[2].toLowerCase()}:${parts[1].toLowerCase()}`;
    }
    return '';
  } catch (_) {
    return '';
  }
}

export function local2PublishedTimestampKey(rawValue) {
  const match = String(rawValue || '').match(/\b(\d{4}-\d\d-\d\d)[T\s](\d\d:\d\d:\d\d)\b/);
  return match ? `${match[1]}T${match[2]}` : '';
}

export function local2ApiPostVideoCount(post = {}) {
  return [post?.file, ...(Array.isArray(post?.attachments) ? post.attachments : [])]
    .filter(Boolean)
    .filter(file => VIDEO_FILE_PATTERN.test(String(file?.name || file?.path || '')))
    .length;
}

export function local2ClonePostMetadata(html, pageUrl) {
  const rows = [];
  const cards = String(html || '').split(/<div[^>]+class=["']post["'][^>]*>/i).slice(1);
  for (const card of cards) {
    const href = (
      card.match(/class=["']view-post["'][^>]+href=["']([^"']+)/i) ||
      card.match(/href=["']([^"']+)["'][^>]+class=["']view-post["']/i) ||
      []
    )[1];
    const published = (
      card.match(/class=["']post-date["'][^>]*>([^<]+)/i) ||
      []
    )[1];
    if (!href || !published) continue;
    try {
      const postUrl = new URL(
        String(href).replace(/&amp;/gi, '&').replace(/&#38;/gi, '&'),
        pageUrl
      ).toString();
      const postKey = canonicalPostKey(postUrl);
      const publishedKey = local2PublishedTimestampKey(published);
      if (postKey && publishedKey) rows.push({ postKey, postUrl, publishedKey });
    } catch (_) {}
  }
  return rows;
}

function postsNeededForKnownTarget(postKeys, hintsByPost, target) {
  let videos = 0;
  for (let index = 0; index < postKeys.length; index++) {
    const hint = hintsByPost.get(postKeys[index]);
    if (hint) videos += Math.max(0, Number(hint.videoCount || 0));
    if (videos >= target) return index + 1;
  }
  return null;
}

/**
 * Reorder clone post URLs with exact, unique timestamp matches from the
 * read-only bulk index. The returned list always contains the identical clone
 * URLs in the identical cardinality; only their scheduling order may change.
 */
export function orderLocal2ClonePostsWithSourceHints({
  postUrls = [],
  listingPages = [],
  apiPosts = [],
  targetVideos = 15
} = {}) {
  const original = Array.isArray(postUrls) ? [...postUrls] : [];
  const cloneRows = [];
  for (const page of Array.isArray(listingPages) ? listingPages : []) {
    cloneRows.push(...local2ClonePostMetadata(page?.html, page?.pageUrl || page?.url || ''));
  }

  const cloneTimestampCounts = new Map();
  for (const row of cloneRows) {
    cloneTimestampCounts.set(row.publishedKey, (cloneTimestampCounts.get(row.publishedKey) || 0) + 1);
  }
  const apiByTimestamp = new Map();
  for (const post of Array.isArray(apiPosts) ? apiPosts : []) {
    const publishedKey = local2PublishedTimestampKey(post?.published);
    if (!publishedKey) continue;
    const values = apiByTimestamp.get(publishedKey) || [];
    values.push(post);
    apiByTimestamp.set(publishedKey, values);
  }

  const hintsByPost = new Map();
  for (const row of cloneRows) {
    const apiMatches = apiByTimestamp.get(row.publishedKey) || [];
    if (cloneTimestampCounts.get(row.publishedKey) !== 1 || apiMatches.length !== 1) continue;
    hintsByPost.set(row.postKey, {
      videoCount: local2ApiPostVideoCount(apiMatches[0]),
      publishedKey: row.publishedKey
    });
  }

  const annotated = original.map((postUrl, originalIndex) => {
    const postKey = canonicalPostKey(postUrl);
    const hint = postKey ? hintsByPost.get(postKey) : null;
    return {
      postUrl,
      postKey,
      originalIndex,
      category: !hint ? 1 : hint.videoCount > 0 ? 0 : 2,
      videoCount: Math.max(0, Number(hint?.videoCount || 0))
    };
  });
  const reordered = [...annotated].sort((left, right) =>
    left.category - right.category ||
    (left.category === 0 ? right.videoCount - left.videoCount : 0) ||
    left.originalIndex - right.originalIndex
  );
  const orderedPostUrls = reordered.map(item => item.postUrl);
  const originalKeys = annotated.map(item => item.postKey);
  const reorderedKeys = reordered.map(item => item.postKey);
  const originalPostsToTarget = postsNeededForKnownTarget(
    originalKeys,
    hintsByPost,
    Math.max(1, Number(targetVideos || 15))
  );
  const reorderedPostsToTarget = postsNeededForKnownTarget(
    reorderedKeys,
    hintsByPost,
    Math.max(1, Number(targetVideos || 15))
  );
  const changedPositions = reordered.reduce(
    (count, item, index) => count + Number(item.originalIndex !== index),
    0
  );

  return {
    postUrls: orderedPostUrls,
    diagnostics: {
      inputPosts: original.length,
      listingRows: cloneRows.length,
      apiRows: Array.isArray(apiPosts) ? apiPosts.length : 0,
      exactMatches: annotated.filter(item => item.category !== 1).length,
      unmatchedPosts: annotated.filter(item => item.category === 1).length,
      hintedVideoPosts: annotated.filter(item => item.category === 0).length,
      hintedNonVideoPosts: annotated.filter(item => item.category === 2).length,
      changedPositions,
      applied: changedPositions > 0,
      projectedOriginalPostsToTarget: originalPostsToTarget,
      projectedReorderedPostsToTarget: reorderedPostsToTarget,
      projectedRequestSavings: (
        Number.isFinite(originalPostsToTarget) && Number.isFinite(reorderedPostsToTarget)
      ) ? Math.max(0, originalPostsToTarget - reorderedPostsToTarget) : null
    }
  };
}

export class Local2SourceHintClient {
  constructor({
    fetchPosts,
    concurrency = 2,
    ttlMs = 90_000,
    failureThreshold = 3,
    circuitMs = 30_000,
    maximumCacheEntries = 256,
    now = () => Date.now()
  } = {}) {
    if (typeof fetchPosts !== 'function') throw new TypeError('fetchPosts is required');
    this.fetchPosts = fetchPosts;
    this.concurrency = Math.max(1, Math.min(2, Number(concurrency || 2)));
    this.ttlMs = Math.max(1, Number(ttlMs || 90_000));
    this.failureThreshold = Math.max(1, Number(failureThreshold || 3));
    this.circuitMs = Math.max(1, Number(circuitMs || 30_000));
    this.maximumCacheEntries = Math.max(1, Number(maximumCacheEntries || 256));
    this.now = now;
    this.active = 0;
    this.waiters = [];
    this.cache = new Map();
    this.inflight = new Map();
    this.consecutiveFailures = 0;
    this.circuitUntil = 0;
    this.stats = {
      requests: 0,
      successes: 0,
      failures: 0,
      cacheHits: 0,
      inflightHits: 0,
      circuitSkips: 0,
      aborted: 0,
      rows: 0
    };
  }

  acquire(signal = null) {
    if (signal?.aborted) {
      this.stats.aborted++;
      return Promise.resolve(null);
    }
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise(resolve => {
      const waiter = { signal, enter: null, abort: null };
      waiter.enter = () => {
        signal?.removeEventListener('abort', waiter.abort);
        this.active++;
        resolve(() => this.release());
      };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.stats.aborted++;
        resolve(null);
      };
      if (signal?.aborted) return waiter.abort();
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (waiter.signal?.aborted) continue;
      waiter.enter();
      break;
    }
  }

  remember(key, posts) {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), posts });
    while (this.cache.size > this.maximumCacheEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  async postsFor(key, { signal = null } = {}) {
    const cacheKey = String(key || '').trim().toLowerCase();
    if (!cacheKey || signal?.aborted) return null;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < this.ttlMs) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.stats.cacheHits++;
      return cached.posts;
    }
    if (cached) this.cache.delete(cacheKey);
    if (this.now() < this.circuitUntil) {
      this.stats.circuitSkips++;
      return null;
    }
    if (this.inflight.has(cacheKey)) {
      this.stats.inflightHits++;
      return this.inflight.get(cacheKey);
    }

    const promise = (async () => {
      const release = await this.acquire(signal);
      if (!release) return null;
      try {
        if (signal?.aborted) {
          this.stats.aborted++;
          return null;
        }
        this.stats.requests++;
        const posts = await this.fetchPosts(cacheKey, { signal });
        if (!Array.isArray(posts)) throw new Error('source hint response was not an array');
        this.stats.successes++;
        this.stats.rows += posts.length;
        this.consecutiveFailures = 0;
        this.circuitUntil = 0;
        this.remember(cacheKey, posts);
        return posts;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
          this.stats.aborted++;
          return null;
        }
        this.stats.failures++;
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failureThreshold) {
          this.circuitUntil = this.now() + this.circuitMs;
        }
        return null;
      } finally {
        release();
      }
    })();
    this.inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(cacheKey) === promise) this.inflight.delete(cacheKey);
    }
  }

  snapshot() {
    return {
      ...this.stats,
      active: this.active,
      queued: this.waiters.length,
      concurrency: this.concurrency,
      cacheEntries: this.cache.size,
      ttlMs: this.ttlMs,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.now() < this.circuitUntil,
      circuitRemainingMs: Math.max(0, this.circuitUntil - this.now())
    };
  }
}
