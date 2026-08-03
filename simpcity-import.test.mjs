import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSimpCityThreadUrl,
  simpCityThreadPageUrl,
  simpCityThreadPageCount,
  extractSimpCityCreatorCandidates,
  simpCityCreatorAliases,
  isDistinctSimpCityCreatorName,
  buildBAlbumsCreatorSearchUrl,
  bunkrAlbumsMatchingCreator,
  classifySimpCityMediaUrl,
  extractSimpCityMediaLinks
} from './simpcity-import.mjs';

const THREAD = 'https://simpcity.cr/threads/lightskin-light-skin-mixed-black-white-girl-thread.210197/?order=reaction_score';

test('normalizes SimpCity threads and preserves only ordering', () => {
  assert.equal(
    normalizeSimpCityThreadUrl(`${THREAD}&utm_source=nope#post-4`),
    THREAD
  );
  assert.equal(
    simpCityThreadPageUrl(THREAD, 3),
    'https://simpcity.cr/threads/lightskin-light-skin-mixed-black-white-girl-thread.210197/page-3?order=reaction_score'
  );
  assert.equal(
    normalizeSimpCityThreadUrl('https://simpcity.cr/threads/mistress-eva-oh-aka-youwillpleaseme.168161/post-21831454'),
    'https://simpcity.cr/threads/mistress-eva-oh-aka-youwillpleaseme.168161/'
  );
  assert.equal(normalizeSimpCityThreadUrl('https://simpcity.cr/members/not-a-thread.5/'), '');
});

test('finds the highest XenForo page number', () => {
  assert.equal(simpCityThreadPageCount(`
    <a href="/threads/example.1/page-2">2</a>
    <a href="/threads/example.1/page-19">19</a>
    <a data-page="7">7</a>
  `), 19);
});

test('extracts creator aliases and names while excluding post authors', () => {
  const html = `
    <article class="message" data-author="6235829486295100">
      <a class="username" href="/members/6235829486295100.4387205/">6235829486295100</a>
      <div class="bbWrapper">
        <a href="/threads/cozyzozie-aka-fairyz222.61225/">cozyzozie aka fairyz222</a><br>
        Ash Kaashh<br>
        emmmyxo<br>
        <a href="https://instagram.com/another_creator/">Instagram</a>
        <blockquote><a href="/members/quoted-user.88/">quoted-user</a> Thanks</blockquote>
      </div>
    </article>
  `;
  const names = extractSimpCityCreatorCandidates(html, THREAD).map(item => item.name.toLowerCase());
  assert.ok(names.includes('cozyzozie'));
  assert.ok(names.includes('fairyz222'));
  assert.ok(names.includes('ash kaashh'));
  assert.ok(names.includes('emmmyxo'));
  assert.ok(names.includes('another_creator'));
  assert.ok(!names.includes('6235829486295100'));
  assert.ok(!names.includes('quoted-user'));
  assert.ok(!names.includes('thanks'));
});

test('builds one-page Balbums searches and keeps only strong creator matches', () => {
  const search = new URL(buildBAlbumsCreatorSearchUrl('Ash Kaashh'));
  assert.equal(search.hostname, 'balbums.st');
  assert.equal(search.searchParams.get('search'), 'Ash Kaashh');
  assert.equal(search.searchParams.get('per'), '20');
  const matches = bunkrAlbumsMatchingCreator([
    { title: 'Ash Kaashh - collection', url: 'https://bunkr.cr/a/one' },
    { title: 'Unrelated creator', url: 'https://bunkr.cr/a/two' }
  ], { name: 'Ash Kaashh' });
  assert.deepEqual(matches.map(item => item.url), ['https://bunkr.cr/a/one']);
});

test('splits linked-thread aliases and rejects vague first names', () => {
  assert.deepEqual(
    simpCityCreatorAliases('https://simpcity.cr/threads/cozyzozie-aka-fairyz222.61225/'),
    ['cozyzozie', 'fairyz222']
  );
  assert.equal(isDistinctSimpCityCreatorName('Ana'), false);
  assert.equal(isDistinctSimpCityCreatorName('Kayce'), false);
  assert.equal(isDistinctSimpCityCreatorName('Sarah'), false);
  assert.equal(isDistinctSimpCityCreatorName('Zoe'), false);
  assert.equal(isDistinctSimpCityCreatorName('Australian Girls'), false);
  assert.equal(isDistinctSimpCityCreatorName('Professional Athletes'), false);
  assert.equal(isDistinctSimpCityCreatorName('Ash Kaashh'), true);
  assert.equal(isDistinctSimpCityCreatorName('emmmyxo'), true);
});

