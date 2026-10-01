// Terminal-only, non-identifying cache evidence for physical TikTok trials.
// /video-cache/status includes source aliases and playback URLs: inspect those
// only in memory, and return strictly whitelisted diagnostic fields.
const VIDEO_ID = /^video:(\d{15,22})$/;
const SESSION_ID = /^[a-f0-9]{32}$/;
const CATEGORIES = new Set([
  'canceled', 'timeout', 'upstream_http', 'network', 'source_unavailable',
  'access_blocked', 'media_invalid', 'media_integrity', 'storage',
  'extractor', 'unknown'
]);
const STATUSES = new Set(['idle', 'queued', 'downloading', 'ready', 'error']);

export function safeRendererErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(value) ? value : '';
}

export function terminalSourceFailureOwner(trial) {
  if (trial?.photoPost || trial?.adPost || trial?.firstPaintUpperMs != null) return null;
  for (const sample of trial?.samples || []) {
    const videoId = VIDEO_ID.exec(sample?.view?.postKey || '')?.[1];
    const sessionId = sample?.pong?.session;
    if (videoId && videoId === sample?.pong?.videoId &&
        videoId !== trial?.beforeVideoId && SESSION_ID.test(sessionId || '') &&
        sample?.renderer?.id === sessionId && sample?.renderer?.state === 'error' &&
        sample?.renderer?.frames === 0) {
      return {videoId, sessionId};
    }
  }
  return null;
}

function matchesVideo(record, videoId) {
  return Array.isArray(record?.urls) && record.urls.some(raw => {
    if (typeof raw !== 'string') return false;
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && /(^|\.)tiktok\.com$/i.test(url.hostname) &&
        url.pathname.match(/\/video\/(\d{15,22})(?:\/|$)/)?.[1] === videoId;
    } catch { return false; }
  });
}

export function safeCacheFailureStatus(payload, videoId) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records))
    return {stage:'cache_source_open', status:'unavailable', category:null};
  const matches = payload.records.filter(record => matchesVideo(record, videoId));
  if (!matches.length) return {stage:'cache_source_open', status:'missing', category:null};
  const states = matches.map(record => ({
    status: STATUSES.has(record?.status) ? record.status : 'unknown',
    category: record?.status === 'error' && CATEGORIES.has(record?.failure?.category)
      ? record.failure.category : null
  }));
  if (states.some(state => state.status !== states[0].status || state.category !== states[0].category))
    return {stage:'cache_source_open', status:'ambiguous', category:null};
  return {stage:'cache_source_open', ...states[0]};
}

export function createTerminalSourceFailureLookup(fetchStatus) {
  const bySession = new Map();
  return owner => {
    if (!owner || !SESSION_ID.test(owner.sessionId || '') || !/^\d{15,22}$/.test(owner.videoId || ''))
      return Promise.resolve(null);
    const existing = bySession.get(owner.sessionId);
    if (existing) return existing.videoId === owner.videoId ? existing.promise : Promise.resolve(null);
    const promise = (async () => {
      try {
        const payload = await fetchStatus();
        return safeCacheFailureStatus(payload, owner.videoId);
      } catch {
        return {stage:'cache_source_open', status:'unavailable', category:null};
      }
    })();
    bySession.set(owner.sessionId, {videoId:owner.videoId, promise});
    return promise;
  };
}
