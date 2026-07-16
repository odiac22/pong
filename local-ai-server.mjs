import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline, RawImage, env } from '@xenova/transformers';

const PORT = Number(process.env.PONG_LOCAL_AI_PORT || 8787);
const HOST = process.env.PONG_LOCAL_AI_HOST || '0.0.0.0';
const MODEL = process.env.PONG_LOCAL_IMAGE_MODEL || 'Xenova/siglip-base-patch16-224';
const OLLAMA_URL = (process.env.PONG_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_VISION_MODEL = process.env.PONG_OLLAMA_VISION_MODEL || 'qwen2.5vl:latest';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOP_K = 10;
const QWEN_ACCEPT_EXAMPLES = Number(process.env.PONG_QWEN_ACCEPT_EXAMPLE_IMAGES || 0);
const QWEN_REJECT_EXAMPLES = Number(process.env.PONG_QWEN_REJECT_EXAMPLE_IMAGES || 0);
const QWEN_CANDIDATE_IMAGES = Number(process.env.PONG_QWEN_CANDIDATE_IMAGES || 2);
const LEARN_IMAGES_PER_RECORD = Number(process.env.PONG_LEARN_IMAGES_PER_RECORD || 40);
const LOCAL_AI_DIR = path.join(process.cwd(), '.pong-local-ai');
const LEARNED_STORE_PATH = path.join(LOCAL_AI_DIR, 'learned-examples.json');
const FINETUNE_DATASET_PATH = path.join(LOCAL_AI_DIR, 'finetune-dataset.json');
const FINETUNE_JSONL_PATH = path.join(LOCAL_AI_DIR, 'qwen-lora-dataset.jsonl');
const FINETUNE_STATUS_PATH = path.join(LOCAL_AI_DIR, 'finetune-status.json');
const FINETUNE_IMAGE_DIR = path.join(LOCAL_AI_DIR, 'training-images');
const FINETUNE_RUN_SCRIPT = path.join(process.cwd(), 'scripts', 'run-lora-train.ps1');
const LORA_INFERENCE_RUN_SCRIPT = path.join(process.cwd(), 'scripts', 'run-lora-infer.ps1');
const LORA_INFERENCE_URL = (process.env.PONG_LORA_INFERENCE_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const LORA_ADAPTER_DIR = path.join(LOCAL_AI_DIR, 'qwen-lora', 'latest');
const FINETUNE_AUTO_RUN = process.env.PONG_LORA_AUTOTRAIN !== '0';
const FINETUNE_MAX_IMAGE_BYTES = Number(process.env.PONG_LORA_MAX_IMAGE_BYTES || 12 * 1024 * 1024);
const MAX_LEARNED_RECORDS = 2000;

env.allowLocalModels = false;
env.useBrowserCache = false;
env.cacheDir = path.join(process.cwd(), '.cache', 'transformers');

let extractorPromise = null;
let extractorReady = false;
let ollamaVisionDisabled = false;
let ollamaFailureReason = '';
const ollamaFailureByModel = new Map();
const embeddingCache = new Map();
let learnedStorePromise = null;
let fineTuneProcess = null;
let loraInferenceProcess = null;
let loraInferenceStarting = null;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readJsonFile(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (_) {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('image-feature-extraction', MODEL, { quantized: true })
      .then(model => {
        extractorReady = true;
        return model;
      });
  }
  return extractorPromise;
}

function normalizeUrl(raw, base = 'https://coomerfans.com/') {
  try {
    return new URL(String(raw || ''), base).toString();
  } catch (_) {
    return '';
  }
}

async function fetchImageBlob(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 PongLocalAI/1.0',
      'Referer': 'https://coomerfans.com/'
    }
  });
  if (!response.ok) throw new Error(`image HTTP ${response.status}`);
  return response.blob();
}

const imageBase64Cache = new Map();
const IMAGE_BASE64_CACHE_MAX = 200;

