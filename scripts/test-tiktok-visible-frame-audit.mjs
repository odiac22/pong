import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MessageChannel} from 'node:worker_threads';
import {webcrypto} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import vm from 'node:vm';

const source = readFileSync(new URL('../android-app/app/src/main/assets/tiktok-visible-frame-audit.js', import.meta.url), 'utf8');
const nativeSource = readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/PongVisibleFrameAuditChannel.java', import.meta.url), 'utf8');
const activitySource = readFileSync(new URL('../android-app/app/src/main/java/com/odiac22/pong/MainActivity.java', import.meta.url), 'utf8');

function harness({visible = true, wrongNonce = false,
  expectedMode = 'echo', reply = 'echo'} = {}) {
  const listeners = new Map();
  const on = (name, fn) => listeners.set(name, fn);
  const off = (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); };
  let presented = 0;
  const video = {
    isConnected: true, paused: false, ended: false, readyState: 4,
    videoWidth: 16, videoHeight: 16,
    getBoundingClientRect: () => ({left: 0, top: 0, right: 160, bottom: 160, width: 160, height: 160}),
    requestVideoFrameCallback: cb => {
      setImmediate(() => { presented++;cb(0, {mediaTime: 1.25 + (presented-1)/30,
        presentedFrames: presented+2}); });return 1;
    },
    cancelVideoFrameCallback: () => {},
    getVideoPlaybackQuality: () => ({totalVideoFrames: presented, droppedVideoFrames: 0}),
  };
  let nativeMessages = 0;
  const nonces = [];
  const window = {
    __pongTikTokObservedVideo: {pageUrl: 'https://www.tiktok.com/@test/video/1', video},
    addEventListener: on, removeEventListener: off,
    PongVisibleFrameAudit: {postMessage(raw) {
      nativeMessages++;
      const request = JSON.parse(raw);
      assert.equal(request.page, 'https://www.tiktok.com/@test/video/1');
      assert.equal(request.mode, expectedMode);
      nonces.push(request.nonce);
      const {port1, port2} = new MessageChannel();
      port1.on('message', bytes => {
        if (bytes === 'close') { port1.close(); return; }
        assert.ok(bytes instanceof ArrayBuffer);
        const header = new DataView(bytes);
        assert.equal(header.getUint32(0, false), 0x50564641);
        assert.equal(header.getUint32(24, false), nativeMessages);
        assert.equal(header.getInt32(28, false), 7);
        assert.equal(header.getUint16(44, false), 16);
        assert.equal(header.getUint16(46, false), 16);
        assert.equal(bytes.byteLength, 64 + 16 * 16 * 4);
        if (reply === 'pc-request-failed') {
          port1.postMessage(JSON.stringify({type: 'pong-visible-frame-audit-error',
            reason: 'pc-request-failed'}));
          return;
        }
        if (reply === 'stall') return;
        if (reply !== 'echo') {
          header.setUint8(7, 1);
          header.setUint8(6, 1);
          if (reply === 'changed') new Uint8Array(bytes)[64] ^= 1;
          if (reply === 'bad-pts') new Uint8Array(bytes)[32] ^= 1;
        }
        port1.postMessage(bytes, [bytes]);
      });
      setImmediate(() => listeners.get('message')?.({
        data: JSON.stringify({type: 'pong-visible-frame-audit-port',
          nonce: wrongNonce ? 'f'.repeat(32) : request.nonce,
          sceneEpoch: 7, mode: request.mode}),
        ports: [port2],
      }));
    }},
  };
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    querySelector: () => null,
    createElement: () => ({
      width: 0, height: 0, remove() {},
      getContext: () => ({drawImage() {}, getImageData: () => ({
        data: new Uint8ClampedArray(16 * 16 * 4).fill(127),
      })}),
    }),
    addEventListener: on, removeEventListener: off,
  };
  vm.runInNewContext(source, {window, document, crypto: webcrypto, performance,
    ArrayBuffer, Uint8Array, Uint32Array, DataView, innerWidth: 160, innerHeight: 160,
    getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'}),
    setTimeout, clearTimeout, setImmediate});
  return {window, nonces, get nativeMessages() { return nativeMessages; }};
}

