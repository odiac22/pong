import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLeakedZoneUrl,
  leakedZoneNextPageUrl,
  leakedZoneCreatorUrl,
  extractLeakedZoneCreatorUrls,
  extractLeakedZoneVideoDetailUrls,
  extractLeakedZonePlaylistUrl
} from './leakedzone-import.mjs';

test('normalizes only public LeakedZone URLs', () => {
  assert.equal(normalizeLeakedZoneUrl('https://www.leakedzone.com/amy?page=2#x'), 'https://leakedzone.com/amy?page=2');
  assert.equal(normalizeLeakedZoneUrl('http://leakedzone.com/amy'), '');
  assert.equal(normalizeLeakedZoneUrl('https://example.com/amy'), '');
});

test('extracts creator cards and next-page arrows without navigation links', () => {
  const html = `
    <a href="/videos">Videos</a>
    <a href="/agatha.s"><img alt="Agatha"></a>
    <a href="https://leakedzone.com/keniamusicr">Kenia</a>
    <a rel="next" href="/creators?Body_Type=Athletic&amp;page=2"></a>`;
  assert.deepEqual(extractLeakedZoneCreatorUrls(html, 'https://leakedzone.com/creators?Body_Type=Athletic'), [
    'https://leakedzone.com/agatha.s',
    'https://leakedzone.com/keniamusicr'
  ]);
  assert.equal(
    leakedZoneNextPageUrl(html, 'https://leakedzone.com/creators?Body_Type=Athletic'),
    'https://leakedzone.com/creators?Body_Type=Athletic&page=2'
  );
});

test('extracts video and short details for the exact creator', () => {
  const html = `
    <a href="/agatha.s/video/18525112">video</a>
    <a href="/agatha.s/short/18525113">short</a>
    <a href="/other/video/9">other</a>`;
  assert.deepEqual(extractLeakedZoneVideoDetailUrls(html, 'https://leakedzone.com/agatha.s'), [
    'https://leakedzone.com/agatha.s/video/18525112',
    'https://leakedzone.com/agatha.s/short/18525113'
  ]);
  assert.equal(leakedZoneCreatorUrl('https://leakedzone.com/agatha.s/video/18525112'), 'https://leakedzone.com/agatha.s');
});

test('decodes the signed HLS URL without binary padding', () => {
  const playlist = 'https://leakedzone.com/m3u8/12.m3u8?time=1&sig=abc&sig2=AbCdEfGhIjKlMnOp';
  const encoded = [...Buffer.concat([Buffer.from(playlist), Buffer.from([0xff, 0x0d, 0x1b])]).toString('base64')].reverse().join('');
  assert.equal(extractLeakedZonePlaylistUrl(`<script>player.setup({file: f("${encoded}")})</script>`), playlist);
});
