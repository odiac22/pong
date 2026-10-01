import { strongVideoEtag } from './video-cache-range-policy.mjs';

export function hlsRangeEligibleRequest(method, headers, pathname, active) {
  return method === 'GET' && !headers?.range &&
    /\.m4s$/i.test(String(pathname || '')) && Number(active || 0) < 1;
}

export function hlsRangeMetadata(headers, status, pathname, maxBytes) {
  const length = Number(headers?.['content-length']);
  const etag = strongVideoEtag(headers?.etag);
  const encoding = String(headers?.['content-encoding'] || '').trim().toLowerCase();
  const type = String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (status !== 200 || !/\.m4s$/i.test(String(pathname || '')) ||
      !/\bbytes\b/i.test(String(headers?.['accept-ranges'] || '')) ||
      !Number.isSafeInteger(length) || length <= 0 || length > maxBytes ||
      !(/^(?:video|audio)\//.test(type) || ['application/octet-stream', 'application/mp4'].includes(type)) ||
      !etag || (encoding && encoding !== 'identity')) return null;
  return { length, etag, type };
}

export function validHlsRangeResponse(headers, status, start, end, total, etag) {
  if (status !== 206 || strongVideoEtag(headers?.etag) !== etag) return false;
  const match = String(headers?.['content-range'] || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== total ||
      Number(headers?.['content-length']) !== end - start + 1) return false;
  const encoding = String(headers?.['content-encoding'] || '').trim().toLowerCase();
  return !encoding || encoding === 'identity';
}

// Return false only before response headers are committed, permitting the
// caller's established single-GET path. Once committed, any mismatch is fatal.
export async function tryStreamHlsRanges({
  request, emitHeaders, emitChunk, finish, signal, pathname,
  chunkBytes = 512 * 1024, concurrency = 4, maxBytes = 128 * 1024 * 1024,
  requestDeadlineMs = 30000,
}) {
  const active = new Set();
  const pendingRequests = new Set();
  let committed = false;
  let currentWave = [];
  const abort = () => {
    for (const controller of pendingRequests) controller.abort();
    for (const response of active) response.destroy();
  };
  const assertLive = () => {
    if (signal?.aborted) throw new Error('HLS range stream aborted');
  };
  signal?.addEventListener?.('abort', abort, { once: true });
  const ownedRequest = async (method, headers) => {
    assertLive();
    const controller = new AbortController();
    pendingRequests.add(controller);
    let response;
    const timer = setTimeout(() => {
      controller.abort();
      response?.destroy(new Error('HLS range absolute deadline exceeded'));
    }, requestDeadlineMs);
    const release = () => {
      clearTimeout(timer);
      pendingRequests.delete(controller);
    };
    try {
      response = await request(method, headers, controller);
      if (controller.signal.aborted) {
        response.destroy();
        throw new Error('HLS range absolute deadline exceeded');
      }
      return { response, release };
    } catch (error) {
      release();
      throw error;
    }
  };
  try {
    assertLive();
    const ownedHead = await ownedRequest('HEAD', {});
    let metadata;
    try {
      metadata = hlsRangeMetadata(ownedHead.response.headers,
        Number(ownedHead.response.statusCode || 0), pathname, maxBytes);
    } finally {
      ownedHead.response.destroy();
      ownedHead.release();
    }
    if (!metadata) return false;
    assertLive();
    const count = Math.ceil(metadata.length / chunkBytes);
    for (let waveStart = 0; waveStart < count; waveStart += concurrency) {
      assertLive();
      const indices = Array.from({ length: Math.min(concurrency, count - waveStart) }, (_, offset) => waveStart + offset);
      const pending = indices.map(async index => {
        const start = index * chunkBytes;
        const end = Math.min(metadata.length - 1, start + chunkBytes - 1);
        const owned = await ownedRequest('GET', {
          range: `bytes=${start}-${end}`, 'if-range': metadata.etag,
        });
        const response = owned.response;
        active.add(response);
        try {
          assertLive();
          if (!validHlsRangeResponse(response.headers, Number(response.statusCode || 0),
            start, end, metadata.length, metadata.etag)) {
            throw new Error('HLS range validator mismatch');
          }
          const pieces = [];
          let received = 0;
          for await (const piece of response) {
            assertLive();
            received += piece.length;
            if (received > end - start + 1) throw new Error('HLS range overflow');
            pieces.push(piece);
          }
          if (received !== end - start + 1) throw new Error('HLS range ended early');
          assertLive();
          return Buffer.concat(pieces, received);
        } finally {
          active.delete(response);
          if (!response.destroyed) response.destroy();
          owned.release();
        }
      });
      const settled = pending.map(task => task.then(value => ({ value }), error => ({ error })));
      currentWave = settled;
      for (const operation of settled) {
        const result = await operation;
        assertLive();
        if (result.error) {
          abort();
          await Promise.all(settled);
          throw result.error;
        }
        if (!committed) {
          emitHeaders(metadata);
          committed = true;
        }
        assertLive();
        await emitChunk(result.value);
      }
      currentWave = [];
    }
    assertLive();
    finish();
    return true;
  } catch (error) {
    abort();
    // Do not release the caller's global range slot while a prior wave may
    // still be acquiring headers or reading a body.
    if (currentWave.length) await Promise.all(currentWave);
    if (signal?.aborted || committed) throw error;
    return false;
  } finally {
    signal?.removeEventListener?.('abort', abort);
  }
}
