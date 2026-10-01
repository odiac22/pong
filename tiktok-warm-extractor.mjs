// Baseline 1.1: keep yt-dlp warm for TikTok media resolution.
// Baseline 1.0 started a new Python + yt-dlp process for every TikTok video
// (first byte median 1.30 s on 12 public videos). A persistent worker keeps
// the module imported and its impersonating session open, and Node then
// downloads the resolved MP4 directly (first byte median 0.64 s).
// The resolved media URL and cookies stay in memory; nothing here logs them.
import { spawn } from 'node:child_process';
import https from 'node:https';
import readline from 'node:readline';
import path from 'node:path';
import { tikTokHintTarget } from './tiktok-media-hints.mjs';

const WORKERS = 2;               // current post + one upcoming post in parallel
const RESOLVE_TIMEOUT_MS = 8000;

export function createTikTokWarmExtractor({python, script, cwd}) {
  const pool = [];
  let nextId = 0, closed = false;

  function startWorker(slot) {
    const child = spawn(python, [script], {cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
    const worker = {child, slot, busy: 0, ready: false, waiting: new Map()};
    worker.readyPromise = new Promise(resolve => { worker.markReady = resolve; });
    readline.createInterface({input: child.stdout}).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.ready) { worker.ready = true; worker.markReady(true); return; }
      const pending = worker.waiting.get(message.id);
      if (pending) { worker.waiting.delete(message.id); worker.busy -= 1; pending(message); }
    });
    child.once('exit', () => {
      worker.markReady(false);
      for (const pending of worker.waiting.values()) pending({ok: false, error: 'WorkerExited'});
      worker.waiting.clear();
      if (pool[slot] === worker) pool[slot] = null;
    });
    child.stdin.on('error', () => {});
    pool[slot] = worker;
    return worker;
  }

  function warm() {
    if (closed) return;
    for (let slot = 0; slot < WORKERS; slot++) if (!pool[slot]) startWorker(slot);
  }

  async function resolve(pageUrl, signal) {
    warm();
    const worker = pool.filter(Boolean).sort((a, b) => a.busy - b.busy)[0];
    if (!worker || !(await worker.readyPromise)) throw new Error('TikTok extractor worker unavailable');
    if (signal?.aborted) throw new DOMException('TikTok resolve aborted', 'AbortError');
    const id = ++nextId;
    worker.busy += 1;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (worker.waiting.delete(id)) { worker.busy -= 1; reject(new Error('TikTok extractor timed out')); }
      }, RESOLVE_TIMEOUT_MS);
      worker.waiting.set(id, message => {
        clearTimeout(timer);
        if (message.ok && message.url) resolvePromise(message);
        else reject(new Error(`TikTok extractor failed: ${message.error || 'no media'}`));
      });
      worker.child.stdin.write(JSON.stringify({id, url: pageUrl}) + '\n');
    });
  }

  // Streams the resolved MP4. Same entity rules as the media-hint path:
  // trusted TikTok CDN hosts only, HTTP 200 video/mp4 with an exact length,
  // no switching entities after the first byte is published.
  async function stream(info, {write, onMetadata, onBytes, signal, maxBytes, agent}) {
    let url = info.url, response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const target = tikTokHintTarget(url);
      if (!target) throw new Error('Untrusted TikTok media host');
      const headers = {...(info.headers || {}), 'accept-encoding': 'identity'};
      if (info.cookies) headers.cookie = info.cookies;
      response = await new Promise((resolvePromise, reject) => {
        const request = https.request(target, {agent, signal, headers}, resolvePromise);
        const timer = setTimeout(() => request.destroy(new Error('TikTok media header timeout')), 4000);
        request.once('response', () => clearTimeout(timer));
        request.once('error', error => { clearTimeout(timer); reject(error); });
        request.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location; response.destroy();
        if (!location || redirects === 3) throw new Error('TikTok media redirect limit');
        url = new URL(location, target).href; continue;
      }
      break;
    }
    const length = Number(response.headers['content-length']);
    if (response.statusCode !== 200 || !Number.isSafeInteger(length) || length <= 0 || length > maxBytes ||
        !/^video\/mp4(?:;|$)/i.test(String(response.headers['content-type'] || '')) ||
        (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
      response.destroy();
      throw new Error('TikTok resolved media is not a complete MP4 response');
    }
    response.setTimeout(5000, () => response.destroy(new Error('TikTok media idle timeout')));
    onMetadata(length);
    let bytes = 0;
    for await (const chunk of response) {
      if (signal?.aborted) throw new Error('TikTok media download cancelled');
      bytes += chunk.length;
      if (bytes > length) throw new Error('TikTok media entity overflow');
      await write(chunk); onBytes(chunk, bytes);
    }
    if (bytes !== length) throw new Error('TikTok media entity truncated');
    return bytes;
  }

  function close() {
    closed = true;
    for (const worker of pool) worker?.child.kill();
  }

  return {warm, resolve, stream, close};
}

export const tikTokWarmExtractorScript = repoRoot => path.join(repoRoot, 'scripts', 'tiktok_extractor_worker.py');
