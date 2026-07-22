import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, rmdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';

// Transport-only benchmark. It never creates a media element, invokes a
// decoder, or opens a downloaded file. Bytes are written under one validated,
// hidden temporary directory and logically deleted after every scenario.

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCAL_AI_DIR = path.resolve(ROOT, '.pong-local-ai');
const BENCHMARK_TEMP_ROOT = path.resolve(LOCAL_AI_DIR, '.transport-benchmark-tmp');
const LOCAL_AI_ENDPOINT = String(
  process.env.PONG_TRANSPORT_LOCAL_AI || 'http://127.0.0.1:8787'
).replace(/\/+$/, '');
const VIDEO_COUNT = boundedInteger(process.env.PONG_TRANSPORT_VIDEO_COUNT, 10, 1, 100);
const REQUEST_TIMEOUT_MS = boundedInteger(
  process.env.PONG_TRANSPORT_REQUEST_TIMEOUT_MS,
  120_000,
  5_000,
  30 * 60_000
);
const LARGE_FILE_BYTES = parseByteSize(
  process.env.PONG_TRANSPORT_LARGE_FILE_BYTES || '64M',
  64 * 1024 * 1024
);
const SCENARIO_COOLDOWN_MS = boundedInteger(
  process.env.PONG_TRANSPORT_COOLDOWN_MS,
  1_000,
  0,
  60_000
);
const GLOBAL_CONCURRENCIES = parseIntegerList(
  process.env.PONG_TRANSPORT_CONCURRENCIES || '4,6,8',
  1,
  24
);
const PER_HOST_CONCURRENCIES = parseIntegerList(
  process.env.PONG_TRANSPORT_PER_HOST || '1,2,3',
  1,
  12
);
const ADAPTIVE_CONFIGS = parseAdaptiveConfigs(
  process.env.PONG_TRANSPORT_ADAPTIVE_CONFIGS || '6:2'
);
const INCLUDE_SERIAL_BASELINE = process.env.PONG_TRANSPORT_INCLUDE_SERIAL !== '0';
const INCLUDE_ADAPTIVE = process.env.PONG_TRANSPORT_INCLUDE_ADAPTIVE !== '0';
const ALLOWED_HOST_SUFFIXES = [...new Set(
  String(process.env.PONG_TRANSPORT_ALLOWED_HOSTS || 'coomerfans.com,onlyfaphouse.com')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
)];

const rootAbortController = new AbortController();
let interruptedSignal = '';
for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.once(signalName, () => {
    interruptedSignal = signalName;
    rootAbortController.abort(new Error(`benchmark interrupted by ${signalName}`));
  });
}

function boundedInteger(raw, fallback, minimum, maximum) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function parseIntegerList(raw, minimum, maximum) {
  const values = String(raw || '')
    .split(',')
    .map(Number)
    .filter(value => Number.isInteger(value) && value >= minimum && value <= maximum);
  if (!values.length) throw new Error(`expected integers between ${minimum} and ${maximum}`);
  return [...new Set(values)];
}

function parseAdaptiveConfigs(raw) {
  const configs = [];
  for (const value of String(raw || '').split(',')) {
    const match = value.trim().match(/^(\d+)\s*:\s*(\d+)$/);
    if (!match) continue;
    const concurrency = boundedInteger(match[1], 6, 2, 24);
    const perHost = boundedInteger(match[2], 2, 1, 12);
    configs.push({ concurrency, perHost: Math.min(concurrency, perHost) });
  }
  if (!configs.length) throw new Error('PONG_TRANSPORT_ADAPTIVE_CONFIGS must contain values like 6:2');
  return configs;
}