test('extracts authoritative social handles without accepting ordinary first names', () => {
  const html = `
    <article class="message" data-author="forum-poster">
      <a class="username" href="/members/forum-poster.1/">forum-poster</a>
      <div class="bbWrapper">
        <a href="https://onlyfans.com/deminovak_">Demi</a>
        <a href="https://onlyfans.com/hyliafawkes">OnlyFans</a>
        <a href="https://onlyfans.com/tyiistarr">profile</a>
        <a href="https://onlyfans.com/Kayce">Kayce</a>
        <a href="https://onlyfans.com/Zoe">Zoe</a>
      </div>
    </article>
  `;
  const names = extractSimpCityCreatorCandidates(html, THREAD).map(item => item.name.toLowerCase());
  assert.ok(names.includes('deminovak_'));
  assert.ok(names.includes('hyliafawkes'));
  assert.ok(names.includes('tyiistarr'));
  assert.ok(!names.includes('kayce'));
  assert.ok(!names.includes('zoe'));
  assert.ok(!names.includes('forum-poster'));
});

test('extracts supported file-host and direct video links from SimpCity posts', () => {
  const posts = [{
    postId: 'post-77',
    text: 'Mirror https://cdn.example.test/clips/one.mp4?download=1',
    links: [
      { url: 'https://gofile.io/d/AbC_123' },
      { url: 'https://pixeldrain.com/u/Px9Z_2' },
      { url: 'https://pixeldrain.com/l/List123' },
      { url: 'https://simpcity.cr/proxy.php?link=https%3A%2F%2Fpixeldrain.com%2Fl%2FXspwPcht' },
      { url: 'https://bunkr.cr/a/kV4toiMV' },
      { url: 'https://cyberdrop.cr/a/Cyber123' },
      { url: 'https://cyberfile.me/hsgY' },
      { url: 'https://saint.to/embed/P9kEUyTHgJd' },
      { url: 'https://bunkrrr.org/f/WIS7IyS4kQ80U' },
      { url: 'https://bunkr.cr/v/3uAUOmsOW1nvi' },
      { url: 'https://simpcity.cr/redirect/?to=aHR0cHM6Ly9waXhlbGRyYWluLmNvbS9sL1JWQkJ4eGNF&e=1&m=b64' },
      { url: 'https://turbo.cr/v/bH_17k91Ltzu2' },
      { url: 'https://example.test/not-video' }
    ]
  }];
  assert.deepEqual(
    extractSimpCityMediaLinks(posts).map(item => [item.kind, item.url, item.postId]),
    [
      ['gofile', 'https://gofile.io/d/AbC_123', 'post-77'],
      ['pixeldrain', 'https://pixeldrain.com/u/Px9Z_2', 'post-77'],
      ['pixeldrain', 'https://pixeldrain.com/l/List123', 'post-77'],
      ['pixeldrain', 'https://pixeldrain.com/l/XspwPcht', 'post-77'],
      ['bunkr', 'https://bunkr.cr/a/kV4toiMV', 'post-77'],
      ['cyberdrop', 'https://cyberdrop.cr/a/Cyber123', 'post-77'],
      ['cyberfile', 'https://cyberfile.me/hsgY', 'post-77'],
      ['saint', 'https://saint.to/embed/P9kEUyTHgJd', 'post-77'],
      ['bunkr', 'https://bunkrrr.org/f/WIS7IyS4kQ80U', 'post-77'],
      ['bunkr', 'https://bunkr.cr/v/3uAUOmsOW1nvi', 'post-77'],
      ['pixeldrain', 'https://pixeldrain.com/l/RVBBxxcE', 'post-77'],
      ['saint', 'https://turbo.cr/v/bH_17k91Ltzu2', 'post-77'],
      ['direct', 'https://cdn.example.test/clips/one.mp4?download=1', 'post-77']
    ]
  );
  assert.equal(classifySimpCityMediaUrl('http://pixeldrain.com/u/nope'), null);
});
