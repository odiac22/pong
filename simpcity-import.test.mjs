import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  extractSimpCityMediaLinks,
  extractSimpCityPostPassword,
  distinctSimpCityProfileCreators,
  extractSimpCityMediaLinksForCreator
} from './simpcity-import.mjs';

const THREAD = 'https://simpcity.cr/threads/lightskin-light-skin-mixed-black-white-girl-thread.210197/?order=reaction_score';

test('first Recall render preserves its incremental importer generation', () => {
  const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(
    source,
    /function renderFirstIncrementalImporterBatch\(\)[\s\S]*?PongPreserveActiveImporterForNextLoad = true;[\s\S]*?loadVideosButton\.click\(\);/
  );
  assert.match(
    source,
    /const preserveActiveImporter = window\.PongPreserveActiveImporterForNextLoad === true;[\s\S]*?window\.PongPreserveActiveImporterForNextLoad = false;/
  );
  assert.match(
    source,
    /if \(options\?\.preserveActiveImporter !== true\) bunkrLoadGeneration\+\+;/
  );

  const recallLoader = source.slice(
    source.indexOf('async function loadSimpCityAsCards'),
    source.indexOf('async function loadLeakedZoneAsCards')
  );
  assert.match(recallLoader, /renderFirstIncrementalImporterBatch\(\);/);
  const firstBatchRenderer = source.slice(
    source.indexOf('function renderFirstIncrementalImporterBatch'),
    source.indexOf('const simpCityActiveJobIds')
  );
  assert.doesNotMatch(firstBatchRenderer, /await/);
});

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
    'https://simpcity.cr/threads/mistress-eva-oh-aka-youwillpleaseme.168161/?order=reaction_score'
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
      { url: 'https://bunkr.pk/f/3b7Zmbkx9Ilwf' },
      { url: 'https://simpcity.cr/redirect/?to=aHR0cHM6Ly9waXhlbGRyYWluLmNvbS9sL1JWQkJ4eGNF&e=1&m=b64' },
      { url: 'https://simpcity.cr/redirect/?to=aHR0cHM6Ly9waXhlbGRyYWluLmNvbS91L2ltOFBQOFBS&e=1&m=b64' },
      { url: 'https://turbo.cr/v/bH_17k91Ltzu2' },
      { url: 'https://www.tiktok.com/@heymissteacher' },
      { url: 'https://www.tiktok.com/@heymissteacher/video/7533519786490000000' },
      { url: 'https://turbo.cr/v/BwKOmaC6PB-vS' },
      { url: 'https://www.tiktok.com/@chloeannfelix' },
      { url: 'https://www.tiktok.com/@cannednestealover?_r=1&_t=ZS-97KSldMhfZE' },
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
      ['bunkr', 'https://bunkr.pk/f/3b7Zmbkx9Ilwf', 'post-77'],
      ['pixeldrain', 'https://pixeldrain.com/l/RVBBxxcE', 'post-77'],
      ['pixeldrain', 'https://pixeldrain.com/u/im8PP8PR', 'post-77'],
      ['saint', 'https://turbo.cr/v/bH_17k91Ltzu2', 'post-77'],
      ['tiktok', 'https://www.tiktok.com/@heymissteacher', 'post-77'],
      ['tiktok', 'https://www.tiktok.com/@heymissteacher/video/7533519786490000000', 'post-77'],
      ['saint', 'https://turbo.cr/v/BwKOmaC6PB-vS', 'post-77'],
      ['tiktok', 'https://www.tiktok.com/@chloeannfelix', 'post-77'],
      ['tiktok', 'https://www.tiktok.com/@cannednestealover?_r=1&_t=ZS-97KSldMhfZE', 'post-77'],
      ['direct', 'https://cdn.example.test/clips/one.mp4?download=1', 'post-77']
    ]
  );
  assert.equal(classifySimpCityMediaUrl('http://pixeldrain.com/u/nope'), null);
  assert.equal(
    classifySimpCityMediaUrl('https://bunkr.cr/v/20211022-2247494...LIL_FUCK_SLUT.mp4'),
    null,
    'visually truncated forum labels must not count as playable media'
  );
});

test('splits back-to-back host links instead of losing the later videos', () => {
  const posts = [{
    postId: 'post-chained',
    text: 'https://turbo.cr/v/Q9ea-gX2ZQDK0https://turbo.cr/v/UoBPHMrW2CA3L',
    links: [],
    attachments: []
  }];
  assert.deepEqual(
    extractSimpCityMediaLinks(posts).map(item => item.url),
    [
      'https://turbo.cr/v/Q9ea-gX2ZQDK0',
      'https://turbo.cr/v/UoBPHMrW2CA3L'
    ]
  );
});