function parseByteSize(raw, fallback) {
  const match = String(raw || '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i);
  if (!match) return fallback;
  const powers = { '': 0, k: 1, m: 2, g: 3, t: 4 };
  const power = powers[match[2].toLowerCase()];
  const value = Number(match[1]) * (1024 ** power);
  return Number.isSafeInteger(Math.round(value)) && value > 0 ? Math.round(value) : fallback;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertPathInside(parent, target, label) {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedParent, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`unsafe ${label} path: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function assertBenchmarkRoot() {
  const relative = path.relative(LOCAL_AI_DIR, BENCHMARK_TEMP_ROOT);
  if (
    relative !== '.transport-benchmark-tmp' ||
    path.dirname(BENCHMARK_TEMP_ROOT) !== LOCAL_AI_DIR
  ) throw new Error(`unsafe benchmark root: ${BENCHMARK_TEMP_ROOT}`);
}

async function removeScenarioDirectory(runDirectory, scenarioDirectory) {
  const safePath = assertPathInside(runDirectory, scenarioDirectory, 'scenario');
  await rm(safePath, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

async function removeRunDirectory(runDirectory) {
  const safePath = assertPathInside(BENCHMARK_TEMP_ROOT, runDirectory, 'run');
  await rm(safePath, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}

async function markHidden(directory) {
  if (process.platform !== 'win32') return;
  await new Promise(resolve => {
    const child = spawn('attrib', ['+H', directory], {
      windowsHide: true,
      stdio: 'ignore'
    });
    child.once('error', resolve);
    child.once('exit', resolve);
  });
}

function validateSourceUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch (_) {
    throw new Error('invalid source URL');
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = url.protocol === 'https:' && ALLOWED_HOST_SUFFIXES.some(suffix => (
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  ));
  if (!allowed || url.username || url.password) {
    throw new Error(`source host is not allowed: ${hostname || 'unknown'}`);
  }
  return url;
}

function canonicalMediaIdentity(rawUrl) {
  const url = validateSourceUrl(rawUrl);
  return `${url.hostname.toLowerCase()}${url.pathname}`;
}

function mediaId(rawUrl) {
  return crypto.createHash('sha256').update(canonicalMediaIdentity(rawUrl)).digest('hex').slice(0, 16);
}

function safeFileName(index, item) {
  return `${String(index + 1).padStart(3, '0')}-${item.id}.transport`;
}

function sanitizeError(error) {
  const value = String(error?.message || error || 'unknown error');
  return value
    .replace(/https?:\/\/[^\s]+/gi, '[source-url]')
    .replace(/[?&](?:e|hash|token|signature|sig)=[^\s&]+/gi, '')
    .slice(0, 500);
}

function parseContentRange(rawValue) {
  const match = String(rawValue || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3])
  };
}

function linkAbortSignals(...signals) {
  const controller = new AbortController();
  const listeners = [];
  const abort = signal => {
    if (!controller.signal.aborted) controller.abort(signal.reason || new Error('request aborted'));
  };
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    }
  };
}

class TransportFailure extends Error {
  constructor(message, result = {}) {
    super(message);
    this.name = 'TransportFailure';
    this.result = result;
  }
}

function requestHeaders(url, range = '') {
  const headers = {
    accept: 'video/*,*/*;q=0.8',
    'accept-encoding': 'identity',
    'user-agent': 'Mozilla/5.0 PongTransportBenchmark/1.0',
    referer: `${url.protocol}//${url.host}/`
  };
  if (range) headers.range = range;
  return headers;
}

function openResponse(url, { agent, method = 'GET', range = '', signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      agent,
      signal,
      timeout: REQUEST_TIMEOUT_MS,
      headers: requestHeaders(url, range)
    }, resolve);
    request.once('timeout', () => request.destroy(new Error('request inactivity timeout')));
    request.once('error', reject);
    request.end();
  });
}

async function drainResponse(response) {
  await new Promise(resolve => {
    response.once('end', resolve);
    response.once('close', resolve);
    response.once('error', resolve);
    response.resume();
  });
}

