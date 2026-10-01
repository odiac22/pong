import assert from 'node:assert/strict';
import test from 'node:test';
import { segmentedMp4Metadata, validMp4SegmentResponse } from './video-cache-range-policy.mjs';

const head = {
  'content-length': '15800328',
  'content-type': 'video/mp4',
  'accept-ranges': 'bytes',
  etag: '"immutable-object"',
  'last-modified': 'Tue, 26 Mar 2024 21:00:03 GMT',
};
const metadata = segmentedMp4Metadata(head, 200, '/video.mp4', 256 * 1024 * 1024);

test('accepts a bounded immutable MP4 with byte ranges', () => {
  assert.equal(metadata.length, 15800328);
  assert.equal(metadata.ifRange, '"immutable-object"');
  assert.equal(segmentedMp4Metadata({ ...head, etag: 'W/"weak"' }, 200, '/video.mp4', 256 * 1024 * 1024)?.ifRange, head['last-modified']);
});

test('rejects unsafe or unsupported segmented metadata', () => {
  assert.equal(segmentedMp4Metadata(head, 206, '/video.mp4', 256 * 1024 * 1024), null);
  assert.equal(segmentedMp4Metadata(head, 200, '/playlist.m3u8', 256 * 1024 * 1024), null);
  assert.equal(segmentedMp4Metadata({ ...head, 'content-length': String(300 * 1024 * 1024) }, 200, '/video.mp4', 256 * 1024 * 1024), null);
  assert.equal(segmentedMp4Metadata({ ...head, 'accept-ranges': 'none' }, 200, '/video.mp4', 256 * 1024 * 1024), null);
  assert.equal(segmentedMp4Metadata({ ...head, etag: '', 'last-modified': '' }, 200, '/video.mp4', 256 * 1024 * 1024), null);
  assert.equal(segmentedMp4Metadata({ ...head, 'content-encoding': 'gzip' }, 200, '/video.mp4', 256 * 1024 * 1024), null);
});

test('accepts only the exact immutable segment requested', () => {
  const range = { 'content-range': 'bytes 0-1023/15800328', 'content-length': '1024', etag: '"immutable-object"' };
  assert.equal(validMp4SegmentResponse(range, 206, 0, 1023, metadata.length, metadata), true);
  assert.equal(validMp4SegmentResponse({ ...range, 'content-range': 'bytes 1-1024/15800328' }, 206, 0, 1023, metadata.length, metadata), false);
  assert.equal(validMp4SegmentResponse({ ...range, 'content-length': '1023' }, 206, 0, 1023, metadata.length, metadata), false);
  assert.equal(validMp4SegmentResponse({ ...range, etag: '"changed"' }, 206, 0, 1023, metadata.length, metadata), false);
  assert.equal(validMp4SegmentResponse({ ...range, 'content-encoding': 'gzip' }, 206, 0, 1023, metadata.length, metadata), false);
  assert.equal(validMp4SegmentResponse(range, 200, 0, 1023, metadata.length, metadata), false);
});
