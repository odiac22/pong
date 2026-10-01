import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { downloadVideoSegments, segmentFailureDisposition } from './video-cache-segmented-downloader.mjs';

function fixture({ failSegment = -1, wrongEtagSegment = -1, badHead = false, abort = false,
  partialWrites = false, gateSegment = -1, cancelDuringWrite = false } = {}) {
  const bytes = Buffer.alloc(8);
  const writes = [];
  const published = [];
  const responses = [];
  const truncations = [];
  let removed = 0;
  let closed = false;
  let currentGeneration = true;
  const signal = { aborted: abort };
  let releaseGate;
  let gateStarted;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const gatedStarted = new Promise(resolve => { gateStarted = resolve; });
  const etag = '"fixed"';
  const request = async (method, headers) => {
    if (method === 'HEAD') {
      return {
        statusCode: 200,
        headers: {
          'content-length': '8', 'content-type': 'video/mp4',
          'accept-ranges': badHead ? 'none' : 'bytes', etag,
        },
        destroy() {},
      };
    }
    const start = Number(headers.range.match(/bytes=(\d+)-/)[1]);
    const end = start + 3;
    if (start / 4 === gateSegment) {
      gateStarted();
      await gate;
    }
    const stream = Readable.from([Buffer.alloc(4, start === 0 ? 0x41 : 0x42)]);
    stream.statusCode = start / 4 === failSegment ? 200 : 206;
    stream.headers = {
      'content-range': `bytes ${start}-${end}/8`,
      'content-length': '4', etag: start / 4 === wrongEtagSegment ? '"changed"' : etag,
    };
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (...args) => { stream.wasDestroyed = true; return destroy(...args); };
    stream.wasDestroyed = false;
    stream.readCalls = 0;
    const read = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = () => {
      stream.readCalls++;
      return read();
    };
    responses.push(stream);
    return stream;
  };
  const run = () => downloadVideoSegments({
    request,
    openFile: async () => ({
      async write(buffer, offset, length, position) {
        const count = partialWrites ? Math.min(2, length) : length;
        buffer.copy(bytes, position, offset, offset + count);
        writes.push({ position, count });
        if (cancelDuringWrite) signal.aborted = true;
        return { bytesWritten: count };
      },
      async truncate(size) { bytes.fill(0, size); truncations.push(size); },
      async close() { closed = true; },
    }),
    removeFile: async () => { removed++; bytes.fill(0); },
    partPath: '/fake/part.mp4', targetPath: '/public/video.mp4',
    signal, isCurrentGeneration: () => currentGeneration,
    generic: true, chunkBytes: 4, concurrency: 2, maxFileBytes: 64,
    onMetadata() {}, onPrefix: count => published.push(count),
  });
  return { run, bytes, writes, published, responses, truncations, signal,
    gatedStarted, releaseGate, invalidateGeneration() { currentGeneration = false; },
    get removed() { return removed; }, get closed() { return closed; } };
}

async function waitForPrefix(state) {
  for (let attempt = 0; attempt < 100 && state.published.length === 0; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(state.published.length > 0, 'expected first range to publish before cancellation');
}

test('publishes only contiguous verified chunks, including partial file writes', async () => {
  const state = fixture({ partialWrites: true });
  assert.deepEqual(await state.run(), { published: 8, total: 8 });
  assert.deepEqual(state.published, [4, 8]);
  assert.equal(state.bytes.toString(), 'AAAABBBB');
  assert.equal(state.writes.length, 4);
  assert.equal(state.removed, 1);
  assert.equal(state.closed, true);
});

test('post-prefix range failure never writes the rejected entity and destroys its response', async () => {
  const state = fixture({ failSegment: 1 });
  await assert.rejects(state.run(), /range mismatch/);
  assert.deepEqual(state.published, [4]);
  assert.equal(state.bytes.subarray(0, 4).toString(), 'AAAA');
  assert.equal(state.bytes.subarray(4).toString('hex'), '00000000');
  assert.equal(state.responses[1].wasDestroyed, true);
  assert.equal(state.responses[1].readCalls, 0);
  assert.equal(segmentFailureDisposition(state.published.at(-1)), 'poison');
  assert.equal(state.closed, true);
});

test('a changed ETag on a 206 second range cannot splice a new entity after the prefix', async () => {
  const state = fixture({ wrongEtagSegment: 1 });
  await assert.rejects(state.run(), /range mismatch/);
  assert.deepEqual(state.published, [4]);
  assert.equal(state.bytes.subarray(0, 4).toString(), 'AAAA');
  assert.equal(state.bytes.subarray(4).toString('hex'), '00000000');
  assert.equal(state.responses[1].statusCode, 206);
  assert.equal(state.responses[1].wasDestroyed, true);
  assert.equal(state.responses[1].readCalls, 0);
  assert.equal(segmentFailureDisposition(state.published.at(-1)), 'poison');
});

test('pre-prefix metadata failure selects safe sequential fallback', async () => {
  const state = fixture({ badHead: true });
  await assert.rejects(state.run(), /metadata unavailable/);
  assert.deepEqual(state.published, []);
  assert.equal(state.removed, 0);
  assert.equal(segmentFailureDisposition(0), 'sequential-fallback');
});

test('cancellation while the second range is in flight does not publish it', async () => {
  const state = fixture({ gateSegment: 1 });
  const pending = state.run();
  await state.gatedStarted;
  await waitForPrefix(state);
  state.signal.aborted = true;
  state.releaseGate();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(state.published, [4]);
  assert.equal(state.bytes.subarray(4).toString('hex'), '00000000');
  assert.equal(state.responses[1].wasDestroyed, true);
  assert.equal(state.closed, true);
});

test('generation invalidation during the first in-flight range prevents all publication', async () => {
  const state = fixture({ gateSegment: 0 });
  const pending = state.run();
  await state.gatedStarted;
  state.invalidateGeneration();
  state.releaseGate();
  await assert.rejects(pending, /aborted/);
  assert.deepEqual(state.published, []);
  assert.equal(state.bytes.toString('hex'), '0000000000000000');
  assert.equal(state.responses[0].wasDestroyed, true);
  assert.equal(state.closed, true);
});

test('cancellation during a pending file write truncates uncommitted bytes', async () => {
  const state = fixture({ cancelDuringWrite: true });
  await assert.rejects(state.run(), /aborted/);
  assert.deepEqual(state.published, []);
  assert.equal(state.bytes.toString('hex'), '0000000000000000');
  assert.deepEqual(state.truncations, [0]);
  assert.equal(state.closed, true);
});