async function resolveResponse(rawUrl, options) {
  let current = validateSourceUrl(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await openResponse(current, options);
    const status = Number(response.statusCode || 0);
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      const next = validateSourceUrl(new URL(String(response.headers.location), current).href);
      await drainResponse(response);
      current = next;
      continue;
    }
    return { response, finalUrl: current, redirects };
  }
  throw new Error('too many redirects');
}

async function probeMetadata(item, agent, signal) {
  const startedAt = performance.now();
  let response;
  try {
    const resolved = await resolveResponse(item.url, {
      agent,
      range: 'bytes=0-0',
      signal
    });
    response = resolved.response;
    const status = Number(response.statusCode || 0);
    const contentRange = parseContentRange(response.headers['content-range']);
    const contentLength = Number(response.headers['content-length'] || 0);
    let bytes = 0;
    let firstByteAt = 0;
    if (status === 206) {
      for await (const chunk of response) {
        if (!firstByteAt) firstByteAt = performance.now();
        bytes += chunk.length;
        if (bytes > 64 * 1024) response.destroy(new Error('metadata probe exceeded range limit'));
      }
    } else {
      // A server that ignores Range could return the entire video. Stop before
      // consuming it; whole-file scenarios will measure that route separately.
      response.destroy();
    }
    const size = contentRange?.total || (status === 200 ? contentLength : 0) || Number(item.size || 0);
    return {
      ...item,
      size,
      rangeSupported: status === 206 && contentRange?.start === 0 && contentRange?.end === 0,
      probeStatus: status,
      probeBytes: bytes,
      probeFirstByteMs: firstByteAt ? firstByteAt - startedAt : null,
      probeError: ''
    };
  } catch (error) {
    response?.destroy();
    return {
      ...item,
      size: Number(item.size || 0),
      rangeSupported: false,
      probeStatus: Number(error?.result?.status || 0),
      probeBytes: Number(error?.result?.networkBytes || 0),
      probeFirstByteMs: null,
      probeError: sanitizeError(error)
    };
  }
}

async function downloadRequest({
  rawUrl,
  filePath,
  fileStart = 0,
  expectedStart = null,
  expectedEnd = null,
  expectedTotal = 0,
  flags = 'w',
  agent,
  signal,
  fileStartedAt
}) {
  const requestStartedAt = performance.now();
  let response;
  let networkBytes = 0;
  let firstByteAt = 0;
  let status = 0;
  let redirects = 0;
  try {
    const range = expectedStart === null ? '' : `bytes=${expectedStart}-${expectedEnd}`;
    const resolved = await resolveResponse(rawUrl, { agent, range, signal });
    response = resolved.response;
    redirects = resolved.redirects;
    status = Number(response.statusCode || 0);
    if (status === 429) {
      await drainResponse(response);
      throw new TransportFailure('upstream returned HTTP 429', {
        status,
        networkBytes,
        firstByteMs: null
      });
    }
    if (expectedStart === null) {
      if (status !== 200) {
        await drainResponse(response);
        throw new TransportFailure(`whole-file request returned HTTP ${status || 'unknown'}`, {
          status,
          networkBytes,
          firstByteMs: null
        });
      }
    } else {
      const rangeHeader = parseContentRange(response.headers['content-range']);
      if (
        status !== 206 ||
        !rangeHeader ||
        rangeHeader.start !== expectedStart ||
        rangeHeader.end !== expectedEnd ||
        (expectedTotal && rangeHeader.total !== expectedTotal)
      ) {
        response.destroy();
        throw new TransportFailure(`range request returned invalid HTTP ${status || 'unknown'} response`, {
          status,
          networkBytes,
          firstByteMs: null,
          rangeUnsupported: true
        });
      }
    }

    response.on('data', chunk => {
      if (!firstByteAt) firstByteAt = performance.now();
      networkBytes += chunk.length;
    });
    const output = createWriteStream(filePath, {
      flags,
      start: flags === 'r+' ? fileStart : undefined,
      autoClose: true
    });
    await pipeline(response, output, { signal });
    const endedAt = performance.now();
    const expectedResponseBytes = expectedStart === null
      ? Number(response.headers['content-length'] || 0)
      : expectedEnd - expectedStart + 1;
    if (expectedResponseBytes > 0 && networkBytes !== expectedResponseBytes) {
      throw new TransportFailure(
        `response ended at ${networkBytes} of ${expectedResponseBytes} bytes`,
        {
          status,
          networkBytes,
          firstByteMs: firstByteAt ? firstByteAt - fileStartedAt : null,
          completionMs: endedAt - fileStartedAt
        }
      );
    }
    return {
      ok: true,
      status,
      redirects,
      networkBytes,
      firstByteMs: firstByteAt ? firstByteAt - fileStartedAt : null,
      requestFirstByteMs: firstByteAt ? firstByteAt - requestStartedAt : null,
      completionMs: endedAt - fileStartedAt,
      error: ''
    };
  } catch (error) {
    response?.destroy();
    if (error instanceof TransportFailure) {
      error.result = {
        status,
        redirects,
        networkBytes,
        firstByteMs: firstByteAt ? firstByteAt - fileStartedAt : null,
        completionMs: performance.now() - fileStartedAt,
        ...error.result
      };
      throw error;
    }
    throw new TransportFailure(sanitizeError(error), {
      status,
      redirects,
      networkBytes,
      firstByteMs: firstByteAt ? firstByteAt - fileStartedAt : null,
      completionMs: performance.now() - fileStartedAt
    });
  }
}