function fetchImageBase64(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return Promise.reject(new Error('bad image url'));
  if (imageBase64Cache.has(url)) {
    const cached = imageBase64Cache.get(url);
    imageBase64Cache.delete(url);
    imageBase64Cache.set(url, cached);
    return cached;
  }

  const promise = (async () => {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 PongLocalAI/1.0',
        'Referer': 'https://coomerfans.com/'
      }
    });
    if (!response.ok) throw new Error(`image HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString('base64');
  })().catch(error => {
    imageBase64Cache.delete(url);
    throw error;
  });

  imageBase64Cache.set(url, promise);
  while (imageBase64Cache.size > IMAGE_BASE64_CACHE_MAX) {
    imageBase64Cache.delete(imageBase64Cache.keys().next().value);
  }
  return promise;
}

async function fetchImagesBase64(urls = []) {
  const settled = await Promise.allSettled(urls.map(fetchImageBase64));
  return settled.filter(item => item.status === 'fulfilled').map(item => item.value);
}

async function fetchImageBuffer(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error('bad image url');
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 PongLocalAI/1.0',
      'Referer': 'https://coomerfans.com/'
    }
  });
  if (!response.ok) throw new Error(`image HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('empty image');
  if (buffer.length > FINETUNE_MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${buffer.length} bytes`);
  }
  return {
    buffer,
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  };
}

function embedImage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return Promise.reject(new Error('bad image url'));
  if (embeddingCache.has(url)) return Promise.resolve(embeddingCache.get(url));

  const promise = (async () => {
    const extractor = await getExtractor();
    const blob = await fetchImageBlob(url);
    const image = await RawImage.fromBlob(blob);
    const output = await extractor(image, { pooling: 'mean', normalize: true });
    const values = Array.from(output?.data || output?.tolist?.()?.flat?.() || []);
    if (!values.length) throw new Error('empty embedding');
    return values;
  })().then(values => {
    embeddingCache.set(url, values);
    return values;
  }).catch(error => {
    embeddingCache.delete(url);
    throw error;
  });

  embeddingCache.set(url, promise);
  return promise;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function topMean(vector, examples, k = TOP_K) {
  if (!examples.length) return 0;
  const scores = examples.map(item => cosine(vector, item.vector)).sort((a, b) => b - a);
  const selected = scores.slice(0, Math.min(k, scores.length));
  return selected.reduce((sum, n) => sum + n, 0) / selected.length;
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

function textHardFilter(artist = {}) {
  const nameTokens = String(artist.artistName || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  if (nameTokens.some(token => token === 'ts' || token.startsWith('ts'))) return 'blocked name prefix: ts';

  const combined = `${artist.artistName || ''} ${artist.pageText || ''} ${artist.artistUrl || ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const fragments = ['transgender', 'transsexual', 'transgirl', 'trans girl', 'tgirl', 't-girl', 'shemale', 'femboy', 'ladyboy', 'crossdresser', 'crossdress', 'mtf'];
  for (const fragment of fragments) {
    if (combined.includes(fragment)) return `blocked text contains: ${fragment}`;
  }
  const tokens = new Set(combined.split(/[^a-z0-9]+/g).filter(Boolean));
  for (const word of ['trans', 'ts', 'cd', 'trap', 'bbw', 'feet']) {
    if (tokens.has(word)) return `blocked word: ${word}`;
  }
  return '';
}

function imageUrlsFromRecords(records = []) {
  const out = [];
  for (const record of records || []) {
    for (const url of record?.imageUrls || []) {
      const normalized = normalizeUrl(url, record.artistUrl || 'https://coomerfans.com/');
      if (normalized) {
        out.push({
          url: normalized,
          artistUrl: record.artistUrl || '',
          artistName: record.artistName || '',
          rejectReason: record.rejectReason || '',
          rejectReasonLabel: record.rejectReasonLabel || ''
        });
      }
    }
  }
  return out;
}

function normalizeArtistUrl(raw) {
  try {
    const url = new URL(String(raw || ''), 'https://coomerfans.com/');
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

async function loadLearnedStore() {
  if (!learnedStorePromise) {
    learnedStorePromise = fs.readFile(LEARNED_STORE_PATH, 'utf8')
      .then(text => JSON.parse(text))
      .catch(() => ({ version: 1, records: [] }))
      .then(store => ({
        version: 1,
        records: Array.isArray(store?.records) ? store.records : []
      }));
  }
  return learnedStorePromise;
}

async function saveLearnedStore(store) {
  await fs.mkdir(path.dirname(LEARNED_STORE_PATH), { recursive: true });
  const clean = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: (store.records || []).slice(0, MAX_LEARNED_RECORDS)
  };
  await fs.writeFile(LEARNED_STORE_PATH, JSON.stringify(clean, null, 2), 'utf8');
  learnedStorePromise = Promise.resolve(clean);
  return clean;
}

function learnedRecordSummaries(store) {
  return (store?.records || []).map(record => ({
    artistUrl: record.artistUrl || '',
    artistName: record.artistName || '',
    label: record.label || '',
    rejectReason: record.rejectReason || '',
    rejectReasonLabel: record.rejectReasonLabel || '',
    learnedAt: record.learnedAt || '',
    imageUrls: (record.embeddings || []).map(item => item?.url).filter(Boolean)
  }));
}

function learnedVectors(store, label) {
  const out = [];
  for (const record of store?.records || []) {
    if (record?.label !== label) continue;
    for (const item of record.embeddings || []) {
      if (!Array.isArray(item?.vector) || !item.vector.length) continue;
      out.push({
        url: item.url || '',
        artistUrl: record.artistUrl || '',
        artistName: record.artistName || '',
        rejectReason: record.rejectReason || '',
        rejectReasonLabel: record.rejectReasonLabel || '',
        label,
        vector: item.vector
      });
    }
  }
  return out;
}

function labelInstruction(record) {
  if (record.label === 'accept') {
    return 'Return accept for this artist. This is a user-saved positive preference example.';
  }

  const reason = String(record.rejectReasonLabel || record.rejectReason || '').trim();
  if (/trans/i.test(reason)) {
    return 'Return reject for this artist because the user marked a text/URL hard-filter violation. Do not infer sensitive status from appearance.';
  }
  if (/male/i.test(reason)) {
    return 'Return reject for this artist because the user marked a visible male-presenting hard-filter violation.';
  }
  if (/fat|overweight/i.test(reason)) {
    return 'Return reject for this artist because the user marked a visual preference mismatch. Do not mention health or medical status.';
  }
  if (/ugly/i.test(reason)) {
    return 'Return reject for this artist because the user marked a visual preference mismatch.';
  }
  return 'Return reject for this artist. This is a user red-X negative preference example.';
}

function assistantDecision(record) {
  return JSON.stringify({
    decision: record.label === 'accept' ? 'accept' : 'reject',
    confidence: 1,
    reason: record.label === 'accept'
      ? 'user saved accepted artist'
      : `user rejected artist${record.rejectReasonLabel ? `: ${record.rejectReasonLabel}` : ''}`,
    checks: {
      photograph: null,
      woman_prominent: null,
      male_only: null,
      male_present: null,
      female_presenting_adult: null,
      appears_over_50: null,
      feet_dominant: null,
      logo_or_placeholder: null
    }
  });
}

async function loadFineTuneDataset() {
  return readJsonFile(FINETUNE_DATASET_PATH, { version: 1, records: [] })
    .then(dataset => ({
      version: 1,
      updatedAt: dataset.updatedAt || '',
      records: Array.isArray(dataset.records) ? dataset.records : []
    }));
}

async function saveFineTuneDataset(dataset) {
  const clean = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: (dataset.records || []).slice(0, MAX_LEARNED_RECORDS)
  };
  await writeJsonFile(FINETUNE_DATASET_PATH, clean);
  const lines = clean.records.map(record => JSON.stringify({
    id: record.id,
    artistUrl: record.artistUrl,
    artistName: record.artistName,
    label: record.label,
    rejectReason: record.rejectReason,
    rejectReasonLabel: record.rejectReasonLabel,
    images: record.images,
    messages: [
      {
        role: 'system',
        content: 'You are a strict visual preference classifier. Follow hard filters first. Use Trans only as a text/URL clue, never as appearance inference. Do not mention medical status.'
      },
      {
        role: 'user',
        content: [
          ...record.images.map(image => ({ type: 'image', image: path.resolve(LOCAL_AI_DIR, image.path) })),
          { type: 'text', text: `${labelInstruction(record)}\nClassify this saved training artist using the same Random 40 output JSON schema.` }
        ]
      },
      { role: 'assistant', content: assistantDecision(record) }
    ]
  }));
  await fs.writeFile(FINETUNE_JSONL_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return clean;
}

async function writeFineTuneStatus(patch) {
  const current = await readJsonFile(FINETUNE_STATUS_PATH, { status: 'idle' });
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(FINETUNE_STATUS_PATH, next);
  return next;
}

async function loraAdapterExists() {
  try {
    await fs.access(path.join(LORA_ADAPTER_DIR, 'adapter_model.safetensors'));
    return true;
  } catch (_) {
    return false;
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function loraInferenceHealth(timeoutMs = 2500) {
  return fetchJsonWithTimeout(`${LORA_INFERENCE_URL}/health?t=${Date.now()}`, {}, timeoutMs);
}

async function ensureLoraInferenceService() {
  if (!(await loraAdapterExists())) return null;

  try {
    const health = await loraInferenceHealth(1200);
    if (health?.ok && health?.ready) return health;
  } catch (_) {}

  if (loraInferenceStarting) return loraInferenceStarting;
  if (loraInferenceProcess) return null;

  loraInferenceStarting = (async () => {
    try {
      await fs.access(LORA_INFERENCE_RUN_SCRIPT);
      loraInferenceProcess = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        LORA_INFERENCE_RUN_SCRIPT,
        '-RepoRoot',
        process.cwd()
      ], {
        cwd: process.cwd(),
        windowsHide: true,
        detached: false,
        stdio: 'ignore'
      });

      loraInferenceProcess.once('exit', () => {
        loraInferenceProcess = null;
      });

      for (let i = 0; i < 90; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const health = await loraInferenceHealth(2000);
          if (health?.ok && health?.ready) return health;
        } catch (_) {}
      }
    } catch (_) {
      loraInferenceProcess = null;
    } finally {
      loraInferenceStarting = null;
    }
    return null;
  })();

  return loraInferenceStarting;
}

async function storeFineTuneImages(artistUrl, imageUrls) {
  await fs.mkdir(FINETUNE_IMAGE_DIR, { recursive: true });
  const stored = [];
  const unique = [...new Set(imageUrls || [])].filter(Boolean).slice(0, LEARN_IMAGES_PER_RECORD);

  for (const rawUrl of unique) {
    try {
      const url = normalizeUrl(rawUrl, artistUrl || undefined);
      const urlHash = sha256(url).slice(0, 32);
      const fileName = `${urlHash}.imgdata`;
      const relativePath = path.join('training-images', fileName).replace(/\\/g, '/');
      const filePath = path.join(LOCAL_AI_DIR, relativePath);

      let buffer = null;
      let contentType = 'application/octet-stream';
      try {
        const existing = await fs.stat(filePath);
        if (existing.size > 0) {
          stored.push({ url, path: relativePath, contentType, bytes: existing.size, sha256: urlHash });
          continue;
        }
      } catch (_) {}

      const fetched = await fetchImageBuffer(url);
      buffer = fetched.buffer;
      contentType = fetched.contentType;
      await fs.writeFile(filePath, buffer);
      stored.push({
        url,
        path: relativePath,
        contentType,
        bytes: buffer.length,
        sha256: sha256(buffer)
      });
    } catch (_) {}
  }

  return stored;
}

async function addFineTuneExample({ artistUrl, artistName, label, rejectReason = '', rejectReasonLabel = '', imageUrls = [] }) {
  const images = await storeFineTuneImages(artistUrl, imageUrls);
  if (!images.length) return { saved: false, images: 0 };

  const dataset = await loadFineTuneDataset();
  const id = sha256(`${artistUrl}|${label}`).slice(0, 24);
  const records = (dataset.records || []).filter(record => normalizeArtistUrl(record.artistUrl || '') !== artistUrl);
  records.unshift({
    id,
    artistUrl,
    artistName: String(artistName || '').slice(0, 120),
    label,
    rejectReason: String(rejectReason || '').slice(0, 40),
    rejectReasonLabel: String(rejectReasonLabel || '').slice(0, 80),
    learnedAt: new Date().toISOString(),
    promptVersion: 'random40-lora-v1',
    images
  });

  const saved = await saveFineTuneDataset({ ...dataset, records });
  await queueFineTuneRun(`learn:${label}`);
  return {
    saved: true,
    images: images.length,
    records: saved.records.length,
    datasetPath: FINETUNE_DATASET_PATH,
    jsonlPath: FINETUNE_JSONL_PATH
  };
}

async function rebuildFineTuneDatasetFromLearnedStore() {
  const store = await loadLearnedStore();
  const records = [];

  for (const learned of store.records || []) {
    const artistUrl = normalizeArtistUrl(learned.artistUrl || '');
    if (!artistUrl || !['accept', 'reject'].includes(learned.label)) continue;
    const imageUrls = (learned.embeddings || []).map(item => item?.url).filter(Boolean);
    const images = await storeFineTuneImages(artistUrl, imageUrls);
    if (!images.length) continue;
    records.push({
      id: sha256(`${artistUrl}|${learned.label}`).slice(0, 24),
      artistUrl,
      artistName: String(learned.artistName || '').slice(0, 120),
      label: learned.label,
      rejectReason: String(learned.rejectReason || '').slice(0, 40),
      rejectReasonLabel: String(learned.rejectReasonLabel || '').slice(0, 80),
      learnedAt: learned.learnedAt || new Date().toISOString(),
      promptVersion: 'random40-lora-v1',
      images
    });
  }

  const saved = await saveFineTuneDataset({ version: 1, records });
  await writeFineTuneStatus({
    status: saved.records.length ? 'queued' : 'no_data',
    message: saved.records.length
      ? `Rebuilt LoRA dataset from ${saved.records.length} learned records.`
      : 'No learned records with image URLs are available for LoRA.',
    datasetRows: saved.records.length,
    datasetPath: FINETUNE_DATASET_PATH,
    jsonlPath: FINETUNE_JSONL_PATH
  });
  return saved;
}

async function queueFineTuneRun(trigger = 'manual') {
  await writeFineTuneStatus({
    status: fineTuneProcess ? 'queued' : 'queued',
    trigger,
    queuedAt: new Date().toISOString(),
    datasetPath: FINETUNE_DATASET_PATH,
    jsonlPath: FINETUNE_JSONL_PATH
  });

  if (!FINETUNE_AUTO_RUN || fineTuneProcess) return false;

  try {
    await fs.access(FINETUNE_RUN_SCRIPT);
  } catch (_) {
    await writeFineTuneStatus({
      status: 'blocked',
      message: 'LoRA runner script is missing.',
      trigger
    });
    return false;
  }

  fineTuneProcess = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    FINETUNE_RUN_SCRIPT,
    '-RepoRoot',
    process.cwd()
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    detached: false,
    stdio: 'ignore'
  });

  fineTuneProcess.once('exit', code => {
    fineTuneProcess = null;
    writeFineTuneStatus({
      status: code === 0 ? 'complete' : 'blocked',
      exitCode: code,
      completedAt: new Date().toISOString()
    }).catch(() => {});
  });

  return true;
}

