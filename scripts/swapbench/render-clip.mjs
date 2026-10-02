// Records a complete swapped clip from the isolated renderer for quality
// review. Optional --preview JSON applies a process-local (non-persisted)
// settings preview first; the saved preset is never written.
// node render-clip.mjs --clip 40831-donut-milkshake.mp4 --face <id> --out F:\...\x.mp4 [--preview '{"runtime":{...}}']
import { createWriteStream, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const RENDERER = `http://127.0.0.1:${arg('renderer', 18792)}`;
const BENCH = `http://127.0.0.1:${arg('bench', 18800)}`;
const clip = arg('clip'), face = arg('face'), out = arg('out');
const previewFile = arg('preview-file', '');
const preview = previewFile ? readFileSync(previewFile, 'utf8') : arg('preview', '');
const json = async (path, options = {}) => {
  const response = await fetch(RENDERER + path, {headers: {'Content-Type': 'application/json'}, ...options});
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

const settings = await json('/settings');
if (preview) await json('/settings/preview', {method: 'PUT', body: preview});
try {
  const epoch = 'render-' + Date.now();
  const created = await json('/sessions', {method: 'POST', body: JSON.stringify({
    channel: 'render', sourceUrl: `${BENCH}/stock/${encodeURIComponent(clip)}`, faceId: face, faceIds: [face],
    startSeconds: 0, prebufferSeconds: 0.25, navigationClass: 'foreground', externalPlaybackClock: true,
    restorationProfile: 'default', clientEpoch: epoch, activationSequence: 1,
    diagnosticsEnabled: arg('diag', '0') === '1'})});
  const id = created.session.id;
  const started = Date.now();
  let sequence = 0;
  // Generous playback credit: the producer may run at full speed.
  const credit = setInterval(() => {
    fetch(`${RENDERER}/sessions/${id}/playback`, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({positionSeconds: (Date.now() - started) / 1000 * 3, paused: false, clientEpoch: epoch, playbackSequence: ++sequence})}).catch(() => {});
  }, 200);
  const raw = out.replace(/\.mp4$/, '.fmp4');
  await new Promise((resolve, reject) => {
    http.get(`${RENDERER}/sessions/${id}/stream?clientEpoch=${epoch}&activationSequence=1`, response => {
      const file = createWriteStream(raw);
      response.pipe(file);
      file.on('finish', resolve);
      response.on('error', reject);
    }).on('error', reject);
  });
  clearInterval(credit);
  const status = (await json(`/sessions/${id}`)).session;
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-c', 'copy', '-movflags', '+faststart', out]);
  console.log(JSON.stringify({clip, out, frames: status.frames, transformed: status.transformedFrames,
    wallSeconds: (Date.now() - started) / 1000, renderFps: +(status.frames / Math.max(0.001, status.frameWorkSeconds ?? status.timingTotals?.frameWorkSeconds ?? 1)).toFixed(1),
    timing: status.timingTotals, compatibility: status.compatibilityStatus,
    // Median per-stage GPU ms when --diag 1 (cuda_* keys).
    stages: Object.fromEntries(Object.entries(status.diagnostics || {}).filter(([k, v]) => /Ms$/.test(k) && v.length)
      .map(([k, v]) => [k, +[...v].sort((a, b) => a - b)[Math.floor(v.length / 2)].toFixed(2)]))}));
  await fetch(`${RENDERER}/sessions/${id}`, {method: 'DELETE'});
} finally {
  // Restore the live (process-local) configuration exactly as it was.
  if (preview) await json('/settings/preview', {method: 'PUT', body: JSON.stringify(settings.config)});
}
