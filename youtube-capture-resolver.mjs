import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map();
const pending = new Map();
const validMediaUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && /(^|\.)googlevideo\.com$/i.test(u.hostname); }
  catch { return false; }
};

export function youtubeVideoIdFromPage(rawUrl) {
  let page;
  try { page = new URL(String(rawUrl || '')); } catch { return ''; }
  if (page.protocol !== 'https:' || page.username || page.password) return '';
  const host = page.hostname.toLowerCase();
  let id = '';
  if (host === 'youtu.be') {
    id = /^\/([\w-]{11})\/?$/.exec(page.pathname)?.[1] || '';
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (page.pathname === '/watch') id = page.searchParams.get('v') || '';
    else id = /^\/(?:embed|shorts)\/([\w-]{11})\/?$/.exec(page.pathname)?.[1] || '';
  }
  return /^[\w-]{11}$/.test(id) ? id : '';
}

export function selectYouTubeStream(info, videoId) {
  if (info.id !== videoId || info.is_live || info.has_drm) throw new Error('Unsupported video');
  const formats = (info.formats || []).filter(f => !f.has_drm);
  const masters = formats.filter(f => validMediaUrl(f.manifest_url) && /^m3u8/.test(f.protocol || ''))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || Number(/^avc/.test(b.vcodec || '')) - Number(/^avc/.test(a.vcodec || '')));
  const muxed = formats.filter(f => validMediaUrl(f.url) && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  const f = masters[0] || muxed[0];
  if (!f) throw new Error('No public combined stream');
  return { ok: true, videoId, videoUrl: masters.length ? f.manifest_url : f.url,
    durationSeconds: Number(info.duration || 0), title: String(info.title || '').slice(0, 300),
    height: Number(f.height || 0), kind: masters.length ? 'hls-master' : 'muxed' };
}

export async function resolveYouTubeCapture(videoId) {
  if (typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid video ID');
  const saved = cache.get(videoId);
  if (saved && saved.expires > Date.now()) return saved.value;
  if (pending.has(videoId)) return pending.get(videoId);
  if (pending.size >= 2) throw new Error('Resolver busy; try again');
  const job = (async () => {
    const python = path.join(root, '.pong-local-ai', 'lora-venv', 'Scripts', 'python.exe');
    const info = await new Promise((resolve, reject) => {
      execFile(python, ['-m', 'yt_dlp', '--ignore-config', '--skip-download', '--no-playlist',
        '--dump-single-json', '--socket-timeout', '8', '--retries', '0', '--js-runtimes', 'node',
        `https://www.youtube.com/watch?v=${videoId}`],
      { windowsHide: true, timeout: 22000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error('YouTube metadata unavailable'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid YouTube metadata')); }
      });
    });
    const value = selectYouTubeStream(info, videoId);
    if (value.kind === 'hls-master') {
      const response = await fetch(value.videoUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error('Manifest unavailable');
      const body = await response.text();
      if (body.length > 1024 * 1024 || !body.startsWith('#EXTM3U') || !body.includes('#EXT-X-STREAM-INF:') || !body.includes('TYPE=AUDIO')) {
        throw new Error('No combined audio/video manifest');
      }
    }
    if (cache.size >= 50) cache.delete(cache.keys().next().value);
    cache.set(videoId, { value, expires: Date.now() + 120000 });
    return value;
  })();
  pending.set(videoId, job);
  try { return await job; } finally { pending.delete(videoId); }
}