async function learn(payload) {
  const label = payload.label === 'accept' ? 'accept' : payload.label === 'reject' ? 'reject' : '';
  if (!label) throw new Error('label must be accept or reject');

  const artist = payload.artist || {};
  const artistUrl = normalizeArtistUrl(artist.artistUrl || '');
  const imageUrls = [...new Set((payload.imageUrls || []).map(url => normalizeUrl(url, artistUrl || undefined)).filter(Boolean))].slice(0, LEARN_IMAGES_PER_RECORD);
  if (!artistUrl) throw new Error('artistUrl is required');
  if (!imageUrls.length) throw new Error('at least one imageUrl is required');

  const embeddingResults = await Promise.allSettled(
    imageUrls.map(async url => ({ url, vector: await embedImage(url) }))
  );
  const embeddings = embeddingResults.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!embeddings.length) throw new Error('could not embed learning images');

  const store = await loadLearnedStore();
  const records = (store.records || [])
    .filter(record => normalizeArtistUrl(record.artistUrl || '') !== artistUrl);
  records.unshift({
    artistUrl,
    artistName: String(artist.artistName || '').slice(0, 120),
    label,
    rejectReason: String(payload.rejectReason || '').slice(0, 40),
    rejectReasonLabel: String(payload.rejectReasonLabel || '').slice(0, 80),
    learnedAt: new Date().toISOString(),
    embeddings
  });

  const saved = await saveLearnedStore({ ...store, records });
  const fineTune = await addFineTuneExample({
    artistUrl,
    artistName: String(artist.artistName || '').slice(0, 120),
    label,
    rejectReason: String(payload.rejectReason || '').slice(0, 40),
    rejectReasonLabel: String(payload.rejectReasonLabel || '').slice(0, 80),
    imageUrls
  }).catch(error => ({
    saved: false,
    error: error.message || String(error)
  }));

  return {
    ok: true,
    label,
    artistUrl,
    embeddings: embeddings.length,
    accepted_records: saved.records.filter(record => record.label === 'accept').length,
    rejected_records: saved.records.filter(record => record.label === 'reject').length,
    finetune: fineTune
  };
}

