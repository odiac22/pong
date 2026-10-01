import { segmentedMp4Metadata, validMp4SegmentResponse } from './video-cache-range-policy.mjs';

export function segmentFailureDisposition(publishedBytes) {
  return Number(publishedBytes || 0) > 0 ? 'poison' : 'sequential-fallback';
}

// Dependencies are injected so the same downloader can be fault-tested without
// opening a network socket or touching a real cache directory.
export async function downloadVideoSegments({
  request, openFile, removeFile, partPath, targetPath, signal, isCurrentGeneration,
  generic, chunkBytes, concurrency, maxFileBytes, onMetadata, onPrefix,
}) {
  let handle;
  let published = 0;
  const assertCurrent = () => {
    if (signal.aborted || !isCurrentGeneration()) throw new Error('segmented video cache aborted');
  };
  try {
    const head = await request('HEAD', {}, generic ? 3000 : 0);
    const status = Number(head.statusCode || 0);
    const headers = head.headers || {};
    const total = Number(headers['content-length'] || 0);
    const etag = String(headers.etag || '');
    const lastModified = String(headers['last-modified'] || '');
    const strictMetadata = generic
      ? segmentedMp4Metadata(headers, status, targetPath, maxFileBytes)
      : null;
    head.destroy();
    if (generic ? !strictMetadata : (
      status !== 200 ||
      !/bytes/i.test(String(headers['accept-ranges'] || '')) ||
      !Number.isSafeInteger(total) || total <= 0 || total > maxFileBytes
    )) throw new Error('segmented video cache metadata unavailable');

    assertCurrent();
    await removeFile(partPath);
    assertCurrent();
    handle = await openFile(partPath);
    assertCurrent();
    onMetadata({
      totalBytes: total,
      contentType: strictMetadata?.type || String(headers['content-type'] || 'video/mp4').split(';')[0],
      etag: strictMetadata?.etag || etag,
      lastModified: strictMetadata?.lastModified || lastModified,
    });
    const count = Math.ceil(total / chunkBytes);
    for (let waveStart = 0; waveStart < count; waveStart += concurrency) {
      assertCurrent();
      const indices = Array.from({ length: Math.min(concurrency, count - waveStart) }, (_, offset) => waveStart + offset);
      const requests = indices.map(async index => {
        const start = index * chunkBytes;
        const end = Math.min(total - 1, start + chunkBytes - 1);
        const ifRange = strictMetadata?.ifRange || etag || lastModified;
        const response = await request('GET', {
          range: `bytes=${start}-${end}`,
          ...(ifRange ? { 'if-range': ifRange } : {}),
        }, generic ? 8000 : 0);
        if (signal.aborted || !isCurrentGeneration()) {
          response.destroy();
          throw new Error('segmented video cache aborted');
        }
        const range = String(response.headers?.['content-range'] || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
        const valid = generic
          ? validMp4SegmentResponse(response.headers || {}, Number(response.statusCode || 0), start, end, total, strictMetadata)
          : Number(response.statusCode || 0) === 206 && range &&
            Number(range[1]) === start && Number(range[2]) === end && Number(range[3]) === total;
        if (!valid) {
          // A rejected Range may be a full 200 response. Do not drain it.
          response.destroy();
          throw new Error('segmented video cache range mismatch');
        }
        const pieces = [];
        let received = 0;
        const bodyTimer = generic
          ? setTimeout(() => response.destroy(new Error('segmented video cache body timeout')), 30000)
          : null;
        try {
          for await (const piece of response) {
            if (signal.aborted || !isCurrentGeneration()) {
              response.destroy();
              throw new Error('segmented video cache aborted');
            }
            received += piece.length;
            if (received > end - start + 1) throw new Error('segmented video cache range overflow');
            pieces.push(piece);
          }
        } finally {
          if (bodyTimer) clearTimeout(bodyTimer);
        }
        if (received !== end - start + 1) throw new Error('segmented video cache range ended early');
        assertCurrent();
        return Buffer.concat(pieces, received);
      });
      const settled = requests.map(operation => operation.then(
        value => ({ value, error: null }), error => ({ value: null, error })
      ));
      for (const operation of settled) {
        const result = await operation;
        assertCurrent();
        if (result.error) {
          await Promise.all(settled);
          throw result.error;
        }
        const buffer = result.value;
        let committed = false;
        try {
          let written = 0;
          while (written < buffer.length) {
            assertCurrent();
            const result = await handle.write(buffer, written, buffer.length - written, published + written);
            if (!result.bytesWritten) throw new Error('segmented video cache write stopped early');
            written += result.bytesWritten;
            assertCurrent();
          }
          const nextPublished = published + buffer.length;
          assertCurrent();
          onPrefix(nextPublished, buffer.length);
          published = nextPublished;
          committed = true;
        } finally {
          // A cancellation or file error may arrive while write() is pending.
          // Keep the on-disk file at the last committed contiguous prefix.
          if (!committed) await handle.truncate(published);
        }
      }
    }
    assertCurrent();
    if (published !== total) throw new Error('segmented video cache did not complete');
    return { published, total };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
