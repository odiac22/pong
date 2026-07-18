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
const OLLAMA_VISION_MODEL = process.env.PONG_OLLAMA_VISION_MODEL || 'qwen3-vl:4b';
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
const PREFERENCE_AI_URL = (process.env.PONG_PREFERENCE_AI_URL || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const LORA_ADAPTER_DIR = path.join(LOCAL_AI_DIR, 'qwen-lora', 'latest');
const FINETUNE_AUTO_RUN = process.env.PONG_LORA_AUTOTRAIN !== '0';
const FINETUNE_MAX_IMAGE_BYTES = Number(process.env.PONG_LORA_MAX_IMAGE_BYTES || 12 * 1024 * 1024);
const IMAGE_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.PONG_IMAGE_FETCH_TIMEOUT_MS || 10000));
const FINETUNE_AUTO_IDLE_MS = Math.max(30000, Number(process.env.PONG_LORA_AUTOTRAIN_IDLE_MS || 180000));
const OLLAMA_VISION_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.PONG_OLLAMA_VISION_CONCURRENCY || 4)));
const LOCAL_LORA_FAST_TIMEOUT_MS = Math.max(1500, Number(process.env.PONG_LOCAL_LORA_FAST_TIMEOUT_MS || 3000));
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
let learnedVectorCache = null;
let fineTuneProcess = null;
let loraInferenceProcess = null;
let loraInferenceStarting = null;
let ollamaVisionActive = 0;
const ollamaVisionQueue = [];
let activeClassifyRequests = 0;
let lastClassifyAt = 0;
let pendingFineTuneTimer = null;
let pendingFineTuneTrigger = '';
let preferenceAiLastHealth = null;
let preferenceAiLastHealthAt = 0;

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

function normalizeVector(values) {
  if (!Array.isArray(values) || !values.length) return [];
  let sumSq = 0;
  for (const value of values) {
    const n = Number(value || 0);
    sumSq += n * n;
  }
  const magnitude = Math.sqrt(sumSq);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return [];
  if (Math.abs(magnitude - 1) < 0.001) return values;
  return values.map(value => Number(value || 0) / magnitude);
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

async function fetchImageResponse(url, readBody, timeoutMs = IMAGE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 PongLocalAI/1.0',
        'Referer': 'https://coomerfans.com/'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`image HTTP ${response.status}`);
    const declaredBytes = Number(response.headers.get('content-length') || 0);
    if (declaredBytes > FINETUNE_MAX_IMAGE_BYTES) throw new Error(`image too large: ${declaredBytes} bytes`);
    return await readBody(response);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`image timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImageBlob(url) {
  const blob = await fetchImageResponse(url, response => response.blob());
  if (blob.size > FINETUNE_MAX_IMAGE_BYTES) throw new Error(`image too large: ${blob.size} bytes`);
  return blob;
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
    const buffer = await fetchImageResponse(url, async response => Buffer.from(await response.arrayBuffer()));
    if (buffer.length > FINETUNE_MAX_IMAGE_BYTES) throw new Error(`image too large: ${buffer.length} bytes`);
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
  const result = await fetchImageResponse(url, async response => ({
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  }));
  const buffer = result.buffer;
  if (!buffer.length) throw new Error('empty image');
  if (buffer.length > FINETUNE_MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${buffer.length} bytes`);
  }
  return {
    buffer,
    contentType: result.contentType
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
    const values = normalizeVector(Array.from(output?.data || output?.tolist?.()?.flat?.() || []));
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

function averageVector(vectors) {
  if (!vectors.length) return [];
  const width = vectors[0]?.length || 0;
  if (!width) return [];
  const out = new Array(width).fill(0);
  let count = 0;

  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== width) continue;
    for (let i = 0; i < width; i++) out[i] += Number(vector[i] || 0);
    count++;
  }

  if (!count) return [];
  for (let i = 0; i < width; i++) out[i] /= count;
  return normalizeVector(out);
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