async function downloadWholeFile(item, filePath, agent, signal) {
  const fileStartedAt = performance.now();
  try {
    const request = await downloadRequest({
      rawUrl: item.url,
      filePath,
      agent,
      signal,
      fileStartedAt
    });
    const sizeMismatch = item.size > 0 && request.networkBytes !== item.size;
    return {
      id: item.id,
      host: item.host,
      mode: 'whole',
      expectedBytes: item.size || request.networkBytes,
      usefulBytes: sizeMismatch ? 0 : request.networkBytes,
      networkBytes: request.networkBytes,
      firstByteMs: request.firstByteMs,
      completionMs: request.completionMs,
      status: request.status,
      redirects: request.redirects,
      segments: 1,
      sizeMismatch,
      ok: !sizeMismatch,
      error: sizeMismatch ? `metadata size ${item.size} differed from ${request.networkBytes}` : ''
    };
  } catch (error) {
    const result = error?.result || {};
    return {
      id: item.id,
      host: item.host,
      mode: 'whole',
      expectedBytes: item.size || 0,
      usefulBytes: 0,
      networkBytes: Number(result.networkBytes || 0),
      firstByteMs: result.firstByteMs ?? null,
      completionMs: Number(result.completionMs || performance.now() - fileStartedAt),
      status: Number(result.status || 0),
      redirects: Number(result.redirects || 0),
      segments: 1,
      sizeMismatch: false,
      ok: false,
      error: sanitizeError(error)
    };
  }
}

