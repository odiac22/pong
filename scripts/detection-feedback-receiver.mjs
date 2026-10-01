import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveDetectionFeedback } from '../detection-feedback.mjs';
import { resolveYouTubeCapture } from '../youtube-capture-resolver.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.pong-local-ai', 'detection-feedback');
const privateAddress = address => {
  const ip = String(address || '').replace(/^::ffff:/, '');
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(ip);
};
let saving = Promise.resolve();
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  const reply = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)); };
  if (!privateAddress(req.socket.remoteAddress)) return reply(403, { ok: false });
  if (req.method === 'OPTIONS') return reply(200, { ok: true });
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, app: 'Pong capture companion', version: '7.19.0' });
  if (req.method !== 'POST' || !['/media-page/detection-feedback', '/media-page/youtube-resolve'].includes(req.url)) return reply(404, { ok: false });
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 128 * 1024) return reply(413, { ok: false, error: 'Report too large' });
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/media-page/youtube-resolve') {
      try { return reply(200, await resolveYouTubeCapture(payload.videoId)); }
      catch (error) { return reply(422, { ok: false, error: error.message }); }
    }
    const job = saving.catch(() => {}).then(() => saveDetectionFeedback(directory, payload));
    saving = job;
    reply(200, await job);
  } catch (_) { reply(400, { ok: false, error: 'Invalid detection report' }); }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.listen(8797, '0.0.0.0', () => console.log('Pong detection feedback ready on 8797'));
