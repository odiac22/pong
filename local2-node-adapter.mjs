import {
  LOCAL2_PIPELINE_SCHEMA,
  Local2CacheBundle,
  Local2ContinuousPipeline,
  local2ArtistIdentity
} from './local2-pipeline.mjs';

const ADAPTER_SCHEMA = 'pong.local2.node-adapter.v1';

function text(value, maximum = 4096) {
  return String(value || '').trim().slice(0, maximum);
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function revisionFrom(value) {
  if (typeof value === 'string') return text(value, 256);
  return text(
    value?.local2_revision ||
    value?.local2Revision ||
    value?.model_revision ||
    value?.modelRevision ||
    value?.revision,
    256
  );
}

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

function uniqueHttpUrls(values, maximum) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(httpUrl)
    .filter(Boolean))].slice(0, maximum);
}

function sanitizeLearningPayload(payload = {}) {
  const label = text(payload.label, 16).toLowerCase();
  if (!['accept', 'reject'].includes(label)) throw new Error('Local2 learning label must be accept or reject');
  const artist = payload.artist && typeof payload.artist === 'object' ? payload.artist : {};
  const artistUrl = httpUrl(artist.artistUrl || payload.artistUrl);
  const artistId = local2ArtistIdentity({
    artistId: artist.artistId || payload.artistId,
    artistUrl
  });
  if (!artistId) throw new Error('Local2 learning requires an artist identity');
  const imageUrls = uniqueHttpUrls(payload.imageUrls, 16);
  if (!imageUrls.length) throw new Error('Local2 learning requires HTTP(S) image URLs');
  return {
    schema: 'pong.local2.learning.v1',
    mode: 'local2',
    label,
    artist: {
      artistId,
      artistUrl,
      artistName: text(artist.artistName || payload.artistName, 256)
    },
    imageUrls,
    rejectReason: text(payload.rejectReason, 240),
    rejectReasonLabel: text(payload.rejectReasonLabel, 80)
  };
}

async function readJsonBody(req, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error('Local2 request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store'
  });
  res.end(encoded);
}

/**
 * Creates a lazy Local2-only HTTP adapter.
 *
 * The adapter never performs source, image, or media I/O itself. All such work
 * is supplied through injected workers and an optional producer. Construction
 * and GET /local2/health are inert; the first start/candidates request creates
 * workers and begins the producer.
 */
