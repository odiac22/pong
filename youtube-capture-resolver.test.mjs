import test from 'node:test';
import assert from 'node:assert/strict';
import { selectYouTubeStream, resolveYouTubeCapture, youtubeVideoIdFromPage } from './youtube-capture-resolver.mjs';
const id = 'guSAAJaSG84';
const format = (height, vcodec = 'avc1') => ({ height, vcodec, protocol: 'm3u8_native', manifest_url: `https://manifest.googlevideo.com/master/${height}/${vcodec}`, acodec: 'none' });
test('chooses highest-resolution HLS master, not video-only variant', () => {
  const r = selectYouTubeStream({ id, duration: 975, title: 'Exact clip', formats: [format(360), format(1080), format(720)] }, id);
  assert.equal(r.height, 1080); assert.equal(r.kind, 'hls-master'); assert.equal(r.durationSeconds, 975);
});
test('prefers AVC master at equivalent resolution', () => {
  const r = selectYouTubeStream({ id, formats: [format(1080,'vp09'), format(1080)] }, id);
  assert.match(r.videoUrl, /avc1$/);
});
test('rejects mismatched identity and DRM', () => {
  assert.throws(() => selectYouTubeStream({ id: 'abcdefghijk', formats: [format(1080)] }, id));
  assert.throws(() => selectYouTubeStream({ id, formats: [{ ...format(1080), has_drm: true }] }, id));
});
test('does not accept audio-only/video-only URLs or arbitrary hosts', () => {
  for (const f of [
    { url: 'https://r1.googlevideo.com/videoplayback', vcodec:'avc1',acodec:'none' },
    { url: 'https://r1.googlevideo.com/videoplayback', vcodec:'none',acodec:'aac' },
    { ...format(1080), manifest_url:'https://googlevideo.com.evil.invalid/master' }
  ]) assert.throws(() => selectYouTubeStream({ id, formats:[f] }, id));
});
test('accepts muxed fallback when no HLS master exists', () => {
  assert.equal(selectYouTubeStream({ id, formats:[{ url:'https://r1.googlevideo.com/videoplayback',vcodec:'avc1',acodec:'aac',height:720 }] }, id).kind, 'muxed');
});
test('validates ID before spawning resolver', async () => {
  for (const value of ['', 'https://example.com', '--config', null]) await assert.rejects(resolveYouTubeCapture(value), /Invalid video ID/);
});
test('extracts only an exact selected YouTube video ID from supported page forms', () => {
  for (const page of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://m.youtube.com/shorts/${id}`,
    `https://youtube.com/embed/${id}`,
    `https://youtu.be/${id}`
  ]) assert.equal(youtubeVideoIdFromPage(page), id);
  for (const page of [
    `https://youtube.com.evil.invalid/watch?v=${id}`,
    `https://youtu.be/${id}/other`,
    'https://www.youtube.com/watch?v=other',
    `http://www.youtube.com/watch?v=${id}`
  ]) assert.equal(youtubeVideoIdFromPage(page), '');
});
