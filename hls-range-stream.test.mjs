import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { hlsRangeEligibleRequest, hlsRangeMetadata, tryStreamHlsRanges,
  validHlsRangeResponse } from './hls-range-stream.mjs';

const etag = '"immutable-v1"';

test('only complete un-ranged m4s GETs enter the parallel transport', () => {
  assert.equal(hlsRangeEligibleRequest('GET', {}, '/signed/fragment.m4s', 0), true);
  assert.equal(hlsRangeEligibleRequest('GET', { range: 'bytes=5-9' }, '/signed/fragment.m4s', 0), false);
  assert.equal(hlsRangeEligibleRequest('HEAD', {}, '/signed/fragment.m4s', 0), false);
  assert.equal(hlsRangeEligibleRequest('GET', {}, '/signed/init.mp4', 0), false);
  assert.equal(hlsRangeEligibleRequest('GET', {}, '/signed/playlist.m3u8', 0), false);
  assert.equal(hlsRangeEligibleRequest('GET', {}, '/signed/fragment.m4s', 1), false);
});

function fixture({ weakEtag = false, badSegment = -1, changedEtag = -1,
  abortSegment = -1, waitSegment = -1, emitFailure = false,
  trickleSegment = -1, requestDeadlineMs = 30000 } = {}) {
  const source = Buffer.from('abcdefghijkl');
  const controller = new AbortController();
  const sent = [];
  const requests = [];
  const responses = [];
  let headers = null;
  let finished = false;
  let pendingAborted = false;
  const request = async (method, requestHeaders, requestController) => {
    requests.push({ method, headers: requestHeaders });
    if (method === 'HEAD') return {
      statusCode: 200,
      headers: {
        'content-length': String(source.length), 'accept-ranges': 'bytes',
        'content-type': 'video/iso.segment', etag: weakEtag ? `W/${etag}` : etag,
      },
      destroy() {},
    };
    const match = String(requestHeaders.range).match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const index = Math.floor(start / 4);
    if (index === waitSegment) {
      await new Promise((resolve, reject) => {
        requestController.signal.addEventListener('abort', () => {
          pendingAborted = true;
          reject(new Error('pending request aborted'));
        }, { once: true });
      });
    }
    const response = index === trickleSegment
      ? new Readable({ read() {} })
      : Readable.from([source.subarray(start, end + 1)]);
    if (index === trickleSegment) {
      let sent = 0;
      const interval = setInterval(() => {
        if (sent >= end - start + 1) { clearInterval(interval); response.push(null); return; }
        response.push(source.subarray(start + sent, start + sent + 1));
        sent++;
      }, 8);
      response.once('close', () => clearInterval(interval));
    }
    response.statusCode = index === badSegment ? 200 : 206;
    response.headers = {
      'content-range': `bytes ${start}-${end}/${source.length}`,
      'content-length': String(end - start + 1),
      etag: index === changedEtag ? '"immutable-v2"' : etag,
    };
    response.wasDestroyed = false;
    const originalDestroy = response.destroy.bind(response);
    response.destroy = (...args) => { response.wasDestroyed = true; return originalDestroy(...args); };
    responses.push(response);
    if (index === abortSegment) controller.abort();
    return response;
  };
  const run = () => tryStreamHlsRanges({
    request, pathname: '/signed/fragment.m4s', signal: controller.signal,
    chunkBytes: 4, concurrency: 2, maxBytes: 64, requestDeadlineMs,
    emitHeaders(value) { headers = value; },
    async emitChunk(value) {
      if (emitFailure) throw new Error('downstream write failed');
      sent.push(value);
    },
    finish() { finished = true; },
  });
  return { run, source, requests, responses, sent, controller,
    get headers() { return headers; }, get finished() { return finished; },
    get pendingAborted() { return pendingAborted; } };
}

test('metadata requires bounded complete m4s with immutable validator', () => {
  const valid = { 'content-length': '12', 'accept-ranges': 'bytes', etag,
    'content-type': 'video/iso.segment' };
  assert.equal(hlsRangeMetadata(valid, 200, '/x.m4s', 64).length, 12);
  assert.equal(hlsRangeMetadata({ ...valid, etag: `W/${etag}` }, 200, '/x.m4s', 64), null);
  assert.equal(hlsRangeMetadata(valid, 200, '/x.mp4', 64), null);
  assert.equal(hlsRangeMetadata(valid, 200, '/x.m4s', 8), null);
  assert.equal(hlsRangeMetadata({ ...valid, 'content-encoding': 'gzip' }, 200, '/x.m4s', 64), null);
  assert.equal(hlsRangeMetadata({ ...valid, 'content-type': 'application/vnd.apple.mpegurl' }, 200, '/x.m4s', 64), null);
});

test('range validation rejects changed validators and full-200 fallbacks', () => {
  const headers = { 'content-range': 'bytes 4-7/12', 'content-length': '4', etag };
  assert.equal(validHlsRangeResponse(headers, 206, 4, 7, 12, etag), true);
  assert.equal(validHlsRangeResponse(headers, 200, 4, 7, 12, etag), false);
  assert.equal(validHlsRangeResponse({ ...headers, etag: '"other"' }, 206, 4, 7, 12, etag), false);
  assert.equal(validHlsRangeResponse({ ...headers, 'content-range': 'bytes 0-3/12' }, 206, 4, 7, 12, etag), false);
});

test('streams exact source bytes in order using If-Range and bounded waves', async () => {
  const state = fixture();
  assert.equal(await state.run(), true);
  assert.deepEqual(Buffer.concat(state.sent), state.source);
  assert.equal(state.headers.length, state.source.length);
  assert.equal(state.finished, true);
  assert.equal(state.requests.length, 4);
  assert.ok(state.requests.slice(1).every(value => value.headers['if-range'] === etag));
});

test('unsupported HEAD and rejected first range leave response uncommitted for legacy fallback', async () => {
  for (const options of [{ weakEtag: true }, { badSegment: 0 }]) {
    const state = fixture(options);
    assert.equal(await state.run(), false);
    assert.equal(state.headers, null);
    assert.deepEqual(state.sent, []);
    assert.equal(state.finished, false);
  }
});

test('changed ETag on later 206 range terminates without splicing bytes', async () => {
  const state = fixture({ changedEtag: 1 });
  await assert.rejects(state.run(), /validator mismatch/);
  assert.deepEqual(Buffer.concat(state.sent), Buffer.from('abcd'));
  assert.equal(state.finished, false);
  assert.equal(state.responses[1].wasDestroyed, true);
});

test('cancellation before publication never emits bytes', async () => {
  const state = fixture({ abortSegment: 0 });
  await assert.rejects(state.run(), /aborted/);
  assert.equal(state.headers, null);
  assert.deepEqual(state.sent, []);
  assert.equal(state.finished, false);
});

test('downstream failure cancels and drains an unresolved in-flight range', async () => {
  const state = fixture({ waitSegment: 1, emitFailure: true });
  await assert.rejects(state.run(), /downstream write failed/);
  assert.equal(state.pendingAborted, true);
  assert.equal(state.finished, false);
  assert.deepEqual(state.sent, []);
});

test('an absolute deadline stops a trickling post-prefix body', async () => {
  const state = fixture({ trickleSegment: 1, requestDeadlineMs: 14 });
  await assert.rejects(state.run(), /absolute deadline/);
  assert.deepEqual(Buffer.concat(state.sent), Buffer.from('abcd'));
  assert.equal(state.finished, false);
  assert.equal(state.responses[1].wasDestroyed, true);
});
