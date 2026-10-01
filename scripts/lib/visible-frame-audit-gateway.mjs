// Temporary offscreen audit gateway. The caller must bind server to 127.0.0.1.
// Neither the renderer bearer nor raw renderer session IDs cross this listener.
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {
  frameByteLengths, rgbaToRgb, validateCreatedSession,
  validateOwnedResponse, ownedRestorationEvidence,
} from './visible-frame-roundtrip.mjs';

const HEADER_BYTES = 64;
const MAX_RGBA_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = HEADER_BYTES + MAX_RGBA_BYTES;
const BODY_TIMEOUT_MS = 10_000;
const CREATE_TIMEOUT_MS = 15_000;
const FRAME_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;
const STATUS_MAX_BYTES = 128 * 1024; // 32 bounded frame-diagnostic records
const DELETE_TIMEOUT_MS = 15_000;
const SESSION_ID = /^[A-Za-z0-9_-]{20,80}$/;

function loopbackAddress(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function rendererOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || (url.pathname !== '/' && url.pathname !== '') ||
      url.search || url.hash) throw Error('rendererBase must be loopback HTTP origin');
  return url.origin;
}

function exactCapability(value, expectedBytes) {
  if (typeof value !== 'string') return false;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(value);
  return !!match && timingSafeEqual(Buffer.from(match[1], 'hex'), expectedBytes);
}

function validateEnvelope(body, persistent=false) {
  if (!Buffer.isBuffer(body) || body.length < HEADER_BYTES || body.length > MAX_BODY_BYTES) {
    throw Error('invalid-frame');
  }
  if (body.readUInt32BE(0) !== 0x50564641 || body[4] !== 1 || body[5] !== 1 ||
      body[6] !== 0 || body[7] !== 0) {
    throw Error('invalid-frame');
  }
  const sequence = body.readUInt32BE(24);
  if (sequence < 1 || sequence > (persistent ? 240 : 1)) throw Error('invalid-frame');
  const nonce = body.subarray(8, 24).toString('hex');
  const sceneEpoch = body.readInt32BE(28);
  const mediaTime = body.readDoubleBE(32);
  const width = body.readUInt16BE(44), height = body.readUInt16BE(46);
  const box = [48, 52, 56, 60].map(offset => body.readFloatBE(offset));
  if (sceneEpoch < 0 || !Number.isFinite(mediaTime) || mediaTime < 0 ||
      box.some(value => !Number.isFinite(value)) || box[2] <= 0 || box[3] <= 0) {
    throw Error('invalid-frame');
  }
  const {rgba, rgb} = frameByteLengths(width, height);
  if (rgba > MAX_RGBA_BYTES || body.length !== HEADER_BYTES + rgba) throw Error('invalid-frame');
  return {nonce, sceneEpoch, mediaTime, width, height, rgba, rgb, sequence};
}

// The generic roundtrip helper intentionally remains a one-frame proof. A
// continuing session needs independent, cumulative ownership checks.
function persistentEvidence(status, id, faces, width, height, sequence, frames) {
  validateCreatedSession(status, faces[0], width, height, 'tiktok-face-size');
  const s = status.session;
  if (s.id !== id || s.closed !== false || s.lastSequence !== sequence ||
      s.frames !== frames || !Array.isArray(s.faceIds) ||
      s.faceIds.length !== faces.length || s.faceIds.some((v, i) => v !== faces[i]) ||
      !Number.isInteger(s.transformedFrames) || s.transformedFrames < 0 ||
      s.transformedFrames > frames) throw Error('persistent evidence mismatch');
  const a = s.adaptiveRestoration || {};
  const allowed = new Set(['GPEN256', 'GPEN512', 'GPEN1024']);
  const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
  const d = s.frameDiagnostics?.records?.at(-1);
  const diagnostic = d && d.frameIndex === frames - 1 ? {
    frameIndex:d.frameIndex,
    acquisitionAttempted:typeof d.acquisitionAttempted === 'boolean' ? d.acquisitionAttempted : null,
    selectionAccepted:typeof d.selectionAccepted === 'boolean' ? d.selectionAccepted : null,
    selectionMs:finite(d.selectionMs), processingMs:finite(d.processingMs),
    totalMs:finite(d.totalMs), detections:finite(d.detections),
    matchSelected:typeof d.matchSelected === 'boolean' ? d.matchSelected : null,
    exactDelta:finite(d.exactDelta), reuseDelta:finite(d.reuseDelta),
  } : null;
  return {transformedFrames:s.transformedFrames,
    actualModel:allowed.has(a.model) ? a.model : null,
    sourceFaceCropPixels:finite(a.sourceFaceCropPixels),
    gpen512Frames:finite(a.GPEN512Frames), gpen1024Frames:finite(a.GPEN1024Frames),
    frameDiagnostic:diagnostic};
}