function rejectReasonSummary(records = []) {
  const counts = new Map();
  for (const record of records || []) {
    const label = String(record?.rejectReasonLabel || record?.rejectReason || '').trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, count]) => `${label}: ${count}`)
    .join(', ');
}

async function embedExamples(records, label) {
  const items = imageUrlsFromRecords(records);
  const settled = await Promise.allSettled(
    items.map(async item => ({ ...item, label, vector: await embedImage(item.url) }))
  );
  return settled.filter(item => item.status === 'fulfilled').map(item => item.value);
}

function gradeCandidate(vector, index, acceptedVectors, rejectedVectors) {
  const pos = topMean(vector, acceptedVectors);
  const neg = topMean(vector, rejectedVectors);
  const margin = pos - neg;
  const preference = logistic(margin * 18);
  const confidence = Math.max(0.5, Math.min(0.99, 0.5 + Math.abs(margin) * 16));
  let decision = 'unsure';
  if (preference >= 0.58 && margin > 0.012) decision = 'accept';
  if (preference <= 0.46 && margin < -0.012) decision = 'reject';

  return {
    image_index: index + 1,
    decision,
    confidence,
    reason: `taste ${Math.round(preference * 100)} pos ${pos.toFixed(3)} neg ${neg.toFixed(3)}`,
    local_score: preference,
    checks: {
      male_present: null,
      female_presenting_adult: null,
      appears_over_50: null,
      feet_dominant: null,
      logo_or_placeholder: null,
      visual_preference_match: preference >= 0.55
    }
  };
}

