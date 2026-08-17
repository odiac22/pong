import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');
const inputFiles = [
  path.join(repoDir, 'pong-data', 'saved-links-v2.json'),
  path.join(repoDir, 'pong-data', 'saved-links.json')
];
const outputFile = path.join(repoDir, 'pong-data', 'saved-erome-recovery.json');

function isEromeRecord(record) {
  const text = [
    record?.source,
    record?.artistUrl,
    record?.url,
    record?.postUrl
  ].join(' ');

  return /(?:^|\.)erome\.com(?:[/:]|$)|\berome\b/i.test(text);
}

function compactArtist(record) {
  const videoMeta = {};
  const videos = Array.isArray(record?.videos)
    ? record.videos.map(value => String(value || '').trim()).filter(Boolean)
    : [];

  for (const videoUrl of videos) {
    const meta = record?.videoMeta?.[videoUrl];
    if (!meta || typeof meta !== 'object') continue;
    videoMeta[videoUrl] = {
      postUrl: String(meta.postUrl || ''),
      artistDisplayName: String(meta.artistDisplayName || '')
    };
  }

  return {
    source: String(record?.source || 'erome'),
    artistUrl: String(record?.artistUrl || record?.url || ''),
    postUrl: String(record?.postUrl || ''),
    artistName: String(record?.artistName || ''),
    artistDisplayName: String(record?.artistDisplayName || ''),
    bundleLabel: String(record?.bundleLabel || ''),
    videos,
    videoMeta
  };
}

function compactVideo(record) {
  return {
    source: String(record?.source || ''),
    artistUrl: String(record?.artistUrl || ''),
    postUrl: String(record?.postUrl || ''),
    url: String(record?.url || '')
  };
}

const recovery = {
  generatedAt: new Date().toISOString(),
  savedArtists: {},
  savedVideos: {}
};

for (const [sourceIndex, inputFile] of inputFiles.entries()) {
  const payload = JSON.parse(await fs.readFile(inputFile, 'utf8'));

  for (const [key, record] of Object.entries(payload?.savedArtists || {})) {
    if (!isEromeRecord(record)) continue;
    recovery.savedArtists[`${sourceIndex}:${key}`] = compactArtist(record);
  }

  for (const [key, record] of Object.entries(payload?.savedVideos || {})) {
    if (!isEromeRecord(record)) continue;
    recovery.savedVideos[`${sourceIndex}:${key}`] = compactVideo(record);
  }
}

await fs.writeFile(outputFile, `${JSON.stringify(recovery)}\n`, 'utf8');
const stats = await fs.stat(outputFile);
console.log(`Wrote ${path.relative(repoDir, outputFile)} (${stats.size} bytes)`);
