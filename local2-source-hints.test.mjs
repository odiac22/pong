import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Local2SourceHintClient,
  local2ApiPostVideoCount,
  local2ClonePostMetadata,
  local2PublishedTimestampKey,
  orderLocal2ClonePostsWithSourceHints
} from './local2-source-hints.mjs';

function card(postId, published) {
  return `<div class="post">
    <span class="post-date">${published} &#43;0000 UTC</span>
    <a class="view-post" href="/p/${postId}/42/onlyfans">View Post</a>
  </div>`;
}

function apiPost(published, files = []) {
  const [file = null, ...attachments] = files.map(name => ({ name, path: `/aa/bb/${name}` }));
  return { published, file, attachments };
}

test('timestamp and video metadata parsers accept clone and API forms', () => {
  assert.equal(local2PublishedTimestampKey('2026-09-10 01:02:03 +0000 UTC'), '2026-09-10T01:02:03');
  assert.equal(local2PublishedTimestampKey('2026-09-10T01:02:03.123Z'), '2026-09-10T01:02:03');
  assert.equal(local2ApiPostVideoCount(apiPost('2026-09-10T01:02:03', [
    'one.jpg', 'two.MP4', 'three.webm?token=x'
  ])), 2);
  assert.deepEqual(
    local2ClonePostMetadata(
      card(1, '2026-09-10 01:02:03'),
      'https://coomerfans.com/u/onlyfans/42/example'
    ).map(row => ({ postKey: row.postKey, publishedKey: row.publishedKey })),
    [{ postKey: 'onlyfans:42:1', publishedKey: '2026-09-10T01:02:03' }]
  );
});

test('only exact unique timestamps reorder video, unmatched, then nonvideo clone posts', () => {
  const pageUrl = 'https://coomerfans.com/u/onlyfans/42/example';
  const postUrls = [1, 2, 3, 4].map(id => `https://coomerfans.com/p/${id}/42/onlyfans`);
  const result = orderLocal2ClonePostsWithSourceHints({
    postUrls,
    listingPages: [{
      pageUrl,
      html: [
        card(1, '2026-09-10 01:00:00'),
        card(2, '2026-09-10 02:00:00'),
        card(3, '2026-09-10 03:00:00'),
        card(4, '2026-09-10 04:00:00')
      ].join('')
    }],
    apiPosts: [
      apiPost('2026-09-10T01:00:00', ['one.jpg']),
      apiPost('2026-09-10T02:00:00', ['two.mp4']),
      // Duplicate API timestamps are deliberately ambiguous and therefore
      // leave clone post 3 in the unmatched middle group.
      apiPost('2026-09-10T03:00:00', ['three.mp4']),
      apiPost('2026-09-10T03:00:00', ['duplicate.mp4']),
      apiPost('2026-09-10T04:00:00', ['four.mp4', 'four-b.mp4'])
    ],
    targetVideos: 3
  });
  assert.deepEqual(result.postUrls, [postUrls[3], postUrls[1], postUrls[2], postUrls[0]]);
  assert.equal(result.diagnostics.exactMatches, 3);
  assert.equal(result.diagnostics.hintedVideoPosts, 2);
  assert.equal(result.diagnostics.unmatchedPosts, 1);
  assert.equal(result.diagnostics.hintedNonVideoPosts, 1);
  assert.equal(result.diagnostics.projectedOriginalPostsToTarget, 4);
  assert.equal(result.diagnostics.projectedReorderedPostsToTarget, 2);
  assert.equal(result.diagnostics.projectedRequestSavings, 2);
});

test('source hints preserve every authoritative clone URL and never remove a candidate', () => {
  const postUrls = [
    'https://coomerfans.com/p/1/42/onlyfans',
    'https://coomerfans.com/p/2/42/onlyfans',
    'https://coomerfans.com/p/3/42/onlyfans'
  ];
  const result = orderLocal2ClonePostsWithSourceHints({
    postUrls,
    listingPages: [{
      pageUrl: 'https://coomerfans.com/u/onlyfans/42/example',
      html: [
        card(1, '2026-09-10 01:00:00'),
        card(2, '2026-09-10 02:00:00'),
        card(3, '2026-09-10 03:00:00')
      ].join('')
    }],
    apiPosts: [apiPost('2026-09-10T01:00:00', ['image.jpg'])]
  });
  assert.equal(result.postUrls.length, postUrls.length);
  assert.deepEqual(new Set(result.postUrls), new Set(postUrls));
  assert.deepEqual(result.postUrls, [postUrls[1], postUrls[2], postUrls[0]]);
});

test('client caps concurrency, deduplicates inflight work, and caches briefly', async () => {
  let active = 0;
  let maximumActive = 0;
  let fetches = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new Local2SourceHintClient({
    concurrency: 2,
    ttlMs: 1000,
    fetchPosts: async key => {
      fetches++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active--;
      return [{ published: key }];
    }
  });
  const first = client.postsFor('a');
  const duplicate = client.postsFor('a');
  const second = client.postsFor('b');
  const third = client.postsFor('c');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.snapshot().active, 2);
  assert.equal(client.snapshot().queued, 1);
  release();
  await Promise.all([first, duplicate, second, third]);
  assert.equal(maximumActive, 2);
  assert.equal(fetches, 3);
  assert.equal(client.snapshot().inflightHits, 1);
  await client.postsFor('a');
  assert.equal(fetches, 3);
  assert.equal(client.snapshot().cacheHits, 1);
});

test('client opens its circuit after repeated failures and later recovers', async () => {
  let now = 1000;
  let attempts = 0;
  const client = new Local2SourceHintClient({
    concurrency: 1,
    failureThreshold: 3,
    circuitMs: 500,
    now: () => now,
    fetchPosts: async () => {
      attempts++;
      if (attempts <= 3) throw new Error('offline');
      return [];
    }
  });
  await client.postsFor('a');
  await client.postsFor('b');
  await client.postsFor('c');
  assert.equal(client.snapshot().circuitOpen, true);
  assert.equal(await client.postsFor('d'), null);
  assert.equal(attempts, 3);
  assert.equal(client.snapshot().circuitSkips, 1);
  now += 501;
  assert.deepEqual(await client.postsFor('d'), []);
  assert.equal(client.snapshot().circuitOpen, false);
  assert.equal(attempts, 4);
});

test('abort after slot acquisition releases the source-hint lane', async () => {
  const controller = new AbortController();
  let fetches = 0;
  const client = new Local2SourceHintClient({
    concurrency: 1,
    fetchPosts: async () => {
      fetches++;
      return [];
    }
  });
  const originalAcquire = client.acquire.bind(client);
  client.acquire = async signal => {
    const release = await originalAcquire(signal);
    controller.abort();
    return release;
  };
  assert.equal(await client.postsFor('aborted', { signal: controller.signal }), null);
  assert.equal(fetches, 0);
  assert.equal(client.snapshot().active, 0);
  assert.equal(client.snapshot().queued, 0);
});