function finalDecision(imageGrades, acceptedCount, rejectedCount) {
  if (acceptedCount < 2 || rejectedCount < 2) {
    return {
      decision: 'unsure',
      confidence: 0.5,
      reason: `local needs more saved examples (${acceptedCount} accept / ${rejectedCount} reject images)`
    };
  }

  const scores = imageGrades.map(item => Number(item.local_score || 0.5));
  const average = scores.reduce((sum, n) => sum + n, 0) / Math.max(1, scores.length);
  const accepts = imageGrades.filter(item => item.decision === 'accept').length;
  const rejects = imageGrades.filter(item => item.decision === 'reject').length;
  const confidence = Math.max(0.5, Math.min(0.98, 0.5 + Math.abs(average - 0.5) * 2.2));

  if (rejects >= Math.ceil(imageGrades.length / 2) || average < 0.47) {
    return { decision: 'reject', confidence, reason: `local rejected ${rejects}/${imageGrades.length}, taste ${Math.round(average * 100)}` };
  }
  if (accepts >= Math.ceil(imageGrades.length / 2) && average >= 0.57) {
    return { decision: 'accept', confidence, reason: `local accepted ${accepts}/${imageGrades.length}, taste ${Math.round(average * 100)}` };
  }
  return { decision: 'unsure', confidence, reason: `local unsure, taste ${Math.round(average * 100)}` };
}

function nearestExampleUrls(candidateVectors, examples, count) {
  if (!candidateVectors.length || !examples.length || count <= 0) return [];
  const ranked = examples.map(example => {
    const best = Math.max(...candidateVectors.map(vector => cosine(vector, example.vector)));
    return { ...example, score: best };
  }).sort((a, b) => b.score - a.score);

  const seen = new Set();
  const urls = [];
  for (const item of ranked) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    urls.push(item.url);
    if (urls.length >= count) break;
  }
  return urls;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error('No JSON object in Ollama response');
}

function requestedVisionModel(raw) {
  return String(raw || OLLAMA_VISION_MODEL).trim() || OLLAMA_VISION_MODEL;
}

async function ollamaAvailable(modelName = OLLAMA_VISION_MODEL) {
  const selectedModel = requestedVisionModel(modelName);
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) return false;
    const payload = await response.json();
    return Array.isArray(payload.models) && payload.models.some(model => model?.name === selectedModel);
  } catch (_) {
    return false;
  }
}

