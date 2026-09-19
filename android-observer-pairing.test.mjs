import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const gradle = await readFile(new URL('./android-app/app/build.gradle', import.meta.url), 'utf8');
const activity = await readFile(new URL('./android-app/app/src/main/java/com/odiac22/pong/MainActivity.java', import.meta.url), 'utf8');
const builder = await readFile(new URL('./scripts/build-paired-pong-apks.ps1', import.meta.url), 'utf8');

test('release APK cannot silently ship without observer pairing', () => {
  assert.match(gradle, /System\.getenv\('PONG_OBSERVER_PAIR'\)/);
  assert.match(gradle, /Release APK requires PONG_OBSERVER_PAIR/);
  assert.match(gradle, /buildConfigField 'String', 'OBSERVER_PAIR'/);
});

test('Android shell reconnects the observer from its build-time pairing', () => {
  assert.match(activity, /observerPair = BuildConfig\.OBSERVER_PAIR/);
  assert.match(activity, /PongLiveObserver\.configure/);
});

test('Android permits Pong-owned ordinary and delayed swap audio playback', () => {
  assert.match(activity, /setMediaPlaybackRequiresUserGesture\(false\)/);
  assert.doesNotMatch(activity, /setMediaPlaybackRequiresUserGesture\(true\)/);
});

test('private pairing is resolved only by the release builder', () => {
  assert.match(builder, /\/etc\/pong-observer\.env/);
  assert.match(builder, /PONG_OBSERVER_INGEST_TOKEN/);
  assert.match(builder, /PONG_OBSERVER_PAIR/);
  assert.doesNotMatch(gradle, /https:\/\/[^'"\s]+\/pong-observe\/ingest/);
});