async function prepareSparseFile(filePath, size) {
  const handle = await open(filePath, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

async function downloadTwoRangeFile(item, filePath, agent, scenarioSignal) {
  const fileStartedAt = performance.now();
  const midpoint = Math.floor(item.size / 2);
  const segments = [
    { start: 0, end: midpoint - 1 },
    { start: midpoint, end: item.size - 1 }
  ];
  const fileController = new AbortController();
  const linked = linkAbortSignals(scenarioSignal, fileController.signal);
  let results = [];
  try {
    await prepareSparseFile(filePath, item.size);
    const settled = await Promise.allSettled(segments.map(segment => downloadRequest({
      rawUrl: item.url,
      filePath,
      fileStart: segment.start,
      expectedStart: segment.start,
      expectedEnd: segment.end,
      expectedTotal: item.size,
      flags: 'r+',
      agent,
      signal: linked.signal,
      fileStartedAt
    }).catch(error => {
      // Stop the sibling range immediately. Otherwise one failed segment can
      // leave the benchmark waiting for the other segment's full timeout.
      fileController.abort(error);
      throw error;
    })));
    results = settled.map(result => result.status === 'fulfilled'
      ? result.value
      : { ok: false, ...(result.reason?.result || {}), error: sanitizeError(result.reason) });
    if (settled.some(result => result.status === 'rejected')) {
      fileController.abort(new Error('one range segment failed'));
      throw new TransportFailure('adaptive range pair failed', {
        networkBytes: results.reduce((sum, result) => sum + Number(result.networkBytes || 0), 0),
        firstByteMs: minimumFinite(results.map(result => result.firstByteMs)),
        completionMs: performance.now() - fileStartedAt,
        status: Number(results.find(result => Number(result.status || 0) === 429)?.status || 0),
        segmentErrors: results.filter(result => !result.ok).map(result => result.error)
      });
    }
    const networkBytes = results.reduce((sum, result) => sum + Number(result.networkBytes || 0), 0);
    const completionMs = Math.max(...results.map(result => Number(result.completionMs || 0)));
    return {
      id: item.id,
      host: item.host,
      mode: 'two-range',
      expectedBytes: item.size,
      usefulBytes: networkBytes === item.size ? item.size : 0,
      networkBytes,
      firstByteMs: minimumFinite(results.map(result => result.firstByteMs)),
      completionMs,
      status: 206,
      redirects: results.reduce((sum, result) => sum + Number(result.redirects || 0), 0),
      segments: 2,
      sizeMismatch: networkBytes !== item.size,
      ok: networkBytes === item.size,
      error: networkBytes === item.size ? '' : `range pair ended at ${networkBytes} of ${item.size}`
    };
  } catch (error) {
    const failure = error?.result || {};
    return {
      id: item.id,
      host: item.host,
      mode: 'two-range',
      expectedBytes: item.size,
      usefulBytes: 0,
      networkBytes: Number(failure.networkBytes || 0),
      firstByteMs: failure.firstByteMs ?? minimumFinite(results.map(result => result.firstByteMs)),
      completionMs: Number(failure.completionMs || performance.now() - fileStartedAt),
      status: Number(failure.status || 0),
      redirects: results.reduce((sum, result) => sum + Number(result.redirects || 0), 0),
      segments: 2,
      sizeMismatch: false,
      ok: false,
      error: sanitizeError(error)
    };
  } finally {
    linked.cleanup();
  }
}

function minimumFinite(values) {
  const finite = values
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  return finite.length ? Math.min(...finite) : null;
}

function percentile(values, fraction) {
  const sorted = values
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number(sorted[index].toFixed(2));
}

function summarizeScenario(definition, results, elapsedMs) {
  const networkBytes = results.reduce((sum, result) => sum + Number(result.networkBytes || 0), 0);
  const usefulBytes = results.reduce((sum, result) => sum + Number(result.usefulBytes || 0), 0);
  const errors = results.filter(result => !result.ok);
  return {
    name: definition.name,
    transport: definition.adaptive ? 'adaptive-two-range-large-files' : 'http1-whole-file',
    concurrency: definition.concurrency,
    perHost: definition.perHost,
    largeFileBytes: definition.adaptive ? LARGE_FILE_BYTES : null,
    files: results.length,
    completed: results.length - errors.length,
    errors: errors.length,
    http429: results.filter(result => Number(result.status || 0) === 429).length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    networkBytes,
    usefulBytes,
    aggregateMbps: elapsedMs > 0 ? Number((networkBytes * 8 / elapsedMs / 1000).toFixed(2)) : 0,
    usefulMbps: elapsedMs > 0 ? Number((usefulBytes * 8 / elapsedMs / 1000).toFixed(2)) : 0,
    firstByteMs: {
      min: percentile(results.map(result => result.firstByteMs), 0),
      p50: percentile(results.map(result => result.firstByteMs), 0.5),
      p95: percentile(results.map(result => result.firstByteMs), 0.95),
      max: percentile(results.map(result => result.firstByteMs), 1)
    },
    completionMs: {
      min: percentile(results.map(result => result.completionMs), 0),
      p50: percentile(results.map(result => result.completionMs), 0.5),
      p95: percentile(results.map(result => result.completionMs), 0.95),
      max: percentile(results.map(result => result.completionMs), 1)
    },
    filesDetail: results.map(result => ({
      id: result.id,
      host: result.host,
      mode: result.mode,
      ok: result.ok,
      expectedBytes: result.expectedBytes,
      networkBytes: result.networkBytes,
      firstByteMs: result.firstByteMs === null ? null : Number(Number(result.firstByteMs).toFixed(2)),
      completionMs: Number(Number(result.completionMs || 0).toFixed(2)),
      status: result.status,
      segments: result.segments,
      error: result.error
    }))
  };
}

async function runScenario(definition, items, runDirectory, signal) {
  const scenarioDirectory = assertPathInside(
    runDirectory,
    path.join(runDirectory, definition.name.replace(/[^a-z0-9_.-]/gi, '_')),
    'scenario'
  );
  await mkdir(scenarioDirectory, { recursive: false });
  await markHidden(scenarioDirectory);
  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: Math.max(2, definition.concurrency),
    maxFreeSockets: Math.max(2, definition.concurrency),
    scheduling: 'lifo'
  });
  const pending = items.map((item, index) => {
    const segmented = Boolean(
      definition.adaptive &&
      item.rangeSupported &&
      item.size >= LARGE_FILE_BYTES &&
      definition.concurrency >= 2 &&
      definition.perHost >= 2
    );
    return {
      item,
      index,
      segmented,
      slots: segmented ? 2 : 1
    };
  });
  const active = new Set();
  const activeByHost = new Map();
  let activeSlots = 0;
  const results = [];
  const startedAt = performance.now();

  const launch = entry => {
    const filePath = assertPathInside(
      scenarioDirectory,
      path.join(scenarioDirectory, safeFileName(entry.index, entry.item)),
      'download file'
    );
    activeSlots += entry.slots;
    activeByHost.set(entry.item.host, Number(activeByHost.get(entry.item.host) || 0) + entry.slots);
    let task;
    task = (entry.segmented
      ? downloadTwoRangeFile(entry.item, filePath, agent, signal)
      : downloadWholeFile(entry.item, filePath, agent, signal))
      .then(result => results.push({ index: entry.index, ...result }))
      .finally(() => {
        activeSlots = Math.max(0, activeSlots - entry.slots);
        activeByHost.set(
          entry.item.host,
          Math.max(0, Number(activeByHost.get(entry.item.host) || 0) - entry.slots)
        );
        active.delete(task);
      });
    active.add(task);
  };

  try {
    while (pending.length || active.size) {
      if (signal.aborted) throw signal.reason || new Error('benchmark aborted');
      let launched = false;
      for (let index = 0; index < pending.length;) {
        const entry = pending[index];
        const hostActive = Number(activeByHost.get(entry.item.host) || 0);
        if (
          activeSlots + entry.slots <= definition.concurrency &&
          hostActive + entry.slots <= definition.perHost
        ) {
          pending.splice(index, 1);
          launch(entry);
          launched = true;
          continue;
        }
        index++;
      }
      if (!launched) {
        if (!active.size) throw new Error(`scenario ${definition.name} scheduler could not make progress`);
        await Promise.race(active);
      }
    }
    results.sort((a, b) => a.index - b.index);
    return summarizeScenario(definition, results, performance.now() - startedAt);
  } finally {
    agent.destroy();
    await Promise.allSettled([...active]);
    await removeScenarioDirectory(runDirectory, scenarioDirectory);
  }
}