async function readRequestBody(req, expected) {
  const body = Buffer.allocUnsafe(expected);
  let offset = 0;
  const timer = setTimeout(() => req.destroy(), BODY_TIMEOUT_MS);
  timer.unref?.();
  try {
    for await (const chunk of req) {
      if (offset + chunk.length > expected) throw Error('invalid-body');
      chunk.copy(body, offset);
      offset += chunk.length;
    }
    if (offset !== expected) throw Error('invalid-body');
    return body;
  } catch (error) {
    body.fill(0);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response, limit) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => {});
    throw Error('renderer-response-invalid');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('renderer-response-invalid');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw Error('renderer-response-invalid');
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

async function rendererRequest(origin, token, path,
  {method='GET', body, contentType, timeoutMs=5_000, signal}={}) {
  const response = await fetch(origin + path, {
    method, body, redirect:'error', signal:signal
      ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
    headers:{Authorization:`Bearer ${token}`,
      ...(contentType ? {'Content-Type':contentType} : {})},
  });
  return response;
}

function sendError(res, status, category) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ok:false,error:category}));
  res.writeHead(status, {'Content-Type':'application/json', 'Content-Length':String(body.length),
    'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
  res.end(body);
}

export function createVisibleFrameAuditGateway({capability, faceIds, token,
  rendererBase='http://127.0.0.1:8792', onRecord=()=>{}, maxRequests=30,
  ttlMs=180_000, persistentSession=false}={}) {
  if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) {
    throw Error('invalid audit capability');
  }
  if (typeof token !== 'string' || token.length < 32) throw Error('invalid renderer token');
  if (!Array.isArray(faceIds) || faceIds.length < 1 || faceIds.length > 16 ||
      faceIds.some(id => typeof id !== 'string' || !id || id.length > 256) ||
      new Set(faceIds).size !== faceIds.length) throw Error('invalid approved face IDs');
  if (typeof persistentSession !== 'boolean' ||
      !Number.isInteger(maxRequests) || maxRequests < 1 ||
      maxRequests > (persistentSession ? 240 : 30) ||
      !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 180_000 ||
      typeof onRecord !== 'function') throw Error('invalid audit bounds');
  const origin = rendererOrigin(rendererBase);
  const approvedFaceIds = Object.freeze([...faceIds]);
  const capabilityBytes = Buffer.from(capability, 'hex');
  const startedAt = Date.now();
  const usedNonces = new Set();
  let requests = 0, busy = false, closed = false;
  let owner = null, persistentSid = null, persistentFrames = 0;
  let lastSequence = 0, lastMediaTime = null, lastRendererTime = null;
  let cleanupPromise = null, persistentCleanupConfirmed = null;
  const active = new Set();
  const record = row => { try { onRecord(row); } catch (_) { /* diagnostic callback is not transport */ } };
  const deleteSession = async id => {
    const deleted = await rendererRequest(origin, token,
      `/remote-sessions/${encodeURIComponent(id)}`,
      {method:'DELETE', timeoutMs:DELETE_TIMEOUT_MS});
    await readResponse(deleted, 4096);
    return deleted.ok;
  };
  const cleanupPersistent = () => {
    if (!cleanupPromise) cleanupPromise = (async () => {
      if (!persistentSid) return true;
      try { return await deleteSession(persistentSid); }
      catch (_) { return false; }
    })().then(ok => { persistentCleanupConfirmed = ok; return ok; });
    return cleanupPromise;
  };

  const server = http.createServer(async (req, res) => {
    const bound = server.address();
    if (!bound || typeof bound !== 'object' || !loopbackAddress(bound.address) ||
        !loopbackAddress(req.socket.remoteAddress)) return sendError(res, 403, 'unavailable');
    if (req.method !== 'POST' || req.url !== '/frame') return sendError(res, 404, 'unavailable');
    if (!exactCapability(req.headers.authorization, capabilityBytes)) {
      return sendError(res, 401, 'unavailable');
    }
    if (closed || Date.now() - startedAt >= ttlMs || requests >= maxRequests) {
      return sendError(res, 410, 'audit-expired');
    }
    if (busy) return sendError(res, 429, 'audit-busy');
    const lengthText = req.headers['content-length'];
    if (req.headers['transfer-encoding'] || req.headers['content-encoding'] ||
        req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !==
          'application/octet-stream' ||
        typeof lengthText !== 'string' || !/^\d+$/.test(lengthText) ||
        Number(lengthText) < HEADER_BYTES || Number(lengthText) > MAX_BODY_BYTES) {
      if (persistentSession && owner) {
        closed = true;
        void cleanupPersistent();
      }
      return sendError(res, 413, 'invalid-frame');
    }
    busy = true;
    requests += 1;
    let input = null, rgb = null, rendered = null, reply = null, sessionId = null;
    let replySent = false;
    let clientGone = false, renderOk = false, responseFinished = false;
    let resultRecord = null, failureStage = '';
    const renderAbort = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) {clientGone = true; renderAbort.abort();}
    });
    const job = (async () => {
      const began = performance.now();
      let stage = 'body';
      try {
        input = await readRequestBody(req, Number(lengthText));
        const envelope = validateEnvelope(input, persistentSession);
        if (clientGone || req.destroyed && !req.complete) throw Error('client-closed');
        if (persistentSession) {
          if (!owner) {
            if (envelope.sequence !== 1) throw Error('initial-sequence');
            owner = {nonce:envelope.nonce, sceneEpoch:envelope.sceneEpoch,
              width:envelope.width, height:envelope.height};
          } else if (envelope.nonce !== owner.nonce ||
                     envelope.sceneEpoch !== owner.sceneEpoch ||
                     envelope.width !== owner.width || envelope.height !== owner.height ||
                     envelope.sequence <= lastSequence) {
            throw Error('owner-or-sequence-mismatch');
          }
        } else {
          if (usedNonces.has(envelope.nonce)) throw Error('replayed-nonce');
          usedNonces.add(envelope.nonce);
        }
        const readMs = performance.now() - began;
        rgb = rgbaToRgb(input.subarray(HEADER_BYTES), envelope.width, envelope.height);
        stage = 'create';
        const createdAt = performance.now();
        if (!persistentSession || !persistentSid) {
        const create = await rendererRequest(origin, token, '/remote-sessions', {
          method:'POST', contentType:'application/json', timeoutMs:CREATE_TIMEOUT_MS,
          body:JSON.stringify({faceId:approvedFaceIds[0], faceIds:approvedFaceIds,
            width:envelope.width,
            height:envelope.height, fps:30, restorationProfile:'tiktok-face-size'}),
        });
        const createdBody = await readResponse(create, 16 * 1024);
        if (!create.ok) throw Error('renderer-create-failed');
        const created = JSON.parse(createdBody.toString('utf8'));
        if (SESSION_ID.test(created?.session?.id || '')) sessionId = created.session.id;
        if (persistentSession && sessionId) persistentSid = sessionId;
        validateCreatedSession(created, approvedFaceIds[0], envelope.width, envelope.height,
          'tiktok-face-size');
        if (!Array.isArray(created.session.faceIds) ||
            created.session.faceIds.length !== approvedFaceIds.length ||
            created.session.faceIds.some((id, index) => id !== approvedFaceIds[index])) {
          throw Error('renderer-face-set-mismatch');
        }
        } else sessionId = persistentSid;
        const createMs = performance.now() - createdAt;
        if (clientGone) throw Error('client-closed');
        stage = 'render';
        const renderAt = performance.now();
        const cut = persistentSession
          ? persistentFrames === 0 || envelope.mediaTime < lastMediaTime - 0.05 ||
            envelope.mediaTime - lastMediaTime > 1.0
          : true;
        const rendererTime = persistentSession
          ? Math.max(performance.now(), (lastRendererTime ?? -Infinity) + 0.001)
          : envelope.mediaTime * 1000;
        const frame = await rendererRequest(origin, token,
          `/remote-sessions/${encodeURIComponent(sessionId)}/frame?seq=${envelope.sequence}&cut=${cut}&timestampMs=${encodeURIComponent(rendererTime)}`,
          {method:'PUT', body:rgb, contentType:'application/octet-stream',
            timeoutMs:FRAME_TIMEOUT_MS, signal:renderAbort.signal});
        rendered = await readResponse(frame, envelope.rgb);
        if (!frame.ok) throw Error('renderer-frame-failed');
        const owned = validateOwnedResponse(frame.headers, rendered, envelope.sequence,
          envelope.width, envelope.height);
        const renderRoundtripMs = performance.now() - renderAt;
        renderOk = true;
        if (clientGone) throw Error('client-closed');
        stage = 'evidence';
        const status = await rendererRequest(origin, token,
          `/remote-sessions/${encodeURIComponent(sessionId)}`,
          {timeoutMs:STATUS_TIMEOUT_MS, signal:renderAbort.signal});
        const statusBody = await readResponse(status,
          persistentSession ? STATUS_MAX_BYTES : 16 * 1024);
        if (!status.ok) throw Error('renderer-status-failed');
        const evidence = persistentSession
          ? persistentEvidence(JSON.parse(statusBody.toString('utf8')),
            sessionId, approvedFaceIds, envelope.width, envelope.height,
            envelope.sequence, persistentFrames + 1)
          : ownedRestorationEvidence(JSON.parse(statusBody.toString('utf8')),
            sessionId, approvedFaceIds[0], envelope.width, envelope.height, 'tiktok-face-size');
        if (clientGone) throw Error('client-closed');
        if (persistentSession) {
          persistentFrames++;
          lastSequence = envelope.sequence;
          lastMediaTime = envelope.mediaTime;
          lastRendererTime = rendererTime;
        }
        stage = 'reply';
        reply = Buffer.allocUnsafe(input.length);
        input.copy(reply, 0, 0, HEADER_BYTES);
        reply[6] = owned.transformed ? 1 : 0;
        reply[7] = 1; // exact raw remote-session render mode
        for (let src=0, dst=HEADER_BYTES; src<rendered.length; src+=3) {
          reply[dst++] = rendered[src];
          reply[dst++] = rendered[src+1];
          reply[dst++] = rendered[src+2];
          reply[dst++] = 255;
        }
        if (!res.destroyed && !res.writableEnded) {
          res.once('finish', () => reply?.fill(0));
          res.once('close', () => reply?.fill(0));
          res.writeHead(200, {'Content-Type':'application/octet-stream',
            'Content-Length':String(reply.length), 'Cache-Control':'no-store',
            'X-Content-Type-Options':'nosniff'});
          res.end(reply);
          replySent = true;
        }
        resultRecord = {ok:true, sequence:envelope.sequence,
          ...(persistentSession ? {rendererFrames:persistentFrames} : {}),
          width:envelope.width, height:envelope.height,
          rgbaBytes:envelope.rgba, transformed:owned.transformed,
          readMs, createMs, renderRoundtripMs, rendererRenderMs:owned.renderMs,
          totalMs:performance.now()-began,
          restoration:{transformedFrames:evidence.transformedFrames,
            modelSize:Number(String(evidence.actualModel || '').replace('GPEN', '')) || null,
            sourceFaceCropPixels:evidence.sourceFaceCropPixels,
            gpen512Frames:evidence.gpen512Frames,
            gpen1024Frames:evidence.gpen1024Frames},
          ...(persistentSession ? {frameDiagnostic:evidence.frameDiagnostic} : {})};
      } catch (_) {
        sendError(res, stage === 'body' ? 400 : 502, 'frame-audit-failed');
        failureStage = stage;
        if (persistentSession) closed = true;
      } finally {
        let cleanupConfirmed = persistentSession ? null : !sessionId && stage === 'body';
        if (persistentSession && (closed || clientGone)) {
          cleanupConfirmed = await cleanupPersistent();
        } else if (sessionId && !persistentSession) {
          try {
            cleanupConfirmed = await deleteSession(sessionId);
          } catch (_) { cleanupConfirmed = false; }
        }
        input?.fill(0); rgb?.fill(0); rendered?.fill(0);
        if (!replySent) reply?.fill(0);
        if (replySent && !res.writableFinished && !res.destroyed) {
          await new Promise(resolve => {
            const timeout = setTimeout(() => { res.destroy(); resolve(); }, BODY_TIMEOUT_MS);
            timeout.unref?.();
            const finish = () => { clearTimeout(timeout); resolve(); };
            res.once('finish', finish); res.once('close', finish);
          });
        }
        responseFinished = res.writableFinished;
        record({...(resultRecord || {ok:false, stage:failureStage,
          totalMs:performance.now()-began}),
          renderOk, replySent, responseFinished, cleanupConfirmed,
          ...(persistentSession ? {cleanupPending:cleanupConfirmed === null} : {})});
        busy = false;
      }
    })();
    active.add(job);
    job.finally(() => active.delete(job));
  });

  return {server, close:async () => {
    closed = true;
    const closing = new Promise(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closing;
    await Promise.allSettled([...active]);
    const cleanupConfirmed = persistentSession ? await cleanupPersistent() : true;
    capabilityBytes.fill(0);
    return {cleanupConfirmed};
  }};
}
