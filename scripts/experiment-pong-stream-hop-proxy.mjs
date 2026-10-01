// Disposable loopback-only byte counter between the Node helper and Pong.
// It changes neither media bytes nor quality. Do not point production at it.
// In an owned test launch: node this-file --upstream-port 8792 --listen-port 8892,
// then start only the disposable helper with PONG_SWAP_PORT=8892. Compare its
// /_hop_status counters with CDP Network.dataReceived and JS transport.bytes.

import http from 'node:http';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_RECORDS = 64;
const MAX_ACTIVE_RECORDS = 64;
const streamSessionHash = path => {
  const match = /^\/sessions\/([a-zA-Z0-9_-]+)\/stream(?:\?|$)/.exec(path);
  return match ? createHash('sha256').update(match[1]).digest('hex') : null;
};

export function createHopProxy({upstreamPort, onEvent = () => {}}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535)
    throw new TypeError('upstreamPort must be a TCP port');
  let nextId = 0;
  const active = new Map(), recent = [];
  let untrackedActive = 0;
  const snapshot = row => ({
    id: row.id, stream: row.stream, sessionHash: row.sessionHash,
    startedAt: row.startedAt,
    headersAt: row.headersAt, lastUpstreamAt: row.lastUpstreamAt,
    lastDownstreamAt: row.lastDownstreamAt, endedAt: row.endedAt,
    upstreamBytes: row.upstreamBytes,
    downstreamSubmittedBytes: row.downstreamSubmittedBytes,
    backpressureCount: row.backpressureCount, drainCount: row.drainCount,
    downstreamQueuedBytes: row.downstreamQueuedBytes,
    upstreamEnded: row.upstreamEnded, clientClosed: row.clientClosed,
    error: row.error,
  });
  const finish = row => {
    if (row.endedAt) return;
    row.endedAt = Date.now();
    if (row.tracked) {
      active.delete(row.id);
      recent.push(snapshot(row));
      if (recent.length > MAX_RECORDS) recent.shift();
      onEvent({kind: 'finish', ...snapshot(row)});
    } else if (row.stream) {
      untrackedActive--;
    }
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/_hop_status') {
      const body = JSON.stringify({active: [...active.values()].map(snapshot), recent,
                                   untrackedActive});
      res.writeHead(200, {'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
                          'cache-control': 'no-store'});
      res.end(body);
      return;
    }
    const sessionHash = streamSessionHash(req.url || '');
    const tracked = !!sessionHash && active.size < MAX_ACTIVE_RECORDS;
    const row = {id: ++nextId, stream: !!sessionHash, sessionHash, tracked,
                 startedAt: Date.now(),
                 headersAt: 0, lastUpstreamAt: 0, lastDownstreamAt: 0, endedAt: 0,
                 upstreamBytes: 0, downstreamSubmittedBytes: 0,
                 backpressureCount: 0, drainCount: 0, downstreamQueuedBytes: 0,
                 upstreamEnded: false, clientClosed: false, error: ''};
    if (tracked) {
      active.set(row.id, row);
      onEvent({kind: 'start', id: row.id, sessionHash, stream: true, at: row.startedAt});
    } else if (row.stream) {
      untrackedActive++;
    }
    const headers = {...req.headers, host: `127.0.0.1:${upstreamPort}`};
    const upstream = http.request({hostname: '127.0.0.1', port: upstreamPort,
      path: req.url, method: req.method, headers}, incoming => {
      row.headersAt = Date.now();
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.on('data', part => {
        row.upstreamBytes += part.length;
        row.lastUpstreamAt = Date.now();
        const writable = res.write(part);
        row.downstreamSubmittedBytes += part.length;
        row.lastDownstreamAt = Date.now();
        row.downstreamQueuedBytes = res.writableLength;
        if (!writable) {
          row.backpressureCount++;
          incoming.pause();
        }
      });
      res.on('drain', () => {
        row.drainCount++;
        row.downstreamQueuedBytes = res.writableLength;
        incoming.resume();
      });
      incoming.on('end', () => {row.upstreamEnded = true;res.end();});
      incoming.on('error', error => {
        row.error = error.code || error.name || 'upstream-error';
        res.destroy(error);
      });
    });
    upstream.on('error', error => {
      row.error = error.code || error.name || 'connection-error';
      if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain'});
      res.end();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => {
      row.clientClosed = !res.writableEnded;
      if (row.clientClosed) upstream.destroy();
      finish(row);
    });
    req.pipe(upstream);
  });
  return {server, snapshot: () => ({active: [...active.values()].map(snapshot),
                                    recent: [...recent], untrackedActive})};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = name => {
    const at = process.argv.indexOf(name);
    return at < 0 ? NaN : Number(process.argv[at + 1]);
  };
  const upstreamPort = value('--upstream-port');
  const listenPort = value('--listen-port');
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535 ||
      listenPort === upstreamPort) throw Error('Use distinct --upstream-port and --listen-port');
  const proxy = createHopProxy({upstreamPort});
  proxy.server.listen(listenPort, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({kind: 'ready', port: listenPort}) + '\n');
  });
  const ticker = setInterval(() => {
    const active = proxy.snapshot().active.filter(row => row.stream);
    if (active.length) process.stdout.write(JSON.stringify({kind: 'hop-snapshot', active}) + '\n');
  }, 1000);
  proxy.server.on('close', () => clearInterval(ticker));
}
