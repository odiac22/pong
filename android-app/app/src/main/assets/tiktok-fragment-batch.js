// Byte-identical batching for Pong's own bounded fragmented-MP4 stream.
// Emit initialization immediately and each moof/mdat pair as soon as complete.
// No timers, re-encoding, frame drops, or changes to TikTok's original media.
(() => {
  const scope = typeof window === 'object' ? window : self;
  if (scope.__pongCreateFragmentBatch) return;
  scope.__pongCreateFragmentBatch = (emit, limit = 16 * 1024 * 1024) => {
    let chunks = [], offset = 0, bytes = 0, group = [], groupBytes = 0, closed = false, awaitingMedia = false;
    const clear = () => { chunks = []; group = []; offset = bytes = groupBytes = 0; closed = true; awaitingMedia = false; };
    const peek = n => {
      const header = new Uint8Array(n); let written = 0;
      for (let i = 0; written < n; i++) {
        const part = chunks[i].subarray(i ? 0 : offset);
        const count = Math.min(part.length, n - written);
        header.set(part.subarray(0, count), written); written += count;
      }
      return header;
    };
    const take = size => {
      const result = new Uint8Array(size); let written = 0;
      while (written < size) {
        const count = Math.min(size - written, chunks[0].length - offset);
        result.set(chunks[0].subarray(offset, offset + count), written);
        offset += count; written += count; bytes -= count;
        if (offset === chunks[0].length) { chunks.shift(); offset = 0; }
      }
      return result;
    };
    const flush = () => {
      if (!groupBytes) return;
      const result = new Uint8Array(groupBytes); let position = 0;
      for (const part of group) { result.set(part, position); position += part.length; }
      group = []; groupBytes = 0; emit(result);
    };
    return {
      push(chunk) {
        if (closed || !chunk?.byteLength) return;
        try {
          chunks.push(chunk); bytes += chunk.byteLength;
          while (bytes >= 8) {
            let header = peek(8), view = new DataView(header.buffer), size = view.getUint32(0);
            const kind = String.fromCharCode(...header.subarray(4, 8));
            let headerSize = 8;
            if (size === 1) {
              if (bytes < 16) break;
              header = peek(16); view = new DataView(header.buffer); headerSize = 16;
              size = view.getUint32(8) * 4294967296 + view.getUint32(12);
            }
            if (!Number.isSafeInteger(size) || size < headerSize || size + groupBytes > limit)
              throw Error('Invalid or oversized Pong fragmented MP4 box');
            if (bytes < size) break;
            if (kind === 'moof') {
              if (awaitingMedia) throw Error('Pong fragment is missing media');
              awaitingMedia = true;
            } else if (kind === 'mdat') awaitingMedia = false;
            group.push(take(size)); groupBytes += size;
            if (kind === 'moov' || kind === 'mdat' || !['ftyp','moof','styp','sidx','emsg','prft'].includes(kind)) flush();
          }
          if (bytes + groupBytes > limit) throw Error('Pong fragment buffer limit');
        } catch (error) { clear(); throw error; }
      },
      finish() {
        if (closed) return;
        try {
          if (bytes || awaitingMedia) throw Error('Truncated Pong fragmented MP4 fragment');
          flush();
        } finally { clear(); }
      },
      dispose: clear,
      get retainedBytes() { return bytes + groupBytes; }
    };
  };
})();
