import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const asyncMarker = `async function ${name}(`;
  const plainMarker = `function ${name}(`;
  const start = html.indexOf(asyncMarker) >= 0
    ? html.indexOf(asyncMarker)
    : html.indexOf(plainMarker);
  assert.notEqual(start, -1, `Missing ${name}`);
  const signatureTail = html.slice(start).match(/\)\s*\{/);
  assert.ok(signatureTail, `Missing body for ${name}`);
  const open = start + signatureTail.index + signatureTail[0].lastIndexOf('{');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${name}`);
}

function section(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end > start, `Missing ${endMarker} after ${startMarker}`);
  return html.slice(start, end);
}

function makeContext(fetchImpl) {
  const context = vm.createContext({
    fetch: fetchImpl,
    random40State: null,
    random40NormalizeLocalEndpoint(value) {
      return String(value || 'http://127.0.0.1:8787').trim().replace(/\/+$/, '');
    }
  });
  vm.runInContext(extractFunction('random40Local2ServerStopPath'), context);
  vm.runInContext(extractFunction('random40StopLocal2ServerRun'), context);
  return context;
}

function stopRun(context, state) {
  context.testRunState = state;
  return vm.runInContext('random40StopLocal2ServerRun(testRunState)', context);
}

test('Local2 fast profiles stop only their matching server lane', async () => {
  for (const [playbackProfile, expectedPath] of [
    ['local2fast', '/local2-fast/stop'],
    ['local22', '/local22-turbo/stop']
  ]) {
    const calls = [];
    const context = makeContext(async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    });
    const stopped = await stopRun(context, {
      mode: 'local2',
      playbackProfile,
      localEndpoint: 'http://127.0.0.1:8787/'
    });
    assert.equal(stopped, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://127.0.0.1:8787${expectedPath}`);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options)), {
      method: 'POST',
      cache: 'no-store',
      keepalive: true
    });
  }
});

test('successful and concurrent stop requests are idempotent', async () => {
  const calls = [];
  let finishRequest;
  const response = new Promise(resolve => { finishRequest = resolve; });
  const context = makeContext((url, options) => {
    calls.push({ url, options });
    return response;
  });
  const state = {
    mode: 'local2',
    playbackProfile: 'local22',
    localEndpoint: 'http://localhost:8787'
  };

  const first = stopRun(context, state);
  const concurrent = stopRun(context, state);
  assert.equal(calls.length, 1);
  finishRequest({ ok: true });
  assert.deepEqual(await Promise.all([first, concurrent]), [true, true]);
  assert.equal(await stopRun(context, state), true);
  assert.equal(calls.length, 1);
});

test('stop waits for an in-flight start and a failed stop remains retryable', async () => {
  const calls = [];
  let finishStart;
  const startPromise = new Promise(resolve => { finishStart = resolve; });
  const context = makeContext(async url => {
    calls.push(url);
    return { ok: calls.length > 1 };
  });
  const state = {
    mode: 'local2',
    playbackProfile: 'local2fast',
    localEndpoint: 'http://localhost:8787',
    local2ServerStartPromise: startPromise
  };

  const first = stopRun(context, state);
  await Promise.resolve();
  assert.equal(calls.length, 0, 'stop must not race ahead of start');
  finishStart({ ok: true });
  assert.equal(await first, false);
  assert.equal(await stopRun(context, state), true);
  assert.equal(calls.length, 2);
});

test('non-fast and non-Local2 runs never stop the core Local2 server', async () => {
  const calls = [];
  const context = makeContext(async url => {
    calls.push(url);
    return { ok: true };
  });
  for (const state of [
    { mode: 'local2', playbackProfile: 'local22', localEndpoint: '' },
    { mode: 'local2', playbackProfile: '', localEndpoint: 'http://localhost:8787' },
    { mode: 'local2', playbackProfile: 'legacy', localEndpoint: 'http://localhost:8787' },
    { mode: 'local', playbackProfile: 'local22', localEndpoint: 'http://localhost:8787' }
  ]) assert.equal(await stopRun(context, state), false);
  assert.deepEqual(calls, []);
});

test('manual stop, refresh, supersession, page close, and natural completion share the stop helper', () => {
  const startSource = section('async function startRandom40(', '\nconst EROME_ALBUM_SCRAPE_CONCURRENCY');
  const progressSource = section('function ensureRandom40ProgressEl()', '\nfunction updateRandom40Progress');
  const refreshSource = extractFunction('stopRandom40WorkflowForRefresh');
  const pageHideSource = extractFunction('random40StopActiveRunOnPageHide');
  const stopHelperSource = extractFunction('random40StopLocal2ServerRun');

  assert.match(progressSource, /random40StopLocal2ServerRun\(stoppingState\)/);
  assert.match(refreshSource, /random40StopLocal2ServerRun\(random40State\)/);
  assert.match(pageHideSource, /random40StopLocal2ServerRun\(stoppingState\)/);
  assert.match(html, /addEventListener\('pagehide', random40StopActiveRunOnPageHide\)/);
  assert.equal(
    [...startSource.matchAll(/random40StopLocal2ServerRun\((?:stoppingState|completedState)\)/g)].length,
    2,
    'both active and completed prior runs must be retired before replacement'
  );
  assert.match(startSource, /finally\s*\{\s*await random40StopLocal2ServerRun\(runState\);\s*\}/);
  assert.equal(
    [...startSource.matchAll(/local2ServerStartPromise = fetch\(/g)].length,
    3,
    'all Local2-derived starts must be ordered before a racing stop'
  );
  assert.doesNotMatch(stopHelperSource, /\/local2\/stop/);
  assert.doesNotMatch(
    startSource,
    /fetch\(`\$\{localEndpoint\}\/(?:local2-fast|local22-turbo)\/stop/
  );
});