async function classifyWithOllamaVision({ artist, candidateUrls, siglipDecision, imageGrades, acceptedExampleUrls = [], rejectedExampleUrls = [], rejectionSummary = '', visionModel = OLLAMA_VISION_MODEL }) {
  const selectedVisionModel = requestedVisionModel(visionModel);
  const previousFailure = ollamaFailureByModel.get(selectedVisionModel);
  if (previousFailure) {
    throw new Error(`Ollama vision disabled for ${selectedVisionModel}: ${previousFailure}`);
  }
  const useExampleImages = !/^qwen3-vl\b/i.test(selectedVisionModel);
  const [candidateImages, acceptedImages, rejectedImages] = await Promise.all([
    fetchImagesBase64(candidateUrls.slice(0, QWEN_CANDIDATE_IMAGES)),
    useExampleImages ? fetchImagesBase64(acceptedExampleUrls.slice(0, QWEN_ACCEPT_EXAMPLES)) : Promise.resolve([]),
    useExampleImages ? fetchImagesBase64(rejectedExampleUrls.slice(0, QWEN_REJECT_EXAMPLES)) : Promise.resolve([])
  ]);
  const candidateCount = candidateImages.length;
  const acceptedStart = candidateImages.length + 1;
  const rejectedStart = candidateImages.length + acceptedImages.length + 1;
  const images = [...candidateImages, ...acceptedImages, ...rejectedImages];
  if (!images.length) return null;

  const localSummary = imageGrades.map(item =>
    `image ${item.image_index}: ${item.decision}, confidence ${item.confidence.toFixed(2)}, ${item.reason}`
  ).join('\n');

  const prompt = [
    'You are a strict local vision triage classifier for adult creator profile filtering.',
    'Return only compact JSON with keys: decision, confidence, reason, checks.',
    'decision must be accept, reject, or unsure. confidence must be 0 to 1.',
    'checks must contain: photograph, woman_prominent, male_only, male_present, female_presenting_adult, appears_over_50, feet_dominant, logo_or_placeholder.',
    'This is an adult creator filtering task. Do not reject merely because an image is revealing, sexualized, lingerie, swimwear, nude, or adult-media styled. Do not give platform/community-guidelines refusals. Judge only the requested filters and user preference signal.',
    'First perform hard visual checks. Reject if any male-presenting person is visible, male-only, no clearly female-presenting adult is visible across the candidate image set, feet are the main subject, age appears over the configured limit, underage-looking, or unclear adult age.',
    'Reject if the entire candidate image set is non-photo/logo/placeholder/anime/artwork/unclear or lacks enough visible face or body evidence to judge the artist. A face-only image or body-only image can still be judged when it gives enough evidence for the hard checks and visual preference.',
    'Do not reject the whole artist just because one candidate image is weak, blank, cropped, or unclear if another candidate clearly supplies enough face/body evidence.',
    'Only after hard checks pass, use the saved preference signal to judge fit. SigLIP is a preference hint, never a hard-rule authority.',
    'The saved preference signal was computed against every locally stored accepted/rejected embedding, not just a nearest-example subset.',
    'Accept only when the image set clearly shows a female-presenting adult and fits the saved visual preference signal: conventionally attractive styling, fit/athletic/slim/lean presentation, polished appearance, or youthful adult presentation.',
    'User reject reasons may include Fat, Male, Trans, and Ugly. Use Male as a hard visual rejection reason. Use Trans only as a user-provided or text/URL hard-filter clue; do not infer sensitive status from appearance. Use Fat/Ugly as visual preference mismatch labels without diagnosing or mentioning health.',
    'Do not identify anyone. Do not infer ethnicity, sexuality, medical conditions, or weight status. Do not mention body weight or health.',
    '',
    `Artist: ${artist.artistName || 'unknown'}`,
    `URL: ${artist.artistUrl || ''}`,
    `SigLIP learned-taste hint, not a hard rule: ${siglipDecision.decision}, confidence ${Number(siglipDecision.confidence || 0).toFixed(2)}, ${siglipDecision.reason || ''}`,
    rejectionSummary ? `User red-X reason history: ${rejectionSummary}` : 'No user red-X reason history yet.',
    'Per-image learned-taste grades:',
    localSummary,
    '',
    `Attached images 1-${candidateCount}: candidate artist images to judge.`,
    acceptedImages.length
      ? `Attached images ${acceptedStart}-${acceptedStart + acceptedImages.length - 1}: nearest user-saved ACCEPT examples. Use as visual preference examples.`
      : 'No accepted example images are attached.',
    rejectedImages.length
      ? `Attached images ${rejectedStart}-${rejectedStart + rejectedImages.length - 1}: nearest user red-X/rejected examples. Treat these as stronger avoid examples.`
      : 'No rejected example images are attached.',
    '',
    'Judge only the candidate artist images for the final decision. Use accepted/rejected example images only to understand user preference.'
  ].join('\n');

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: selectedVisionModel,
      prompt,
      images,
      stream: false,
      format: 'json',
      think: false,
      options: {
        temperature: 0,
        num_ctx: Number(process.env.PONG_OLLAMA_NUM_CTX || 8192),
        num_predict: 220
      }
    })
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Ollama HTTP ${response.status}: ${errorText.slice(0, 180)}`);
  }
  const payload = await response.json();
  const parsed = extractJsonObject(payload.response || payload.thinking || '');
  const checks = parsed.checks || {};
  ollamaFailureByModel.delete(selectedVisionModel);
  if (selectedVisionModel === OLLAMA_VISION_MODEL) {
    ollamaVisionDisabled = false;
    ollamaFailureReason = '';
  }
  return {
    decision: ['accept', 'reject', 'unsure'].includes(parsed.decision) ? parsed.decision : 'unsure',
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.5))),
    reason: String(parsed.reason || 'qwen vision decision').slice(0, 140),
    checks: {
      photograph: checks.photograph ?? null,
      woman_prominent: checks.woman_prominent ?? null,
      male_only: checks.male_only ?? null,
      male_present: checks.male_present ?? null,
      female_presenting_adult: checks.female_presenting_adult ?? null,
      appears_over_50: checks.appears_over_50 ?? null,
      feet_dominant: checks.feet_dominant ?? null,
      logo_or_placeholder: checks.logo_or_placeholder ?? null
    }
  };
}

async function classifyWithLoraVision({ artist, candidateUrls, siglipDecision, imageGrades, rejectionSummary = '' }) {
  const health = await ensureLoraInferenceService();
  if (!health?.ready) {
    throw new Error('LoRA inference service is not ready');
  }

  return fetchJsonWithTimeout(`${LORA_INFERENCE_URL}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      artist,
      candidateImageUrls: candidateUrls.slice(0, QWEN_CANDIDATE_IMAGES),
      siglipDecision,
      imageGrades,
      rejectionSummary,
      promptVersion: 'random40-lora-v1'
    })
  }, Number(process.env.PONG_LORA_CLASSIFY_TIMEOUT_MS || 90000));
}

