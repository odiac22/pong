import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const userscript = fs.readFileSync(new URL('../pong-simpcity.user.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../local-ai-server.mjs', import.meta.url), 'utf8');

function section(startMarker, endMarker) {
  const start = userscript.indexOf(startMarker);
  assert.ok(start >= 0, `Missing ${startMarker}`);
  const end = userscript.indexOf(endMarker, start);
  assert.ok(end > start, `Missing ${endMarker} after ${startMarker}`);
  return userscript.slice(start, end);
}

// The safe source pace and extraction lanes remain bounded. A third creator
// worker overlaps response latency while every request still passes through the
// same shared permit.
assert.match(userscript, /const PAGE_CONCURRENCY = 2;/);
assert.match(userscript, /const FORUM_CREATOR_CONCURRENCY = 3;/);
assert.match(userscript, /const SIMPCITY_REQUEST_GAP_MS = 1200;/);
assert.match(userscript, /const AI_CONCURRENCY = 2;/);
assert.doesNotMatch(server, /SIMPCITY_EARLY_ARTIST_VIDEO_COUNT/);

// Exercise the exact slot-selection statements used by queuePosts.
const slotStatements = section('          let slot;\n', '          const task =');
const slotContext = vm.createContext({});
vm.runInContext(`
  function selectSlot(lane, slotIndex, AI_CONCURRENCY) {
${slotStatements}
    return { slot, slotIndex };
  }
`, slotContext);
const selectSlot = (lane, ordinal, concurrency) => JSON.parse(
  vm.runInContext(`JSON.stringify(selectSlot(${JSON.stringify(lane)}, ${ordinal}, ${concurrency}))`, slotContext)
);
assert.deepEqual(selectSlot('creator-entry', 7, 2), { slot: 0, slotIndex: 7 });
assert.deepEqual(selectSlot('creator-background', 0, 2), { slot: 1, slotIndex: 1 });
assert.deepEqual(selectSlot('creator-background', 1, 3), { slot: 2, slotIndex: 2 });
assert.deepEqual(selectSlot('shared', 0, 2), { slot: 0, slotIndex: 1 });
assert.deepEqual(selectSlot('shared', 1, 2), { slot: 1, slotIndex: 2 });

// Page-one work has its own lane; deeper and completed-thread work cannot fill it.
const scanThread = section('      const scanThread = async', '      const currentPage =');
assert.match(scanThread, /queuePosts\(\s*probePosts,[\s\S]*?'creator-entry'\s*\);/);
assert.match(scanThread, /queuePosts\(\s*enrichPosts,[\s\S]*?'creator-background'\s*,\s*creatorEntryTasks\.get\(threadUrl\) \|\| null\s*\);/);
assert.match(scanThread, /queuePosts\(\s*collectedPosts,[\s\S]*?'creator-background'\s*,\s*creatorEntryTasks\.get\(threadUrl\) \|\| null\s*\);/);
assert.match(scanThread, /onEntryComplete\(entryTask\)/);
const queuePosts = section('      const queuePosts =', '      const pageCountFromHtml =');
assert.match(queuePosts, /if \(prerequisite\) await prerequisite;/);
assert.match(queuePosts, /return Promise\.all\(queuedTasks\);/);
assert.match(queuePosts, /seenLinkedThreads\.size < MAX_LINKED_THREADS/);
assert.doesNotMatch(queuePosts, /seenThreads\.size <= MAX_LINKED_THREADS/);

const creatorWorkers = section('        const creatorWorkers =', '        if (listingIsArtistLookup)');
assert.match(creatorWorkers, /await priorEntryTurn;/);
assert.match(creatorWorkers, /onEntryComplete: releaseAfterEntry/);

// Execute the production completion callback with a slow index 0. Index 1 must
// publish immediately, while the resume checkpoint must remain at 0 until the
// missing contiguous prefix completes.
const completionSource = section('        const completeCreatorScan =', '        const queueListingThreads =');
const published = [];
const completionContext = vm.createContext({
  completedCreatorIndexes: new Set(),
  resumeSkipProfiles: 0,
  resumedProfilesSkipped: 0,
  diagnostic() {},
  queuePosts(...args) { published.push(args); },
  creatorEntryTasks: new Map(),
  MAX_LINKED_THREAD_DEPTH: 2,
  nextCreatorCheckpoint: 0
});
vm.runInContext(completionSource, completionContext);
vm.runInContext("completeCreatorScan(1, ['creator-1'])", completionContext);
assert.equal(published.length, 1, 'creator 1 should publish without waiting for creator 0');
assert.deepEqual(JSON.parse(JSON.stringify(published[0][0])), ['creator-1']);
assert.equal(completionContext.nextCreatorCheckpoint, 0, 'resume must not skip unfinished creator 0');
vm.runInContext("completeCreatorScan(0, ['creator-0'])", completionContext);
assert.equal(published.length, 2);
assert.equal(completionContext.nextCreatorCheckpoint, 2, 'resume advances after the contiguous prefix finishes');

assert.doesNotMatch(userscript, /flushCompletedCreators|nextCreatorToSubmit/);
assert.doesNotMatch(userscript, /threads\.slice\(0, 2\)/, 'exact artist matches must not be truncated');
assert.doesNotMatch(userscript, /ARTIST_LOOKUP_THREAD_PAGES/, 'exact artist profiles must retain complete pagination');
assert.doesNotMatch(
  server,
  /artistVideos\.size\s*>?=\s*20/,
  'Recall must not require twenty hosted videos before publishing an artist'
);
assert.match(server, /const playableReady = aggregate\.artistVideos\.size > 0 \|\| aggregate\.tiktokVideos\.size > 0;/);
assert.match(server, /const profileCreators = payload\?\.orderedPair === true[\s\S]*?simpCityPrimaryPairCreator\(pairedCreators\)/);
assert.match(server, /creatorPairAggregates/, 'incremental pages must share one creator accumulator');
assert.match(userscript, /const quotedMediaEntries = \[\.\.\.clone\.querySelectorAll/, 'quoted media embeds must survive quote-text removal');
assert.match(userscript, /'blockquote iframe\[src\]'/, 'quoted iframe videos must be captured');
assert.match(server, /aliases: artistLookupAliases/, 'later pages must preserve exact social handles for TikTok lookup');
assert.match(server, /tiktokProfilesTried: new Set\(\)/, 'newly discovered TikTok handles must be attempted once each');
assert.match(userscript, /<input data-multi type="checkbox"/, 'Multi must be visible and unchecked by default');
assert.doesNotMatch(userscript, /data-multi[^>]*checked/, 'Multi must default to off');
assert.match(userscript, /multi:\s*multiEnabled/, 'Android must pass Multi to the background worker');
assert.match(server, /globalThis\.PONG_SIMPCITY_MULTI = \$\{multi\}/, 'the hidden worker must receive Multi');
const directThreadBranch = section('      } else if (rootIsSinglePageThread)', '      await Promise.allSettled(linkedThreadTasks)');
assert.match(directThreadBranch, /atomic:\s*true/);
assert.match(directThreadBranch, /streamFirstPage:\s*true/);
assert.match(directThreadBranch, /followLinkedThreads:\s*multiEnabled/);
assert.match(server, /createHash\('sha256'\)\.update\(password\)/, 'Gofile passwords must use the documented SHA-256 API parameter');
console.log('PASS: ordered page-one admission, thread-level artist grouping, linked-thread traversal, and zero artificial video-count floor are present while source pacing stays bounded.');
