import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pipeline, RawImage, env } from '@xenova/transformers';

const PORT = Number(process.env.PONG_LOCAL_AI_PORT || 8787);
const HOST = process.env.PONG_LOCAL_AI_HOST || '0.0.0.0';
const MODEL = process.env.PONG_LOCAL_IMAGE_MODEL || 'Xenova/siglip-base-patch16-224';
const OLLAMA_URL = (process.env.PONG_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_VISION_MODEL = process.env.PONG_OLLAMA_VISION_MODEL || 'qwen2.5vl:latest';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOP_K = 10;
const QWEN_ACCEPT_EXAMPLES = 2;
const QWEN_REJECT_EXAMPLES = 2;
const QWEN_CANDIDATE_IMAGES = 3;
const LEARNED_STORE_PATH = path.join(process.cwd(), '.pong-local-ai', 'learned-examples.json');
const MAX_LEARNED_RECORDS = 300;

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

async function learn(payload) {
  const label = payload.label === 'accept' ? 'accept' : payload.label === 'reject' ? 'reject' : '';
  if (!label) throw new Error('label must be accept or reject');

  const artist = payload.artist || {};
  const artistUrl = normalizeArtistUrl(artist.artistUrl || '');
  const imageUrls = [...new Set((payload.imageUrls || []).map(url => normalizeUrl(url, artistUrl || undefined)).filter(Boolean))].slice(0, 8);
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
  return {
    ok: true,
    label,
    artistUrl,
    embeddings: embeddings.length,
    accepted_records: saved.records.filter(record => record.label === 'accept').length,
    rejected_records: saved.records.filter(record => record.label === 'reject').length
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
  const [candidateImages, acceptedImages, rejectedImages] = await Promise.all([
    fetchImagesBase64(candidateUrls.slice(0, QWEN_CANDIDATE_IMAGES)),
    fetchImagesBase64(acceptedExampleUrls.slice(0, QWEN_ACCEPT_EXAMPLES)),
    fetchImagesBase64(rejectedExampleUrls.slice(0, QWEN_REJECT_EXAMPLES))
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
    'Reject if any male-presenting person is visible, male-only, no clearly female-presenting adult is visible, feet are the main subject, non-photo/logo/placeholder, age appears over the configured limit, underage-looking, unclear adult age, or the visual presentation conflicts with the saved preference signal.',
    'Accept only when the image set clearly shows a female-presenting adult and fits the saved visual preference signal: conventionally attractive styling, fit/athletic/slim/lean presentation, polished appearance, or youthful adult presentation.',
    'User reject reasons may include Fat, Male, Trans, and Ugly. Use Male as a hard visual rejection reason. Use Trans only as a user-provided or text/URL hard-filter clue; do not infer sensitive status from appearance. Use Fat/Ugly as visual preference mismatch labels without diagnosing or mentioning health.',
    'Do not identify anyone. Do not infer ethnicity, sexuality, medical conditions, or weight status. Do not mention body weight or health.',
    '',
    `Artist: ${artist.artistName || 'unknown'}`,
    `URL: ${artist.artistUrl || ''}`,
    `SigLIP learned-taste decision: ${siglipDecision.decision}, confidence ${Number(siglipDecision.confidence || 0).toFixed(2)}, ${siglipDecision.reason || ''}`,
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
  const acceptedExampleUrls = nearestExampleUrls(candidateVectors, acceptedVectors, QWEN_ACCEPT_EXAMPLES);
  const rejectedExampleUrls = nearestExampleUrls(candidateVectors, rejectedVectors, QWEN_REJECT_EXAMPLES);
  const rejectionSummary = rejectReasonSummary([
    ...(learnedStore.records || []).filter(record => record.label === 'reject'),
    ...(payload.rejectedArtists || [])
  ]);
  let qwen;
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
  } catch (error) {
    const message = error.message || String(error);
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
      reason: `qwen unavailable: ${message}`,
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

  let combined = /^qwen unavailable:/i.test(qwen.reason || '')
    ? { ...qwen, decision: 'reject', confidence: 0.75, reason: 'qwen unavailable for visual safety check' }
    : qwen;
  if (qwen.checks?.male_present === true || qwen.checks?.male_only === true || qwen.checks?.appears_over_50 === true || qwen.checks?.feet_dominant === true) {
    combined = { ...qwen, decision: 'reject', confidence: Math.max(Number(qwen.confidence || 0), 0.96) };
  }
  if (combined.decision === 'accept') {
    const checks = qwen.checks || {};
    const safeFemaleOnly =
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

  return {
    ...combined,
    model: `${MODEL} + ${visionModel}`,
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
        learned_reject_records: learnedStore.records.filter(record => record.label === 'reject').length
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
});
