import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  return html.slice(start, html.indexOf('\nfunction ', start + 1));
}

test('visible-frame tracking acquires audio only once per source', () => {
  const source = functionSource('markPongVideoVisualFramePresented');
  assert.match(source, /firstVisibleFrameForSource/);
  assert.match(source, /firstVisibleFrameForSource && isPongActiveVideo/);
});

test('steady swap audio does not call play repeatedly', () => {
  const source = functionSource('syncPongFaceSwapAudioCompanion');
  const alreadyPlayingGuard = source.indexOf('if (!audio.paused) return true;');
  const playCall = source.indexOf('const promise = audio.play();');
  assert.ok(alreadyPlayingGuard >= 0, 'already-playing guard must exist');
  assert.ok(playCall > alreadyPlayingGuard, 'guard must run before audio.play()');
});
