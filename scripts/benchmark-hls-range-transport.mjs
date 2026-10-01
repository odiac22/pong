// Read-only, silent full-fragment A/B. Signed URLs stay in memory and are not
// printed or persisted. This does not start or restart the Pong service.
import crypto from 'node:crypto';
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { tryStreamHlsRanges } from '../hls-range-stream.mjs';

const proxyBase = 'http://127.0.0.1:17929';
const master = 'https://stream.mux.com/BV3YZtogl89mg9VcNBhhnHm02Y34zI1nlMuMQfAbl3dM.m3u8';
const height = Number(process.argv[2] || 2160);
if (![1080, 2160].includes(height)) throw new Error('only 1080 and 2160 benchmark variants are supported');
const reportPath = `E:/Pong Benchmarks/v3029-overnight/network-audit/hls-range-${height}-report.json`;

async function firstFragmentUrl() {
  const masterLocation = height === 2160
    ? `${proxyBase}/generic-media/hls?url=${encodeURIComponent(master)}`
    : master;
  const masterResponse = await fetch(masterLocation, {
    signal: AbortSignal.timeout(15000),
  });
  if (!masterResponse.ok) throw new Error(`master status ${masterResponse.status}`);
  const masterLines = (await masterResponse.text()).split(/\r?\n/);
  const variants = masterLines.flatMap((line, index) =>
    line.startsWith('#EXT-X-STREAM-INF') && line.includes(`x${height}`) ? [index] : []);
  const variant = variants.at(-1) ?? -1;
  if (variant < 0) throw new Error('master has no variant');
  const renditionUrl = new URL(masterLines[variant + 1].trim(), masterLocation);
  const renditionResponse = await fetch(renditionUrl, {
    signal: AbortSignal.timeout(15000),
  });
  if (!renditionResponse.ok) throw new Error(`rendition status ${renditionResponse.status}`);
  const renditionLines = (await renditionResponse.text()).split(/\r?\n/);
  if (renditionLines.some(line => line.startsWith('#EXT-X-BYTERANGE'))) {
    throw new Error('fragment uses EXT-X-BYTERANGE; benchmark ineligible');
  }
  const first = renditionLines.findIndex(line => line.startsWith('#EXTINF'));
  if (first < 0) throw new Error('rendition has no fragment');
  const fragment = new URL(renditionLines[first + 1].trim(), renditionUrl);
  const target = height === 2160
    ? new URL(fragment.searchParams.get('url') || '')
    : fragment;
  if (target.protocol !== 'https:' || !/\.m4s$/i.test(target.pathname) ||
      !/^(?:[a-z0-9-]+\.)*mux\.com$/i.test(target.hostname)) {
    throw new Error('fragment is outside the expected public Mux host');
  }
  return target;
}

function request(target, method, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request(target, {
      method, timeout: 30000,
      headers: {
        accept: '*/*', 'accept-encoding': 'identity',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36',
        ...headers,
      },
    }, resolve);
    outgoing.once('timeout', () => outgoing.destroy(new Error('source inactivity timeout')));
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function rangedRun() {
  const target = await firstFragmentUrl();
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  let metadata;
  const started = performance.now();
  const streamed = await tryStreamHlsRanges({
    pathname: target.pathname,
    request: (method, headers) => request(target, method, headers),
    emitHeaders(value) { metadata = value; },
    async emitChunk(chunk) { digest.update(chunk); bytes += chunk.length; },
    finish() {},
  });
  if (!streamed || bytes !== metadata?.length) throw new Error('range stream incomplete');
  return { seconds: (performance.now() - started) / 1000, bytes,
    sha256: digest.digest('hex'), etag: metadata.etag };
}

async function directRun() {
  const target = await firstFragmentUrl();
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  const started = performance.now();
  const response = await request(target, 'GET');
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`direct status ${response.statusCode}`);
  }
  const length = Number(response.headers['content-length']);
  for await (const chunk of response) { digest.update(chunk); bytes += chunk.length; }
  if (bytes !== length) throw new Error('direct stream incomplete');
  return { seconds: (performance.now() - started) / 1000, bytes,
    sha256: digest.digest('hex'), etag: response.headers.etag || '' };
}

const ranged = await rangedRun();
const direct = await directRun();
const report = {
  scope: `isolated public Mux first ${height}p fMP4 fragment; no service restart`,
  limits: { concurrency: 4, chunkBytes: 512 * 1024, maxBytes: 128 * 1024 * 1024 },
  ranged, direct,
  byteIdentical: ranged.bytes === direct.bytes && ranged.sha256 === direct.sha256,
  speedRatioDirectOverRanged: direct.seconds / ranged.seconds,
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.byteIdentical) process.exitCode = 1;
