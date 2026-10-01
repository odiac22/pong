import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createHopProxy} from './experiment-pong-stream-hop-proxy.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1',
  () => resolve(server.address().port)));
const close = server => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
});
const until = async (predicate, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Timed out waiting for loopback hop state');
};

test('open-but-stalled upstream is localized without inventing EOF or retry', async () => {
  let finishUpstream;
  const first = Buffer.alloc(1_833_787, 0x35), last = Buffer.alloc(524_288, 0x67);
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'video/mp4'});
    res.write(first);
    finishUpstream = () => {res.end(last);};
  });
  const upstreamPort = await listen(upstream);
  const proxy = createHopProxy({upstreamPort});
  const proxyPort = await listen(proxy.server);
  try {
    let received = 0;
    const completed = new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/sessions/test/stream?transport=mse`, res => {
        res.on('data', part => {received += part.length;});
        res.on('end', resolve);
        res.on('error', reject);
      }).on('error', reject);
    });
    await until(() => received === first.length && !!finishUpstream);
    const mid = proxy.snapshot().active[0];
    assert.equal(mid.sessionHash, createHash('sha256').update('test').digest('hex'));
    assert.equal(JSON.stringify(proxy.snapshot()).includes('/sessions/test'), false);
    assert.equal(JSON.stringify(proxy.snapshot()).includes('transport=mse'), false);
    assert.equal(mid.upstreamBytes, first.length);
    assert.equal(mid.downstreamSubmittedBytes, first.length);
    assert.equal(mid.upstreamEnded, false);
    assert.equal(received, first.length);
    // This is an observational adapter; an open stream must remain open.
    finishUpstream();
    await completed;
    assert.equal(received, first.length + last.length);
    const end = proxy.snapshot().recent[0];
    assert.equal(end.upstreamEnded, true);
    assert.equal(end.error, '');
    assert.equal(end.clientClosed, false);
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test('non-stream requests pass through without occupying stream diagnostics', async () => {
  const upstream = http.createServer((_req, res) => res.end('healthy'));
  const upstreamPort = await listen(upstream);
  const proxy = createHopProxy({upstreamPort});
  const proxyPort = await listen(proxy.server);
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/health`, res => {
        const parts = [];
        res.on('data', part => parts.push(part));
        res.on('end', () => resolve(Buffer.concat(parts).toString()));
        res.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(body, 'healthy');
    assert.deepEqual(proxy.snapshot(), {active: [], recent: [], untrackedActive: 0});
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});

test('paused downstream creates observable proxy backpressure then drains in order', async () => {
  const parts = Array.from({length: 12}, (_, index) => Buffer.alloc(512 * 1024, index));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'video/mp4'});
    for (const part of parts) res.write(part);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const proxy = createHopProxy({upstreamPort});
  const proxyPort = await listen(proxy.server);
  try {
    let received = 0, client;
    const completed = new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/sessions/test/stream`, res => {
        client = res;
        res.once('data', part => {received += part.length;res.pause();});
        res.on('data', part => {if (!res.isPaused()) received += part.length;});
        res.on('end', resolve);
        res.on('error', reject);
      }).on('error', reject);
    });
    await until(() => !!client && proxy.snapshot().active[0]?.backpressureCount > 0);
    const paused = proxy.snapshot().active[0];
    assert.ok(paused.upstreamBytes >= received);
    assert.ok(paused.backpressureCount > 0);
    client.resume();
    await completed;
    assert.equal(received, parts.reduce((sum, part) => sum + part.length, 0));
    assert.ok(proxy.snapshot().recent[0].drainCount > 0);
  } finally {
    await close(proxy.server);
    await close(upstream);
  }
});
