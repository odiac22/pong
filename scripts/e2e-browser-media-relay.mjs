import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const endpoint = 'http://127.0.0.1:8787';
const clientId = crypto.randomUUID();
const pageUrl = 'https://www.pornhub.com/view_video.php?viewkey=relay-contract-test';
const captureResponse = await fetch(`${endpoint}/media-page/recall`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-pong-simpcity-controller': '1'
  },
  body: JSON.stringify({
    channel: 1,
    mode: 'main',
    sourceUrl: pageUrl,
    pageUrls: [pageUrl],
    browserRelayClientId: clientId,
    browserRelayBrowser: 'test',
    entries: [{
      pageUrl,
      postUrl: pageUrl,
      videoUrl: 'https://cdn.phncdn.com/full-video.mp4?token=relay-test',
      durationSeconds: 870
    }]
  })
});
assert.equal(captureResponse.status, 200);
const capture = await captureResponse.json();
assert.equal(capture.browserRelay?.enabled, true);
assert.equal(capture.videos, 1);
assert.equal(capture.browserRelay?.keeperStarted, false);
assert.equal(
  capture.recall.genericBundles[0].videos[0].videoUrl,
  'https://cdn.phncdn.com/full-video.mp4?token=relay-test'
);
const streamPath = capture.recall.genericBundles[0].videos[0].browserRelayUrl;
assert.match(streamPath, /^\/media-browser-relay\/stream\/[a-z0-9-]+$/i);
assert.equal(capture.recall.genericBundles[0].videos[0].durationSeconds, 870);

const streamPromise = fetch(`${endpoint}${streamPath}`, {
  headers: { range: 'bytes=0-1023' }
});
const pollResponse = await fetch(`${endpoint}/media-browser-relay/jobs?clientId=${clientId}`, {
  headers: { 'x-pong-simpcity-controller': '1' }
});
assert.equal(pollResponse.status, 200);
const { job } = await pollResponse.json();
assert.ok(job?.id);
assert.equal(job.range, 'bytes=0-1023');
assert.equal(job.candidates.length, 1);

const expected = Buffer.from('synthetic fragmented media bytes');
const resultResponse = await fetch(`${endpoint}/media-browser-relay/jobs/${job.id}/result`, {
  method: 'POST',
  headers: {
    'content-type': 'application/octet-stream',
    'x-pong-simpcity-controller': '1',
    'x-pong-relay-status': '206',
    'x-pong-relay-content-type': 'video/mp4',
    'x-pong-relay-content-range': `bytes 0-${expected.length - 1}/1234567`,
    'x-pong-relay-accept-ranges': 'bytes'
  },
  body: expected
});
assert.equal(resultResponse.status, 200);

const streamResponse = await streamPromise;
assert.equal(streamResponse.status, 206);
assert.equal(streamResponse.headers.get('content-range'), `bytes 0-${expected.length - 1}/1234567`);
assert.equal(streamResponse.headers.get('x-pong-browser-relay'), '1');
assert.deepEqual(Buffer.from(await streamResponse.arrayBuffer()), expected);

console.log('PASS browser media relay: logical duration and byte-range playback contract');