test('one visible synthetic RGBA frame transfers and echoes through a binary port', async () => {
  const trial = harness();
  const result = await trial.window.__pongVisibleFrameAuditRun();
  assert.equal(result.ok, true);
  assert.equal(result.transformed, false);
  assert.equal(result.bytes, 64 + 16 * 16 * 4);
  assert.equal(result.width, 16);
  assert.equal(trial.nativeMessages, 1);
  assert.equal(trial.window.__pongVisibleFrameAuditLast.ok, true);
});

test('PC-render result accepts changed pixels and preserves ownership header', async () => {
  const trial = harness({expectedMode: 'pc-render', reply: 'changed'});
  const result = await trial.window.__pongVisibleFrameAuditRun({mode: 'pc-render'});
  assert.equal(result.ok, true);
  assert.equal(result.transformed, true);
  assert.equal(result.mode, 'pc-render');
});

test('transformed claim with identical pixels is rejected despite changed flags', async () => {
  const trial = harness({expectedMode: 'pc-render', reply: 'identical-transformed'});
  const result = await trial.window.__pongVisibleFrameAuditRun({mode: 'pc-render'});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'response-mismatch');
});

test('PC-render result with changed source PTS is rejected', async () => {
  const trial = harness({expectedMode: 'pc-render', reply: 'bad-pts'});
  const result = await trial.window.__pongVisibleFrameAuditRun({mode: 'pc-render'});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'response-mismatch');
});

test('PC network failure returns a generic prompt result without waiting for timeout', async () => {
  const trial = harness({expectedMode: 'pc-render', reply: 'pc-request-failed'});
  const started = performance.now();
  const result = await trial.window.__pongVisibleFrameAuditRun({mode: 'pc-render'});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pc-request-failed');
  assert.ok(performance.now() - started < 1000);
});

test('series reuses a private nonce and advances exact source frames and sequences', async () => {
  const trial = harness({expectedMode: 'pc-render', reply: 'changed'});
  const result = await trial.window.__pongVisibleFrameAuditSeries(3);
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 3);
  assert.deepEqual(Array.from(result.records, record => record.sequence), [1, 2, 3]);
  assert.deepEqual(Array.from(result.records, record => record.presentedFrames), [3, 4, 5]);
  assert.equal(result.sourceFramesPresentedDelta, 2);
  assert.ok(result.sourceAdvancedSeconds > 0);
  assert.equal(result.decodedFrames, 3);
  assert.equal(result.droppedFrames, 0);
  assert.equal(new Set(trial.nonces).size, 1);
  assert.equal(trial.nativeMessages, 3);
  assert.ok(result.rafIntervalsMs.length <= 2048);
  assert.equal(JSON.stringify(result).includes('https://'), false);
  assert.equal(JSON.stringify(result).includes(trial.nonces[0]), false);
});

test('series cancellation closes its pending one-frame port promptly', async () => {
  const trial = harness({expectedMode: 'pc-render', reply: 'stall'});
  const pending = trial.window.__pongVisibleFrameAuditSeries(3);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trial.window.__pongVisibleFrameAuditSeriesCancel(), true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'series-cancelled');
  assert.equal(result.records.length, 0);
});

test('reverse endpoint is fixed and gated behind emulator audit and PC capability', () => {
  assert.match(nativeSource, /http:\/\/10\.0\.2\.2:17941\/frame/);
  assert.match(nativeSource, /http:\/\/127\.0\.0\.1:17941\/frame/);
  assert.match(nativeSource, /openConnection\(Proxy\.NO_PROXY\)/);
  assert.match(activitySource, /final boolean reverse = pcRender &&\s*getIntent\(\)\.getBooleanExtra\("pong_audit_visible_frame_reverse", false\)/);
  assert.match(activitySource, /if \(!tikTokVisibleFrameAuditAvailable\(\).*?view != tiktokWeb/s);
  assert.match(activitySource, /capability == null \|\| !capability\.matches\("\[a-f0-9\]\{64\}"\)/);
});

test('a hidden page cannot open the native frame port', async () => {
  const trial = harness({visible: false});
  const result = await trial.window.__pongVisibleFrameAuditRun();
  assert.equal(result.ok, false);
  assert.equal(trial.nativeMessages, 0);
});