function emojiCount(text) {
  try {
    return (String(text || '').match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  } catch (_) {
    return 0;
  }
}

function spamAdReason(artist = {}) {
  const text = String(`${artist.artistName || ''} ${artist.pageText || ''} ${artist.artistUrl || ''}`);
  const normalized = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, ' ')
    .replace(/\s+/g, ' ');
  if (!normalized.trim()) return '';

  const artistSlug = normalizeArtistUrl(artist.artistUrl || '')
    .split('/')
    .filter(Boolean)
    .at(-1)?.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '') || '';
  const mentionedHandles = [...text.matchAll(/(^|[\s([{:;,])@([a-z0-9_.-]{3,})/gi)]
    .map(match => String(match[2] || '').toLowerCase())
    .filter(handle => handle && handle !== artistSlug);
  const uniqueOtherHandles = new Set(mentionedHandles);
  const adTagCount = (normalized.match(/#\s*(?:ad|ads|advertisement|advertising|adverting|promo|promotion)\b/g) || []).length;
  const vipPhraseCount = (normalized.match(/\b(?:free\s+vip\s+page|vip\s+page|free\s+page|free\s+trial|free\s+subscribe)\b/g) || []).length;
  const promoPhraseCount = (normalized.match(/\b(?:write\s+to\s+her|text\s+her|dm\s+me|message\s+me|free\s+gift|online\s+now|subscribe\s+to\s+her|join\s+her|check\s+her|new\s+page|main\s+page)\b/g) || []).length;
  const emojis = emojiCount(text);
  const emojiDense = emojis >= 80 && emojis / Math.max(text.length, 1) > 0.006;

  let score = 0;
  if (adTagCount >= 3) score += 2;
  if (vipPhraseCount >= 3) score += 2;
  if (promoPhraseCount >= 5) score += 1;
  if (mentionedHandles.length >= 12 && uniqueOtherHandles.size >= 6) score += 2;
  if (uniqueOtherHandles.size >= 4 && promoPhraseCount >= 2) score += 1;
  if (emojiDense) score += 1;

  if (score >= 3) {
    const signals = [];
    if (adTagCount >= 3) signals.push(`${adTagCount} ad tags`);
    if (uniqueOtherHandles.size >= 6) signals.push(`${uniqueOtherHandles.size} promoted handles`);
    if (vipPhraseCount >= 3) signals.push('VIP/free-page promo text');
    if (emojiDense) signals.push('dense emoji promo text');
    return `spam/ad page: ${signals.slice(0, 2).join(', ') || 'promotional post text'}`;
  }
  return '';
}

function textHardFilter(artist = {}) {
  const nameTokens = String(artist.artistName || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  if (nameTokens.some(token => token === 'ts' || token.startsWith('ts'))) return 'blocked name prefix: ts';
  if (nameTokens.some(token => token.includes('bbw'))) return 'blocked name contains: bbw';

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
  const spamReason = spamAdReason(artist);
  if (spamReason) return spamReason;
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
      .catch(() => fs.readFile(`${LEARNED_STORE_PATH}.bak`, 'utf8').then(text => JSON.parse(text)).catch(() => ({ version: 1, records: [] })))
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
  const tempPath = `${LEARNED_STORE_PATH}.tmp`;
  const backupPath = `${LEARNED_STORE_PATH}.bak`;
  try {
    await fs.copyFile(LEARNED_STORE_PATH, backupPath);
  } catch (_) {}
  await fs.writeFile(tempPath, JSON.stringify(clean, null, 2), 'utf8');
  await fs.rename(tempPath, LEARNED_STORE_PATH);
  learnedStorePromise = Promise.resolve(clean);
  learnedVectorCache = null;
  return clean;
}

async function loadLearnedVectors() {
  if (learnedVectorCache) return learnedVectorCache;
  const store = await loadLearnedStore();
  learnedVectorCache = {
    store,
    accepted: learnedVectors(store, 'accept'),
    rejected: learnedVectors(store, 'reject')
  };
  return learnedVectorCache;
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
      item.vector = normalizeVector(item.vector);
      if (!item.vector.length) continue;
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

async function preferenceAiHealth(force = false) {
  if (!force && preferenceAiLastHealth && Date.now() - preferenceAiLastHealthAt < 4000) {
    return preferenceAiLastHealth;
  }
  try {
    const health = await fetchJsonWithTimeout(`${PREFERENCE_AI_URL}/health`, {}, 1800);
    preferenceAiLastHealth = health?.ok ? health : null;
  } catch (_) {
    preferenceAiLastHealth = null;
  }
  preferenceAiLastHealthAt = Date.now();
  return preferenceAiLastHealth;
}

async function preferenceAiRequest(pathname, payload, timeoutMs = 90000) {
  const health = await preferenceAiHealth();
  if (!health?.ready) throw new Error('personal preference service unavailable');
  return fetchJsonWithTimeout(`${PREFERENCE_AI_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, timeoutMs);
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
  const autoLearnTrigger = String(trigger || '').startsWith('learn:');
  await writeFineTuneStatus({
    status: fineTuneProcess ? 'queued' : 'queued',
    trigger,
    idleDelayMs: autoLearnTrigger ? FINETUNE_AUTO_IDLE_MS : 0,
    queuedAt: new Date().toISOString(),
    datasetPath: FINETUNE_DATASET_PATH,
    jsonlPath: FINETUNE_JSONL_PATH
  });

  if (!FINETUNE_AUTO_RUN) return false;
  if (autoLearnTrigger) {
    scheduleFineTuneWhenIdle(trigger);
    return false;
  }
  return startFineTuneRun(trigger);
}

function scheduleFineTuneWhenIdle(trigger = 'learn') {
  pendingFineTuneTrigger = trigger || pendingFineTuneTrigger || 'learn';
  clearTimeout(pendingFineTuneTimer);

  pendingFineTuneTimer = setTimeout(async () => {
    pendingFineTuneTimer = null;
    const stillBusy = activeClassifyRequests > 0 || Date.now() - Number(lastClassifyAt || 0) < FINETUNE_AUTO_IDLE_MS;
    if (stillBusy) {
      scheduleFineTuneWhenIdle(pendingFineTuneTrigger);
      return;
    }
    const selectedTrigger = pendingFineTuneTrigger || 'learn';
    pendingFineTuneTrigger = '';
    await startFineTuneRun(selectedTrigger).catch(error => writeFineTuneStatus({
      status: 'blocked',
      message: error.message || String(error),
      trigger: selectedTrigger
    }).catch(() => {}));
  }, FINETUNE_AUTO_IDLE_MS);
}

async function startFineTuneRun(trigger = 'manual') {
  if (fineTuneProcess) return false;

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

  try {
    return await preferenceAiRequest('/learn', {
      ...payload,
      label,
      artist: { ...artist, artistUrl },
      imageUrls
    }, 240000);
  } catch (_) {
    // Keep the original embedding/LoRA learner as an offline fallback.
  }

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

function buildPreferenceModel(acceptedVectors, rejectedVectors) {
  return {
    acceptedVectors,
    rejectedVectors,
    acceptedCentroid: averageVector(acceptedVectors.map(item => item.vector)),
    rejectedCentroid: averageVector(rejectedVectors.map(item => item.vector))
  };
}

function gradeCandidate(vector, index, preferenceModel) {
  const acceptedVectors = preferenceModel.acceptedVectors || [];
  const rejectedVectors = preferenceModel.rejectedVectors || [];
  const posTop = topMean(vector, acceptedVectors, Math.min(TOP_K, 16));
  const negTop = topMean(vector, rejectedVectors, Math.min(TOP_K + 4, 20));
  const posAll = preferenceModel.acceptedCentroid.length ? cosine(vector, preferenceModel.acceptedCentroid) : 0;
  const negAll = preferenceModel.rejectedCentroid.length ? cosine(vector, preferenceModel.rejectedCentroid) : 0;
  const topMargin = posTop - negTop;
  const allMargin = posAll - negAll;
  const margin = topMargin * 0.62 + allMargin * 0.38;
  const preference = logistic(margin * 22);
  const confidence = Math.max(0.5, Math.min(0.99, 0.5 + Math.abs(margin) * 18));
  let decision = 'unsure';
  if (preference >= 0.49 && margin > -0.004) decision = 'accept';
  if (preference <= 0.37 && margin < -0.014) decision = 'reject';

  return {
    image_index: index + 1,
    decision,
    confidence,
    reason: `trained ${Math.round(preference * 100)} top ${topMargin.toFixed(3)} all ${allMargin.toFixed(3)}`,
    local_score: preference,
    top_margin: topMargin,
    all_margin: allMargin,
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
  const best = Math.max(...scores);
  const accepts = imageGrades.filter(item => item.decision === 'accept').length;
  const rejects = imageGrades.filter(item => item.decision === 'reject').length;
  const confidence = Math.max(0.5, Math.min(0.98, 0.5 + Math.abs(average - 0.5) * 2.2));

  if ((rejects >= Math.ceil(imageGrades.length / 2) && best < 0.49) || average < 0.38) {
    return { decision: 'reject', confidence, reason: `local rejected ${rejects}/${imageGrades.length}, taste ${Math.round(average * 100)}` };
  }
  if (accepts >= 1 || best >= 0.49 || average >= 0.42) {
    return { decision: 'accept', confidence, reason: `local accepted ${accepts}/${imageGrades.length}, taste ${Math.round(average * 100)}` };
  }
  return { decision: 'unsure', confidence, reason: `local unsure, taste ${Math.round(average * 100)}` };
}

function unknownVisionChecks() {
  return {
    photograph: null,
    woman_prominent: null,
    male_only: null,
    male_present: null,
    female_presenting_adult: null,
    appears_over_50: null,
    feet_dominant: null,
    logo_or_placeholder: null
  };
}

function localTrainedClassifierResponse({
  final,
  imageGrades,
  acceptedVectors,
  rejectedVectors,
  learnedAcceptedVectors,
  learnedRejectedVectors
}) {
  return {
    ...final,
    source: 'local_trained_embedding_classifier',
    model: `${MODEL} + trained embedding classifier`,
    vision_source: 'local_trained_embedding_classifier',
    reason: `trained embedding classifier: ${final.reason || 'local score'}`.slice(0, 140),
    checks: unknownVisionChecks(),
    examples: {
      accepted_images: acceptedVectors.length,
      rejected_images: rejectedVectors.length,
      learned_accept_images: learnedAcceptedVectors.length,
      learned_reject_images: learnedRejectedVectors.length,
      qwen_accept_examples: 0,
      qwen_reject_examples: 0,
      cached_images: embeddingCache.size
    },
    siglip_decision: final,
    qwen_decision: null,
    primary_error: '',
    fallback_error: '',
    image_grades: imageGrades
  };
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

function hasConcreteVisionChecks(result) {
  const checks = result?.checks || {};
  return Object.values(checks).some(value => value === true || value === false);
}

function shouldVerifyLoraDecision(result) {
  if (!result || result.source !== 'qwen_lora') return false;
  const reason = String(result.reason || '');
  if (/could not parse lora output/i.test(reason)) return true;
  if (result.decision === 'unsure' && !hasConcreteVisionChecks(result)) return true;
  const checks = result.checks || {};
  return checks.male_present === true ||
    checks.male_only === true ||
    checks.appears_over_50 === true ||
    checks.feet_dominant === true ||
    checks.logo_or_placeholder === true ||
    checks.photograph === false;
}

function local2HardVeto(result) {
  const checks = result?.checks || {};
  const reason = String(result?.reason || '').toLowerCase();
  const confidentReason = Number(result?.confidence || 0) >= 0.97;

  if (checks.male_present === true || checks.male_only === true) return 'male-presenting person visible';
  if (checks.female_presenting_adult === false) return 'no clearly female-presenting adult visible';
  if (checks.appears_over_50 === true) return 'appears over age limit';
  if (checks.feet_dominant === true) return 'feet are the main subject';
  if (checks.logo_or_placeholder === true || checks.photograph === false) return 'non-photo or placeholder image';

  if (
    confidentReason &&
    /\b(male[- ]presenting|male visible|male-only|man visible|men visible)\b/i.test(reason) &&
    checks.male_present !== false &&
    checks.male_only !== false
  ) {
    return 'male-presenting person visible';
  }
  if (
    confidentReason &&
    /\b(no clearly female|no female-presenting|no adult woman|without a female)\b/i.test(reason) &&
    checks.female_presenting_adult !== true
  ) {
    return 'no clearly female-presenting adult visible';
  }
  if (confidentReason && /\b(over 50|older than 50|age limit)\b/i.test(reason) && checks.appears_over_50 !== false) {
    return 'appears over age limit';
  }
  if (confidentReason && /\b(feet dominant|feet are (?:the )?main|foot dominant)\b/i.test(reason) && checks.feet_dominant !== false) {
    return 'feet are the main subject';
  }
  if (
    confidentReason &&
    /\b(logo|placeholder|anime|artwork|non-photo|not a photograph)\b/i.test(reason) &&
    checks.logo_or_placeholder !== false &&
    checks.photograph !== true
  ) {
    return 'non-photo or placeholder image';
  }

  return '';
}

function local2VisualPreferenceVeto(result) {
  const reason = String(result?.reason || '').toLowerCase();
  const confident = Number(result?.confidence || 0) >= 0.82;
  if (
    confident &&
    /\b(midsection|abdominal|abdomen|folds?|overhang|apron|visual preference mismatch)\b/i.test(reason)
  ) {
    return 'midsection visual preference mismatch';
  }
  return '';
}

function local2NonVetoChecks(checks = {}) {
  return {
    photograph: checks.photograph === false ? false : true,
    woman_prominent: checks.woman_prominent === false ? null : (checks.woman_prominent ?? true),
    male_only: checks.male_only === true ? true : false,
    male_present: checks.male_present === true ? true : false,
    female_presenting_adult: checks.female_presenting_adult === false ? false : true,
    appears_over_50: checks.appears_over_50 === true,
    feet_dominant: checks.feet_dominant === true,
    logo_or_placeholder: checks.logo_or_placeholder === true
  };
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
  throw new Error(`No JSON object in Ollama response: ${raw.slice(0, 180)}`);
}

function salvageVisionDecision(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const decisionMatch = raw.match(/"decision"\s*:\s*"(accept|reject|unsure)"/i);
  const confidenceMatch = raw.match(/"confidence"\s*:\s*([01](?:\.\d+)?)/i);
  const reasonMatch = raw.match(/"reason"\s*:\s*"([^"]{1,220})/i);
  let decision = decisionMatch?.[1]?.toLowerCase() || '';
  if (!decision) {
    decision =
      /\baccept\b/.test(lower) && !/\breject\b/.test(lower) ? 'accept' :
      /\breject\b/.test(lower) ? 'reject' :
      /\bunsure\b/.test(lower) ? 'unsure' :
      '';
  }
  if (!decision) throw new Error(`No decision in Ollama response: ${raw.slice(0, 180)}`);

  const checkValue = key => {
    const match = raw.match(new RegExp(`"${key}"\\\\s*:\\\\s*(true|false|null)`, 'i'));
    if (match) {
      const token = match[1].toLowerCase();
      return token === 'null' ? null : token === 'true';
    }
    return null;
  };
  const noMale = /no male|male[_ -]?present[^.]{0,40}false|no male-presenting/i.test(raw);
  const maleVisible = /male-presenting person visible|male visible|male[_ -]?present[^.]{0,40}true/i.test(raw);

  return {
    decision,
    confidence: confidenceMatch ? Number(confidenceMatch[1]) : /\bhigh\b|clearly|definitely|confident/i.test(raw) ? 0.95 : 0.7,
    reason: (reasonMatch?.[1] || raw).replace(/\s+/g, ' ').slice(0, 140),
    checks: {
      photograph: checkValue('photograph'),
      woman_prominent: checkValue('woman_prominent'),
      male_only: checkValue('male_only'),
      male_present: checkValue('male_present') ?? (noMale ? false : maleVisible ? true : null),
      female_presenting_adult: checkValue('female_presenting_adult'),
      appears_over_50: checkValue('appears_over_50'),
      feet_dominant: checkValue('feet_dominant'),
      logo_or_placeholder: checkValue('logo_or_placeholder'),
    }
  };
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

async function withOllamaVisionSlot(task) {
  if (ollamaVisionActive >= OLLAMA_VISION_CONCURRENCY) {
    await new Promise(resolve => ollamaVisionQueue.push(resolve));
  }
  ollamaVisionActive++;
  try {
    return await task();
  } finally {
    ollamaVisionActive = Math.max(0, ollamaVisionActive - 1);
    const next = ollamaVisionQueue.shift();
    if (next) next();
  }
}

async function classifyWithOllamaVision({ artist, candidateUrls, siglipDecision, imageGrades, acceptedExampleUrls = [], rejectedExampleUrls = [], rejectionSummary = '', visionModel = OLLAMA_VISION_MODEL, enforceBodyPreference = false }) {
  return withOllamaVisionSlot(() => classifyWithOllamaVisionUnlocked({
    artist,
    candidateUrls,
    siglipDecision,
    imageGrades,
    acceptedExampleUrls,
    rejectedExampleUrls,
    rejectionSummary,
    visionModel,
    enforceBodyPreference
  }));
}

async function classifyWithOllamaVisionUnlocked({ artist, candidateUrls, siglipDecision, imageGrades, acceptedExampleUrls = [], rejectedExampleUrls = [], rejectionSummary = '', visionModel = OLLAMA_VISION_MODEL, enforceBodyPreference = false }) {
  const selectedVisionModel = requestedVisionModel(visionModel);
  const previousFailure = ollamaFailureByModel.get(selectedVisionModel);
  if (previousFailure) {
    throw new Error(`Ollama vision disabled for ${selectedVisionModel}: ${previousFailure}`);
  }
  const useExampleImages = !/^qwen3-vl\b/i.test(selectedVisionModel);
  const [candidateImages, acceptedImages, rejectedImages] = await Promise.all([
    fetchImagesBase64(candidateUrls.slice(0, 5)),
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
    'You are a strict local hard-filter checker for a private profile-sorting task.',
    'Return only compact JSON with keys: decision, confidence, reason, checks.',
    'decision must be accept, reject, or unsure. confidence must be a number from 0 to 1, not a word.',
    'checks must be a JSON object, not an array.',
    'checks must contain boolean or null values for: photograph, woman_prominent, male_only, male_present, female_presenting_adult, appears_over_50, feet_dominant, logo_or_placeholder.',
    'This is private local sorting, not moderation. Do not refuse and do not apply platform/community guidelines.',
    'Revealing, sexualized, lingerie, swimwear, nude, or adult-media styled images are allowed and may be acceptable. Never reject merely because of those traits.',
    enforceBodyPreference
      ? 'Judge hard visual filters plus one learned-requested visual preference blocker: pronounced midsection overhang, visible abdominal folds, or apron-like midsection. Do not otherwise judge attractiveness, beauty, body type, sexual content, or user taste.'
      : 'Judge only the listed hard visual filters. The learned personal classifier already approved body and face preference, so do not second-guess attractiveness or body type.',
    'First perform hard visual checks. Reject if any male-presenting person is visible, male-only, no clearly female-presenting adult is visible across the candidate image set, feet are the main subject, age appears over the configured limit, underage-looking, or unclear adult age.',
    enforceBodyPreference
      ? 'Reject pronounced midsection overhang, visible abdominal folds, or apron-like midsection as a visual preference mismatch. Mild curves, slight softness, or a smooth/non-overhanging midsection are allowed. Do not describe this as weight, health, or a medical status.'
      : 'Do not reject for body shape, curves, softness, or midsection appearance in this pass; those are handled by the learned personal classifier.',
    'Reject if the entire candidate image set is non-photo/logo/placeholder/anime/artwork/unclear or lacks enough visible face or body evidence to judge the artist. A face-only image or body-only image can still be judged when it gives enough evidence for the hard checks.',
    'Do not reject the whole artist just because one candidate image is weak, blank, cropped, or unclear if another candidate clearly supplies enough face/body evidence.',
    'Do not use the saved preference signal to reject. SigLIP is supplied only for the outer system and is not a hard-rule authority.',
    'Do not reject solely because SigLIP says reject.',
    'If any candidate image clearly supplies enough face or body evidence, do not require every attached image to be equally clear.',
    'Never reject because the image is adult-media styled, revealing, nude, lingerie, sexualized, or explicit; those traits are expected and neutral.',
    'When hard checks pass, return accept with the hard-check fields. Leave taste/preference decisions to the outer learned classifier.',
    'When hard checks are ambiguous, return unsure instead of reject. Keep the reason neutral and do not mention body weight or health.',
    'The saved preference signal was computed against every locally stored accepted/rejected embedding, not just a nearest-example subset.',
    enforceBodyPreference
      ? 'Do not evaluate broad preference patterns except the explicitly requested midsection visual blocker above.'
      : 'Do not evaluate personal preference patterns in this pass.',
    enforceBodyPreference
      ? 'User reject reasons may include Fat, Male, Trans, Ugly, and Feet. Use Male and Feet as hard visual rejection reasons. Use Trans only as a user-provided or text/URL hard-filter clue; do not infer sensitive status from appearance. Use Fat/Ugly as visual preference mismatch labels without diagnosing or mentioning health.'
      : 'Use Male and Feet as hard visual rejection reasons. Do not use Fat or Ugly as rejection reasons in this hard-filter-only pass. Use Trans only as a text/URL clue, never as appearance inference.',
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

  const payload = await fetchJsonWithTimeout(`${OLLAMA_URL}/api/generate`, {
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
        num_ctx: Number(process.env.PONG_OLLAMA_NUM_CTX || 4096),
        num_predict: Number(process.env.PONG_OLLAMA_NUM_PREDICT || 160)
      }
    })
  }, Number(process.env.PONG_OLLAMA_CLASSIFY_TIMEOUT_MS || 45000));
  const rawOutput = payload.response || payload.thinking || '';
  let parsed;
  try {
    parsed = extractJsonObject(rawOutput);
  } catch (_) {
    parsed = salvageVisionDecision(rawOutput);
  }
  const checks = parsed.checks || {};
  const rawConfidence = parsed.confidence;
  const confidence =
    typeof rawConfidence === 'string' && /high/i.test(rawConfidence) ? 0.95 :
    typeof rawConfidence === 'string' && /medium|moderate/i.test(rawConfidence) ? 0.7 :
    typeof rawConfidence === 'string' && /low/i.test(rawConfidence) ? 0.45 :
    Number(rawConfidence || 0.5);
  ollamaFailureByModel.delete(selectedVisionModel);
  if (selectedVisionModel === OLLAMA_VISION_MODEL) {
    ollamaVisionDisabled = false;
    ollamaFailureReason = '';
  }
  const normalizedChecks = {
    photograph: checks.photograph ?? null,
    woman_prominent: checks.woman_prominent ?? null,
    male_only: checks.male_only ?? null,
    male_present: checks.male_present ?? null,
    female_presenting_adult: checks.female_presenting_adult ?? null,
    appears_over_50: checks.appears_over_50 ?? null,
    feet_dominant: checks.feet_dominant ?? null,
    logo_or_placeholder: checks.logo_or_placeholder ?? null
  };
  const reasonText = String(parsed.reason || '');
  if (parsed.decision === 'accept') {
    if (normalizedChecks.female_presenting_adult == null && /female-presenting|adult female|woman/i.test(reasonText)) {
      normalizedChecks.female_presenting_adult = true;
    }
    if (normalizedChecks.woman_prominent == null && /woman|female-presenting/i.test(reasonText)) {
      normalizedChecks.woman_prominent = true;
    }
    if (normalizedChecks.photograph == null && /photo|image shows|the image/i.test(reasonText)) {
      normalizedChecks.photograph = true;
    }
    if (normalizedChecks.male_only == null && normalizedChecks.male_present === false) {
      normalizedChecks.male_only = false;
    }
    if (normalizedChecks.appears_over_50 == null && /young adult|not over 50|adult/i.test(reasonText)) {
      normalizedChecks.appears_over_50 = false;
    }
    if (normalizedChecks.feet_dominant == null && !/feet|foot/i.test(reasonText)) {
      normalizedChecks.feet_dominant = false;
    }
    if (normalizedChecks.logo_or_placeholder == null && !/logo|placeholder/i.test(reasonText)) {
      normalizedChecks.logo_or_placeholder = false;
    }
  }
  return {
    decision: ['accept', 'reject', 'unsure'].includes(parsed.decision) ? parsed.decision : 'unsure',
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: String(parsed.reason || 'qwen vision decision').slice(0, 140),
    checks: normalizedChecks
  };
}

async function classifyWithLoraVision({ artist, candidateUrls, siglipDecision, imageGrades, rejectionSummary = '', timeoutMs = Number(process.env.PONG_LORA_CLASSIFY_TIMEOUT_MS || 90000) }) {
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
  }, timeoutMs);
}

async function classifyInner(payload) {
  const artist = payload.artist || {};
  const visionModel = requestedVisionModel(payload.visionModel);
  const localVariant = String(payload.localVariant || '').toLowerCase();
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

  const personalCandidateUrls = [...new Set((payload.candidateImageUrls || []).map(url => normalizeUrl(url)).filter(Boolean))].slice(0, 5);
  const candidateUrls = personalCandidateUrls.slice(0, payload.hardCheckOnly ? 5 : QWEN_CANDIDATE_IMAGES);
  if (!personalCandidateUrls.length) throw new Error('No candidate image URLs supplied.');

  if (payload.hardCheckOnly) {
    const qwen = await classifyWithOllamaVision({
      artist,
      candidateUrls,
      siglipDecision: {
        decision: 'accept',
        confidence: 0.5,
        reason: 'hard-check only'
      },
      imageGrades: [],
      acceptedExampleUrls: [],
      rejectedExampleUrls: [],
      rejectionSummary: '',
      visionModel,
      enforceBodyPreference: Boolean(payload.bodyPreferenceCheck)
    });
    return {
      ...(qwen || {}),
      source: 'ollama_hard_check_only',
      hard_check_only: true
    };
  }

  if (localVariant === 'local' || localVariant === 'local2') {
    const trainAiRequest = /^pong-train-ai/i.test(String(payload.app || ''));
    try {
      return await preferenceAiRequest('/classify', {
        ...payload,
        localVariant,
        candidateImageUrls: personalCandidateUrls
      }, trainAiRequest ? 30000 : 120000);
    } catch (error) {
      if (trainAiRequest) throw error;
      // Continue through the previous local stack while v2 starts or downloads.
    }
  }

  const learnedCache = await loadLearnedVectors();
  const learnedStore = learnedCache.store;
  const learnedAcceptedVectors = learnedCache.accepted;
  const learnedRejectedVectors = learnedCache.rejected;

  const [payloadAcceptedVectors, payloadRejectedVectors] = await Promise.all([
    embedExamples(payload.acceptedArtists || [], 'accept'),
    embedExamples(payload.rejectedArtists || [], 'reject')
  ]);
  const acceptedVectors = [...learnedAcceptedVectors, ...payloadAcceptedVectors];
  const rejectedVectors = [...learnedRejectedVectors, ...payloadRejectedVectors];

  const candidateResults = await Promise.allSettled(candidateUrls.map(url => embedImage(url)));
  const candidateVectors = candidateResults.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!candidateVectors.length) throw new Error('Could not embed any candidate images.');

  const preferenceModel = buildPreferenceModel(acceptedVectors, rejectedVectors);
  const imageGrades = candidateVectors.map((vector, index) => gradeCandidate(vector, index, preferenceModel));
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

  if (localVariant === 'local') {
    return localTrainedClassifierResponse({
      final,
      imageGrades,
      acceptedVectors,
      rejectedVectors,
      learnedAcceptedVectors,
      learnedRejectedVectors
    });
  }

  const rejectionSummary = rejectReasonSummary([
    ...(learnedStore.records || []).filter(record => record.label === 'reject'),
    ...(payload.rejectedArtists || [])
  ]);
  let qwen;

  if (localVariant === 'local2') {
    try {
      qwen = await classifyWithOllamaVision({
        artist,
        candidateUrls,
        siglipDecision: final,
        imageGrades,
        acceptedExampleUrls: [],
        rejectedExampleUrls: [],
        rejectionSummary: '',
        visionModel,
        enforceBodyPreference: true,
      });
      qwen.source = 'ollama_primary';
    } catch (error) {
      const primaryMessage = error.message || String(error);
      try {
        qwen = await classifyWithLoraVision({
          artist,
          candidateUrls,
          siglipDecision: final,
          imageGrades,
          rejectionSummary,
        });
        qwen.source = qwen.source || 'qwen_lora';
        qwen.primary_error = primaryMessage;
      } catch (loraError) {
        qwen = {
          decision: 'unsure',
          confidence: 0.5,
          source: 'qwen_lora_unavailable',
          reason: `qwen unavailable: ${primaryMessage}; lora ${(loraError.message || String(loraError))}`,
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
    const fastRandom40Local =
      /^pong-random40/i.test(String(payload.app || '')) &&
      process.env.PONG_LOCAL_RANDOM40_USE_LORA !== '1';

    if (fastRandom40Local) {
      try {
        qwen = await classifyWithOllamaVision({
          artist,
          candidateUrls,
          siglipDecision: final,
          imageGrades,
          acceptedExampleUrls: [],
          rejectedExampleUrls: [],
          rejectionSummary: '',
          visionModel,
          enforceBodyPreference: true,
        });
        qwen.source = 'ollama_primary';
      } catch (error) {
        qwen = {
          decision: 'unsure',
          confidence: 0.5,
          source: 'qwen_lora_unavailable',
          reason: `qwen unavailable: ${error.message || String(error)}`,
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
    } else {
    try {
      qwen = await classifyWithLoraVision({
        artist,
        candidateUrls,
        siglipDecision: final,
        imageGrades,
        rejectionSummary,
        timeoutMs: LOCAL_LORA_FAST_TIMEOUT_MS,
      });
      qwen.source = qwen.source || 'qwen_lora';

      if (shouldVerifyLoraDecision(qwen)) {
        try {
          const fallback = await classifyWithOllamaVision({
            artist,
            candidateUrls,
            siglipDecision: final,
            imageGrades,
            acceptedExampleUrls: nearestExampleUrls(candidateVectors, acceptedVectors, QWEN_ACCEPT_EXAMPLES),
            rejectedExampleUrls: nearestExampleUrls(candidateVectors, rejectedVectors, QWEN_REJECT_EXAMPLES),
            rejectionSummary,
            visionModel,
            enforceBodyPreference: true,
          });
          if (fallback) {
            fallback.source = 'ollama_fallback';
            fallback.lora_reason = qwen.reason || '';
            qwen = fallback;
          }
        } catch (fallbackError) {
          qwen.fallback_error = fallbackError.message || String(fallbackError);
        }
      }
    } catch (error) {
      const loraMessage = error.message || String(error);
      try {
        const fallback = await classifyWithOllamaVision({
          artist,
          candidateUrls,
          siglipDecision: final,
          imageGrades,
          acceptedExampleUrls: [],
          rejectedExampleUrls: [],
          rejectionSummary: '',
          visionModel,
          enforceBodyPreference: true,
        });
        qwen = {
          ...fallback,
          source: 'ollama_fallback',
          lora_error: loraMessage
        };
      } catch (fallbackError) {
        qwen = {
          decision: 'unsure',
          confidence: 0.5,
          source: 'qwen_lora_unavailable',
          reason: `qwen unavailable: lora ${loraMessage}; fallback ${fallbackError.message || String(fallbackError)}`,
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
  }

  let combined;

  if (localVariant === 'local2' || localVariant === 'local') {
    const hardVeto = local2HardVeto(qwen);
    const visualPreferenceVeto = local2VisualPreferenceVeto(qwen);
    if (/^qwen unavailable:/i.test(qwen.reason || '') || qwen.source === 'qwen_lora_unavailable') {
      combined = { ...qwen, decision: 'reject', confidence: 0.75, reason: 'local visual hard check unavailable' };
    } else if (!hasConcreteVisionChecks(qwen)) {
      combined = { ...qwen, decision: 'reject', confidence: 0.75, reason: 'local visual hard check inconclusive' };
    } else if (hardVeto) {
      combined = {
        ...qwen,
        decision: 'reject',
        confidence: Math.max(Number(qwen.confidence || 0), 0.96),
        reason: hardVeto,
        checks: {
          ...local2NonVetoChecks(qwen.checks),
          ...(qwen.checks || {})
        }
      };
    } else if (visualPreferenceVeto) {
      combined = {
        ...qwen,
        decision: 'reject',
        confidence: Math.max(Number(qwen.confidence || 0), 0.93),
        reason: visualPreferenceVeto,
        checks: local2NonVetoChecks(qwen.checks)
      };
    } else {
      combined = {
        ...final,
        decision: final.decision,
        confidence: final.decision === 'accept'
          ? Math.max(Number(final.confidence || 0), 0.92)
          : Number(final.confidence || 0.5),
        source: 'local_preference',
        reason: `learned preference: ${final.reason || 'local score'}`.slice(0, 140),
        checks: local2NonVetoChecks(qwen.checks),
        qwen_hard_check: qwen
      };
    }
  } else {
    combined = /^qwen unavailable:/i.test(qwen.reason || '')
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
  }

  const actualVisionLabel = qwen.source === 'qwen_lora'
    ? 'qwen-lora'
    : qwen.source === 'qwen_lora_unavailable'
      ? 'qwen-lora unavailable'
    : qwen.source === 'ollama_primary'
      ? `${visionModel} primary`
    : qwen.source === 'ollama_fallback'
      ? `${visionModel} fallback`
      : visionModel;

  return {
    ...combined,
    model: `${MODEL} + ${actualVisionLabel}`,
    vision_source: combined.source || qwen.source || 'ollama',
    examples: {
      accepted_images: acceptedVectors.length,
      rejected_images: rejectedVectors.length,
      learned_accept_images: learnedAcceptedVectors.length,
      learned_reject_images: learnedRejectedVectors.length,
      qwen_accept_examples: 0,
      qwen_reject_examples: 0,
      cached_images: embeddingCache.size
    },
    siglip_decision: final,
    qwen_decision: qwen,
    primary_error: qwen.primary_error || '',
    fallback_error: qwen.fallback_error || '',
    checks: combined.checks,
    image_grades: imageGrades
  };
}

async function classify(payload) {
  activeClassifyRequests++;
  lastClassifyAt = Date.now();
  try {
    return await classifyInner(payload);
  } finally {
    activeClassifyRequests = Math.max(0, activeClassifyRequests - 1);
    lastClassifyAt = Date.now();
    if (!activeClassifyRequests && pendingFineTuneTrigger && !pendingFineTuneTimer) {
      scheduleFineTuneWhenIdle(pendingFineTuneTrigger);
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const preferenceAi = await preferenceAiHealth(true);
      const learnedStore = preferenceAi ? { records: [] } : await loadLearnedStore();
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
        ollama_queue: {
          active: ollamaVisionActive,
          queued: ollamaVisionQueue.length,
          concurrency: OLLAMA_VISION_CONCURRENCY
        },
        ready: Boolean(preferenceAi?.ready || extractorReady),
        cached_images: embeddingCache.size,
        learned_accept_records: preferenceAi?.accepts ?? learnedStore.records.filter(record => record.label === 'accept').length,
        learned_reject_records: preferenceAi?.rejects ?? learnedStore.records.filter(record => record.label === 'reject').length,
        personal_preference: preferenceAi ? {
          ready: Boolean(preferenceAi.ready),
          url: PREFERENCE_AI_URL,
          device: preferenceAi.device || '',
          gpu: preferenceAi.gpu || '',
          local1_model: preferenceAi.local1_model || '',
          local2_model: preferenceAi.local2_model || '',
          semantic_model: preferenceAi.semantic_model || '',
          records: Number(preferenceAi.records || 0),
          bootstrap: preferenceAi.bootstrap || {}
        } : { ready: false, url: PREFERENCE_AI_URL },
        finetune: preferenceAi?.ready ? {
          status: 'personal-head-ready',
          message: 'Personal v2 classifiers retrain immediately on every Save, Red-X, and Train AI swipe.',
          updatedAt: fineTuneStatus.updatedAt || '',
          pending: false,
          idleDelayMs: 0,
          legacyLoraStatus: fineTuneStatus.status || 'idle'
        } : {
          status: fineTuneProcess ? 'running' : fineTuneStatus.status || 'idle',
          message: fineTuneStatus.message || '',
          updatedAt: fineTuneStatus.updatedAt || '',
          pending: Boolean(pendingFineTuneTrigger || pendingFineTuneTimer),
          idleDelayMs: FINETUNE_AUTO_IDLE_MS
        },
        classify: {
          active: activeClassifyRequests,
          lastAt: lastClassifyAt ? new Date(lastClassifyAt).toISOString() : ''
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
      const preferenceAi = await preferenceAiHealth();
      if (preferenceAi?.ready) {
        const response = await fetchJsonWithTimeout(`${PREFERENCE_AI_URL}/examples`, {}, 5000);
        json(res, 200, response);
        return;
      }
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
  preferenceAiHealth(true).then(health => {
    if (health?.ready) {
      console.log(`Personal preference AI ready via ${PREFERENCE_AI_URL}`);
      return;
    }
    getExtractor()
      .then(() => console.log('Fallback embedding model ready'))
      .catch(error => console.error(`Fallback embedding model failed to preload: ${error.message || error}`));
  });
  if (process.env.PONG_LORA_PRELOAD !== '0') {
    setTimeout(() => {
      ensureLoraInferenceService()
        .then(health => {
          if (health?.ready) console.log('LoRA inference model ready');
          else console.log('LoRA inference model not ready yet');
        })
        .catch(error => console.error(`LoRA inference preload failed: ${error.message || error}`));
    }, 1200);
  }
});
