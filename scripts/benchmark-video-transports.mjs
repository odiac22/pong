import https from 'node:https';
import http2 from 'node:http2';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
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
const INCLUDE_HTTP1_WHOLE = process.env.PONG_TRANSPORT_INCLUDE_HTTP1 !== '0';
// HTTP/2 remains an opt-in benchmark transport. Production continues using
// HTTP/1.1 until identical-manifest A/B runs prove that H2 is faster.
// For a focused pair, also set PONG_TRANSPORT_INCLUDE_SERIAL=0,
// PONG_TRANSPORT_INCLUDE_ADAPTIVE=0, and one CONCURRENCIES/PER_HOST value.
// Repeat once with PONG_TRANSPORT_HTTP2_FIRST=0 and once with it set to 1.
const INCLUDE_HTTP2_WHOLE = process.env.PONG_TRANSPORT_INCLUDE_HTTP2 === '1';
// Flip this on the repeat run to balance CDN/cache/order effects:
//   PONG_TRANSPORT_HTTP2_FIRST=0, then PONG_TRANSPORT_HTTP2_FIRST=1.
const HTTP2_FIRST = process.env.PONG_TRANSPORT_HTTP2_FIRST === '1';
const INCLUDE_ADAPTIVE = process.env.PONG_TRANSPORT_INCLUDE_ADAPTIVE !== '0';
const ADAPTIVE_FIRST = process.env.PONG_TRANSPORT_ADAPTIVE_FIRST === '1';
const HTTP2_SESSIONS_PER_ORIGIN = parseIntegerList(
  process.env.PONG_TRANSPORT_HTTP2_SESSION_COUNTS || '1,2',
  1,
  4
);
const HTTP2_CONNECT_TIMEOUT_MS = boundedInteger(
  process.env.PONG_TRANSPORT_HTTP2_CONNECT_TIMEOUT_MS,
  Math.min(10_000, REQUEST_TIMEOUT_MS),
  1_000,
  REQUEST_TIMEOUT_MS
);
const HTTP2_INITIAL_WINDOW_BYTES = boundedInteger(
  process.env.PONG_TRANSPORT_HTTP2_INITIAL_WINDOW_BYTES,
  2 * 1024 * 1024,
  64 * 1024,
  16 * 1024 * 1024
);
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

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
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

function awaitPromiseOrAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('request aborted'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason || new Error('request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

class TransportFailure extends Error {
  constructor(message, result = {}) {
    super(message);
    this.name = 'TransportFailure';
    this.result = result;
  }
}

function requestHeaders(url, range = '', validators = {}) {
  const headers = {
    accept: 'video/*,*/*;q=0.8',
    'accept-encoding': 'identity',
    'user-agent': 'Mozilla/5.0 PongTransportBenchmark/1.0',
    referer: `${url.protocol}//${url.host}/`
  };
  if (range) headers.range = range;
  if (validators.strongEtag) headers['if-match'] = validators.strongEtag;
  else if (validators.lastModified) headers['if-unmodified-since'] = validators.lastModified;
  return headers;
}

class Http1RequestMetrics {
  constructor() {
    this.requestsStarted = 0;
    this.responsesReceived = 0;
    this.requestErrors = 0;
    this.requestTimeouts = 0;
    this.newSocketRequests = 0;
    this.reusedSocketRequests = 0;
    this.sessionsCreated = 0;
    this.sessionsConnected = 0;
    this.sessionsClosed = 0;
    this.sessionErrors = 0;
    this.nextSessionId = 0;
    this.socketIds = new WeakMap();
    this.alpnObserved = new WeakSet();
    this.alpnProtocols = new Map();
  }

  observeRequest(request) {
    this.requestsStarted++;
    request.once('socket', socket => {
      if (!this.socketIds.has(socket)) {
        this.socketIds.set(socket, ++this.nextSessionId);
        this.sessionsCreated++;
        socket.once('close', () => { this.sessionsClosed++; });
        socket.once('error', () => { this.sessionErrors++; });
      }
      const recordAlpn = () => {
        if (this.alpnObserved.has(socket)) return;
        this.alpnObserved.add(socket);
        this.sessionsConnected++;
        const protocol = String(socket.alpnProtocol || 'none');
        this.alpnProtocols.set(protocol, Number(this.alpnProtocols.get(protocol) || 0) + 1);
      };
      if (socket.connecting) socket.once('secureConnect', recordAlpn);
      else recordAlpn();
    });
  }

  observeResponse(request, response) {
    this.responsesReceived++;
    if (request.reusedSocket) this.reusedSocketRequests++;
    else this.newSocketRequests++;
    response.pongProtocol = `http/${String(response.httpVersion || '1.1')}`;
    response.pongSessionId = Number(this.socketIds.get(response.socket) || 0);
  }

  snapshot() {
    return {
      requestedProtocol: 'http/1.1',
      sessionsPerOrigin: null,
      sessionsCreated: this.sessionsCreated,
      sessionsConnected: this.sessionsConnected,
      sessionsClosed: this.sessionsClosed,
      sessionErrors: this.sessionErrors,
      goaways: null,
      requestsStarted: this.requestsStarted,
      responsesReceived: this.responsesReceived,
      requestErrors: this.requestErrors,
      requestTimeouts: this.requestTimeouts,
      newSocketRequests: this.newSocketRequests,
      reusedSocketRequests: this.reusedSocketRequests,
      retriesBeforeHeaders: 0,
      streamErrors: 0,
      peakStreamsPerSession: 1,
      alpnProtocols: Object.fromEntries(this.alpnProtocols),
      remoteMaxConcurrentStreams: []
    };
  }
}

function retryableHttp2Error(error) {
  if (
    String(error?.code || '') === 'ERR_HTTP2_STREAM_ERROR' &&
    Number(error?.pongHttp2RstCode) === http2.constants.NGHTTP2_REFUSED_STREAM
  ) return true;
  return [
    'ERR_HTTP2_GOAWAY_SESSION',
    'ERR_HTTP2_INVALID_SESSION',
    'ERR_HTTP2_STREAM_CANCEL',
    'ECONNRESET',
    'EPIPE'
  ].includes(String(error?.code || ''));
}

class PersistentHttp2Pool {
  constructor(sessionsPerOrigin) {
    this.sessionsPerOrigin = sessionsPerOrigin;
    this.origins = new Map();
    this.allSessions = new Set();
    this.nextSessionId = 0;
    this.closed = false;
    this.metrics = {
      sessionsCreated: 0,
      sessionsConnected: 0,
      sessionsClosed: 0,
      sessionErrors: 0,
      goaways: 0,
      requestsStarted: 0,
      responsesReceived: 0,
      retriesBeforeHeaders: 0,
      streamErrors: 0,
      requestTimeouts: 0,
      connectErrors: 0,
      alpnFailures: 0,
      requestCreateErrors: 0,
      preHeaderErrors: 0,
      preHeaderAborts: 0,
      preHeaderCloses: 0,
      refusedStreamRetries: 0,
      peakStreamsPerSession: 0,
      alpnProtocols: new Map(),
      remoteMaxConcurrentStreams: new Set()
    };
  }

  originState(url) {
    const origin = url.origin;
    let state = this.origins.get(origin);
    if (!state) {
      state = {
        origin,
        slots: Array.from({ length: this.sessionsPerOrigin }, () => null),
        cursor: 0
      };
      this.origins.set(origin, state);
    }
    return state;
  }

  createSlot(state, index) {
    if (this.closed) throw new Error('HTTP/2 pool is closed');
    const session = http2.connect(state.origin, {
      settings: {
        enablePush: false,
        initialWindowSize: HTTP2_INITIAL_WINDOW_BYTES
      }
    });
    const slot = {
      id: ++this.nextSessionId,
      session,
      active: 0,
      peakActive: 0,
      retiring: false,
      ready: null
    };
    state.slots[index] = slot;
    this.allSessions.add(session);
    this.metrics.sessionsCreated++;

    slot.ready = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        session.off('connect', connected);
        session.off('error', failed);
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(slot);
      };
      const connected = () => {
        const alpn = String(session.socket?.alpnProtocol || 'none');
        this.metrics.alpnProtocols.set(alpn, Number(this.metrics.alpnProtocols.get(alpn) || 0) + 1);
        if (alpn !== 'h2') {
          this.metrics.alpnFailures++;
          const error = new Error(`origin negotiated ${alpn} instead of h2`);
          error.code = 'PONG_HTTP2_ALPN_MISMATCH';
          slot.retiring = true;
          if (state.slots[index] === slot) state.slots[index] = null;
          session.destroy(error);
          finish(error);
          return;
        }
        this.metrics.sessionsConnected++;
        finish();
      };
      const failed = error => {
        if (!settled) this.metrics.connectErrors++;
        slot.retiring = true;
        if (state.slots[index] === slot) state.slots[index] = null;
        finish(error);
      };
      timer = setTimeout(() => {
        const error = new Error('HTTP/2 connection timed out');
        error.code = 'PONG_HTTP2_CONNECT_TIMEOUT';
        slot.retiring = true;
        if (state.slots[index] === slot) state.slots[index] = null;
        session.destroy(error);
        finish(error);
      }, HTTP2_CONNECT_TIMEOUT_MS);
      session.once('connect', connected);
      session.once('error', failed);
    });

    session.on('remoteSettings', settings => {
      const maximum = Number(settings?.maxConcurrentStreams);
      if (Number.isFinite(maximum)) this.metrics.remoteMaxConcurrentStreams.add(maximum);
    });
    session.on('goaway', () => {
      this.metrics.goaways++;
      slot.retiring = true;
      if (state.slots[index] === slot) state.slots[index] = null;
    });
    session.on('error', () => {
      this.metrics.sessionErrors++;
    });
    session.on('close', () => {
      this.metrics.sessionsClosed++;
      this.allSessions.delete(session);
      slot.retiring = true;
      if (state.slots[index] === slot) state.slots[index] = null;
    });
    return slot;
  }

  async selectSlot(url, signal = null) {
    const state = this.originState(url);
    const index = state.cursor++ % this.sessionsPerOrigin;
    let slot = state.slots[index];
    if (!slot || slot.retiring || slot.session.closed || slot.session.destroyed) {
      slot = this.createSlot(state, index);
    }
    await awaitPromiseOrAbort(slot.ready, signal);
    return slot;
  }

  async openResponse(url, { method = 'GET', range = '', validators = {}, signal }) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.openResponseOnce(url, { method, range, validators, signal });
      } catch (error) {
        lastError = error;
        if (attempt || signal?.aborted || !retryableHttp2Error(error)) throw error;
        this.metrics.retriesBeforeHeaders++;
        if (
          String(error?.code || '') === 'ERR_HTTP2_STREAM_ERROR' &&
          Number(error?.pongHttp2RstCode) === http2.constants.NGHTTP2_REFUSED_STREAM
        ) this.metrics.refusedStreamRetries++;
      }
    }
    throw lastError || new Error('HTTP/2 request failed');
  }

  async openResponseOnce(url, { method = 'GET', range = '', validators = {}, signal }) {
    if (signal?.aborted) throw signal.reason || new Error('request aborted');
    const target = validateSourceUrl(url);
    const slot = await this.selectSlot(target, signal);
    if (signal?.aborted) throw signal.reason || new Error('request aborted');
    const headers = {
      ':method': method,
      ':scheme': target.protocol.slice(0, -1),
      ':authority': target.host,
      ':path': `${target.pathname}${target.search}`,
      ...requestHeaders(target, range, validators)
    };
    this.metrics.requestsStarted++;
    let stream;
    try {
      stream = slot.session.request(headers);
    } catch (error) {
      this.metrics.requestCreateErrors++;
      slot.retiring = true;
      throw error;
    }
    slot.active++;
    slot.peakActive = Math.max(slot.peakActive, slot.active);
    this.metrics.peakStreamsPerSession = Math.max(
      this.metrics.peakStreamsPerSession,
      slot.peakActive
    );

    return new Promise((resolve, reject) => {
      let responseReceived = false;
      let preHeaderFailureRecorded = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        slot.active = Math.max(0, slot.active - 1);
        signal?.removeEventListener('abort', abort);
      };
      const failBeforeResponse = (error, kind) => {
        if (responseReceived || preHeaderFailureRecorded) return;
        preHeaderFailureRecorded = true;
        if (kind === 'error') this.metrics.preHeaderErrors++;
        else if (kind === 'aborted') this.metrics.preHeaderAborts++;
        else if (kind === 'close') this.metrics.preHeaderCloses++;
        reject(error);
      };
      const abort = () => {
        const error = signal?.reason instanceof Error ? signal.reason : new Error('request aborted');
        stream.destroy(error);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (typeof stream.setTimeout === 'function') {
        stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
          this.metrics.requestTimeouts++;
          const error = new Error('request inactivity timeout');
          error.code = 'PONG_HTTP2_REQUEST_TIMEOUT';
          stream.destroy(error);
        });
      }
      stream.once('response', rawHeaders => {
        responseReceived = true;
        this.metrics.responsesReceived++;
        const responseHeaders = {};
        for (const [name, value] of Object.entries(rawHeaders || {})) {
          if (!name.startsWith(':')) responseHeaders[name] = value;
        }
        stream.statusCode = Number(rawHeaders?.[':status'] || 0);
        stream.headers = responseHeaders;
        stream.httpVersion = '2.0';
        stream.pongProtocol = 'h2';
        stream.pongSessionId = slot.id;
        resolve(stream);
      });
      stream.once('error', error => {
        this.metrics.streamErrors++;
        error.pongHttp2RstCode = Number(stream.rstCode);
        failBeforeResponse(error, 'error');
      });
      stream.once('aborted', () => {
        failBeforeResponse(new Error('HTTP/2 stream aborted before response'), 'aborted');
      });
      stream.once('close', () => {
        release();
        failBeforeResponse(new Error('HTTP/2 stream closed before response'), 'close');
      });
      stream.end();
    });
  }

  snapshot() {
    return {
      requestedProtocol: 'h2',
      sessionsPerOrigin: this.sessionsPerOrigin,
      origins: this.origins.size,
      sessionsCreated: this.metrics.sessionsCreated,
      sessionsConnected: this.metrics.sessionsConnected,
      sessionsClosed: this.metrics.sessionsClosed,
      sessionErrors: this.metrics.sessionErrors,
      goaways: this.metrics.goaways,
      requestsStarted: this.metrics.requestsStarted,
      responsesReceived: this.metrics.responsesReceived,
      requestErrors: this.metrics.connectErrors + this.metrics.alpnFailures +
        this.metrics.requestCreateErrors + this.metrics.preHeaderErrors +
        this.metrics.preHeaderAborts + this.metrics.preHeaderCloses,
      requestTimeouts: this.metrics.requestTimeouts,
      newSocketRequests: null,
      reusedSocketRequests: null,
      retriesBeforeHeaders: this.metrics.retriesBeforeHeaders,
      streamErrors: this.metrics.streamErrors,
      connectErrors: this.metrics.connectErrors,
      alpnFailures: this.metrics.alpnFailures,
      requestCreateErrors: this.metrics.requestCreateErrors,
      preHeaderErrors: this.metrics.preHeaderErrors,
      preHeaderAborts: this.metrics.preHeaderAborts,
      preHeaderCloses: this.metrics.preHeaderCloses,
      refusedStreamRetries: this.metrics.refusedStreamRetries,
      peakStreamsPerSession: this.metrics.peakStreamsPerSession,
      alpnProtocols: Object.fromEntries(this.metrics.alpnProtocols),
      remoteMaxConcurrentStreams: [...this.metrics.remoteMaxConcurrentStreams].sort((a, b) => a - b)
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.allSessions];
    const waits = sessions.map(session => new Promise(resolve => {
      if (session.closed || session.destroyed) {
        resolve();
        return;
      }
      session.once('close', resolve);
      session.close();
    }));
    await Promise.race([
      Promise.allSettled(waits),
      delay(1_000)
    ]);
    for (const session of sessions) {
      if (!session.destroyed) session.destroy();
    }
    await Promise.race([
      Promise.allSettled(waits),
      delay(500)
    ]);
  }
}