async function loadInputManifest() {
  let supplied = null;
  if (process.env.PONG_TRANSPORT_URL_FILE) {
    const filePath = path.resolve(String(process.env.PONG_TRANSPORT_URL_FILE));
    supplied = JSON.parse(await readFile(filePath, 'utf8'));
  } else if (process.env.PONG_TRANSPORT_URLS_JSON) {
    supplied = JSON.parse(String(process.env.PONG_TRANSPORT_URLS_JSON));
  } else if (process.env.PONG_TRANSPORT_URLS) {
    supplied = String(process.env.PONG_TRANSPORT_URLS)
      .split(/[\r\n,]+/)
      .map(value => value.trim())
      .filter(Boolean);
  }

  if (supplied !== null) {
    const values = Array.isArray(supplied) ? supplied : supplied?.urls;
    if (!Array.isArray(values)) throw new Error('supplied URL JSON must be an array or {"urls": [...]}');
    return values.map(value => typeof value === 'string'
      ? { url: value, size: 0, sourceStatus: 'supplied' }
      : {
          url: String(value?.url || ''),
          size: Number(value?.size || value?.totalBytes || 0),
          sourceStatus: 'supplied'
        });
  }

  const response = await fetch(`${LOCAL_AI_ENDPOINT}/video-cache/status?t=${Date.now()}`, {
    cache: 'no-store',
    signal: rootAbortController.signal
  });
  if (!response.ok) throw new Error(`video cache status returned HTTP ${response.status}`);
  const payload = await response.json();
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const ordered = [
    ...records.filter(record => record?.ready === true),
    ...records.filter(record => record?.ready !== true)
  ];
  return ordered.map(record => ({
    url: String((Array.isArray(record?.urls) ? record.urls : []).at(-1) || ''),
    size: Number(record?.totalBytes || record?.bytes || 0),
    sourceStatus: String(record?.status || '')
  }));
}