async function classify(payload) {
  const artist = payload.artist || {};
  const visionModel = requestedVisionModel(payload.visionModel);
  const hard = textHardFilter(artist);
  if (hard) {
    return {
      decision: 'reject',
      confidence: 1,
      source: 'hard_filter',
      reason: hard,
      checks: {
        photograph: null,
        woman_prominent: null,
        male_only: null,
        male_present: null,
        female_presenting_adult: null,
        appears_over_50: null,
        feet_dominant: null,
        logo_or_placeholder: null
      },
      image_grades: []
    };
  }

  const candidateUrls = [...new Set((payload.candidateImageUrls || []).map(url => normalizeUrl(url)).filter(Boolean))].slice(0, QWEN_CANDIDATE_IMAGES);
  if (!candidateUrls.length) throw new Error('No candidate image URLs supplied.');

  const learnedStore = await loadLearnedStore();
  const learnedAcceptedVectors = learnedVectors(learnedStore, 'accept');
  const learnedRejectedVectors = learnedVectors(learnedStore, 'reject');

  const [payloadAcceptedVectors, payloadRejectedVectors] = await Promise.all([
    embedExamples(payload.acceptedArtists || [], 'accept'),
    embedExamples(payload.rejectedArtists || [], 'reject')
  ]);
  const acceptedVectors = [...learnedAcceptedVectors, ...payloadAcceptedVectors];
  const rejectedVectors = [...learnedRejectedVectors, ...payloadRejectedVectors];

  const candidateResults = await Promise.allSettled(candidateUrls.map(url => embedImage(url)));
  const candidateVectors = candidateResults.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!candidateVectors.length) throw new Error('Could not embed any candidate images.');

  const imageGrades = candidateVectors.map((vector, index) => gradeCandidate(vector, index, acceptedVectors, rejectedVectors));
  const final = finalDecision(imageGrades, acceptedVectors.length, rejectedVectors.length);

  if (String(payload.stage || '') === 'thumbnail') {
    return {
      ...final,
      stage: 'thumbnail',
      model: MODEL,
      checks: {
        photograph: null,
        woman_prominent: null,
        male_only: null,
        male_present: null,
        female_presenting_adult: null,
        appears_over_50: null,
        feet_dominant: null,
        logo_or_placeholder: null
      },
      examples: {
        accepted_images: acceptedVectors.length,
        rejected_images: rejectedVectors.length,
        cached_images: embeddingCache.size
      },
      siglip_decision: final,
      image_grades: imageGrades
    };
  }
  const acceptedExampleUrls = QWEN_ACCEPT_EXAMPLES > 0 ? nearestExampleUrls(candidateVectors, acceptedVectors, QWEN_ACCEPT_EXAMPLES) : [];
  const rejectedExampleUrls = QWEN_REJECT_EXAMPLES > 0 ? nearestExampleUrls(candidateVectors, rejectedVectors, QWEN_REJECT_EXAMPLES) : [];
  const rejectionSummary = rejectReasonSummary([
    ...(learnedStore.records || []).filter(record => record.label === 'reject'),
    ...(payload.rejectedArtists || [])
  ]);
  const preferOllamaVision =
    payload.preferOllama === true ||
    String(payload.localVariant || '').toLowerCase() === 'local2' ||
    process.env.PONG_LORA_PREFER_OLLAMA === '1';
  let qwen;

  if (preferOllamaVision) {
    try {
      qwen = await classifyWithOllamaVision({
        artist,
        candidateUrls,
        siglipDecision: final,
        imageGrades,
        acceptedExampleUrls,
        rejectedExampleUrls,
        rejectionSummary,
        visionModel
      });
      qwen.source = qwen.source || 'ollama';
    } catch (error) {
      const ollamaMessage = error.message || String(error);
      if (/CUDA|PTX|Ollama HTTP 500|model/i.test(ollamaMessage)) {
        ollamaFailureByModel.set(visionModel, ollamaMessage.slice(0, 180));
      }
      try {
        qwen = await classifyWithLoraVision({
          artist,
          candidateUrls,
          siglipDecision: final,
          imageGrades,
          rejectionSummary,
        });
        qwen.source = qwen.source || 'qwen_lora';
        qwen.ollama_error = ollamaMessage.slice(0, 180);
      } catch (fallbackError) {
        const message = fallbackError.message || String(fallbackError);
        qwen = {
          decision: 'unsure',
          confidence: 0.5,
          reason: `qwen unavailable: ollama ${ollamaMessage}; lora ${message}`,
          checks: {
            photograph: null,
            woman_prominent: null,
            male_only: null,
            male_present: null,
            female_presenting_adult: null,
            appears_over_50: null,
            feet_dominant: null,
            logo_or_placeholder: null
          }
        };
      }
    }
  } else {
    try {
      qwen = await classifyWithLoraVision({
        artist,
        candidateUrls,
        siglipDecision: final,
        imageGrades,
        rejectionSummary,
      });
      qwen.source = qwen.source || 'qwen_lora';
    } catch (error) {
      const loraMessage = error.message || String(error);
      try {
        qwen = await classifyWithOllamaVision({
          artist,
          candidateUrls,
          siglipDecision: final,
          imageGrades,
          acceptedExampleUrls,
          rejectedExampleUrls,
          rejectionSummary,
          visionModel
        });
        qwen.source = qwen.source || 'ollama_fallback';
        qwen.lora_error = loraMessage.slice(0, 180);
      } catch (fallbackError) {
        const message = fallbackError.message || String(fallbackError);
        if (/CUDA|PTX|Ollama HTTP 500|model/i.test(message)) {
          ollamaFailureByModel.set(visionModel, message.slice(0, 180));
          if (visionModel === OLLAMA_VISION_MODEL) {
            ollamaVisionDisabled = true;
            ollamaFailureReason = message.slice(0, 180);
          }
        }
        qwen = {
          decision: 'unsure',
          confidence: 0.5,
          reason: `qwen unavailable: lora ${loraMessage}; fallback ${message}`,
          checks: {
            photograph: null,
            woman_prominent: null,
            male_only: null,
            male_present: null,
            female_presenting_adult: null,
            appears_over_50: null,
            feet_dominant: null,
            logo_or_placeholder: null
          }
        };
      }
    }
  }

  let combined = /^qwen unavailable:/i.test(qwen.reason || '')
    ? { ...qwen, decision: 'reject', confidence: 0.75, reason: 'qwen unavailable for visual safety check' }
    : qwen;

  if (qwen.checks?.male_present === true || qwen.checks?.male_only === true || qwen.checks?.appears_over_50 === true || qwen.checks?.feet_dominant === true || qwen.checks?.logo_or_placeholder === true || qwen.checks?.photograph === false) {
    combined = { ...qwen, decision: 'reject', confidence: Math.max(Number(qwen.confidence || 0), 0.96) };
  }
  if (combined.decision === 'accept') {
    const checks = qwen.checks || {};
    const safeFemaleOnly =
      checks.photograph !== false &&
      checks.logo_or_placeholder !== true &&
      checks.appears_over_50 !== true &&
      checks.feet_dominant !== true &&
      checks.female_presenting_adult === true &&
      checks.male_present === false &&
      checks.male_only === false;
    if (!safeFemaleOnly) {
      combined = {
        ...combined,
        decision: 'reject',
        confidence: Math.max(Number(combined.confidence || 0), 0.93),
        reason: 'local vision did not prove female-only adult profile'
      };
    }
  }

  const actualVisionLabel = qwen.source === 'qwen_lora'
    ? 'qwen-lora'
    : qwen.source === 'ollama_fallback'
      ? `${visionModel} fallback`
      : visionModel;

  return {
    ...combined,
    model: `${MODEL} + ${actualVisionLabel}`,
    vision_source: qwen.source || 'ollama',
    examples: {
      accepted_images: acceptedVectors.length,
      rejected_images: rejectedVectors.length,
      learned_accept_images: learnedAcceptedVectors.length,
      learned_reject_images: learnedRejectedVectors.length,
      qwen_accept_examples: acceptedExampleUrls.length,
      qwen_reject_examples: rejectedExampleUrls.length,
      cached_images: embeddingCache.size
    },
    siglip_decision: final,
    qwen_decision: qwen,
    checks: combined.checks,
    image_grades: imageGrades
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const learnedStore = await loadLearnedStore();
      const fineTuneStatus = await readJsonFile(FINETUNE_STATUS_PATH, { status: 'idle' });
      const adapterPresent = await loraAdapterExists();
      let adapterHealth = null;
      try {
        adapterHealth = await loraInferenceHealth(900);
      } catch (_) {}
      json(res, 200, {
        ok: true,
        app: 'pong-local-ai',
        model: MODEL,
        vision_model: OLLAMA_VISION_MODEL,
        alternate_vision_models: ['qwen3-vl:4b'],
        ollama_ready: !ollamaVisionDisabled && await ollamaAvailable(OLLAMA_VISION_MODEL),
        ollama_disabled: ollamaVisionDisabled,
        ollama_failure: ollamaFailureReason,
        ollama_failures_by_model: Object.fromEntries(ollamaFailureByModel),
        ready: extractorReady,
        cached_images: embeddingCache.size,
        learned_accept_records: learnedStore.records.filter(record => record.label === 'accept').length,
        learned_reject_records: learnedStore.records.filter(record => record.label === 'reject').length,
        finetune: {
          status: fineTuneProcess ? 'running' : fineTuneStatus.status || 'idle',
          message: fineTuneStatus.message || '',
          updatedAt: fineTuneStatus.updatedAt || ''
        },
        lora_inference: {
          adapter_present: adapterPresent,
          running: Boolean(loraInferenceProcess),
          ready: Boolean(adapterHealth?.ready),
          url: LORA_INFERENCE_URL,
          model: adapterHealth?.model || '',
          adapter: adapterHealth?.adapter || ''
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/lora/health') {
      const adapterPresent = await loraAdapterExists();
      let adapterHealth = null;
      try {
        adapterHealth = await loraInferenceHealth(3000);
      } catch (error) {
        adapterHealth = { ok: false, error: error.message || String(error) };
      }
      json(res, 200, {
        ok: true,
        adapter_present: adapterPresent,
        running: Boolean(loraInferenceProcess),
        inference: adapterHealth
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/finetune/status') {
      const fineTuneStatus = await readJsonFile(FINETUNE_STATUS_PATH, { status: 'idle' });
      json(res, 200, {
        ok: true,
        running: Boolean(fineTuneProcess),
        ...fineTuneStatus
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/finetune/run') {
      const started = await queueFineTuneRun('manual');
      const fineTuneStatus = await readJsonFile(FINETUNE_STATUS_PATH, { status: 'queued' });
      json(res, 200, {
        ok: true,
        started,
        running: Boolean(fineTuneProcess),
        ...fineTuneStatus
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/finetune/rebuild') {
      const dataset = await rebuildFineTuneDatasetFromLearnedStore();
      const started = await queueFineTuneRun('rebuild');
      const fineTuneStatus = await readJsonFile(FINETUNE_STATUS_PATH, { status: 'queued' });
      json(res, 200, {
        ok: true,
        records: dataset.records.length,
        started,
        running: Boolean(fineTuneProcess),
        ...fineTuneStatus
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/examples') {
      const learnedStore = await loadLearnedStore();
      const records = learnedRecordSummaries(learnedStore);
      json(res, 200, {
        ok: true,
        records,
        accepted: records.filter(record => record.label === 'accept'),
        rejected: records.filter(record => record.label === 'reject')
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/learn') {
      const payload = JSON.parse(await readBody(req));
      const result = await learn(payload);
      json(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/classify') {
      const payload = JSON.parse(await readBody(req));
      const result = await classify(payload);
      json(res, 200, result);
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 500, { error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pong local AI listening on http://${HOST}:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Vision model: ${OLLAMA_VISION_MODEL} via ${OLLAMA_URL}`);
  getExtractor()
    .then(() => console.log('Embedding model ready'))
    .catch(error => console.error(`Embedding model failed to preload: ${error.message || error}`));
});
