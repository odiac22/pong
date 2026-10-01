import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractGenericEmbedUrlsFromHtml,
  extractGenericMediaPageMetadata,
  extractGenericWatchPageUrlsFromHtml,
  extractGenericVideoUrlsFromHtml
} from './media-page-resolver.mjs';

test('extracts a player-config MP4 from a generic webpage', () => {
  const html = `<!doctype html><title>Long example</title><script>window.player={file:"https:\\/\\/cdn.example/video.mp4"}</script>`;
  assert.deepEqual(
    extractGenericVideoUrlsFromHtml(html, 'https://example.test/watch/one'),
    ['https://cdn.example/video.mp4']
  );
});

test('prefers metadata and de-duplicates repeated video URLs', () => {
  const html = `<meta property="og:title" content="Example title"><meta property="og:video" content="/movie.mp4"><video src="/movie.mp4"></video>`;
  assert.deepEqual(extractGenericMediaPageMetadata(html, 'https://example.test/post'), {
    pageUrl: 'https://example.test/post',
    title: 'Example title',
    videoUrls: ['https://example.test/movie.mp4']
  });
});

test('ignores non-video links', () => {
  assert.deepEqual(extractGenericVideoUrlsFromHtml('<a href="/next">next</a>', 'https://example.test/post'), []);
});

test('HQPorner metadata rejects playable preroll ads and keeps the full duration', () => {
  const html = `<meta name="description" content="Video duration is 43min 55sec.">
    <script>const preroll="https://ht-cdn2.adtng.com/a7/creative/preroll_video.mp4";</script>
    <iframe src="https://mydaddy.cc/video/full-movie/"></iframe>`;
  assert.deepEqual(extractGenericMediaPageMetadata(html, 'https://m.hqporner.com/hdporn/117806-example.html'), {
    pageUrl: 'https://m.hqporner.com/hdporn/117806-example.html',
    title: '',
    videoUrls: [],
    durationSeconds: 2635
  });
  assert.deepEqual(extractGenericEmbedUrlsFromHtml(html, 'https://m.hqporner.com/hdporn/117806-example.html'), [
    'https://mydaddy.cc/video/full-movie/'
  ]);
});

test('extracts nested player embeds separately from direct media', () => {
  const html = `<meta itemprop="embedURL" content="https://player.example/embed/one"><iframe src="/embed/two"></iframe>`;
  assert.deepEqual(extractGenericEmbedUrlsFromHtml(html, 'https://example.test/post'), [
    'https://player.example/embed/one',
    'https://example.test/embed/two'
  ]);
});

test('extracts JSON-LD and lazy player media including HLS', () => {
  const html = `<script type="application/ld+json">{"contentUrl":"https:\\/\\/cdn.example\\/full.mp4"}</script><video data-src="/master.m3u8"></video>`;
  assert.deepEqual(extractGenericVideoUrlsFromHtml(html, 'https://example.test/post'), [
    'https://example.test/master.m3u8',
    'https://cdn.example/full.mp4'
  ]);
});

test('returns every distinct full media file declared by one page', () => {
  const html = `<video src="/one.mp4"></video>
    <source src="/two.mov" type="video/quicktime">
    <script>window.items=[{"contentUrl":"https:\\/\\/cdn.example\\/three.webm"}]</script>
    <a href="/one.mp4">duplicate</a>`;
  assert.deepEqual(extractGenericVideoUrlsFromHtml(html, 'https://example.test/post'), [
    'https://example.test/one.mp4',
    'https://example.test/two.mov',
    'https://cdn.example/three.webm'
  ]);
});

test('preserves KVS access tokens and selects the highest-quality signed source', () => {
  const html = `<script>var flashvars = {
    video_url: 'https://media.example/get_file/44/movie.mp4/?v-acctoken=low-token',
    video_alt_url: 'https://media.example/get_file/44/movie_720p.mp4/?v-acctoken=hd-token',
    preview_url: 'https://media.example/preview.mp4'
  };</script>`;
  assert.deepEqual(extractGenericVideoUrlsFromHtml(html, 'https://example.test/watch'), [
    'https://media.example/get_file/44/movie_720p.mp4/?v-acctoken=hd-token'
  ]);
});

test('extracts click-to-load player mirrors while ignoring about:blank', () => {
  const html = `<iframe src="about:blank"></iframe>
    <button onclick="playEmbed('https://streamtape.com/e/example')">one</button>
    <button onclick="loadEmbed(\"https://voe.sx/e/example\")">two</button>`;
  assert.deepEqual(extractGenericEmbedUrlsFromHtml(html, 'https://example.test/post'), [
    'https://streamtape.com/e/example',
    'https://voe.sx/e/example'
  ]);
});

test('extracts escaped snake-case embed mirrors and the declared full duration', () => {
  const html = String.raw`{"video_duration":2281,"video_urls":{"iframe":[
    {"embed_url":"https:\/\/streamtape.com\/e\/first"},
    {"embed_url":"https:\/\/streamtape.com\/e\/second"}
  ]},"video_preview_url":"https:\/\/img.example\/preview_video_hash.mp4"}`;
  assert.deepEqual(extractGenericEmbedUrlsFromHtml(html, 'https://example.test/post'), [
    'https://streamtape.com/e/first',
    'https://streamtape.com/e/second'
  ]);
  assert.deepEqual(extractGenericMediaPageMetadata(html, 'https://example.test/post'), {
    pageUrl: 'https://example.test/post',
    title: '',
    videoUrls: [],
    durationSeconds: 2281
  });
});

test('reconstructs a split Streamtape signed video endpoint without executing scripts', () => {
  const html = `<script>document.getElementById('robotlink').innerHTML = '//streamtape.com/get_video?id=ex' +
    ('xcdample&expires=123&token=good').substring(2).substring(1);</script>`;
  assert.deepEqual(extractGenericVideoUrlsFromHtml(html, 'https://streamtape.com/e/example'), [
    'https://streamtape.com/get_video?id=example&expires=123&token=good'
  ]);
});

test('orders labelled Playerjs renditions from highest to lowest quality', () => {
  const html = `<script>new Playerjs({file: "[240p]https://cdn.example/movie_2.mp4,[360p]https://cdn.example/movie_3.mp4,[HD]https://cdn.example/movie_7.mp4"});</script>`;
  assert.deepEqual(extractGenericVideoUrlsFromHtml(html, 'https://example.test/watch'), [
    'https://cdn.example/movie_7.mp4',
    'https://cdn.example/movie_3.mp4',
    'https://cdn.example/movie_2.mp4'
  ]);
});

test('extracts genuine same-site watch links from a listing and ignores ads and media thumbnails', () => {
  const html = `<a href="/view_video.php?viewkey=one&utm_source=grid">one</a>
    <a href="https://example.test/view_video.php?viewkey=two">two</a>
    <a href="https://ads.invalid/watch/sponsor">ad</a>
    <a href="/video/search?search=more">next</a>
    <a href="/preview.gif">preview</a>`;
  assert.deepEqual(extractGenericWatchPageUrlsFromHtml(html, 'https://example.test/video/search?q=x'), [
    'https://example.test/view_video.php?viewkey=one',
    'https://example.test/view_video.php?viewkey=two'
  ]);
});