function freezeManifest(rawItems) {
  const seen = new Set();
  const items = [];
  for (const raw of rawItems) {
    if (!raw?.url) continue;
    const identity = canonicalMediaIdentity(raw.url);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const url = validateSourceUrl(raw.url);
    items.push({
      url: url.href,
      id: mediaId(url.href),
      host: url.hostname.toLowerCase(),
      path: url.pathname,
      size: Number(raw.size || 0),
      sourceStatus: String(raw.sourceStatus || '')
    });
    if (items.length >= VIDEO_COUNT) break;
  }
  if (!items.length) {
    throw new Error('no valid source URLs were found; supply PONG_TRANSPORT_URLS_JSON or warm the cache');
  }
  return items;
}

function createScenarios() {
  const scenarios = [];
  if (INCLUDE_SERIAL_BASELINE) {
    scenarios.push({
      name: 'whole-c1-h1',
      adaptive: false,
      concurrency: 1,
      perHost: 1
    });
  }
  for (const concurrency of GLOBAL_CONCURRENCIES) {
    for (const perHost of PER_HOST_CONCURRENCIES) {
      scenarios.push({
        name: `whole-c${concurrency}-h${Math.min(concurrency, perHost)}`,
        adaptive: false,
        concurrency,
        perHost: Math.min(concurrency, perHost)
      });
    }
  }
  if (INCLUDE_ADAPTIVE) {
    for (const config of ADAPTIVE_CONFIGS) {
      scenarios.push({
        name: `adaptive2-c${config.concurrency}-h${config.perHost}`,
        adaptive: true,
        ...config
      });
    }
  }
  if (!scenarios.length) throw new Error('transport benchmark has no enabled scenarios');
  return scenarios;
}

