// Disposable, byte-identical fMP4 receive experiment. Complete MP4 boxes are
// delivered together, never delayed by a timer or modified/re-encoded.
(() => {
  const create = (emit, limit = 16 * 1024 * 1024) => {
    let chunks = [], offset = 0, bytes = 0, group = [], groupBytes = 0;
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
        if (!chunk?.byteLength) return;
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
          // This experiment accepts bounded fragmented MP4 only. Never hide a
          // malformed stream or accumulate a size-zero/unbounded box forever.
          if (!Number.isSafeInteger(size) || size < headerSize || size + groupBytes > limit)
            throw Error('Invalid or oversized fragmented MP4 box');
          if (bytes < size) break;
          group.push(take(size)); groupBytes += size;
          if (kind === 'moov' || kind === 'mdat' || !['ftyp','moof','styp','sidx','emsg','prft'].includes(kind)) flush();
        }
        if (bytes + groupBytes > limit) throw Error('Fragmented MP4 buffering limit');
      },
      finish() {
        if (bytes) throw Error('Truncated fragmented MP4 box');
        flush();
      }
    };
  };
  window.__pongCreateFragmentBatch = create;
  if (window.__pongUndoFragmentBatch) return {installed:false};
  const original = window.fetch;
  if (typeof original !== 'function') return {factoryOnly:true};
  const stats = window.__pongFragmentBatchStats = {streams:0,reads:0,packets:0,bytes:0};
  window.fetch = async function(input, init) {
    const response = await original.call(this, input, init);
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!/^https:\/\/www\.tiktok\.com\/__pong_swap\/[A-Za-z0-9_-]+(?:\?|$)/.test(url) || !response.ok || !response.body ||
        !(response.headers.get('content-type') || '').split(',').every(t => /^video\/mp4(?:\s*;|\s*$)/i.test(t.trim()))) return response;
    const reader = response.body.getReader(); let done = false;
    stats.streams++;
    const ready = [], packetizer = create(part => {stats.packets++;ready.push(part)});
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (!ready.length && !done) {
            const next = await reader.read();
            if (next.done) { done = true; packetizer.finish(); }
            else {stats.reads++;stats.bytes+=next.value.byteLength;packetizer.push(next.value);}
          }
          if (ready.length) controller.enqueue(ready.shift());
          else controller.close();
        } catch (error) { done = true; void reader.cancel().catch(() => {}); controller.error(error); }
      },
      cancel(reason) { done = true; return reader.cancel(reason); }
    }, {highWaterMark:0});
    return new Response(stream, {status:response.status, statusText:response.statusText, headers:response.headers});
  };
  window.__pongUndoFragmentBatch = () => { window.fetch = original; delete window.__pongUndoFragmentBatch; };
  return {installed:true};
})()