test('extracts the complete Sophmore thread URL chain and carries its Gofile password', () => {
  const gofileRedirect = 'https://simpcity.cr/redirect/?to=aHR0cHM6Ly9nb2ZpbGUuaW8vZC9FTm1xTnQ&e=1&m=b64';
  const anonfilesRedirect = 'https://simpcity.cr/redirect/?to=aHR0cHM6Ly9hbm9uZmlsZXMuY29tL3Q5bjJJNW0zeTAvU29waG1vcmVzMXV0X2Z1bGxfbnVkZV9zdHJpcF90b19wdXNzeV9wbGF5X21wNA&e=1&m=b64';
  const pixeldrainRedirect = 'https://simpcity.cr/redirect/?to=aHR0cHM6Ly9waXhlbGRyYWluLmNvbS91L2pZR2lDZUNV&e=1&m=b64';
  const chain = [
    gofileRedirect,
    'https://bunkr.cr/v/DYpth8yAKUPZi',
    'https://bunkr.cr/v/9bnkKQj7bMKPw',
    'https://bunkr.cr/a/4aURbCJN',
    'https://bunkr.cr/v/new-plug-tape-KVhdK1dR.mkv',
    'https://bunkr.cr/a/6ZVBXYlp',
    'https://bunkr.ph/f/K3iXm45DFk4qs',
    'https://bunkr.cr/a/CjsYshyz',
    'https://turbo.cr/v/ORcxWTllkWS',
    'https://turbo.cr/v/xjWj4T5kulC',
    'https://turbo.cr/v/QEQWE_YaVg9',
    'https://turbo.cr/v/3k-xjY6VKMg',
    'https://turbo.cr/v/HnsYa1WEgv-',
    'https://cdn9.bunkr.ru/0gpfqfyg04rfd5smgbpaa_source-nXAA34RG.mp4',
    anonfilesRedirect,
    'https://turbo.cr/v/wKUke7y7lCZ',
    'https://turbo.cr/v/kMEDl_jOiPg',
    'https://bunkr.cr/v/2tlekAIYG1GH2',
    'https://bunkr.cr/v/bpk9fjHKYYLWn',
    pixeldrainRedirect,
    'https://turbo.cr/v/UWKaVpbgnkv',
    'https://turbo.cr/v/MPovn0wXcG-',
    'https://turbo.cr/v/Rxl_ofE2SY-',
    'https://turbo.cr/v/ZO8lpzTQWlj'
  ].join('');
  const post = {
    postId: 'sophmore-pages-1-2',
    text: `Password: emendado ${chain}`,
    links: [],
    attachments: []
  };
  assert.equal(extractSimpCityPostPassword(post), 'emendado');
  const links = extractSimpCityMediaLinks([post]);
  assert.equal(links.length, 24);
  const gofile = links.find(link => link.url === 'https://gofile.io/d/ENmqNt');
  assert.deepEqual([gofile?.kind, gofile?.password], ['gofile', 'emendado']);
  assert.ok(links.some(link => link.kind === 'anonfiles' && /anonfiles\.com/.test(link.url)));
  assert.ok(links.some(link => link.kind === 'pixeldrain' && link.url === 'https://pixeldrain.com/u/jYGiCeCU'));
  assert.ok(links.some(link => link.url === 'https://bunkr.cr/v/new-plug-tape-KVhdK1dR.mkv'));
});

test('keeps every linked creator profile as a separate bundle candidate', () => {
  const creators = distinctSimpCityProfileCreators([
    {
      postId: 'post-1', primaryName: 'kinsley wyatt', aliases: ['kinsleywyatt1'],
      usernames: ['kinsleywyatt'], evidence: 'https://simpcity.cr/threads/kinsley-wyatt.115082/',
      threadUrl: 'https://simpcity.cr/threads/kinsley-wyatt.115082/'
    },
    {
      postId: 'post-1', primaryName: 'soogsx', aliases: [], usernames: ['soogsx'],
      evidence: 'https://simpcity.cr/threads/soogsx.13222/',
      threadUrl: 'https://simpcity.cr/threads/soogsx.13222/'
    }
  ]);
  assert.deepEqual(creators.map(creator => creator.primaryName), ['kinsley wyatt', 'soogsx']);
});

test('assigns attached post videos to the nearest matching creator profile', () => {
  const kinsleyUrl = 'https://simpcity.cr/threads/kinsley-wyatt.115082/';
  const soogsUrl = 'https://simpcity.cr/threads/soogsx.13222/';
  const post = {
    postId: 'post-2', text: '', attachments: [], links: [
      { text: 'Kinsley Wyatt', url: kinsleyUrl },
      { text: 'Kinsley clip', url: 'https://cdn.example.test/kinsley.mp4' },
      { text: 'Soogsx', url: soogsUrl },
      { text: 'Soogsx clip', url: 'https://cdn.example.test/soogs.mp4' }
    ]
  };
  const creators = [
    { postId: 'post-2', primaryName: 'kinsley wyatt', evidence: kinsleyUrl, threadUrl: kinsleyUrl },
    { postId: 'post-2', primaryName: 'soogsx', evidence: soogsUrl, threadUrl: soogsUrl }
  ];
  assert.deepEqual(
    extractSimpCityMediaLinksForCreator([post], creators, creators[0]).map(link => link.url),
    ['https://cdn.example.test/kinsley.mp4']
  );
  assert.deepEqual(
    extractSimpCityMediaLinksForCreator([post], creators, creators[1]).map(link => link.url),
    ['https://cdn.example.test/soogs.mp4']
  );
});