async function main() {
  assertBenchmarkRoot();
  await mkdir(LOCAL_AI_DIR, { recursive: true });
  await mkdir(BENCHMARK_TEMP_ROOT, { recursive: true });
  await markHidden(BENCHMARK_TEMP_ROOT);
  const runDirectory = await mkdtemp(path.join(BENCHMARK_TEMP_ROOT, 'run-'));
  assertPathInside(BENCHMARK_TEMP_ROOT, runDirectory, 'run');
  await markHidden(runDirectory);

  try {
    const frozen = freezeManifest(await loadInputManifest());
    const probeAgent = new https.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
    const probed = [];
    try {
      // Sequential probing avoids polluting the transport comparison with a
      // burst of extra connections. Each successful probe consumes one byte.
      for (const item of frozen) {
        if (rootAbortController.signal.aborted) throw rootAbortController.signal.reason;
        probed.push(await probeMetadata(item, probeAgent, rootAbortController.signal));
      }
    } finally {
      probeAgent.destroy();
    }

    const scenarios = createScenarios();
    const scenarioReports = [];
    for (let index = 0; index < scenarios.length; index++) {
      if (rootAbortController.signal.aborted) throw rootAbortController.signal.reason;
      const definition = scenarios[index];
      process.stderr.write(
        `[transport-bench] ${index + 1}/${scenarios.length} ${definition.name}\n`
      );
      const report = await runScenario(
        definition,
        probed,
        runDirectory,
        rootAbortController.signal
      );
      scenarioReports.push(report);
      process.stderr.write(
        `[transport-bench] ${definition.name}: ${report.completed}/${report.files}, ` +
        `${report.aggregateMbps} Mbps, ${report.http429} HTTP 429\n`
      );
      if (index + 1 < scenarios.length && SCENARIO_COOLDOWN_MS) {
        await delay(SCENARIO_COOLDOWN_MS);
      }
    }

    const manifestDigest = crypto.createHash('sha256')
      .update(probed.map(item => item.url).join('\n'))
      .digest('hex');
    const report = {
      schema: 'pong-video-transport-benchmark-v1',
      generatedAt: new Date().toISOString(),
      safety: {
        transportOnly: true,
        decodedOrPlayedMedia: false,
        visibleDesktopOutput: false,
        childOutputDisabled: true,
        temporaryStorage: BENCHMARK_TEMP_ROOT,
        perScenarioLogicalWipe: true,
        finalLogicalWipe: true
      },
      source: process.env.PONG_TRANSPORT_URL_FILE
        ? 'json-file'
        : process.env.PONG_TRANSPORT_URLS_JSON
          ? 'json-env'
          : process.env.PONG_TRANSPORT_URLS
            ? 'url-env'
            : 'local-video-cache-status',
      manifestSha256: manifestDigest,
      files: probed.map(item => ({
        id: item.id,
        host: item.host,
        path: item.path,
        size: item.size,
        rangeSupported: item.rangeSupported,
        probeStatus: item.probeStatus,
        probeBytes: item.probeBytes,
        probeFirstByteMs: item.probeFirstByteMs,
        probeError: item.probeError,
        sourceStatus: item.sourceStatus
      })),
      configuration: {
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        largeFileBytes: LARGE_FILE_BYTES,
        scenarioCooldownMs: SCENARIO_COOLDOWN_MS,
        globalConcurrencies: GLOBAL_CONCURRENCIES,
        perHostConcurrencies: PER_HOST_CONCURRENCIES,
        adaptiveConfigs: ADAPTIVE_CONFIGS,
        includeSerialBaseline: INCLUDE_SERIAL_BASELINE,
        includeAdaptive: INCLUDE_ADAPTIVE
      },
      scenarios: scenarioReports
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await removeRunDirectory(runDirectory).catch(error => {
      process.stderr.write(`[transport-bench] cleanup failed: ${sanitizeError(error)}\n`);
      process.exitCode = 1;
    });
    // Remove only the exact benchmark root, and only when it is empty. Never
    // recursively remove .pong-local-ai or the production video cache.
    await rmdir(BENCHMARK_TEMP_ROOT).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`[transport-bench] ${sanitizeError(error)}\n`);
  process.exitCode = interruptedSignal ? 130 : 1;
});