function openResponse(url, {
  agent,
  h2Pool = null,
  requestMetrics = null,
  method = 'GET',
  range = '',
  validators = {},
  signal
}) {
  if (h2Pool) return h2Pool.openResponse(url, { method, range, validators, signal });
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      agent,
      signal,
      timeout: REQUEST_TIMEOUT_MS,
      headers: requestHeaders(url, range, validators)
    }, response => {
      requestMetrics?.observeResponse(request, response);
      resolve(response);
    });
    requestMetrics?.observeRequest(request);
    request.once('timeout', () => {
      if (requestMetrics) requestMetrics.requestTimeouts++;
      request.destroy(new Error('request inactivity timeout'));
    });
    request.once('error', error => {
      if (requestMetrics) requestMetrics.requestErrors++;
      reject(error);
    });
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
    const finalUrl = validateSourceUrl(resolved.finalUrl);
    const etag = String(response.headers.etag || '');
    return {
      ...item,
      sourceUrl: item.url,
      url: finalUrl.href,
      host: finalUrl.hostname.toLowerCase(),
      path: finalUrl.pathname,
      finalUrl: finalUrl.href,
      redirects: resolved.redirects,
      size,
      etag,
      strongEtag: etag && !/^W\//i.test(etag) ? etag : '',
      lastModified: String(response.headers['last-modified'] || ''),
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
      sourceUrl: item.url,
      finalUrl: '',
      redirects: 0,
      etag: '',
      strongEtag: '',
      lastModified: '',
      size: Number(item.size || 0),
      rangeSupported: false,
      probeStatus: Number(error?.result?.status || 0),
      probeBytes: Number(error?.result?.networkBytes || 0),
      probeFirstByteMs: null,
      probeError: sanitizeError(error)
    };
  }
}