export function createLocal2NodeAdapter({
  workers = null,
  createWorkers = null,
  producer = null,
  learn = null,
  getRevision = null,
  initialRevision = 'local2-untrained',
  modelRevision = 'local2-models-unversioned',
  pipelineOptions = {},
  cacheOptions = {},
  bodyLimitBytes = 256 * 1024,
  revisionPollMs = 1000,
  onProducerError = null,
  now = () => Date.now()
} = {}) {
  if (!workers && typeof createWorkers !== 'function') {
    throw new Error('Local2 adapter requires workers or createWorkers');
  }

  let pipeline = null;
  let cache = null;
  let starting = null;
  let producerController = null;
  let producerPromise = null;
  let producerCleanup = null;
  let generation = 0;
  let lastRevisionCheckAt = 0;
  let lastProducerError = '';
  let stoppedAt = 0;

  const configuredInitialRevision = revisionFrom(initialRevision) || 'local2-untrained';

  function inactiveSnapshot() {
    return {
      schema: ADAPTER_SCHEMA,
      pipelineSchema: LOCAL2_PIPELINE_SCHEMA,
      mode: 'local2',
      storage: 'memory-only',
      active: false,
      starting: Boolean(starting),
      revision: configuredInitialRevision,
      producer: {
        running: false,
        error: lastProducerError
      },
      stoppedAt
    };
  }

  function snapshot() {
    if (!pipeline) return inactiveSnapshot();
    const pipelineState = pipeline.stats();
    return {
      ...pipelineState,
      schema: ADAPTER_SCHEMA,
      pipelineSchema: pipelineState.schema || LOCAL2_PIPELINE_SCHEMA,
      mode: 'local2',
      storage: 'memory-only',
      active: true,
      starting: false,
      cache: cache?.stats() || null,
      producer: {
        running: Boolean((producerPromise || producerCleanup) && !producerController?.signal.aborted),
        error: lastProducerError
      }
    };
  }

  async function resolveRevision(force = false) {
    if (typeof getRevision !== 'function') return pipeline?.revision || configuredInitialRevision;
    if (!force && pipeline && now() - lastRevisionCheckAt < Math.max(0, revisionPollMs)) return pipeline.revision;
    lastRevisionCheckAt = now();
    const resolved = revisionFrom(await getRevision({
      mode: 'local2',
      active: Boolean(pipeline),
      signal: producerController?.signal
    }));
    return resolved || pipeline?.revision || configuredInitialRevision;
  }

  function rotateRevision(nextRevision) {
    const revision = revisionFrom(nextRevision);
    if (!revision) return false;
    const cacheChanged = cache?.rotateLearningRevision(revision) || false;
    const pipelineChanged = pipeline?.rotateRevision(revision) || false;
    return cacheChanged || pipelineChanged;
  }

  async function syncRevision(force = false) {
    if (!pipeline) return configuredInitialRevision;
    const revision = await resolveRevision(force);
    rotateRevision(revision);
    return pipeline.revision;
  }

  function startProducer(currentGeneration) {
    if (typeof producer !== 'function' || !pipeline || !producerController || producerPromise || producerCleanup) return;
    const context = {
      schema: ADAPTER_SCHEMA,
      mode: 'local2',
      storage: 'memory-only',
      signal: producerController.signal,
      submit: (candidate, options) => {
        if (currentGeneration !== generation || producerController.signal.aborted) return false;
        return pipeline.submit(candidate, options);
      },
      snapshot,
      needsCandidates: () => {
        const state = pipeline.stats();
        return state.accepted < state.target && !producerController.signal.aborted;
      }
    };
    producerPromise = Promise.resolve()
      .then(() => producer(context))
      .then(cleanup => {
        if (typeof cleanup === 'function') producerCleanup = cleanup;
      })
      .catch(error => {
        if (producerController?.signal.aborted || currentGeneration !== generation) return;
        lastProducerError = text(error?.message || error, 240);
        onProducerError?.(error);
      })
      .finally(() => {
        if (currentGeneration === generation) producerPromise = null;
      });
  }

  function kickProducer() {
    if (!pipeline || pipeline.stats().accepted >= pipeline.targetAccepted) return;
    startProducer(generation);
  }

  async function ensureStarted() {
    if (pipeline) return pipeline;
    if (starting) return starting;
    const currentGeneration = ++generation;
    starting = (async () => {
      producerController = new AbortController();
      const revision = await resolveRevision(true);
      if (currentGeneration !== generation || producerController.signal.aborted) throw new Error('Local2 startup superseded');
      cache = new Local2CacheBundle({
        modelRevision,
        learningRevision: revision,
        ...cacheOptions
      });
      const workerContext = {
        schema: ADAPTER_SCHEMA,
        mode: 'local2',
        storage: 'memory-only',
        signal: producerController.signal,
        cache,
        generation: currentGeneration
      };
      const injectedWorkers = workers || await createWorkers(workerContext);
      if (currentGeneration !== generation || producerController.signal.aborted) throw new Error('Local2 startup superseded');
      pipeline = new Local2ContinuousPipeline({
        ...pipelineOptions,
        revision,
        workers: injectedWorkers,
        now
      });
      stoppedAt = 0;
      lastProducerError = '';
      startProducer(currentGeneration);
      return pipeline;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function stop() {
    generation++;
    producerController?.abort(new Error('Local2 adapter stopped'));
    pipeline?.stop();
    if (typeof producerCleanup === 'function') {
      await Promise.resolve(producerCleanup()).catch(() => {});
    }
    pipeline = null;
    cache = null;
    producerController = null;
    producerPromise = null;
    producerCleanup = null;
    starting = null;
    stoppedAt = now();
    return inactiveSnapshot();
  }

  async function dispatch({ method = 'GET', pathname = '/', query = {}, body = {} } = {}) {
    const normalizedMethod = text(method, 16).toUpperCase();
    const normalizedPath = `/${text(pathname).replace(/^\/+|\/+$/g, '')}`;
    if (!normalizedPath.startsWith('/local2/')) return { handled: false };

    if (normalizedMethod === 'GET' && normalizedPath === '/local2/health') {
      return { handled: true, status: 200, body: { ok: true, ...snapshot() } };
    }

    if (normalizedMethod === 'POST' && normalizedPath === '/local2/start') {
      await ensureStarted();
      await syncRevision();
      return { handled: true, status: 200, body: { ok: true, ...snapshot() } };
    }

    if (normalizedMethod === 'POST' && normalizedPath === '/local2/stop') {
      const state = await stop();
      return { handled: true, status: 200, body: { ok: true, ...state } };
    }

    if (normalizedMethod === 'GET' && normalizedPath === '/local2/candidates') {
      const activePipeline = await ensureStarted();
      await syncRevision();
      const before = activePipeline.stats();
      const count = integer(query.count, activePipeline.deliveryBatch, 1, 64);
      const candidates = activePipeline.lease(count);
      const after = activePipeline.stats();
      kickProducer();
      return {
        handled: true,
        status: 200,
        body: {
          ok: true,
          schema: ADAPTER_SCHEMA,
          mode: 'local2',
          storage: 'memory-only',
          active: true,
          revision: activePipeline.revision,
          ready: before.ready,
          candidates,
          remaining: after.accepted,
          leased: after.leased,
          target: after.target,
          readyMinimum: after.readyMinimum
        }
      };
    }

    if (normalizedMethod === 'POST' && normalizedPath === '/local2/candidates/ack') {
      const activePipeline = await ensureStarted();
      const values = [
        ...(Array.isArray(body.artistIds) ? body.artistIds : []),
        ...(Array.isArray(body.artistUrls) ? body.artistUrls.map(artistUrl => local2ArtistIdentity({ artistUrl })) : [])
      ];
      const consumed = activePipeline.acknowledge(values.slice(0, 64));
      kickProducer();
      return {
        handled: true,
        status: 200,
        body: {
          ok: true,
          schema: ADAPTER_SCHEMA,
          storage: 'memory-only',
          consumed,
          leased: activePipeline.stats().leased
        }
      };
    }

    if (normalizedMethod === 'POST' && normalizedPath === '/local2/learn') {
      if (typeof learn !== 'function') {
        return { handled: true, status: 501, body: { ok: false, error: 'Local2 learning is not configured' } };
      }
      await ensureStarted();
      const sanitized = sanitizeLearningPayload(body);
      const result = await learn(sanitized, {
        schema: ADAPTER_SCHEMA,
        mode: 'local2',
        storage: 'embeddings-and-labels-only',
        signal: producerController.signal,
        cache
      });
      const nextRevision = revisionFrom(result) || await syncRevision(true);
      rotateRevision(nextRevision);
      return {
        handled: true,
        status: 200,
        body: {
          ok: result?.ok !== false,
          schema: ADAPTER_SCHEMA,
          storage: 'embeddings-and-labels-only',
          revision: pipeline.revision,
          learned: result?.learned !== false
        }
      };
    }

    return {
      handled: true,
      status: 404,
      body: { ok: false, schema: ADAPTER_SCHEMA, error: 'unknown Local2 endpoint' }
    };
  }

  async function handleNodeRequest(req, res, parsedUrl = null) {
    const url = parsedUrl instanceof URL ? parsedUrl : new URL(req.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/local2/')) return false;
    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(text(req.method, 16).toUpperCase())
        ? await readJsonBody(req, integer(bodyLimitBytes, 256 * 1024, 1024, 4 * 1024 * 1024))
        : {};
      const result = await dispatch({
        method: req.method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body
      });
      sendJson(res, result.status || 200, result.body || {});
    } catch (error) {
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 400, {
          ok: false,
          schema: ADAPTER_SCHEMA,
          error: text(error?.message || error, 240)
        });
      }
    }
    return true;
  }

  return Object.freeze({
    dispatch,
    ensureStarted,
    handleNodeRequest,
    rotateRevision,
    snapshot,
    stop,
    submit(candidate, options) {
      if (!pipeline) return false;
      return pipeline.submit(candidate, options);
    }
  });
}

export { ADAPTER_SCHEMA as LOCAL2_NODE_ADAPTER_SCHEMA };
