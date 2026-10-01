import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('./workers/erome-proxy.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < html.length; index++) {
    if (html[index] === '{') depth++;
    if (html[index] === '}') depth--;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('fresh Erome creator imports preserve paperclip group order', () => {
  const context = vm.createContext({
    artistNameFromUrl: () => 'Casualandhot'
  });
  vm.runInContext(extractFunction('buildEromeImportGroups'), context);
  const groups = vm.runInContext(`buildEromeImportGroups({
    title: 'Casualandhot',
    albumGroups: [
      { url: 'https://www.erome.com/a/THDyt8nF', videos: ['one.mp4'] },
      { url: 'https://www.erome.com/a/H6fWVg6G', videos: ['two.mp4'] },
      { url: 'https://www.erome.com/a/TafhqT0L', videos: ['three.mp4'] }
    ]
  }, 'https://www.erome.com/Casualandhot')`, context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(groups.map(group => ({
      url: group.url,
      source: group.source,
      preserveGroupOrder: group.preserveGroupOrder
    })))),
    [
      { url: 'https://www.erome.com/a/THDyt8nF', source: 'erome', preserveGroupOrder: true },
      { url: 'https://www.erome.com/a/H6fWVg6G', source: 'erome', preserveGroupOrder: true },
      { url: 'https://www.erome.com/a/TafhqT0L', source: 'erome', preserveGroupOrder: true }
    ]
  );
});

test('ordinary Erome Paperclip navigation is sequential, not random', () => {
  const source = extractFunction('resolveNextPaperclipEventIndex');
  const navigationSource = extractFunction('navigateToNextPasteEvent');
  const capabilitySource = extractFunction('canNavigateToNextPasteEvent');

  assert.match(source, /eromeBundleMode[\s\S]*document\.documentElement\.dataset\.pongSimpCityActive === 'true'[\s\S]*getFirstActiveEromePasteEventIndex[\s\S]*getNextActivePasteEventIndex/);
  assert.doesNotMatch(source, /getRandomActiveEromePasteEventIndex/);
  assert.match(navigationSource, /resolveNextPaperclipEventIndex\(excludedIdentity\)/);
  assert.match(capabilitySource, /resolveNextPaperclipEventIndex\(excludedIdentity\)/);
  assert.doesNotMatch(capabilitySource, /getRandomActiveEromePasteEventIndex/);
});

test('the Erome proxy never expands neighbouring albums from an album URL', () => {
  assert.match(worker, /const isAlbumTarget = \/\^\\\/a\\\/[\s\S]*target\.pathname/);
  assert.match(worker, /if \(!isAlbumTarget && !videos\.length && albumEntries\.length\)/);
});

test('profile page one establishes the first Paperclips before background pages', () => {
  assert.match(html, /firstPagePriorityAlbums = albumQueue[\s\S]{0,220}EROME_INITIAL_ALBUM_BATCH_SIZE\)[\s\S]{0,40}\.reverse\(\)/);
  assert.match(html, /for \(const album of firstPagePriorityAlbums\)[\s\S]{0,260}scrapeEromeAlbumOnce\(album, 'page 1 priority'\)/);
  assert.match(html, /publishScrapedGroups\('page 1 ready', true\)/);
});

test('the final Load Videos shuffle keeps ordered Erome events adjacent', () => {
  const shuffleSource = extractFunction('shuffleLoadedVideosForPlayback');
  const payloadSource = extractFunction('buildEromeCardImportPayload');
  assert.match(payloadSource, /preserveGroupOrder: group\.preserveGroupOrder === true/);
  assert.match(shuffleSource, /preserveGroupOrder = groups\.some\(group => group\.event\?\.preserveGroupOrder === true\)/);
  assert.match(shuffleSource, /if \(!preserveGroupOrder\) shuffleInPlace\(groups\)/);
});