async function qualifyHttp2Origins(items, signal) {
  const candidates = items.filter(item => (
    item.finalUrl &&
    Number(item.size || 0) > 0 &&
    [200, 206].includes(Number(item.probeStatus || 0))
  ));
  const representativeByOrigin = new Map();
  for (const item of candidates) {
    const url = validateSourceUrl(item.finalUrl);
    if (!representativeByOrigin.has(url.origin)) representativeByOrigin.set(url.origin, url);
  }
  const pool = new PersistentHttp2Pool(1);
  const eligibleOrigins = new Set();
  const origins = [];
  try {
    for (const [origin, url] of representativeByOrigin) {
      if (signal.aborted) throw signal.reason || new Error('benchmark aborted');
      try {
        await pool.selectSlot(url, signal);
        eligibleOrigins.add(origin);
        origins.push({ originSha256: crypto.createHash('sha256').update(origin).digest('hex'), h2: true, error: '' });
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
        origins.push({
          originSha256: crypto.createHash('sha256').update(origin).digest('hex'),
          h2: false,
          error: sanitizeError(error)
        });
      }
    }
  } finally {
    await pool.close();
  }
  return {
    items: candidates.filter(item => eligibleOrigins.has(new URL(item.finalUrl).origin)),
    report: {
      checkedOrigins: origins.length,
      eligibleOrigins: eligibleOrigins.size,
      excludedFiles: items.length - candidates.filter(item => (
        eligibleOrigins.has(new URL(item.finalUrl).origin)
      )).length,
      origins,
      connectionMetrics: pool.snapshot()
    }
  };
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
  h2Pool = null,
  requestMetrics = null,
  validators = {},
  signal,
  fileStartedAt
}) {
  const requestStartedAt = performance.now();
  let response;
  let networkBytes = 0;
  let firstByteAt = 0;
  let status = 0;
  let redirects = 0;
  let protocol = '';
  let sessionId = 0;
  try {
    const range = expectedStart === null ? '' : `bytes=${expectedStart}-${expectedEnd}`;
    const resolved = await resolveResponse(rawUrl, {
      agent,
      h2Pool,
      requestMetrics,
      validators,
      range,
      signal
    });
    response = resolved.response;
    redirects = resolved.redirects;
    status = Number(response.statusCode || 0);
    protocol = String(response.pongProtocol || `http/${response.httpVersion || '1.1'}`);
    sessionId = Number(response.pongSessionId || 0);
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
    const responseEtag = String(response.headers.etag || '');
    const responseLastModified = String(response.headers['last-modified'] || '');
    if (validators.strongEtag && responseEtag && validators.strongEtag !== responseEtag) {
      response.destroy();
      throw new TransportFailure('response ETag changed after manifest freeze', {
        status,
        networkBytes,
        firstByteMs: null
      });
    }
    if (
      !validators.strongEtag &&
      validators.lastModified &&
      responseLastModified &&
      validators.lastModified !== responseLastModified
    ) {
      response.destroy();
      throw new TransportFailure('response Last-Modified changed after manifest freeze', {
        status,
        networkBytes,
        firstByteMs: null
      });
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
      protocol,
      sessionId,
      error: ''
    };
  } catch (error) {
    response?.destroy();
    if (error instanceof TransportFailure) {
      error.result = {
        status,
        redirects,
        networkBytes,
        protocol,
        sessionId,
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
      protocol,
      sessionId,
      firstByteMs: firstByteAt ? firstByteAt - fileStartedAt : null,
      completionMs: performance.now() - fileStartedAt
    });
  }
}

