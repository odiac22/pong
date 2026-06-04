// Pong GitHub shared saved videos/artists sync override.
// Separate lists:
// - savedVideos = only videos saved with the Video button
// - savedArtists = only paperclip/artist bundles saved with the Artist button
//
// Added:
// - Remove button above the eye button
// - If viewing saved videos: remove current video only
// - If viewing saved artist bundles: remove the whole current artist bundle only
// - Saved videos play fully randomized
// - Saved artists play randomized by artist bundle, and videos inside each artist bundle are also randomized, but bundles stay grouped

(function () {
  'use strict';

  const SAVED_VIDEOS_KEY = 'pong_saved_videos_v1';
  const SAVED_ARTISTS_KEY = 'pong_saved_artists_v1';
  const GITHUB_TOKEN_KEY = 'pong_github_token_v1';
  const MEDIA_SIGNATURE_CACHE_KEY = 'pong_media_signature_cache_v1';
  const COOMERFANS_PROXY_URL_KEY = 'pong_coomerfans_proxy_url_v1';
  const SAVE_COUNTS_KEY = 'pong_save_counts_v1';
  const DEFAULT_COOMERFANS_PROXY_URL = 'https://pong-coomerfans-proxy.odiac22-pong-repair.workers.dev';
  const PONG_ARTIST_PREFIX = '#PONG_ARTIST ';
  const PONG_VIDEO_PREFIX = '#PONG_VIDEO ';

  const GITHUB_SYNC = {
    owner: 'odiac22',
    repo: 'pong',
    branch: 'main',
    path: 'pong-data/saved-links.json'
  };

  const SCRUB_START_PX = 34;
  const SCRUB_DOMINANCE_RATIO = 2.0;
  const VERTICAL_START_PX = 12;
  const VERTICAL_DOMINANCE_RATIO = 1.2;
  const SCRUB_PIXELS_PER_SECOND = 22;
  const SAVE_TAP_MOVE_CANCEL_PX = 28;

  window.PongLoadedSavedMode = window.PongLoadedSavedMode || 'normal';

  function injectPongSyncStyles() {
    let style = document.getElementById('pong-sync-style');

    if (!style) {
      style = document.createElement('style');
      style.id = 'pong-sync-style';
      document.head.appendChild(style);
    }

    style.textContent = `
      .save-actions-panel {
        position: fixed !important;
        left: 12px !important;
        top: calc(50% + 78px) !important;
        right: auto !important;
        transform: translateY(0) !important;
        z-index: 1200 !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 6px !important;
        pointer-events: auto !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        -webkit-touch-callout: none !important;
      }

      .side-save-button {
        width: 30px !important;
        min-height: 32px !important;
        border: 1px solid rgba(255,255,255,0.13) !important;
        border-radius: 9px !important;
        background: rgba(7,11,15,0.46) !important;
        color: rgba(244,248,255,0.86) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 1px !important;
        cursor: pointer !important;
        opacity: 0.42 !important;
        box-shadow: 0 8px 24px rgba(0,0,0,0.28) !important;
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
        -webkit-tap-highlight-color: transparent !important;
        touch-action: manipulation !important;
        transition: all 0.18s ease !important;
        padding: 2px !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        -webkit-touch-callout: none !important;
      }

      .side-save-button:hover,
      .side-save-button:active {
        opacity: 1 !important;
        transform: scale(1.05) !important;
      }

      .side-save-icon {
        font-size: 12px !important;
        line-height: 1 !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        -webkit-touch-callout: none !important;
      }

      .side-save-label {
        font-size: 6px !important;
        font-weight: 700 !important;
        line-height: 1 !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        -webkit-touch-callout: none !important;
      }

      .side-save-count {
        margin-top: 1px !important;
        min-width: 12px !important;
        height: 10px !important;
        padding: 0 2px !important;
        border-radius: 999px !important;
        background: rgba(103,232,249,0.78) !important;
        color: white !important;
        font-size: 7px !important;
        font-weight: 800 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        -webkit-touch-callout: none !important;
      }

      .remove-saved-button {
        position: fixed !important;
        left: 12px !important;
        top: calc(50% - 84px) !important;
        transform: translateY(-50%) !important;
        width: 26px !important;
        height: 26px !important;
        background: rgba(251,113,133,0.16) !important;
        opacity: 0.42 !important;
        font-size: 13px !important;
        border: 1px solid rgba(255,255,255,0.13) !important;
        border-radius: 999px !important;
        z-index: 1200 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        color: rgba(244,248,255,0.86) !important;
        box-shadow: 0 8px 24px rgba(0,0,0,0.28) !important;
        -webkit-tap-highlight-color: transparent !important;
        touch-action: manipulation !important;
        transition: all 0.18s ease !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        -webkit-touch-callout: none !important;
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
      }

      .remove-saved-button:hover,
      .remove-saved-button:active {
        opacity: 0.88 !important;
        transform: translateY(-50%) scale(1.06) !important;
      }

      .pong-repair-panel {
        position: fixed !important;
        left: 50% !important;
        top: 6px !important;
        transform: translateX(-50%) !important;
        width: min(94vw, 560px) !important;
        max-height: min(28vh, 150px) !important;
        overflow: auto !important;
        z-index: 14000 !important;
        border: 1px solid rgba(255,255,255,0.1) !important;
        border-radius: 8px !important;
        background: rgba(7,11,15,0.66) !important;
        color: rgba(244,248,255,0.88) !important;
        box-shadow: 0 10px 30px rgba(0,0,0,0.32) !important;
        backdrop-filter: blur(12px) !important;
        -webkit-backdrop-filter: blur(12px) !important;
        padding: 6px !important;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        -webkit-touch-callout: none !important;
      }

      .pong-repair-title {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        gap: 5px !important;
        font-size: 9px !important;
        font-weight: 800 !important;
        line-height: 1.05 !important;
        margin-bottom: 4px !important;
      }

      .pong-repair-actions {
        display: flex !important;
        align-items: center !important;
        gap: 3px !important;
      }

      .pong-repair-status {
        color: rgba(244,248,255,0.62) !important;
        font-size: 8px !important;
        line-height: 1.1 !important;
        min-height: 9px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        margin-bottom: 4px !important;
      }

      .pong-repair-track {
        height: 4px !important;
        border-radius: 999px !important;
        background: rgba(255,255,255,0.12) !important;
        overflow: hidden !important;
      }

      .pong-repair-fill {
        height: 100% !important;
        width: 0 !important;
        border-radius: inherit !important;
        background: rgba(103,232,249,0.78) !important;
        transition: width 0.24s ease !important;
      }

      .pong-repair-meta {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        gap: 5px !important;
        margin-top: 4px !important;
        color: rgba(244,248,255,0.56) !important;
        font-size: 7px !important;
      }

      .pong-repair-detail {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        gap: 5px !important;
        margin-top: 2px !important;
        color: rgba(244,248,255,0.38) !important;
        font-size: 6px !important;
        line-height: 1.05 !important;
      }

      .pong-repair-detail span {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }

      .pong-repair-stop,
      .pong-repair-copy {
        border: 1px solid rgba(255,255,255,0.13) !important;
        border-radius: 999px !important;
        background: rgba(251,113,133,0.16) !important;
        color: rgba(244,248,255,0.82) !important;
        padding: 2px 6px !important;
        font-size: 7px !important;
        font-weight: 800 !important;
        cursor: pointer !important;
      }

      .pong-repair-copy {
        background: rgba(103,232,249,0.14) !important;
      }

      .pong-repair-frame {
        display: none !important;
        width: 100% !important;
        height: clamp(180px, 42vh, 430px) !important;
        margin-top: 8px !important;
        border: 1px solid rgba(255,255,255,0.12) !important;
        border-radius: 8px !important;
        background: #05070a !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }

      .pong-repair-log {
        display: block !important;
        width: 100% !important;
        max-height: 38px !important;
        overflow: auto !important;
        box-sizing: border-box !important;
        margin: 4px 0 0 !important;
        padding: 3px 4px !important;
        border: 1px solid rgba(255,255,255,0.09) !important;
        border-radius: 6px !important;
        background: rgba(0,0,0,0.28) !important;
        color: rgba(229,231,235,0.58) !important;
        font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace !important;
        font-size: 6px !important;
        line-height: 1.15 !important;
        white-space: pre-wrap !important;
      }

      .pong-repair-worker-note {
        display: none !important;
        margin-top: 4px !important;
        padding: 3px 4px !important;
        border-radius: 6px !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        background: rgba(0,0,0,0.22) !important;
        color: rgba(229,231,235,0.48) !important;
        font-size: 6px !important;
        line-height: 1.1 !important;
      }

      .pong-video-expired-hint {
        position: absolute !important;
        left: 50% !important;
        top: calc(50% + 60px) !important;
        transform: translateX(-50%) !important;
        max-width: min(70vw, 260px) !important;
        z-index: 25 !important;
        color: rgba(210,214,220,0.42) !important;
        background: rgba(8,12,16,0.18) !important;
        border: 1px solid rgba(255,255,255,0.05) !important;
        border-radius: 999px !important;
        padding: 2px 6px !important;
        font-size: 7px !important;
        line-height: 1.15 !important;
        font-weight: 600 !important;
        letter-spacing: 0 !important;
        text-align: center !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        opacity: 0.45 !important;
        pointer-events: none !important;
        backdrop-filter: blur(6px) !important;
        -webkit-backdrop-filter: blur(6px) !important;
      }
    `;
  }

  function emptySharedData() {
    return {
      savedVideos: {},
      savedArtists: {}
    };
  }

  function showMsg(msg) {
    if (typeof showSortingIndicator === 'function') {
      showSortingIndicator(msg);
    } else {
      console.log(msg);
    }
  }

  function getGitHubToken() {
    try {
      return localStorage.getItem(GITHUB_TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setGitHubToken() {
    const current = getGitHubToken();
    const token = prompt('Paste GitHub token for Pong sync:', current);

    if (token === null) return;

    try {
      localStorage.setItem(GITHUB_TOKEN_KEY, token.trim());
      showMsg(token.trim() ? 'GitHub token saved' : 'GitHub token cleared');
    } catch (e) {
      showMsg('Could not save token');
    }
  }

  function requireGitHubToken() {
    const token = getGitHubToken();

    if (!token) {
      setGitHubToken();
      return getGitHubToken();
    }

    return token;
  }

  function getCoomerfansProxyUrl() {
    try {
      const configured = String(
        window.PONG_COOMERFANS_PROXY_URL ||
        localStorage.getItem(COOMERFANS_PROXY_URL_KEY) ||
        DEFAULT_COOMERFANS_PROXY_URL ||
        ''
      ).trim();
      return configured.replace(/\/+$/, '');
    } catch (e) {
      return DEFAULT_COOMERFANS_PROXY_URL;
    }
  }

  function setCoomerfansProxyUrl() {
    const current = getCoomerfansProxyUrl();
    const proxyUrl = prompt('Paste Cloudflare Worker repair proxy URL:', current);

    if (proxyUrl === null) return current;

    const trimmed = proxyUrl.trim().replace(/\/+$/, '');

    try {
      if (trimmed) {
        localStorage.setItem(COOMERFANS_PROXY_URL_KEY, trimmed);
      } else {
        localStorage.removeItem(COOMERFANS_PROXY_URL_KEY);
      }

      showMsg(trimmed ? 'Repair proxy saved' : 'Repair proxy cleared');
    } catch (e) {
      showMsg('Could not save repair proxy');
    }

    return trimmed;
  }

  function repairProxyFetchUrl(rawUrl) {
    const proxy = getCoomerfansProxyUrl();

    if (!proxy) {
      return rawUrl;
    }

    const separator = proxy.includes('?') ? '&' : '?';

    return `${proxy}${separator}url=${encodeURIComponent(rawUrl)}&t=${Date.now()}`;
  }

  function loadSavedMap(key) {
    try {
      const data = JSON.parse(localStorage.getItem(key) || '{}');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
      return {};
    }
  }

  function saveSavedMap(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function runWhenIdle(fn, timeout = 5000) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout });
    } else {
      setTimeout(fn, Math.min(timeout, 1200));
    }
  }

  function loadSaveCounts() {
    try {
      const counts = JSON.parse(localStorage.getItem(SAVE_COUNTS_KEY) || 'null');
      if (!counts || typeof counts !== 'object') return null;

      return {
        videos: Math.max(0, Number(counts.videos || 0)),
        artists: Math.max(0, Number(counts.artists || 0))
      };
    } catch (e) {
      return null;
    }
  }

  function saveSaveCounts(counts) {
    try {
      localStorage.setItem(SAVE_COUNTS_KEY, JSON.stringify({
        videos: Math.max(0, Number(counts?.videos || 0)),
        artists: Math.max(0, Number(counts?.artists || 0)),
        updatedAt: new Date().toISOString()
      }));
    } catch (e) {}
  }

  function updateSaveCounterElements(counts) {
    const videoCount = document.getElementById('saved-video-count');
    const artistCount = document.getElementById('saved-artist-count');

    if (videoCount) {
      videoCount.textContent = String(Math.max(0, Number(counts?.videos || 0)));
    }

    if (artistCount) {
      artistCount.textContent = String(Math.max(0, Number(counts?.artists || 0)));
    }
  }

  function getCountsFromSharedData(data) {
    return {
      videos: Object.keys(data?.savedVideos || {}).length,
      artists: Object.keys(data?.savedArtists || {}).length
    };
  }

  function getQuickSavedMapCount(key, pattern) {
    try {
      const raw = localStorage.getItem(key) || '';
      if (!raw) return 0;

      const matches = raw.match(pattern);
      return matches ? matches.length : 0;
    } catch (e) {
      return 0;
    }
  }

  function getQuickLocalSaveCounts() {
    return {
      videos: getQuickSavedMapCount(SAVED_VIDEOS_KEY, /"mediaKey"\s*:/g),
      artists: getQuickSavedMapCount(SAVED_ARTISTS_KEY, /"videos"\s*:/g)
    };
  }

  function base64EncodeUnicode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';

    bytes.forEach(byte => {
      binary += String.fromCharCode(byte);
    });

    return btoa(binary);
  }

  function base64DecodeUnicode(base64) {
    const binary = atob(String(base64 || '').replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function githubApiUrl() {
    return `https://api.github.com/repos/${GITHUB_SYNC.owner}/${GITHUB_SYNC.repo}/contents/${GITHUB_SYNC.path}`;
  }

  function githubHeaders(options = {}) {
    const token = options.requireToken ? requireGitHubToken() : '';
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  function normalizeSharedData(data, options = {}) {
    let normalized = data;

    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      normalized = emptySharedData();
    }

    normalized.savedVideos = normalized.savedVideos || {};
    normalized.savedArtists = normalized.savedArtists || {};

    if (options.refreshMedia) {
      refreshSharedDataMediaUrls(normalized);
    }

    return normalized;
  }

  async function fetchRawSharedData(rawUrl) {
    const target = rawUrl || `https://raw.githubusercontent.com/${GITHUB_SYNC.owner}/${GITHUB_SYNC.repo}/${GITHUB_SYNC.branch}/${GITHUB_SYNC.path}`;
    const rawRes = await fetch(`${target}${target.includes('?') ? '&' : '?'}t=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store'
    });

    if (rawRes.status === 404) {
      return emptySharedData();
    }

    if (!rawRes.ok) {
      throw new Error(`GitHub raw load failed: ${rawRes.status}`);
    }

    try {
      return await rawRes.json();
    } catch (e) {
      throw new Error('GitHub raw JSON parse failed');
    }
  }

  async function fetchSharedDataFromGitHub(options = {}) {
    const requireWriteSha = !!options.requireWriteSha;
    let file = null;
    let parsed = null;
    let apiError = null;

    try {
      const res = await fetch(`${githubApiUrl()}?ref=${encodeURIComponent(GITHUB_SYNC.branch)}&t=${Date.now()}`, {
        method: 'GET',
        headers: githubHeaders({ requireToken: requireWriteSha }),
        cache: 'no-store'
      });

      if (res.status === 404) {
        return {
          data: emptySharedData(),
          sha: null
        };
      }

      if (!res.ok) {
        throw new Error(`GitHub load failed: ${res.status}`);
      }

      file = await res.json();

      const inlineContent =
        typeof file?.content === 'string' && file.content.trim()
          ? file.content
          : '';

      if (inlineContent && file?.encoding === 'base64') {
        try {
          parsed = JSON.parse(base64DecodeUnicode(inlineContent));
        } catch (e) {
          parsed = null;
        }
      }
    } catch (e) {
      apiError = e;

      if (requireWriteSha) {
        throw e;
      }
    }

    if (!parsed) {
      const rawUrl = (
        typeof file?.download_url === 'string' && file.download_url.trim()
          ? file.download_url
          : ''
      ) || '';

      try {
        parsed = await fetchRawSharedData(rawUrl);
      } catch (e) {
        throw apiError || e;
      }
    }

    return {
      data: normalizeSharedData(parsed, { refreshMedia: !!options.refreshMedia }),
      sha: file?.sha || null
    };
  }

  function mergeSharedDataWithLocal(data, options = {}) {
    const remote = normalizeSharedData({
      ...(data || {}),
      savedVideos: { ...((data && data.savedVideos) || {}) },
      savedArtists: { ...((data && data.savedArtists) || {}) }
    });
    const localVideos = loadSavedMap(SAVED_VIDEOS_KEY);
    const localArtists = loadSavedMap(SAVED_ARTISTS_KEY);

    return normalizeSharedData({
      ...remote,
      savedVideos: {
        ...remote.savedVideos,
        ...localVideos
      },
      savedArtists: {
        ...remote.savedArtists,
        ...localArtists
      }
    }, { refreshMedia: !!options.refreshMedia });
  }

  async function writeSharedDataToGitHub(data, sha) {
    const token = requireGitHubToken();

    if (!token) {
      throw new Error('No GitHub token configured');
    }

    const body = {
      message: `Update Pong saved links ${new Date().toISOString()}`,
      content: base64EncodeUnicode(JSON.stringify(data)),
      branch: GITHUB_SYNC.branch
    };

    if (sha) {
      body.sha = sha;
    }

    const res = await fetch(githubApiUrl(), {
      method: 'PUT',
      headers: {
        ...githubHeaders({ requireToken: true }),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`GitHub save failed: ${res.status}`);
    }

    return await res.json();
  }

  async function updateSharedData(mutatorFn) {
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const loaded = await fetchSharedDataFromGitHub({ requireWriteSha: true });
        const data = mergeSharedDataWithLocal(loaded.data);
        const result = await mutatorFn(data) || {};

        await writeSharedDataToGitHub(data, loaded.sha);
        mirrorSharedDataToLocal(data);

        return {
          ok: true,
          data,
          result
        };
      } catch (e) {
        lastError = e;
        await new Promise(r => setTimeout(r, 400 + attempt * 400));
      }
    }

    throw lastError;
  }

  function queueSmoothSave(label, workFn, showQueuedMessage = true) {
    if (showQueuedMessage) {
      showMsg(`${label} queued`);
    }

    const run = () => {
      Promise.resolve()
        .then(workFn)
        .catch(e => {
          showMsg(`${label} failed`);
          console.error(e);
        });
    };

    runWhenIdle(run, 2500);
  }

  function mirrorSharedDataToLocal(data) {
    saveSavedMap(SAVED_VIDEOS_KEY, data.savedVideos || {});
    saveSavedMap(SAVED_ARTISTS_KEY, data.savedArtists || {});
    updateSaveCountersFromData(data);
  }

  function updateSaveCountersFromData(data) {
    if (data) {
      const counts = getCountsFromSharedData(data);
      saveSaveCounts(counts);
      updateSaveCounterElements(counts);
      return;
    }

    const cachedCounts = loadSaveCounts();

    if (cachedCounts) {
      updateSaveCounterElements(cachedCounts);
      return;
    }

    const quickCounts = getQuickLocalSaveCounts();

    if (quickCounts.videos || quickCounts.artists) {
      saveSaveCounts(quickCounts);
      updateSaveCounterElements(quickCounts);
    } else {
      updateSaveCounterElements({ videos: 0, artists: 0 });
    }
  }

  async function updateSaveCountersOverride() {
    updateSaveCountersFromData();
  }

  function shuffleArray(arr) {
    const copy = arr.slice();

    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
  }

  function toUrl(rawUrl) {
    try {
      return new URL(String(rawUrl || '').trim(), window.location.href);
    } catch (e) {
      return null;
    }
  }

  function getMediaUrlKey(rawUrl) {
    const url = toUrl(rawUrl);

    if (!url) return null;

    const host = url.hostname.toLowerCase();

    if (!/(^|\.)coomerfans\.com$/i.test(host) && !/(^|\.)coomer\.(su|st)$/i.test(host)) {
      return null;
    }

    const path = decodeURIComponent(url.pathname || '').replace(/\/+/g, '/');
    const storageMatch = path.match(/\/(?:storage|storager)\/(.+\.(?:mp4|m4v|webm|mov))$/i);

    if (storageMatch) {
      return `media:${storageMatch[1].toLowerCase()}`;
    }

    const fileMatch = path.match(/\/([^/?#]+\.(?:mp4|m4v|webm|mov))$/i);

    return fileMatch ? `media-file:${fileMatch[1].toLowerCase()}` : null;
  }

  function getSavedVideoKey(rawUrl) {
    return getMediaUrlKey(rawUrl) || String(rawUrl || '').trim();
  }

  function getSignedMediaInfo(rawUrl) {
    const url = toUrl(rawUrl);

    if (!url || !url.searchParams.get('hash')) return null;

    const expiresAt = Number(url.searchParams.get('e') || 0);

    return {
      url: url.href,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0
    };
  }

  function signedUrlStillFresh(rawUrl, graceSeconds) {
    const info = getSignedMediaInfo(rawUrl);

    if (!info) return false;
    if (!info.expiresAt) return true;

    return info.expiresAt > Math.floor(Date.now() / 1000) + (graceSeconds || 60);
  }

  function loadMediaSignatureCache() {
    try {
      const data = JSON.parse(localStorage.getItem(MEDIA_SIGNATURE_CACHE_KEY) || '{}');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
      return {};
    }
  }

  function saveMediaSignatureCache(cache) {
    try {
      localStorage.setItem(MEDIA_SIGNATURE_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
  }

  function rememberFreshMediaUrls(urls) {
    if (!Array.isArray(urls) || !urls.length) return 0;

    const cache = loadMediaSignatureCache();
    let changed = 0;

    urls.forEach(rawUrl => {
      const trimmed = String(rawUrl || '').trim();
      const mediaKey = getMediaUrlKey(trimmed);
      const signed = getSignedMediaInfo(trimmed);

      if (!mediaKey || !signed || !signedUrlStillFresh(trimmed, 30)) return;

      const existing = cache[mediaKey];
      const existingExpiresAt = Number(existing?.expiresAt || 0);

      if (!existing || signed.expiresAt >= existingExpiresAt || existing.url !== signed.url) {
        cache[mediaKey] = {
          url: signed.url,
          expiresAt: signed.expiresAt,
          cachedAt: new Date().toISOString()
        };
        changed++;
      }
    });

    if (changed) {
      saveMediaSignatureCache(cache);
    }

    return changed;
  }

  function getCachedFreshMediaUrl(rawUrl) {
    const mediaKey = getMediaUrlKey(rawUrl);

    if (!mediaKey) return null;

    const entry = loadMediaSignatureCache()[mediaKey];

    if (!entry || !entry.url || !signedUrlStillFresh(entry.url, 60)) {
      return null;
    }

    return entry.url;
  }

  function preferFreshMediaUrl(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    return getCachedFreshMediaUrl(trimmed) || trimmed;
  }

  function chooseBestMediaUrl(firstUrl, secondUrl) {
    const first = String(firstUrl || '').trim();
    const second = String(secondUrl || '').trim();

    if (!first) return second;
    if (!second) return first;

    const firstSigned = getSignedMediaInfo(first);
    const secondSigned = getSignedMediaInfo(second);

    if (secondSigned && !firstSigned) return second;
    if (!secondSigned && firstSigned) return signedUrlStillFresh(first, 60) ? first : second;
    if (firstSigned && secondSigned) {
      return Number(secondSigned.expiresAt || 0) >= Number(firstSigned.expiresAt || 0) ? second : first;
    }

    return first;
  }

  function dedupeAndRefreshMediaUrls(urls) {
    rememberFreshMediaUrls(urls);

    const byMediaKey = new Map();
    const orderedKeys = [];

    (urls || []).forEach(rawUrl => {
      const refreshed = preferFreshMediaUrl(rawUrl);
      const mediaKey = getSavedVideoKey(refreshed);

      if (!mediaKey) return;

      if (!byMediaKey.has(mediaKey)) {
        orderedKeys.push(mediaKey);
        byMediaKey.set(mediaKey, refreshed);
      } else {
        byMediaKey.set(mediaKey, chooseBestMediaUrl(byMediaKey.get(mediaKey), refreshed));
      }
    });

    return orderedKeys.map(key => byMediaKey.get(key)).filter(Boolean);
  }

  function refreshSharedDataMediaUrls(data) {
    if (!data || typeof data !== 'object') {
      return {
        data,
        changed: false
      };
    }

    data.savedVideos = data.savedVideos || {};
    data.savedArtists = data.savedArtists || {};

    const allKnownUrls = [];

    Object.entries(data.savedVideos).forEach(([key, item]) => {
      allKnownUrls.push(item?.url || key);
    });

    Object.values(data.savedArtists).forEach(artist => {
      if (artist && Array.isArray(artist.videos)) {
        artist.videos.forEach(url => allKnownUrls.push(url));
      }
    });

    rememberFreshMediaUrls(allKnownUrls);

    const rebuiltSavedVideos = {};
    let changed = false;

    Object.entries(data.savedVideos).forEach(([key, item]) => {
      const originalUrl = String(item?.url || key || '').trim();
      const refreshedUrl = preferFreshMediaUrl(originalUrl);
      const stableKey = getSavedVideoKey(originalUrl);

      if (!stableKey) return;

      const existing = rebuiltSavedVideos[stableKey];
      const merged = {
        ...(existing || {}),
        ...(item || {}),
        url: chooseBestMediaUrl(existing?.url, refreshedUrl),
        mediaKey: stableKey
      };

      if (merged.url !== originalUrl || stableKey !== key) {
        merged.updatedAt = new Date().toISOString();
        changed = true;
      }

      rebuiltSavedVideos[stableKey] = merged;
    });

    data.savedVideos = rebuiltSavedVideos;

    Object.values(data.savedArtists).forEach(artist => {
      if (!artist || !Array.isArray(artist.videos)) return;

      const refreshedVideos = dedupeAndRefreshMediaUrls(artist.videos);

      if (JSON.stringify(refreshedVideos) !== JSON.stringify(artist.videos)) {
        artist.videos = refreshedVideos;
        artist.updatedAt = new Date().toISOString();
        changed = true;
      }
    });

    return {
      data,
      changed
    };
  }

  function refreshPastedInputMediaUrls() {
    const input = document.getElementById('video-urls');

    if (!input || !input.value) return;
    if (input.value.length > 50000) return;

    capturePastedMetadata(input.value);

    const originalUrls = input.value
      .split('\n')
      .map(url => url.trim())
      .filter(url => url && !url.startsWith('#PONG_') && isPlayableVideoUrl(url));

    const refreshedUrls = dedupeAndRefreshMediaUrls(originalUrls);

    if (refreshedUrls.length && JSON.stringify(refreshedUrls) !== JSON.stringify(originalUrls)) {
      input.value = refreshedUrls.join('\n');
      showMsg('Refreshed saved CDN URLs from known signed links');
    }
  }

  function isPlayableVideoUrl(rawUrl) {
    return /\.(mp4|m4v|mov|webm)(\?|$)/i.test(String(rawUrl || '').trim());
  }

  function parsePongJsonLine(line, prefix) {
    if (!line.startsWith(prefix)) return null;

    try {
      const parsed = JSON.parse(line.slice(prefix.length).trim());
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function compactField(value) {
    return String(value || '').trim();
  }

  function parseCompactArtistLine(line) {
    if (!line.startsWith('#PA|')) return null;

    const parts = line.slice(4).split('|');
    return {
      type: 'artist',
      source: compactField(parts[0]) || 'coomerfans',
      artistKey: compactField(parts[1]),
      artistUrl: compactField(parts[2]),
      artistName: compactField(parts.slice(3).join('|')),
      scrapedAt: ''
    };
  }

  function parseCompactVideoLine(line, activeArtist) {
    if (!line.startsWith('#PV|')) return null;

    const parts = line.slice(4).split('|');
    return {
      ...(activeArtist || {}),
      type: 'video',
      postUrl: compactField(parts[0]),
      postIndex: Number(compactField(parts[1]) || 0)
    };
  }

  function emptyPastedMetadata() {
    return {
      artist: null,
      videosByUrl: {},
      videosByMediaKey: {},
      orderedVideos: []
    };
  }

  function parsePastedMetadata(text) {
    const result = emptyPastedMetadata();
    let activeArtist = null;
    let pendingVideo = null;

    String(text || '').split(/\r?\n/).forEach(rawLine => {
      const line = rawLine.trim();

      if (!line) return;

      const artist = parsePongJsonLine(line, PONG_ARTIST_PREFIX);

      if (artist) {
        activeArtist = artist;
        result.artist = artist;
        pendingVideo = null;
        return;
      }

      const compactArtist = parseCompactArtistLine(line);

      if (compactArtist) {
        activeArtist = compactArtist;
        result.artist = compactArtist;
        pendingVideo = null;
        return;
      }

      const videoMeta = parsePongJsonLine(line, PONG_VIDEO_PREFIX);

      if (videoMeta) {
        pendingVideo = {
          ...(activeArtist || {}),
          ...videoMeta
        };
        return;
      }

      const compactVideoMeta = parseCompactVideoLine(line, activeArtist);

      if (compactVideoMeta) {
        pendingVideo = compactVideoMeta;
        return;
      }

      if (!isPlayableVideoUrl(line)) return;

      const mediaKey = getSavedVideoKey(line);
      const mergedMeta = {
        ...(activeArtist || {}),
        ...(pendingVideo || {}),
        videoUrl: line,
        mediaKey
      };

      result.videosByUrl[line] = mergedMeta;

      if (mediaKey) {
        result.videosByMediaKey[mediaKey] = mergedMeta;
      }

      result.orderedVideos.push(mergedMeta);
      pendingVideo = null;
    });

    return result;
  }

  function mergePastedMetadata(existing, incoming) {
    const merged = existing || emptyPastedMetadata();

    if (incoming.artist) {
      merged.artist = incoming.artist;
    }

    Object.assign(merged.videosByUrl, incoming.videosByUrl || {});
    Object.assign(merged.videosByMediaKey, incoming.videosByMediaKey || {});

    if (!merged.orderedMediaKeys) {
      merged.orderedMediaKeys = {};
      (merged.orderedVideos || []).forEach(existingItem => {
        const existingKey = existingItem.mediaKey || getSavedVideoKey(existingItem.videoUrl);
        if (existingKey) merged.orderedMediaKeys[existingKey] = true;
      });
    }

    (incoming.orderedVideos || []).forEach(item => {
      if (!item?.videoUrl) return;

      const mediaKey = item.mediaKey || getSavedVideoKey(item.videoUrl);

      if (!mediaKey || !merged.orderedMediaKeys[mediaKey]) {
        merged.orderedVideos.push(item);
        if (mediaKey) merged.orderedMediaKeys[mediaKey] = true;
      }
    });

    return merged;
  }

  const metadataCaptureQueue = [];
  let metadataCaptureScheduled = false;

  function scheduleMetadataCaptureQueue() {
    if (metadataCaptureScheduled) return;

    metadataCaptureScheduled = true;

    const run = () => {
      metadataCaptureScheduled = false;
      const next = metadataCaptureQueue.shift();

      if (next) {
        capturePastedMetadata(next);
      }

      if (metadataCaptureQueue.length) {
        scheduleMetadataCaptureQueue();
      }
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 750 });
    } else {
      setTimeout(run, 0);
    }
  }

  function capturePastedMetadataAsync(text) {
    if (!text) return;

    metadataCaptureQueue.push(text);
    scheduleMetadataCaptureQueue();
  }

  function capturePastedMetadata(text) {
    const parsed = parsePastedMetadata(text);
    const urls = parsed.orderedVideos.map(item => item.videoUrl).filter(Boolean);

    rememberFreshMediaUrls(urls);

    window.PongCurrentPastedMetadata = mergePastedMetadata(window.PongCurrentPastedMetadata, parsed);

    return window.PongCurrentPastedMetadata;
  }

  function getPastedMetadataForUrl(rawUrl) {
    const metadata = window.PongCurrentPastedMetadata || emptyPastedMetadata();
    const direct = metadata.videosByUrl[String(rawUrl || '').trim()];

    if (direct) return direct;

    const mediaKey = getSavedVideoKey(rawUrl);
    const cachedEntries = Array.isArray(window.PongLastPastedEntries)
      ? window.PongLastPastedEntries
      : Array.isArray(window.PongPendingPasteCache?.entries)
        ? window.PongPendingPasteCache.entries
        : [];
    const cachedEntry = cachedEntries.find(entry => {
      if (!entry?.videoUrl) return false;
      if (String(entry.videoUrl).trim() === String(rawUrl || '').trim()) return true;
      return mediaKey && getSavedVideoKey(entry.videoUrl) === mediaKey;
    });

    if (cachedEntry) return cachedEntry;

    return mediaKey ? metadata.videosByMediaKey[mediaKey] || null : null;
  }

  function artistNameFromUrl(rawUrl) {
    if (!String(rawUrl || '').trim()) return '';

    try {
      const url = new URL(String(rawUrl || ''), window.location.href);
      const parts = url.pathname.split('/').map(part => part.trim()).filter(Boolean);
      const lastPart = parts.length ? decodeURIComponent(parts[parts.length - 1]) : '';
      return /^\d+$/.test(lastPart) ? '' : lastPart;
    } catch (e) {
      return '';
    }
  }

  function getArtistDisplayName(meta) {
    if (!meta) return '';

    const displayName =
      meta.artistDisplayName ||
      artistNameFromUrl(meta.artistUrl) ||
      String(meta.artistName || '').trim();

    if (!displayName || /^\d+$/.test(displayName) || displayName.toLowerCase() === 'pong') return '';

    return displayName;
  }

  function getLoadedMetadataForUrl(rawUrl) {
    const mediaKey = getSavedVideoKey(rawUrl);

    if (!mediaKey || !Array.isArray(allVideoUrls) || !Array.isArray(allVideoMetadata)) return null;

    const index = allVideoUrls.findIndex(url => getSavedVideoKey(url) === mediaKey);

    return index >= 0 ? allVideoMetadata[index] || null : null;
  }

  function compactVideoMetadata(meta) {
    if (!meta) return null;

    return {
      source: meta.source || 'coomerfans',
      artistName: meta.artistName || '',
      artistKey: meta.artistKey || '',
      artistUrl: meta.artistUrl || '',
      artistDisplayName: getArtistDisplayName(meta),
      postUrl: meta.postUrl || '',
      postIndex: Number(meta.postIndex || 0),
      scrapedAt: meta.scrapedAt || '',
      mediaKey: meta.mediaKey || ''
    };
  }

  function compactArtistMetadata(videos) {
    const metadata = window.PongCurrentPastedMetadata || emptyPastedMetadata();
    const firstVideoMeta = (videos || [])
      .map(url => getPastedMetadataForUrl(url) || getLoadedMetadataForUrl(url))
      .find(Boolean);
    const artist = metadata.artist || firstVideoMeta || null;

    if (!artist) return {};

    return {
      artistName: artist.artistName || '',
      artistKey: artist.artistKey || '',
      artistUrl: artist.artistUrl || '',
      artistDisplayName: getArtistDisplayName(artist),
      source: artist.source || 'coomerfans',
      scrapedAt: artist.scrapedAt || ''
    };
  }

  function buildVideoMetadataMap(urls) {
    const map = {};

    (urls || []).forEach(url => {
      const mediaKey = getSavedVideoKey(url);
      const meta = compactVideoMetadata(getPastedMetadataForUrl(url) || getLoadedMetadataForUrl(url));

      if (mediaKey && meta) {
        map[mediaKey] = meta;
      }
    });

    return map;
  }

  function resetSavedPlaybackMode() {
    window.PongLoadedSavedMode = 'normal';
  }

  function loadSavedListIntoPlayer(urls, message, newPasteEvents, mode, metadata) {
    if (!urls || !urls.length) {
      showMsg('No saved videos found');
      return;
    }

    if (window.currentlyPlayingVideo && !window.currentlyPlayingVideo.paused) {
      window.currentlyPlayingVideo.pause();
    }

    window.PongLoadedSavedMode = mode || 'normal';

    allVideoUrls = urls.slice();
    allVideoMetadata = Array.isArray(metadata) ? metadata.slice() : urls.map(() => ({}));
    videoUrls = [];
    videoMetadata = [];
    currentBatch = 0;
    currentVideoIndex = 0;

    if (Array.isArray(newPasteEvents)) {
      pasteEvents = newPasteEvents;
      currentPasteIndex = -1;

      if (typeof updatePasteNavigationButton === 'function') {
        updatePasteNavigationButton();
      }
    }

    if (typeof saveSession === 'function') {
      saveSession();
    }

    videoContainer.innerHTML = '<div class="loading-message">Loading saved videos...</div>';

    setTimeout(() => {
      loadNextBatch();

      if (typeof hideControls === 'function') {
        hideControls();
      }

      if (typeof updatePasteNavigationButton === 'function') {
        updatePasteNavigationButton();
      }

      showMsg(message);
    }, 250);
  }

  async function playSavedVideosRandomized() {
    try {
      showMsg('Loading saved videos...');

      const loaded = await fetchSharedDataFromGitHub();
      const savedData = mergeSharedDataWithLocal(loaded.data);
      refreshSharedDataMediaUrls(savedData);
      mirrorSharedDataToLocal(savedData);

      const savedVideoItems = Object.values(savedData.savedVideos || {})
        .filter(Boolean);
      const urls = savedVideoItems
        .map(item => item && item.url)
        .filter(Boolean);

      if (!urls.length) {
        showMsg('No saved videos yet');
        return;
      }

      const savedVideoMetaByKey = {};
      savedVideoItems.forEach(item => {
        const key = getSavedVideoKey(item?.url);
        if (key) savedVideoMetaByKey[key] = compactVideoMetadata(item) || {};
      });

      const randomizedVideos = shuffleArray(dedupeAndRefreshMediaUrls(urls));
      const randomizedMetadata = randomizedVideos.map(url => {
        const key = getSavedVideoKey(url);
        return key ? savedVideoMetaByKey[key] || {} : {};
      });

      loadSavedListIntoPlayer(
        randomizedVideos,
        `Playing ${randomizedVideos.length} saved videos 🎲`,
        [],
        'savedVideos',
        randomizedMetadata
      );
    } catch (e) {
      showMsg('Could not load saved videos');
      console.error(e);
    }
  }

  async function playSavedArtistsRandomized() {
    try {
      showMsg('Loading saved artists...');

      const loaded = await fetchSharedDataFromGitHub();
      const savedData = mergeSharedDataWithLocal(loaded.data);
      refreshSharedDataMediaUrls(savedData);
      mirrorSharedDataToLocal(savedData);

      const artistEntries = Object.values(savedData.savedArtists || {})
        .filter(item => item && Array.isArray(item.videos) && item.videos.length);

      if (!artistEntries.length) {
        showMsg('No saved artists yet');
        return;
      }

      const randomizedArtists = shuffleArray(artistEntries);
      const groupedVideos = [];
      const groupedMetadata = [];
      const rebuiltPasteEvents = [];

      randomizedArtists.forEach((artist, artistIndex) => {
        const cleanVideos = shuffleArray(dedupeAndRefreshMediaUrls(artist.videos.filter(Boolean)));

        if (!cleanVideos.length) return;

        const startIndex = groupedVideos.length;

        cleanVideos.forEach(url => {
          groupedVideos.push(url);
          const mediaKey = getSavedVideoKey(url);
          const videoMeta = mediaKey && artist.videoMeta ? artist.videoMeta[mediaKey] : null;
          groupedMetadata.push({
            ...(artist || {}),
            ...(videoMeta || {}),
            artistDisplayName: getArtistDisplayName(videoMeta) || getArtistDisplayName(artist)
          });
        });

        rebuiltPasteEvents.push({
          startIndex,
          count: cleanVideos.length,
          artistKey: artist.artistKey || `saved-artist-${artistIndex}`,
          source: 'saved-artist-bundle'
        });
      });

      if (!groupedVideos.length) {
        showMsg('No saved artist videos found');
        return;
      }

      loadSavedListIntoPlayer(
        groupedVideos,
        `Playing ${rebuiltPasteEvents.length} saved bundles 👤🎲`,
        rebuiltPasteEvents,
        'savedArtists',
        groupedMetadata
      );
    } catch (e) {
      showMsg('Could not load saved artists');
      console.error(e);
    }
  }

  function getVisibleCurrentVideoWrapperOverride() {
    return (
      document.querySelector('.video-wrapper.most-visible') ||
      document.querySelector('.video-wrapper[data-playable="true"]') ||
      document.querySelector(`.video-wrapper[data-index="${currentVideoIndex}"]`)
    );
  }

  function getCurrentVideoWrapperOverride() {
    const visibleWrapper = getVisibleCurrentVideoWrapperOverride();

    if (visibleWrapper) {
      return visibleWrapper;
    }

    if (window.currentlyPlayingVideo) {
      const playingWrapper = window.currentlyPlayingVideo.closest('.video-wrapper');

      if (playingWrapper) {
        return playingWrapper;
      }
    }

    return null;
  }

  function getVideoUrlFromWrapperOverride(wrapper) {
    if (!wrapper) return null;

    const index = parseInt(wrapper.dataset.index || '0', 10);

    if (!isNaN(index) && videoUrls[index]) {
      return videoUrls[index];
    }

    const video = wrapper.querySelector('video');

    if (video) {
      return video.currentSrc || video.src || null;
    }

    return null;
  }

  function getCurrentVideoUrlOverride() {
    const wrapper = getCurrentVideoWrapperOverride();

    if (wrapper) {
      const wrapperUrl = getVideoUrlFromWrapperOverride(wrapper);
      if (wrapperUrl) return wrapperUrl;
    }

    if (window.currentlyPlayingVideo) {
      return window.currentlyPlayingVideo.currentSrc || window.currentlyPlayingVideo.src || null;
    }

    return null;
  }

  function extractArtistKeyOverride(rawUrl) {
    if (!rawUrl) return null;

    let url;

    try {
      url = new URL(rawUrl, window.location.href);
    } catch (e) {
      return null;
    }

    const path = decodeURIComponent(url.pathname || '');

    let match = path.match(/^\/p\/[^/]+\/([^/]+)\/([^/?#]+)/i);

    if (match) {
      return `${match[2].toLowerCase()}:${match[1].toLowerCase()}`;
    }

    match = path.match(/^\/([^/]+)\/user\/([^/]+)(?:\/|$)/i);

    if (match) {
      return `${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
    }

    match = path.match(/\/icons\/([^/]+)\/([^/?#]+)/i);

    if (match) {
      return `${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
    }

    match = path.match(/\/istorage\/([^/.?#]+)/i);

    if (match) {
      return `coomerfans:${match[1].toLowerCase()}`;
    }

    const paramNames = [
      'artist',
      'creator',
      'creator_id',
      'user',
      'username',
      'user_id',
      'model',
      'account'
    ];

    for (const name of paramNames) {
      const value = url.searchParams.get(name);

      if (value) {
        return `${name}:${value.toLowerCase()}`;
      }
    }

    const filename = url.searchParams.get('f') || url.searchParams.get('filename') || '';

    if (filename) {
      const fileMatch = filename.match(/(?:onlyfans|fansly|patreon|coomerfans|fansone|candfans)[_\-\s]+([a-z0-9_.-]+)/i);

      if (fileMatch) {
        return `file:${fileMatch[1].toLowerCase()}`;
      }
    }

    return null;
  }

  function addSavedVideosToData(data, urls, artistKey) {
    data.savedVideos = data.savedVideos || {};
    rememberFreshMediaUrls(urls);

    let added = 0;

    urls.forEach(url => {
      if (!url) return;

      const rawUrl = String(url).trim();
      const key = getSavedVideoKey(rawUrl);
      const playableUrl = preferFreshMediaUrl(rawUrl);

      if (!key) return;

      if (!data.savedVideos[key]) {
        const pastedMeta = compactVideoMetadata(getPastedMetadataForUrl(rawUrl));
        data.savedVideos[key] = {
          url: playableUrl,
          mediaKey: key,
          artistKey: artistKey || extractArtistKeyOverride(playableUrl) || null,
          ...(pastedMeta || {}),
          savedAt: new Date().toISOString()
        };

        added++;
      } else {
        const existing = data.savedVideos[key];
        const bestUrl = chooseBestMediaUrl(existing.url, playableUrl);

        if (bestUrl !== existing.url) {
          existing.url = bestUrl;
          existing.updatedAt = new Date().toISOString();
        }

        if (!existing.mediaKey) {
          existing.mediaKey = key;
        }

        if (!existing.artistKey && artistKey) {
          existing.artistKey = artistKey;
        }

        const pastedMeta = compactVideoMetadata(getPastedMetadataForUrl(rawUrl));

        if (pastedMeta) {
          Object.assign(existing, pastedMeta);
        }
      }
    });

    return added;
  }

  function applyArtistBundleToData(data, bundleInfo, artistVideos) {
    const artistKey = bundleInfo.bundleKey;
    data.savedArtists = data.savedArtists || {};

    const existing = data.savedArtists[artistKey];
    const existingVideos = existing && Array.isArray(existing.videos)
      ? dedupeAndRefreshMediaUrls(existing.videos)
      : [];

    const existingKeys = new Set(existingVideos.map(url => getSavedVideoKey(url)));
    const newVideosOnly = artistVideos.filter(url => !existingKeys.has(getSavedVideoKey(url)));
    const mergedVideos = dedupeAndRefreshMediaUrls([...existingVideos, ...artistVideos]);
    const artistMeta = compactArtistMetadata(artistVideos);
    const videoMeta = {
      ...(existing?.videoMeta || {}),
      ...buildVideoMetadataMap(mergedVideos)
    };

    data.savedArtists[artistKey] = {
      artistKey,
      source: 'paperclip-bundle',
      ...artistMeta,
      startIndex: bundleInfo.startIndex,
      count: bundleInfo.count,
      videos: mergedVideos,
      videoMeta,
      savedAt: existing?.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return {
      addedBundleVideoCount: newVideosOnly.length,
      artistVideoCount: mergedVideos.length
    };
  }

  function saveVideoLocally(url, artistKey) {
    const data = {
      savedVideos: loadSavedMap(SAVED_VIDEOS_KEY),
      savedArtists: loadSavedMap(SAVED_ARTISTS_KEY)
    };
    const added = addSavedVideosToData(data, [url], artistKey);

    saveSavedMap(SAVED_VIDEOS_KEY, data.savedVideos);
    updateSaveCountersFromData(data);

    return added;
  }

  function saveArtistBundleLocally(bundleInfo, artistVideos) {
    const data = {
      savedVideos: loadSavedMap(SAVED_VIDEOS_KEY),
      savedArtists: loadSavedMap(SAVED_ARTISTS_KEY)
    };
    const result = applyArtistBundleToData(data, bundleInfo, artistVideos);

    saveSavedMap(SAVED_ARTISTS_KEY, data.savedArtists);
    updateSaveCountersFromData(data);

    return result;
  }

  function getCurrentGlobalVideoIndex(wrapperOverride) {
    const wrapper = wrapperOverride || getCurrentVideoWrapperOverride();

    if (!wrapper) return -1;

    const localIndex = parseInt(wrapper.dataset.index || '0', 10);

    if (isNaN(localIndex)) return -1;

    const hasRange = typeof activePlaybackRange === 'object' &&
      activePlaybackRange &&
      Number.isInteger(activePlaybackRange.start) &&
      Number.isInteger(activePlaybackRange.end) &&
      activePlaybackRange.end > activePlaybackRange.start;
    const rangeOffset = hasRange
      ? Math.max(0, Number(activePlaybackRange.currentOffset || 0))
      : 0;
    const batchStartIndex = hasRange
      ? activePlaybackRange.start + rangeOffset
      : Math.max(0, currentBatch - 1) * BATCH_SIZE;

    return batchStartIndex + localIndex;
  }

  function getCurrentPasteBundleInfo(wrapperOverride) {
    const globalIndex = getCurrentGlobalVideoIndex(wrapperOverride);

    if (globalIndex < 0) return null;

    if (!Array.isArray(pasteEvents) || !pasteEvents.length) {
      return {
        bundleKey: `loaded-batch:${Math.max(0, currentBatch - 1)}`,
        startIndex: Math.max(0, currentBatch - 1) * BATCH_SIZE,
        count: videoUrls.length,
        urls: videoUrls.slice()
      };
    }

    const bundle = pasteEvents.find(item => {
      if (!item) return false;

      const start = Number(item.startIndex);
      const count = Number(item.count);

      return globalIndex >= start && globalIndex < start + count;
    });

    if (!bundle) {
      return null;
    }

    const startIndex = Number(bundle.startIndex);
    const count = Number(bundle.count);
    const urls = allVideoUrls.slice(startIndex, startIndex + count).filter(Boolean);

    return {
      bundleKey: bundle.artistKey || bundle.bundleKey || `paste-bundle:${startIndex}:${count}`,
      startIndex,
      count,
      urls
    };
  }

  function getCurrentPasteEventIndex() {
    const globalIndex = getCurrentGlobalVideoIndex();

    if (globalIndex < 0 || !Array.isArray(pasteEvents)) return -1;

    return pasteEvents.findIndex(item => {
      if (!item) return false;

      const start = Number(item.startIndex);
      const count = Number(item.count);

      return globalIndex >= start && globalIndex < start + count;
    });
  }

  async function saveCurrentVideoLinkOverride(capturedUrl) {
    const url = capturedUrl || getCurrentVideoUrlOverride();

    if (!url) {
      showMsg('No current video found');
      return;
    }

    const artistKey = extractArtistKeyOverride(url);
    const addedLocally = saveVideoLocally(url, artistKey);

    showMsg(addedLocally ? 'Saved video locally; syncing...' : 'Video already saved locally; syncing...');

    queueSmoothSave('Video sync', async () => {
      const result = await updateSharedData(data => {
        return {
          added: addSavedVideosToData(data, [url], artistKey)
        };
      });

      if (result.result.added) {
        showMsg('Saved current video 💾');
      } else {
        showMsg('Video already synced');
      }
    }, false);
  }

  async function saveCurrentArtistVideosOverride(capturedBundleInfo) {
    const bundleInfo = capturedBundleInfo || getCurrentPasteBundleInfo();

    if (!bundleInfo || !bundleInfo.urls || !bundleInfo.urls.length) {
      showMsg('No paperclip bundle found');
      return;
    }

    const artistKey = bundleInfo.bundleKey;
    const artistVideos = dedupeAndRefreshMediaUrls(bundleInfo.urls.filter(Boolean));
    const localResult = saveArtistBundleLocally(bundleInfo, artistVideos);

    showMsg(
      localResult.addedBundleVideoCount > 0
        ? `Saved artist locally + ${localResult.addedBundleVideoCount}; syncing...`
        : 'Artist already saved locally; syncing...'
    );

    queueSmoothSave('Artist sync', async () => {
      const result = await updateSharedData(data => {
        return applyArtistBundleToData(data, bundleInfo, artistVideos);
      });

      if (result.result.addedBundleVideoCount > 0) {
        showMsg(`Saved bundle + ${result.result.addedBundleVideoCount} videos 👤`);
      } else {
        showMsg('Artist already synced');
      }
    }, false);
  }

  function rebuildSavedArtistsAfterRemovingEvent(removeEventIndex) {
    const rebuiltUrls = [];
    const rebuiltEvents = [];

    if (!Array.isArray(pasteEvents) || removeEventIndex < 0) {
      return {
        urls: [],
        events: []
      };
    }

    pasteEvents.forEach((event, index) => {
      if (index === removeEventIndex) return;

      const oldStart = Number(event.startIndex);
      const oldCount = Number(event.count);
      const eventUrls = allVideoUrls.slice(oldStart, oldStart + oldCount).filter(Boolean);

      if (!eventUrls.length) return;

      const newStart = rebuiltUrls.length;

      eventUrls.forEach(url => rebuiltUrls.push(url));

      rebuiltEvents.push({
        ...event,
        startIndex: newStart,
        count: eventUrls.length
      });
    });

    return {
      urls: rebuiltUrls,
      events: rebuiltEvents
    };
  }

  function reloadCurrentSavedVideosAfterRemoval(removedUrl) {
    const remaining = allVideoUrls.filter(url => url !== removedUrl);

    if (!remaining.length) {
      allVideoUrls = [];
      videoUrls = [];
      videoMetadata = [];
      pasteEvents = [];
      currentBatch = 0;
      currentVideoIndex = 0;
      videoContainer.innerHTML = '<div class="loading-message">No saved videos left</div>';
      showMsg('Removed video');
      return;
    }

    loadSavedListIntoPlayer(
      remaining,
      `Removed video. ${remaining.length} left`,
      [],
      'savedVideos'
    );
  }

  function reloadCurrentSavedArtistsAfterRemoval(removeEventIndex) {
    const rebuilt = rebuildSavedArtistsAfterRemovingEvent(removeEventIndex);

    if (!rebuilt.urls.length) {
      allVideoUrls = [];
      videoUrls = [];
      videoMetadata = [];
      pasteEvents = [];
      currentBatch = 0;
      currentVideoIndex = 0;
      videoContainer.innerHTML = '<div class="loading-message">No saved artist bundles left</div>';
      showMsg('Removed artist bundle');
      return;
    }

    loadSavedListIntoPlayer(
      rebuilt.urls,
      `Removed bundle. ${rebuilt.events.length} left`,
      rebuilt.events,
      'savedArtists'
    );
  }

  async function removeCurrentSavedItemOverride() {
    const mode = window.PongLoadedSavedMode || 'normal';

    if (mode === 'savedVideos') {
      const url = getCurrentVideoUrlOverride();

      if (!url) {
        showMsg('No current video found');
        return;
      }

      try {
        showMsg('Removing saved video...');

        const result = await updateSharedData(data => {
          data.savedVideos = data.savedVideos || {};

          let removed = false;

          if (data.savedVideos[url]) {
            delete data.savedVideos[url];
            removed = true;
          } else {
            Object.keys(data.savedVideos).forEach(key => {
              if (data.savedVideos[key]?.url === url) {
                delete data.savedVideos[key];
                removed = true;
              }
            });
          }

          return {
            removed
          };
        });

        if (result.result.removed) {
          reloadCurrentSavedVideosAfterRemoval(url);
        } else {
          showMsg('Video was not in saved list');
        }
      } catch (e) {
        showMsg('Could not remove video');
        console.error(e);
      }

      return;
    }

    if (mode === 'savedArtists') {
      const bundleInfo = getCurrentPasteBundleInfo();
      const eventIndex = getCurrentPasteEventIndex();

      if (!bundleInfo || !bundleInfo.bundleKey || eventIndex < 0) {
        showMsg('No current artist bundle found');
        return;
      }

      const artistKey = bundleInfo.bundleKey;

      try {
        showMsg('Removing artist bundle...');

        const result = await updateSharedData(data => {
          data.savedArtists = data.savedArtists || {};

          let removed = false;

          if (data.savedArtists[artistKey]) {
            delete data.savedArtists[artistKey];
            removed = true;
          } else {
            Object.keys(data.savedArtists).forEach(key => {
              if (data.savedArtists[key]?.artistKey === artistKey) {
                delete data.savedArtists[key];
                removed = true;
              }
            });
          }

          return {
            removed
          };
        });

        if (result.result.removed) {
          reloadCurrentSavedArtistsAfterRemoval(eventIndex);
        } else {
          showMsg('Artist bundle was not in saved list');
        }
      } catch (e) {
        showMsg('Could not remove artist bundle');
        console.error(e);
      }

      return;
    }

    showMsg('Load saved videos or artists first');
  }

  function repairEntriesFromCurrentPaste() {
    const input = document.getElementById('video-urls');

    if (input && input.value) {
      capturePastedMetadata(input.value);
    }

    const entries = [
      ...(window.PongCurrentPastedMetadata?.orderedVideos || []),
      ...(Array.isArray(window.PongPendingPasteCache?.entries) ? window.PongPendingPasteCache.entries : []),
      ...(Array.isArray(window.PongLastPastedEntries) ? window.PongLastPastedEntries : [])
    ];
    const seen = {};

    return entries.filter(item => {
      if (!item?.videoUrl) return false;

      const key = getSavedVideoKey(item.videoUrl) || item.videoUrl;

      if (seen[key]) return false;

      seen[key] = true;
      return true;
    });
  }

  function buildFreshEntryMaps(entries) {
    const byMediaKey = {};
    const byPostKey = {};
    const urls = [];

    (entries || []).forEach(entry => {
      const videoUrl = entry?.videoUrl || entry?.url;

      if (!videoUrl) return;

      urls.push(videoUrl);

      const mediaKey = entry.mediaKey || getSavedVideoKey(videoUrl);

      if (mediaKey) {
        byMediaKey[mediaKey] = {
          ...entry,
          videoUrl,
          mediaKey
        };
      }

      if (entry.postUrl) {
        byPostKey[`${entry.postUrl}#${Number(entry.postIndex || 0)}`] = {
          ...entry,
          videoUrl,
          mediaKey
        };
      }
    });

    rememberFreshMediaUrls(urls);

    return {
      byMediaKey,
      byPostKey
    };
  }

  function freshEntryForSavedUrl(rawUrl, savedMeta, maps) {
    const mediaKey = savedMeta?.mediaKey || getSavedVideoKey(rawUrl);

    if (mediaKey && maps.byMediaKey[mediaKey]) {
      return maps.byMediaKey[mediaKey];
    }

    if (savedMeta?.postUrl) {
      return maps.byPostKey[`${savedMeta.postUrl}#${Number(savedMeta.postIndex || 0)}`] || null;
    }

    return null;
  }

  function applyFreshEntryToSavedVideo(item, freshEntry) {
    if (!item || !freshEntry?.videoUrl) return false;

    const bestUrl = chooseBestMediaUrl(item.url, freshEntry.videoUrl);
    const changed = bestUrl && bestUrl !== item.url;

    if (changed) {
      item.url = bestUrl;
    }

    Object.assign(item, compactVideoMetadata(freshEntry) || {});

    if (changed) {
      item.updatedAt = new Date().toISOString();
    }

    return changed;
  }

  function repairDataWithEntries(data, entries, options = {}) {
    if (!entries || !entries.length) {
      return {
        repaired: 0
      };
    }

    const maps = buildFreshEntryMaps(entries);
    let repaired = 0;

    data.savedVideos = data.savedVideos || {};
    data.savedArtists = data.savedArtists || {};

    Object.entries(data.savedVideos).forEach(([key, item]) => {
      if (options.savedVideoKey && key !== options.savedVideoKey) return;

      const freshEntry = freshEntryForSavedUrl(item?.url || key, item, maps);

      if (freshEntry && applyFreshEntryToSavedVideo(item, freshEntry)) {
        repaired++;
      }
    });

    Object.entries(data.savedArtists).forEach(([artistKey, artist]) => {
      if (options.artistKey && artistKey !== options.artistKey) return;
      if (!artist || !Array.isArray(artist.videos)) return;

      artist.videoMeta = artist.videoMeta || {};

      const repairedVideos = artist.videos.map(oldUrl => {
        const mediaKey = getSavedVideoKey(oldUrl);
        const savedMeta = mediaKey ? artist.videoMeta[mediaKey] : null;
        const freshEntry = freshEntryForSavedUrl(oldUrl, savedMeta, maps);

        if (!freshEntry?.videoUrl) return oldUrl;

        const bestUrl = chooseBestMediaUrl(oldUrl, freshEntry.videoUrl);
        const freshMeta = compactVideoMetadata(freshEntry);

        if (mediaKey && freshMeta) {
          artist.videoMeta[mediaKey] = freshMeta;
        }

        if (bestUrl && bestUrl !== oldUrl) {
          repaired++;
          return bestUrl;
        }

        return oldUrl;
      });

      artist.videos = dedupeAndRefreshMediaUrls(repairedVideos);

      const artistMeta = compactArtistMetadata(artist.videos);

      Object.assign(artist, artistMeta);

      if (repaired) {
        artist.updatedAt = new Date().toISOString();
      }
    });

    return {
      repaired
    };
  }

  function getSavedVideoRepairTarget(data, rawUrl) {
    data.savedVideos = data.savedVideos || {};

    const mediaKey = getSavedVideoKey(rawUrl);

    if (mediaKey && data.savedVideos[mediaKey]) {
      return {
        key: mediaKey,
        item: data.savedVideos[mediaKey]
      };
    }

    const foundKey = Object.keys(data.savedVideos).find(key => {
      const item = data.savedVideos[key];
      return item?.url === rawUrl || getSavedVideoKey(item?.url || key) === mediaKey;
    });

    return foundKey
      ? {
          key: foundKey,
          item: data.savedVideos[foundKey]
        }
      : null;
  }

  const REPAIR_ITEM_TIMEOUT_MS = 120000;
  const DIRECT_REPAIR_ITEM_TIMEOUT_MS = 240000;
  const DIRECT_REPAIR_POST_CONCURRENCY = 20;
  const DIRECT_REPAIR_MAX_RETRIES = 2;
  let iframeRepairState = null;

  function appendRepairHash(rawUrl, item) {
    try {
      const url = new URL(rawUrl, window.location.href);
      const params = new URLSearchParams();
      params.set('pongRepair', '1');
      params.set('repairId', item.id);
      params.set('kind', item.kind);
      url.hash = params.toString();
      return url.toString();
    } catch (_) {
      return rawUrl;
    }
  }

  function getSavedArtistRepairSources(artist, fallbackKey) {
    const sources = [];
    const seenUrls = {};

    function add(rawUrl, rawLabel) {
      const url = String(rawUrl || '').trim();
      if (!url || seenUrls[url]) return;

      seenUrls[url] = true;
      sources.push({
        url,
        label: rawLabel || url
      });
    }

    Object.values(artist?.videoMeta || {}).forEach(meta => {
      add(meta?.artistUrl, meta?.artistDisplayName || meta?.artistName);
    });

    if (!sources.length) {
      add(artist?.artistUrl, artist?.artistDisplayName || artist?.artistName || fallbackKey);
    }

    return sources;
  }

  function buildIframeRepairQueue(data) {
    const queue = [];
    const seen = {};
    const savedArtists = Object.entries(data?.savedArtists || {});
    const savedVideos = Object.entries(data?.savedVideos || {});

    function add(kind, rawUrl, label, extra = {}) {
      const url = String(rawUrl || '').trim();
      const phase = extra.phase || (kind === 'post' ? 'video' : 'artist');

      if (!url && !extra.countMissing) return;

      const key = url ? `${phase}:${kind}:${url}` : `${phase}:${kind}:missing:${extra.savedKey || queue.length}`;
      if (seen[key]) {
        const existing = seen[key];

        if (extra.savedKey && !existing.savedKeys.includes(extra.savedKey)) {
          existing.savedKeys.push(extra.savedKey);
        }

        existing.savedCount += extra.savedCount || 1;
        return;
      }

      const item = {
        id: `${Date.now().toString(36)}-${queue.length + 1}`,
        kind,
        url,
        phase,
        label: label || url || 'Missing source URL',
        savedKey: extra.savedKey || '',
        savedKeys: extra.savedKey ? [extra.savedKey] : [],
        savedCount: extra.savedCount || 1,
        sourceMeta: extra.sourceMeta || null,
        skipReason: extra.skipReason || ''
      };

      seen[key] = item;
      queue.push(item);
    }

    savedArtists.forEach(([artistKey, artist]) => {
      const sources = getSavedArtistRepairSources(artist, artistKey);

      sources.forEach(source => {
        add('artist', source.url, source.label || artist?.artistDisplayName || artist?.artistName || artistKey, {
          phase: 'artist',
          savedKey: artistKey,
          savedCount: 1,
          sourceMeta: artist
        });
      });
    });

    savedVideos.forEach(([key, item]) => {
      const label = item?.artistDisplayName || item?.artistName || key;
      const sourceUrl = item?.postUrl || item?.artistUrl || '';
      const kind = item?.postUrl ? 'post' : item?.artistUrl ? 'artist' : 'missing';

      add(kind, sourceUrl, label, {
        phase: 'video',
        savedKey: key,
        sourceMeta: item,
        countMissing: true,
        skipReason: sourceUrl ? '' : 'No post URL saved yet'
      });
    });

    return {
      queue,
      stats: {
        savedArtists: savedArtists.length,
        uniqueArtists: queue.filter(item => item.phase === 'artist').length,
        savedVideos: savedVideos.length,
        repairableVideos: queue.filter(item => item.phase === 'video' && item.url).length
      }
    };
  }

  function ensureRepairQueuePanel() {
    injectPongSyncStyles();

    let panel = document.getElementById('pong-repair-panel');

    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'pong-repair-panel';
    panel.className = 'pong-repair-panel';
    panel.innerHTML = `
      <div class="pong-repair-title">
        <span>Repairing saved links</span>
        <div class="pong-repair-actions">
          <button id="pong-repair-copy-log" class="pong-repair-copy" type="button">Copy log</button>
          <button id="pong-repair-stop" class="pong-repair-stop" type="button">Stop</button>
        </div>
      </div>
      <div id="pong-repair-status" class="pong-repair-status">Preparing...</div>
      <div class="pong-repair-track"><div id="pong-repair-fill" class="pong-repair-fill"></div></div>
      <div class="pong-repair-meta">
        <span id="pong-repair-count">0/0</span>
        <span id="pong-repair-found">0 fresh</span>
      </div>
      <div class="pong-repair-detail">
        <span id="pong-repair-artists">Artists 0/0 unique</span>
        <span id="pong-repair-videos">Videos 0/0</span>
      </div>
      <pre id="pong-repair-log" class="pong-repair-log"></pre>
      <div id="pong-repair-worker-note" class="pong-repair-worker-note">Repair tries direct browser scraping first; a visible tab is only used as fallback.</div>
      <iframe id="pong-repair-frame" class="pong-repair-frame" title="Pong repair worker"></iframe>
    `;

    document.body.appendChild(panel);

    const stop = document.getElementById('pong-repair-stop');
    if (stop) {
      stop.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        writeRepairLog('Repair stopped by user');
        stopIframeRepairQueue('Repair stopped');
      });
    }

    const copy = document.getElementById('pong-repair-copy-log');
    if (copy) {
      copy.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        copyRepairLog();
      });
    }

    return panel;
  }

  function directRepairBaseUrl(rawUrl) {
    const url = new URL(rawUrl, window.location.href);
    url.searchParams.delete('page');
    url.hash = '';
    return url.toString();
  }

  function directRepairPageUrl(base, page) {
    const url = new URL(base, window.location.href);
    if (page > 1) {
      url.searchParams.set('page', page);
    } else {
      url.searchParams.delete('page');
    }
    return url.toString();
  }

  async function directRepairFetchText(url) {
    const fetchUrl = repairProxyFetchUrl(url);
    const usingProxy = fetchUrl !== url;
    writeRepairLog(`Fetch ${usingProxy ? 'proxy' : 'direct'}: ${fetchUrl}`);

    let res;

    try {
      res = await fetch(fetchUrl, {
        credentials: 'omit',
        mode: 'cors'
      });
    } catch (error) {
      const detail = [
        error?.name || 'FetchError',
        error?.message || String(error || ''),
        navigator?.userAgent ? `ua=${navigator.userAgent}` : ''
      ].filter(Boolean).join(' | ');
      throw new Error(`Fetch failed before response: ${detail}`);
    }

    if (!res.ok) {
      let body = '';

      try {
        body = await res.text();
      } catch (_) {}

      throw new Error(`${usingProxy ? 'Proxy ' : ''}HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }

    return res.text();
  }

  async function directRepairFetchDoc(url, attempt = 1) {
    try {
      const html = await directRepairFetchText(url);
      return new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      if (attempt >= DIRECT_REPAIR_MAX_RETRIES) {
        throw e;
      }

      await new Promise(resolve => setTimeout(resolve, 400 * attempt));
      return directRepairFetchDoc(url, attempt + 1);
    }
  }

  async function directRepairPool(tasks, limit) {
    const results = new Array(tasks.length);
    let index = 0;

    async function worker() {
      while (index < tasks.length) {
        const current = index++;
        results[current] = await tasks[current]();
      }
    }

    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
  }

  function directRepairShuffle(items) {
    const copy = items.slice();
    const cryptoApi = window.crypto || window.msCrypto;

    if (!cryptoApi?.getRandomValues) {
      return copy.sort(() => Math.random() - 0.5);
    }

    const randoms = new Uint32Array(copy.length);
    cryptoApi.getRandomValues(randoms);

    for (let i = copy.length - 1; i > 0; i--) {
      const j = randoms[i] % (i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
  }

  function directRepairExtractVideoPostLinks(doc, baseUrl) {
    const links = [];

    doc.querySelectorAll('div.post').forEach(post => {
      if (post.querySelector('img')) return;

      const link = post.querySelector('a.view-post');
      const href = link?.getAttribute('href') || '';

      if (href) {
        links.push(new URL(href, baseUrl).toString());
      }
    });

    return links;
  }

  function directRepairArtistInfo(rawUrl, doc, fallbackMeta = {}) {
    const url = new URL(directRepairBaseUrl(rawUrl), window.location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    const userIndex = parts.findIndex(part => part.toLowerCase() === 'u');
    const service = userIndex >= 0 ? parts[userIndex + 1] || '' : '';
    const accountId = userIndex >= 0 ? parts[userIndex + 2] || '' : '';
    const username = userIndex >= 0 ? parts[userIndex + 3] || accountId || '' : '';
    const titleText = (
      doc?.querySelector('h1')?.textContent ||
      doc?.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      ''
    ).trim();
    const artistName = decodeURIComponent(username || fallbackMeta.artistDisplayName || fallbackMeta.artistName || titleText || 'unknown').trim();
    const artistKey = service && (accountId || username)
      ? `${service.toLowerCase()}:${decodeURIComponent(accountId || username).toLowerCase()}`
      : (fallbackMeta.artistKey || url.pathname.toLowerCase());

    return {
      type: 'artist',
      source: fallbackMeta.source || 'coomerfans',
      artistName,
      artistDisplayName: artistName,
      artistKey,
      artistUrl: url.toString(),
      scrapedAt: new Date().toISOString()
    };
  }

  async function directRepairVideoEntriesFromPost(postUrl, artistInfo) {
    const doc = await directRepairFetchDoc(postUrl);
    const body = doc.querySelector('div.post-body');

    if (!body) return [];

    const urls = [];

    body.querySelectorAll('video source').forEach(source => {
      const src = source.getAttribute('src');
      if (src) urls.push(new URL(src, postUrl).toString());
    });

    body.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');

      if (href && /\.(mp4|m4v|mov|webm)(\?|$)/i.test(href)) {
        urls.push(new URL(href, postUrl).toString());
      }
    });

    return [...new Set(urls)].map((videoUrl, postIndex) => ({
      ...artistInfo,
      type: 'video',
      videoUrl,
      mediaKey: getSavedVideoKey(videoUrl),
      postUrl,
      postIndex
    }));
  }

  function directRepairFormatPongExport(entries) {
    const cleanEntries = (entries || []).filter(entry => entry?.videoUrl);

    if (!cleanEntries.length) return '';

    const first = cleanEntries[0];
    const lines = [
      `#PA|${first.source || 'coomerfans'}|${first.artistKey || ''}|${first.artistUrl || ''}|${first.artistDisplayName || first.artistName || ''}`
    ];

    cleanEntries.forEach(entry => {
      lines.push(`#PV|${entry.postUrl || ''}|${Number(entry.postIndex || 0)}`);
      lines.push(entry.videoUrl);
    });

    return lines.join('\n');
  }

  function directRepairWithTimeout(promise, ms, label) {
    let timer = null;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${formatRepairSeconds(ms)}`)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function directRepairScrapeArtist(item) {
    const base = directRepairBaseUrl(item.url);
    setRepairCurrentProgress(0.03);
    const firstDoc = await directRepairFetchDoc(directRepairPageUrl(base, 1));
    setRepairCurrentProgress(0.08);
    const artistInfo = directRepairArtistInfo(base, firstDoc, item.sourceMeta || {});
    const firstPagePosts = firstDoc.querySelectorAll('div.post').length;
    const postLinks = directRepairExtractVideoPostLinks(firstDoc, base);

    writeRepairLog(`Direct page 1: ${postLinks.length}/${firstPagePosts} video posts`);

    if (firstDoc.querySelector('a[href*="page="]')) {
      let batchStart = 2;
      const batchSize = 8;
      let pageBatchCount = 0;

      while (true) {
        const pages = Array.from({ length: batchSize }, (_, i) => batchStart + i);
        const docs = await Promise.all(pages.map(page => {
          const pageUrl = directRepairPageUrl(base, page);
          return directRepairFetchDoc(pageUrl).catch(error => {
            writeRepairLog(`Direct page ${page} failed: ${error?.message || error}`);
            return null;
          });
        }));
        let anyContent = false;
        let batchPostCount = 0;
        let batchVideoPostCount = 0;

        docs.forEach(doc => {
          if (!doc) return;

          const posts = doc.querySelectorAll('div.post').length;
          const links = directRepairExtractVideoPostLinks(doc, base);

          if (posts > 0) anyContent = true;

          batchPostCount += posts;
          batchVideoPostCount += links.length;
          postLinks.push(...links);
        });

        writeRepairLog(`Direct pages ${batchStart}-${batchStart + batchSize - 1}: ${batchVideoPostCount}/${batchPostCount} video posts`);
        pageBatchCount++;
        setRepairCurrentProgress(Math.min(0.24, 0.1 + pageBatchCount * 0.025));

        if (!anyContent) break;

        batchStart += batchSize;
      }
    }

    const shuffledPostLinks = directRepairShuffle([...new Set(postLinks)]);

    writeRepairLog(`Direct fetching ${shuffledPostLinks.length} video posts`);
    setRepairCurrentProgress(0.25);

    let done = 0;
    const tasks = shuffledPostLinks.map(postUrl => async () => {
      const entries = await directRepairVideoEntriesFromPost(postUrl, artistInfo).catch(error => {
        writeRepairLog(`Direct post failed: ${postUrl} (${error?.message || error})`);
        return [];
      });

      done++;
      setRepairCurrentProgress(0.25 + (shuffledPostLinks.length ? (done / shuffledPostLinks.length) * 0.7 : 0.7));

      if (done % 20 === 0 || done === shuffledPostLinks.length) {
        writeRepairLog(`Direct post progress: ${done}/${shuffledPostLinks.length}`);
      }

      return entries;
    });
    const results = await directRepairPool(tasks, DIRECT_REPAIR_POST_CONCURRENCY);

    return directRepairShuffle(results.flat());
  }

  async function directRepairScrapePost(item) {
    setRepairCurrentProgress(0.2);
    const doc = await directRepairFetchDoc(item.url);
    setRepairCurrentProgress(0.55);
    const artistInfo = directRepairArtistInfo(item.sourceMeta?.artistUrl || item.url, doc, item.sourceMeta || {});
    const entries = await directRepairVideoEntriesFromPost(item.url, artistInfo);
    setRepairCurrentProgress(0.9);
    return entries;
  }

  async function directRepairScrapeItem(item) {
    const entries = await directRepairWithTimeout(
      item.kind === 'post' ? directRepairScrapePost(item) : directRepairScrapeArtist(item),
      DIRECT_REPAIR_ITEM_TIMEOUT_MS,
      `Direct scrape for ${item.label}`
    );

    return {
      ok: true,
      count: entries.length,
      text: directRepairFormatPongExport(entries)
    };
  }

  function getRepairElapsedMs() {
    return iframeRepairState?.startedAt ? Date.now() - iframeRepairState.startedAt : 0;
  }

  function setRepairCurrentProgress(progress) {
    if (!iframeRepairState) return;

    const next = Math.max(0, Math.min(0.95, Number(progress) || 0));
    const current = Number(iframeRepairState.currentProgress || 0);

    if (next < 0.95 && Math.abs(next - current) < 0.01) return;

    iframeRepairState.currentProgress = next;
    updateRepairQueuePanel();
  }

  function formatRepairSeconds(ms) {
    return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  }

  function writeRepairLog(message) {
    const state = iframeRepairState;
    const line = `[+${formatRepairSeconds(getRepairElapsedMs())}] ${message}`;

    console.log(`[Pong repair] ${line}`);

    if (!state) return;

    state.logLines = state.logLines || [];
    state.logLines.push(line);

    const log = document.getElementById('pong-repair-log');
    if (log) {
      log.textContent = state.logLines.join('\n');
      log.scrollTop = log.scrollHeight;
    }
  }

  async function copyRepairLog() {
    const text = (iframeRepairState?.logLines || []).join('\n');

    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      writeRepairLog('Log copied to clipboard');
    } catch (e) {
      const log = document.getElementById('pong-repair-log');
      if (log) {
        log.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(log);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      writeRepairLog('Clipboard copy failed; log text selected');
    }
  }

  function openRepairWorkerWindow() {
    let worker = null;

    try {
      worker = window.open('about:blank', 'pong-repair-worker', 'popup,width=980,height=760');
    } catch (e) {
      worker = null;
    }

    if (worker) {
      try {
        worker.document.write('<!doctype html><title>Pong repair worker</title><body style="background:#05070a;color:#d1d5db;font:13px system-ui;margin:16px">Pong repair worker starting...</body>');
        worker.document.close();
      } catch (_) {}
    }

    return worker;
  }

  function closeRepairWorkerWindow(worker) {
    try {
      if (worker && !worker.closed) worker.close();
    } catch (_) {}
  }

  function navigateRepairWorker(item) {
    const state = iframeRepairState;
    const targetUrl = appendRepairHash(item.url, item);

    if (!state?.workerWindow || state.workerWindow.closed) {
      state.workerWindow = openRepairWorkerWindow();
      writeRepairLog(state.workerWindow ? 'Repair worker tab reopened' : 'Repair worker tab could not open');
    }

    if (!state.workerWindow) {
      return false;
    }

    try {
      state.workerWindow.location.href = targetUrl;
      state.workerWindow.focus();
      writeRepairLog(`Opened repair tab: ${item.url}`);
      writeRepairLog(`Waiting for Tampermonkey result: ${targetUrl}`);
      return true;
    } catch (e) {
      writeRepairLog(`Could not navigate repair tab: ${e?.message || e}`);
      return false;
    }
  }

  function updateRepairQueuePanel(status) {
    if (!iframeRepairState) return;

    const total = iframeRepairState.queue.length;
    const done = Math.min(total, Math.max(0, iframeRepairState.completed || 0));
    const current = iframeRepairState.queue[iframeRepairState.index] || null;
    const inFlightProgress = current && done < total
      ? Math.max(0, Math.min(0.95, Number(iframeRepairState.currentProgress || 0)))
      : 0;
    const pct = total ? Math.round(((done + inFlightProgress) / total) * 100) : 0;
    const stats = iframeRepairState.stats || {};
    const artistTotal = Number(stats.uniqueArtists || 0);
    const savedArtistTotal = Number(stats.savedArtists || 0);
    const videoTotal = Number(stats.savedVideos || 0);
    const artistDone = iframeRepairState.queue
      .slice(0, done)
      .filter(item => item.phase === 'artist').length;
    const videoDone = iframeRepairState.queue
      .slice(0, done)
      .filter(item => item.phase === 'video').length;
    const currentPhaseItems = current
      ? iframeRepairState.queue.filter(item => item.phase === current.phase)
      : [];
    const currentPhaseIndex = current
      ? Math.max(0, currentPhaseItems.findIndex(item => item.id === current.id)) + 1
      : 0;
    const currentPrefix = current?.phase === 'video'
      ? `Video ${currentPhaseIndex}/${videoTotal || currentPhaseItems.length}`
      : current?.phase === 'artist'
        ? `Artist ${currentPhaseIndex}/${artistTotal || currentPhaseItems.length} unique`
        : '';
    const statusEl = document.getElementById('pong-repair-status');
    const fill = document.getElementById('pong-repair-fill');
    const count = document.getElementById('pong-repair-count');
    const found = document.getElementById('pong-repair-found');
    const artists = document.getElementById('pong-repair-artists');
    const videos = document.getElementById('pong-repair-videos');

    if (statusEl) {
      statusEl.textContent = status || (current ? `${currentPrefix}: ${current.label}` : 'Preparing...');
    }

    if (fill) fill.style.width = `${pct}%`;
    if (count) {
      count.textContent = current?.phase === 'video'
        ? `${videoDone}/${videoTotal || currentPhaseItems.length} videos`
        : `${artistDone}/${artistTotal || currentPhaseItems.length} artists`;
    }
    if (found) found.textContent = `${iframeRepairState.freshCount} fresh`;
    if (artists) artists.textContent = `${savedArtistTotal} saved artists · ${artistTotal} unique`;
    if (videos) videos.textContent = `${videoDone}/${videoTotal} saved videos`;
  }

  function stopIframeRepairQueue(message) {
    if (!iframeRepairState) return;

    if (iframeRepairState.timeoutId) {
      clearTimeout(iframeRepairState.timeoutId);
    }

    closeRepairWorkerWindow(iframeRepairState.workerWindow);
    iframeRepairState.active = false;
    iframeRepairState = null;

    const frame = document.getElementById('pong-repair-frame');
    if (frame) frame.removeAttribute('src');

    const panel = document.getElementById('pong-repair-panel');
    if (panel && message) {
      const statusEl = document.getElementById('pong-repair-status');
      if (statusEl) statusEl.textContent = message;
      setTimeout(() => panel.remove(), 1600);
    } else if (panel) {
      panel.remove();
    }
  }

  function applyArtistScrapeResultsToSavedArtists(data, scrapeResults) {
    data.savedArtists = data.savedArtists || {};

    const groupedBySavedArtist = {};

    (scrapeResults || []).forEach(result => {
      const item = result?.item;

      if (item?.phase !== 'artist' || !result?.text) return;

      const entries = (parsePastedMetadata(result.text).orderedVideos || [])
        .filter(entry => entry?.videoUrl);

      if (!entries.length) return;

      (item.savedKeys || []).forEach(savedKey => {
        groupedBySavedArtist[savedKey] = groupedBySavedArtist[savedKey] || [];
        groupedBySavedArtist[savedKey].push(...entries);
      });
    });

    let repaired = 0;

    Object.entries(groupedBySavedArtist).forEach(([savedKey, entries]) => {
      const artist = data.savedArtists[savedKey];

      if (!artist || !entries.length) return;

      const oldVideos = Array.isArray(artist.videos) ? artist.videos : [];
      const freshVideos = dedupeAndRefreshMediaUrls(entries.map(entry => entry.videoUrl));

      if (!freshVideos.length) return;

      const freshMeta = {};

      entries.forEach(entry => {
        const mediaKey = getSavedVideoKey(entry.videoUrl);
        const meta = compactVideoMetadata(entry);

        if (mediaKey && meta) {
          freshMeta[mediaKey] = meta;
        }
      });

      const changed = JSON.stringify(oldVideos) !== JSON.stringify(freshVideos);

      artist.videos = freshVideos;
      artist.videoMeta = {
        ...(artist.videoMeta || {}),
        ...freshMeta
      };

      const firstFreshMeta = entries.map(entry => compactVideoMetadata(entry)).find(Boolean);

      if (firstFreshMeta) {
        Object.assign(artist, {
          artistName: firstFreshMeta.artistName || artist.artistName || '',
          artistKey: firstFreshMeta.artistKey || artist.artistKey || '',
          artistUrl: firstFreshMeta.artistUrl || artist.artistUrl || '',
          artistDisplayName: firstFreshMeta.artistDisplayName || artist.artistDisplayName || '',
          source: firstFreshMeta.source || artist.source || 'coomerfans',
          scrapedAt: firstFreshMeta.scrapedAt || artist.scrapedAt || ''
        });
      }

      if (changed) {
        artist.updatedAt = new Date().toISOString();
        repaired += Math.max(oldVideos.length, freshVideos.length);
      }
    });

    return {
      repaired
    };
  }

  async function finishIframeRepairQueue() {
    const state = iframeRepairState;

    if (!state) return;

    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
    }

    state.completed = state.queue.length;
    writeRepairLog('Applying scraped links to saved data');
    const applyStartedAt = Date.now();
    updateRepairQueuePanel('Applying fresh links...');

    const entries = state.results
      .flatMap(result => parsePastedMetadata(result.text).orderedVideos || [])
      .filter(item => item?.videoUrl);

    let repaired = state.initialRepaired || 0;

    if (entries.length || state.results.length) {
      const result = await updateSharedData(data => {
        const artistApplied = applyArtistScrapeResultsToSavedArtists(data, state.results).repaired;
        const applied = repairDataWithEntries(data, entries).repaired;
        refreshSharedDataMediaUrls(data);
        return {
          repaired: artistApplied + applied
        };
      });

      repaired += result.result.repaired || 0;
    }

    writeRepairLog(`Apply complete in ${formatRepairSeconds(Date.now() - applyStartedAt)}; repaired ${repaired} links`);
    updateRepairQueuePanel(`Done. Repaired ${repaired} links.`);
    updateSaveCountersOverride();

    const fill = document.getElementById('pong-repair-fill');
    const count = document.getElementById('pong-repair-count');
    if (fill) fill.style.width = '100%';
    if (count) count.textContent = `${state.queue.length}/${state.queue.length}`;

    showMsg(repaired ? `Repaired ${repaired} saved links` : 'No matching saved links needed repair');

    state.active = false;
    const stop = document.getElementById('pong-repair-stop');
    closeRepairWorkerWindow(state.workerWindow);
    if (stop) stop.textContent = 'Close';
    writeRepairLog('Repair finished; copy the log before closing if you want me to inspect timing');
  }

  async function runNextIframeRepairItem() {
    const state = iframeRepairState;
    if (!state || !state.active) return;

    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }

    state.index++;

    if (state.index >= state.queue.length) {
      writeRepairLog('Queue complete; finishing repair');
      finishIframeRepairQueue().catch(e => {
        showMsg('Could not apply repaired links');
        console.error(e);
        writeRepairLog(`Repair failed while applying results: ${e?.message || e}`);
        stopIframeRepairQueue('Repair failed');
      });
      return;
    }

    const item = state.queue[state.index];

    updateRepairQueuePanel();

    if (!item.url) {
      state.completed = Math.max(state.completed || 0, state.index + 1);
      state.currentProgress = 0;
      writeRepairLog(`Skip ${item.phase} ${state.index + 1}/${state.queue.length}: ${item.label} (${item.skipReason || 'No source URL'})`);
      updateRepairQueuePanel(`Skipped: ${item.label} (${item.skipReason || 'No source URL'})`);
      setTimeout(runNextIframeRepairItem, 250);
      return;
    }

    state.itemStartedAt = Date.now();
    state.currentProgress = 0;
    writeRepairLog(`Start ${item.phase} ${state.index + 1}/${state.queue.length}: ${item.label}`);

    if (state.directRepairDisabled) {
      writeRepairLog('Direct browser scrape skipped; using userscript worker');
    } else {
      try {
      updateRepairQueuePanel(`Direct scrape: ${item.label}`);
      writeRepairLog(`Direct browser scrape starting: ${item.url}`);
      const data = await directRepairScrapeItem(item);

      if (!iframeRepairState || iframeRepairState.id !== state.id || !state.active) return;

      if (data.ok && data.text && Number(data.count || 0) > 0) {
        state.results.push({
          item,
          text: String(data.text)
        });
        state.freshCount += Number(data.count || 0);

        state.completed = Math.max(state.completed || 0, state.index + 1);
        state.currentProgress = 0;
        writeRepairLog(`Direct result ${item.label}: ${Number(data.count || 0)} videos in ${formatRepairSeconds(Date.now() - (state.itemStartedAt || Date.now()))}`);
        updateRepairQueuePanel(`Done: ${item.label}`);
        setTimeout(runNextIframeRepairItem, 350);
        return;
      }

      writeRepairLog(`Direct scrape returned 0 videos for ${item.label}`);
      writeRepairLog('Falling back to visible repair tab worker');
      } catch (e) {
        if (!iframeRepairState || iframeRepairState.id !== state.id || !state.active) return;

        if (/failed to fetch|cors/i.test(String(e?.message || e))) {
          state.directRepairDisabled = true;
          writeRepairLog('Direct browser scrape disabled for this run after fetch/CORS failure');
        }

        writeRepairLog(`Direct scrape failed: ${e?.message || e}`);
        writeRepairLog('Falling back to visible repair tab worker');
      }
    }

    if (!navigateRepairWorker(item)) {
      state.completed = Math.max(state.completed || 0, state.index + 1);
      state.currentProgress = 0;
      updateRepairQueuePanel(`Skipped: ${item.label} (repair tab blocked)`);
      setTimeout(runNextIframeRepairItem, 250);
      return;
    }

    state.timeoutId = setTimeout(() => {
      if (!iframeRepairState || iframeRepairState.id !== state.id) return;
      state.completed = Math.max(state.completed || 0, state.index + 1);
      state.currentProgress = 0;
      writeRepairLog(`Timeout after ${formatRepairSeconds(REPAIR_ITEM_TIMEOUT_MS)}: ${item.label}`);
      writeRepairLog('No userscript message received; check that Tampermonkey is enabled in the repair tab browser/profile.');
      updateRepairQueuePanel(`Timed out: ${item.label}`);
      setTimeout(runNextIframeRepairItem, 250);
    }, REPAIR_ITEM_TIMEOUT_MS);
  }

  function startIframeRepairQueue(queueInfo, initialRepaired = 0, workerWindow = null) {
    const queue = Array.isArray(queueInfo) ? queueInfo : queueInfo?.queue || [];
    const stats = Array.isArray(queueInfo) ? {} : queueInfo?.stats || {};

    if (!queue.length) return false;

    if (iframeRepairState) {
      stopIframeRepairQueue();
    }

    ensureRepairQueuePanel();

    iframeRepairState = {
      id: Date.now().toString(36),
      active: true,
      queue,
      index: -1,
      completed: 0,
      results: [],
      freshCount: 0,
      initialRepaired,
      stats,
      timeoutId: null,
      startedAt: Date.now(),
      itemStartedAt: 0,
      logLines: [],
      currentProgress: 0,
      directRepairDisabled: false,
      workerWindow
    };

    updateRepairQueuePanel('Starting repair...');
    writeRepairLog(`Queue created: ${queue.length} jobs`);
    writeRepairLog('Direct browser scrape enabled');
    writeRepairLog(getCoomerfansProxyUrl() ? `Repair proxy: ${getCoomerfansProxyUrl()}` : 'Repair proxy not configured; direct fetch will likely fail');
    writeRepairLog(workerWindow ? 'Visible repair tab opened' : 'Visible repair tab fallback is closed until needed');
    writeRepairLog(`${stats.savedArtists || 0} saved artists, ${stats.uniqueArtists || 0} unique artist pages`);
    writeRepairLog(`${stats.savedVideos || 0} saved videos, ${stats.repairableVideos || 0} repairable source pages`);
    runNextIframeRepairItem();
    return true;
  }

  window.addEventListener('message', event => {
    const state = iframeRepairState;
    const data = event.data || {};

    if (!state || !state.active) return;

    const current = state.queue[state.index];

    if (data.type === 'PONG_REPAIR_HELLO') {
      if (!current || data.repairId !== current.id) {
        writeRepairLog(`Ignored userscript hello for ${data.repairId || 'missing id'} while waiting for ${current?.id || 'none'}`);
        return;
      }

      writeRepairLog(`Userscript detected for ${current.label}; scraping started`);
      updateRepairQueuePanel(`Userscript scraping: ${current.label}`);
      return;
    }

    if (data.type !== 'PONG_REPAIR_RESULT') return;

    if (!current || data.repairId !== current.id) {
      writeRepairLog(`Ignored repair message for ${data.repairId || 'missing id'} while waiting for ${current?.id || 'none'}`);
      return;
    }

    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }

    if (data.ok && data.text) {
      state.results.push({
        item: current,
        text: String(data.text)
      });
      state.freshCount += Number(data.count || 0);
    }

    state.completed = Math.max(state.completed || 0, state.index + 1);
    state.currentProgress = 0;
    writeRepairLog(`${data.ok ? 'Result' : 'Skip'} ${current.label}: ${Number(data.count || 0)} videos in ${formatRepairSeconds(Date.now() - (state.itemStartedAt || Date.now()))}`);
    updateRepairQueuePanel(data.ok ? `Done: ${current.label}` : `Skipped: ${current.label}`);
    setTimeout(runNextIframeRepairItem, 350);
  });

  async function scrapeRepairEntriesForTarget(target) {
    const api = window.PongCoomerfansRepair;

    if (!api) return [];

    if (target?.postUrl && typeof api.scrapePost === 'function') {
      return await api.scrapePost(target.postUrl);
    }

    if (target?.artistUrl && typeof api.scrapeArtist === 'function') {
      return await api.scrapeArtist(target.artistUrl);
    }

    return [];
  }

  async function repairSavedLinksOverride() {
    const workerWindow = null;

    try {
      showMsg('Repairing saved links...');

      let pastedRepaired = 0;
      const pastedEntries = repairEntriesFromCurrentPaste();

      if (pastedEntries.length) {
        const pastedResult = await updateSharedData(data => {
          const repaired = repairDataWithEntries(data, pastedEntries).repaired;
          refreshSharedDataMediaUrls(data);
          return {
            repaired
          };
        });

        pastedRepaired = pastedResult.result.repaired || 0;
      }

      const loaded = await fetchSharedDataFromGitHub();
      const queueInfo = buildIframeRepairQueue(mergeSharedDataWithLocal(loaded.data));

      if (queueInfo.queue.length) {
        if (!getCoomerfansProxyUrl()) {
          setCoomerfansProxyUrl();
        }

        startIframeRepairQueue(queueInfo, pastedRepaired, workerWindow);
        return;
      }

      closeRepairWorkerWindow(workerWindow);
      showMsg(pastedRepaired ? `Repaired ${pastedRepaired} saved links` : 'No repairable artist or post URLs found');
    } catch (e) {
      closeRepairWorkerWindow(workerWindow);
      showMsg('Could not repair saved links');
      console.error(e);
    }
  }

  function createRemoveSavedButtonOverride() {
    injectPongSyncStyles();

    const existing = document.getElementById('remove-saved-button');

    if (existing) {
      existing.remove();
    }

    const btn = document.createElement('button');
    btn.id = 'remove-saved-button';
    btn.className = 'remove-saved-button';
    btn.type = 'button';
    btn.innerHTML = '×';
    btn.title = 'Remove current saved video, or remove current saved artist bundle';

    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      removeCurrentSavedItemOverride();
    });

    document.body.appendChild(btn);
  }

  function createSaveButtonsOverride() {
    injectPongSyncStyles();

    const existing = document.getElementById('save-actions-panel');

    if (existing) {
      updateSaveCountersOverride();
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'save-actions-panel';
    panel.className = 'save-actions-panel';

    const tokenBtn = document.createElement('button');
    tokenBtn.id = 'github-token-button';
    tokenBtn.className = 'side-save-button';
    tokenBtn.type = 'button';
    tokenBtn.title = 'Set GitHub sync token';
    tokenBtn.innerHTML = `
      <span class="side-save-icon">⌁</span>
      <span class="side-save-label">Sync</span>
      <span class="side-save-count">GH</span>
    `;
    tokenBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      setGitHubToken();
    });

    const repairBtn = document.createElement('button');
    repairBtn.id = 'repair-saved-links-button';
    repairBtn.className = 'side-save-button';
    repairBtn.type = 'button';
    repairBtn.title = 'Repair saved links from pasted fresh metadata, or from stored artist/post URLs when the updated Tampermonkey script is installed on this page.';
    repairBtn.innerHTML = `
      <span class="side-save-icon">↻</span>
      <span class="side-save-label">Repair</span>
      <span class="side-save-count">Fix</span>
    `;
    repairBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      repairSavedLinksOverride();
    });

    const artistBtn = document.createElement('button');
    artistBtn.id = 'save-current-artist-button';
    artistBtn.className = 'side-save-button';
    artistBtn.type = 'button';
    artistBtn.title = 'Press to save current paperclip bundle. Hold 2 seconds to play saved bundles randomized.';
    artistBtn.innerHTML = `
      <span class="side-save-icon">👤</span>
      <span class="side-save-label">Artist</span>
      <span id="saved-artist-count" class="side-save-count">0</span>
    `;

    let artistHoldTimer = null;
    let artistLongPress = false;
    let artistSaveTarget = null;
    let artistTouchStart = null;
    let artistTouchMoved = false;

    function captureCurrentSaveTarget() {
      const wrapper = getCurrentVideoWrapperOverride();

      return {
        wrapper,
        url: getVideoUrlFromWrapperOverride(wrapper) || getCurrentVideoUrlOverride(),
        bundleInfo: getCurrentPasteBundleInfo(wrapper)
      };
    }

    function startArtistHold(e) {
      artistLongPress = false;
      artistTouchMoved = false;
      artistSaveTarget = captureCurrentSaveTarget();
      artistTouchStart = e && e.touches && e.touches[0]
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null;
      clearTimeout(artistHoldTimer);

      artistHoldTimer = setTimeout(() => {
        artistLongPress = true;
        playSavedArtistsRandomized();
      }, 2000);
    }

    function moveArtistTouch(e) {
      if (!artistTouchStart || !e.touches || !e.touches[0]) return;

      const dx = e.touches[0].clientX - artistTouchStart.x;
      const dy = e.touches[0].clientY - artistTouchStart.y;

      if (Math.hypot(dx, dy) > SAVE_TAP_MOVE_CANCEL_PX) {
        artistTouchMoved = true;
        clearTimeout(artistHoldTimer);
      }
    }

    function endArtistHold(e) {
      clearTimeout(artistHoldTimer);

      if (e) {
        if (!artistTouchMoved) e.preventDefault();
        e.stopPropagation();
      }

      if (!artistLongPress && !artistTouchMoved) {
        saveCurrentArtistVideosOverride(artistSaveTarget && artistSaveTarget.bundleInfo);
      }

      artistSaveTarget = null;
      artistTouchStart = null;
      artistTouchMoved = false;
    }

    artistBtn.addEventListener('touchstart', startArtistHold, { passive: true });
    artistBtn.addEventListener('touchmove', moveArtistTouch, { passive: true });
    artistBtn.addEventListener('touchend', endArtistHold);
    artistBtn.addEventListener('touchcancel', () => {
      clearTimeout(artistHoldTimer);
      artistSaveTarget = null;
      artistTouchStart = null;
      artistTouchMoved = false;
    });
    artistBtn.addEventListener('mousedown', startArtistHold);
    artistBtn.addEventListener('mouseup', endArtistHold);
    artistBtn.addEventListener('mouseleave', () => clearTimeout(artistHoldTimer));

    const videoBtn = document.createElement('button');
    videoBtn.id = 'save-current-video-button';
    videoBtn.className = 'side-save-button';
    videoBtn.type = 'button';
    videoBtn.title = 'Press to save current video. Hold 2 seconds to play saved videos randomized.';
    videoBtn.innerHTML = `
      <span class="side-save-icon">💾</span>
      <span class="side-save-label">Video</span>
      <span id="saved-video-count" class="side-save-count">0</span>
    `;

    let videoHoldTimer = null;
    let videoLongPress = false;
    let videoSaveTarget = null;
    let videoTouchStart = null;
    let videoTouchMoved = false;

    function startVideoHold(e) {
      videoLongPress = false;
      videoTouchMoved = false;
      videoSaveTarget = captureCurrentSaveTarget();
      videoTouchStart = e && e.touches && e.touches[0]
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null;
      clearTimeout(videoHoldTimer);

      videoHoldTimer = setTimeout(() => {
        videoLongPress = true;
        playSavedVideosRandomized();
      }, 2000);
    }

    function moveVideoTouch(e) {
      if (!videoTouchStart || !e.touches || !e.touches[0]) return;

      const dx = e.touches[0].clientX - videoTouchStart.x;
      const dy = e.touches[0].clientY - videoTouchStart.y;

      if (Math.hypot(dx, dy) > SAVE_TAP_MOVE_CANCEL_PX) {
        videoTouchMoved = true;
        clearTimeout(videoHoldTimer);
      }
    }

    function endVideoHold(e) {
      clearTimeout(videoHoldTimer);

      if (e) {
        if (!videoTouchMoved) e.preventDefault();
        e.stopPropagation();
      }

      if (!videoLongPress && !videoTouchMoved) {
        saveCurrentVideoLinkOverride(videoSaveTarget && videoSaveTarget.url);
      }

      videoSaveTarget = null;
      videoTouchStart = null;
      videoTouchMoved = false;
    }

    videoBtn.addEventListener('touchstart', startVideoHold, { passive: true });
    videoBtn.addEventListener('touchmove', moveVideoTouch, { passive: true });
    videoBtn.addEventListener('touchend', endVideoHold);
    videoBtn.addEventListener('touchcancel', () => {
      clearTimeout(videoHoldTimer);
      videoSaveTarget = null;
      videoTouchStart = null;
      videoTouchMoved = false;
    });
    videoBtn.addEventListener('mousedown', startVideoHold);
    videoBtn.addEventListener('mouseup', endVideoHold);
    videoBtn.addEventListener('mouseleave', () => clearTimeout(videoHoldTimer));

    panel.appendChild(tokenBtn);
    panel.appendChild(repairBtn);
    panel.appendChild(artistBtn);
    panel.appendChild(videoBtn);
    document.body.appendChild(panel);

    updateSaveCountersOverride();
  }

  function showSeekFlash(wrapper, side) {
    const flash = wrapper.querySelector(`.seek-flash.${side}`);

    if (!flash) return;

    flash.classList.add('show');

    setTimeout(() => {
      flash.classList.remove('show');
    }, 500);
  }

  function attachSmoothScrubToTapArea(tapArea) {
    if (!tapArea || tapArea.dataset.pongSmoothScrub === 'true') return;

    tapArea.dataset.pongSmoothScrub = 'true';

    const wrapper = tapArea.closest('.video-wrapper');

    if (!wrapper) return;

    const video = wrapper.querySelector('video');
    const progressBar = wrapper.querySelector('.video-progress-bar');
    const progressFill = wrapper.querySelector('.video-progress-fill');
    const scrubberHandle = wrapper.querySelector('.scrubber-handle');

    if (!video || !progressBar || !progressFill) return;

    const state = {
      startX: 0,
      startY: 0,
      startTime: 0,
      isHorizontalScrub: false,
      isVerticalSwipe: false,
      lastTapTime: 0,
      lastTapX: 0,
      lastTouchActionTime: 0
    };

    function removePreviewAndFadeTime() {
      const preview = wrapper.querySelector('.preview-fill');

      if (preview) {
        preview.remove();
      }

      const timeIndicator = wrapper.querySelector('.time-indicator');

      if (timeIndicator) {
        timeIndicator.classList.add('fade-out');
        setTimeout(() => {
          timeIndicator.style.display = 'none';
        }, 1000);
      }

      if (scrubberHandle) {
        setTimeout(() => {
          scrubberHandle.style.display = '';
        }, 1200);
      }
    }

    tapArea.addEventListener('touchstart', e => {
      if (!e.touches || !e.touches[0]) return;

      e.stopImmediatePropagation();

      state.startX = e.touches[0].clientX;
      state.startY = e.touches[0].clientY;
      state.startTime = video.currentTime || 0;
      state.isHorizontalScrub = false;
      state.isVerticalSwipe = false;
    }, { capture: true, passive: true });

    tapArea.addEventListener('touchmove', e => {
      if (!e.touches || !e.touches[0]) return;

      e.stopImmediatePropagation();

      const dx = e.touches[0].clientX - state.startX;
      const dy = e.touches[0].clientY - state.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (state.isVerticalSwipe) {
        return;
      }

      if (!state.isHorizontalScrub && absY > VERTICAL_START_PX && absY > absX * VERTICAL_DOMINANCE_RATIO) {
        state.isVerticalSwipe = true;
        return;
      }

      const shouldStartScrub =
        state.isHorizontalScrub ||
        (absX > SCRUB_START_PX && absX > absY * SCRUB_DOMINANCE_RATIO);

      if (!shouldStartScrub) {
        return;
      }

      state.isHorizontalScrub = true;

      e.preventDefault();

      const duration = video.duration || 0;
      const newTime =
        typeof window.getAdaptiveScrubTime === 'function'
          ? window.getAdaptiveScrubTime(state.startTime, dx, duration, wrapper.offsetWidth)
          : Math.max(0, Math.min(duration, state.startTime + dx / SCRUB_PIXELS_PER_SECOND));

      wrapper.dataset.pendingTime = newTime;

      if (duration && !isNaN(newTime)) {
        let preview = wrapper.querySelector('.preview-fill');

        if (!preview) {
          preview = document.createElement('div');
          preview.className = 'preview-fill';
          progressBar.appendChild(preview);
        }

        preview.style.width = `${(newTime / duration) * 100}%`;

        if (scrubberHandle) {
          scrubberHandle.style.display = 'block';
        }
      }

      let timeIndicator = wrapper.querySelector('.time-indicator');

      if (!timeIndicator) {
        timeIndicator = document.createElement('div');
        timeIndicator.className = 'time-indicator';
        wrapper.appendChild(timeIndicator);
      }

      timeIndicator.classList.remove('fade-out');
      timeIndicator.style.opacity = '1';
      timeIndicator.style.display = 'flex';
      timeIndicator.textContent = `${dx > 0 ? '▶️' : '◀️'} ${formatTime(newTime)} / ${formatTime(duration)}`;
    }, { capture: true, passive: false });

    tapArea.addEventListener('touchend', e => {
      e.stopImmediatePropagation();

      state.lastTouchActionTime = Date.now();

      if (state.isVerticalSwipe) {
        state.isVerticalSwipe = false;
        state.isHorizontalScrub = false;
        return;
      }

      if (state.isHorizontalScrub) {
        e.preventDefault();

        const pendingTime = parseFloat(wrapper.dataset.pendingTime);

        if (!isNaN(pendingTime) && pendingTime >= 0) {
          video.currentTime = pendingTime;

          if (video.duration) {
            progressFill.style.width = `${(pendingTime / video.duration) * 100}%`;
          }

          delete wrapper.dataset.pendingTime;
        }

        state.isHorizontalScrub = false;

        removePreviewAndFadeTime();
        return;
      }

      if (!e.changedTouches || !e.changedTouches[0]) return;

      e.preventDefault();

      const now = Date.now();
      const tapX = e.changedTouches[0].clientX;
      const isDoubleTap = (now - state.lastTapTime) < 300 && Math.abs(tapX - state.lastTapX) < 80;

      if (isDoubleTap) {
        if (tapX < wrapper.offsetWidth * 0.4) {
          video.currentTime = Math.max(0, video.currentTime - 10);
          showSeekFlash(wrapper, 'left');
        } else if (tapX > wrapper.offsetWidth * 0.6) {
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          showSeekFlash(wrapper, 'right');
        }

        state.lastTapTime = 0;
        return;
      }

      state.lastTapTime = now;
      state.lastTapX = tapX;

      if (video.paused) {
        if (typeof window.playVideoCleanly === 'function') {
          window.playVideoCleanly(video);
        } else {
          video.play().catch(() => {});
        }
      } else {
        video.pause();
      }
    }, { capture: true, passive: false });

    tapArea.addEventListener('click', e => {
      if (Date.now() - state.lastTouchActionTime < 700) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, { capture: true });
  }

  function attachSmoothScrubToAllTapAreas() {
    document.querySelectorAll('.tap-area').forEach(attachSmoothScrubToTapArea);
  }

  function startSmoothScrubObserver() {
    attachSmoothScrubToAllTapAreas();

    const target = document.getElementById('video-container') || document.body;

    const observer = new MutationObserver(() => {
      attachSmoothScrubToAllTapAreas();
    });

    observer.observe(target, {
      childList: true,
      subtree: true
    });
  }

  function attachNormalModeReset() {
    const loadBtn = document.getElementById('load-videos');

    if (loadBtn && loadBtn.dataset.pongModeReset !== 'true') {
      loadBtn.dataset.pongModeReset = 'true';
      loadBtn.addEventListener('click', () => {
        refreshPastedInputMediaUrls();
        resetSavedPlaybackMode();
      }, true);
    }
  }

  function attachExpiredMediaHintsToVideo(video) {
    if (!video || video.dataset.pongExpiredMediaHint === 'true') return;

    video.dataset.pongExpiredMediaHint = 'true';
    video.addEventListener('error', () => {
      const failedUrl = video.currentSrc || video.src || '';

      if (!getMediaUrlKey(failedUrl)) return;

      const cachedFreshUrl = getCachedFreshMediaUrl(failedUrl);

      if (cachedFreshUrl && cachedFreshUrl !== failedUrl) {
        video.src = cachedFreshUrl;
        video.load();
        showMsg('Retried with refreshed signed URL');
        return;
      }

      if (!getSignedMediaInfo(failedUrl) || !signedUrlStillFresh(failedUrl, 0)) {
        showVideoExpiredHint(video, 'CDN link expired. Repair or paste fresh link.');
      }
    });
  }

  function showVideoExpiredHint(video, message) {
    injectPongSyncStyles();

    const wrapper = video && video.closest('.video-wrapper');

    if (!wrapper) {
      showMsg(message);
      return;
    }

    let hint = wrapper.querySelector('.pong-video-expired-hint');

    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'pong-video-expired-hint';
      wrapper.appendChild(hint);
    }

    hint.textContent = message;
  }

  function attachExpiredMediaHints() {
    document.querySelectorAll('video.video-player').forEach(attachExpiredMediaHintsToVideo);
  }

  function startExpiredMediaHintObserver() {
    attachExpiredMediaHints();

    const target = document.getElementById('video-container') || document.body;
    const observer = new MutationObserver(attachExpiredMediaHints);

    observer.observe(target, {
      childList: true,
      subtree: true
    });
  }

  try {
    updateSaveCounters = updateSaveCountersOverride;
    saveCurrentVideoLink = saveCurrentVideoLinkOverride;
    saveCurrentArtistVideos = saveCurrentArtistVideosOverride;
    createSaveButtons = createSaveButtonsOverride;
  } catch (e) {
    console.warn('Could not override original save functions:', e);
  }

  function bootPongSync() {
    injectPongSyncStyles();

    setTimeout(() => {
      createSaveButtonsOverride();
      createRemoveSavedButtonOverride();
      startSmoothScrubObserver();
      startExpiredMediaHintObserver();
      attachNormalModeReset();
    }, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootPongSync);
  } else {
    bootPongSync();
  }

  window.PongGitHubSync = {
    setGitHubToken,
    playSavedVideosRandomized,
    playSavedArtistsRandomized,
    saveCurrentVideoLink: saveCurrentVideoLinkOverride,
    saveCurrentArtistVideos: saveCurrentArtistVideosOverride,
    removeCurrentSavedItem: removeCurrentSavedItemOverride,
    repairSavedLinks: repairSavedLinksOverride
  };

  window.PongMetadataSync = {
    capturePastedText: capturePastedMetadata,
    capturePastedTextAsync: capturePastedMetadataAsync,
    parsePastedMetadata,
    getPastedMetadataForUrl,
    getCurrentMetadata: () => window.PongCurrentPastedMetadata || emptyPastedMetadata()
  };
})();