async function downloadWholeFile(item, filePath, requestContext, signal) {
  const fileStartedAt = performance.now();
  try {
    const request = await downloadRequest({
      rawUrl: item.url,
      filePath,
      ...requestContext,
      validators: {
        strongEtag: item.strongEtag,
        lastModified: item.lastModified
      },
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
      protocol: request.protocol,
      sessionId: request.sessionId,
      filePath,
      contentSha256: '',
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
      protocol: String(result.protocol || ''),
      sessionId: Number(result.sessionId || 0),
      filePath,
      contentSha256: '',
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

async function downloadTwoRangeFile(item, filePath, requestContext, scenarioSignal) {
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
      ...requestContext,
      validators: {
        strongEtag: item.strongEtag,
        lastModified: item.lastModified
      },
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
      protocol: String(results.find(result => result.protocol)?.protocol || ''),
      sessionId: 0,
      filePath,
      contentSha256: '',
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
      protocol: String(results.find(result => result.protocol)?.protocol || ''),
      sessionId: 0,
      filePath,
      contentSha256: '',
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

function summarizeScenario(definition, results, elapsedMs, connectionMetrics) {
  const networkBytes = results.reduce((sum, result) => sum + Number(result.networkBytes || 0), 0);
  const usefulBytes = results.reduce((sum, result) => sum + Number(result.usefulBytes || 0), 0);
  const errors = results.filter(result => !result.ok);
  const successful = results.filter(result => result.ok);
  const protocolCounts = {};
  for (const result of results) {
    const protocol = String(result.protocol || 'unknown');
    protocolCounts[protocol] = Number(protocolCounts[protocol] || 0) + 1;
  }
  return {
    name: definition.name,
    transport: definition.adaptive
      ? 'adaptive-two-range-large-files'
      : definition.protocol === 'http2'
        ? 'http2-whole-file'
        : 'http1-whole-file',
    requestedProtocol: definition.protocol === 'http2' ? 'h2' : 'http/1.1',
    protocolsObserved: protocolCounts,
    sessionsPerOrigin: definition.protocol === 'http2'
      ? Number(definition.sessionsPerOrigin || 1)
      : null,
    connectionMetrics,
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
      min: percentile(successful.map(result => result.firstByteMs), 0),
      p50: percentile(successful.map(result => result.firstByteMs), 0.5),
      p95: percentile(successful.map(result => result.firstByteMs), 0.95),
      max: percentile(successful.map(result => result.firstByteMs), 1)
    },
    completionMs: {
      min: percentile(successful.map(result => result.completionMs), 0),
      p50: percentile(successful.map(result => result.completionMs), 0.5),
      p95: percentile(successful.map(result => result.completionMs), 0.95),
      max: percentile(successful.map(result => result.completionMs), 1)
    },
    filesDetail: results.map(result => ({
      id: result.id,
      host: result.host,
      mode: result.mode,
      ok: result.ok,
      expectedBytes: result.expectedBytes,
      networkBytes: result.networkBytes,
      usefulBytes: result.usefulBytes,
      sizeMismatch: result.sizeMismatch,
      firstByteMs: result.firstByteMs === null ? null : Number(Number(result.firstByteMs).toFixed(2)),
      completionMs: Number(Number(result.completionMs || 0).toFixed(2)),
      status: result.status,
      segments: result.segments,
      protocol: result.protocol,
      sessionId: result.sessionId || null,
      contentSha256: result.contentSha256 || '',
      error: result.error
    }))
  };
}

function pairedContentIntegrity(scenarioReports) {
  if (scenarioReports.length < 2) {
    return { scenarios: scenarioReports.length, comparableFiles: 0, hashMismatches: [], complete: false };
  }
  const ids = new Set(scenarioReports.flatMap(report => report.filesDetail.map(file => file.id)));
  const comparable = [];
  const hashMismatches = [];
  for (const id of ids) {
    const entries = scenarioReports.map(report => report.filesDetail.find(file => file.id === id));
    if (entries.some(entry => !entry?.ok || !entry.contentSha256)) continue;
    const hashes = new Set(entries.map(entry => entry.contentSha256));
    if (hashes.size === 1) comparable.push(id);
    else hashMismatches.push(id);
  }
  return {
    scenarios: scenarioReports.length,
    comparableFiles: comparable.length,
    comparableFileIds: comparable,
    hashMismatches,
    complete: comparable.length === ids.size && hashMismatches.length === 0
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
  const h2Pool = definition.protocol === 'http2'
    ? new PersistentHttp2Pool(Number(definition.sessionsPerOrigin || 1))
    : null;
  const requestMetrics = h2Pool ? null : new Http1RequestMetrics();
  const agent = h2Pool ? null : new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: Math.max(2, definition.concurrency),
    maxFreeSockets: Math.max(2, definition.concurrency),
    scheduling: 'lifo'
  });
  const requestContext = { agent, h2Pool, requestMetrics };
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
      ? downloadTwoRangeFile(entry.item, filePath, requestContext, signal)
      : downloadWholeFile(entry.item, filePath, requestContext, signal))
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
    const elapsedMs = performance.now() - startedAt;
    for (const result of results.filter(item => item.ok)) {
      try {
        result.contentSha256 = await sha256File(result.filePath);
      } catch (error) {
        result.ok = false;
        result.usefulBytes = 0;
        result.error = `content hash failed: ${sanitizeError(error)}`;
      }
    }
    if (h2Pool) await h2Pool.close();
    else agent.destroy();
    return summarizeScenario(
      definition,
      results,
      elapsedMs,
      h2Pool ? h2Pool.snapshot() : requestMetrics.snapshot()
    );
  } finally {
    if (h2Pool) await h2Pool.close();
    else agent.destroy();
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
    const values = Array.isArray(supplied) ? supplied : supplied?.urls || supplied?.videos;
    if (!Array.isArray(values)) {
      throw new Error('supplied URL JSON must be an array, {"urls": [...]}, or a Pong video fixture');
    }
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
  const adaptiveScenarios = [];
  if (INCLUDE_SERIAL_BASELINE && INCLUDE_HTTP1_WHOLE) {
    scenarios.push({
      name: 'whole-c1-h1',
      protocol: 'http1',
      adaptive: false,
      concurrency: 1,
      perHost: 1
    });
  }
  for (const concurrency of GLOBAL_CONCURRENCIES) {
    for (const perHost of PER_HOST_CONCURRENCIES) {
      const boundedPerHost = Math.min(concurrency, perHost);
      const http1 = INCLUDE_HTTP1_WHOLE
        ? [{
          name: `whole-c${concurrency}-h${boundedPerHost}`,
          protocol: 'http1',
          adaptive: false,
          concurrency,
          perHost: boundedPerHost
        }]
        : [];
      const http2Scenarios = INCLUDE_HTTP2_WHOLE
        ? HTTP2_SESSIONS_PER_ORIGIN.map(sessionsPerOrigin => ({
            name: `h2s${sessionsPerOrigin}-whole-c${concurrency}-h${boundedPerHost}`,
            protocol: 'http2',
            sessionsPerOrigin,
            adaptive: false,
            concurrency,
            perHost: boundedPerHost
          }))
        : [];
      scenarios.push(...(HTTP2_FIRST
        ? [...http2Scenarios, ...http1]
        : [...http1, ...http2Scenarios]));
    }
  }
  if (INCLUDE_ADAPTIVE) {
    for (const config of ADAPTIVE_CONFIGS) {
      adaptiveScenarios.push({
        name: `adaptive2-c${config.concurrency}-h${config.perHost}`,
        protocol: 'http1',
        adaptive: true,
        ...config
      });
    }
  }
  const ordered = ADAPTIVE_FIRST
    ? [...adaptiveScenarios, ...scenarios]
    : [...scenarios, ...adaptiveScenarios];
  if (!ordered.length) throw new Error('transport benchmark has no enabled scenarios');
  return ordered;
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

    let scenarioItems = probed;
    let http2Qualification = null;
    if (INCLUDE_HTTP2_WHOLE) {
      const qualification = await qualifyHttp2Origins(probed, rootAbortController.signal);
      scenarioItems = qualification.items;
      http2Qualification = qualification.report;
      if (!scenarioItems.length) {
        throw new Error('none of the resolved media origins negotiated HTTP/2');
      }
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
        scenarioItems,
        runDirectory,
        rootAbortController.signal
      );
      scenarioReports.push(report);
      process.stderr.write(
        `[transport-bench] ${definition.name}: ${report.completed}/${report.files}, ` +
        `${report.usefulMbps} useful Mbps (${report.aggregateMbps} wire), ` +
        `${report.http429} HTTP 429\n`
      );
      if (index + 1 < scenarios.length && SCENARIO_COOLDOWN_MS) {
        await delay(SCENARIO_COOLDOWN_MS);
      }
    }

    const manifestDigest = crypto.createHash('sha256')
      .update(probed.map(item => item.url).join('\n'))
      .digest('hex');
    const report = {
      schema: 'pong-video-transport-benchmark-v2',
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
      scenarioFiles: scenarioItems.length,
      http2Qualification,
      pairedContentIntegrity: pairedContentIntegrity(scenarioReports),
      files: probed.map(item => ({
        id: item.id,
        host: item.host,
        path: item.path,
        size: item.size,
        redirects: item.redirects,
        strongValidator: Boolean(item.strongEtag),
        lastModifiedValidator: !item.strongEtag && Boolean(item.lastModified),
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
        includeHttp1Whole: INCLUDE_HTTP1_WHOLE,
        includeHttp2Whole: INCLUDE_HTTP2_WHOLE,
        http2First: HTTP2_FIRST,
        http2SessionsPerOrigin: HTTP2_SESSIONS_PER_ORIGIN,
        http2ConnectTimeoutMs: HTTP2_CONNECT_TIMEOUT_MS,
        http2InitialWindowBytes: HTTP2_INITIAL_WINDOW_BYTES,
        includeAdaptive: INCLUDE_ADAPTIVE,
        adaptiveFirst: ADAPTIVE_FIRST
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
