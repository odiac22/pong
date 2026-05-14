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
        left: 10px !important;
        top: calc(50% + 92px) !important;
        right: auto !important;
        transform: translateY(0) !important;
        z-index: 1200 !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 7px !important;
        pointer-events: auto !important;
      }

      .side-save-button {
        width: 36px !important;
        min-height: 40px !important;
        border: none !important;
        border-radius: 11px !important;
        background: rgba(30,30,30,0.78) !important;
        color: white !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 1px !important;
        cursor: pointer !important;
        opacity: 0.62 !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
        backdrop-filter: blur(5px) !important;
        -webkit-backdrop-filter: blur(5px) !important;
        -webkit-tap-highlight-color: transparent !important;
        touch-action: manipulation !important;
        transition: all 0.2s ease !important;
        padding: 2px !important;
      }

      .side-save-button:hover,
      .side-save-button:active {
        opacity: 1 !important;
        transform: scale(1.08) !important;
      }

      .side-save-icon {
        font-size: 14px !important;
        line-height: 1 !important;
      }

      .side-save-label {
        font-size: 7px !important;
        font-weight: 700 !important;
        line-height: 1 !important;
      }

      .side-save-count {
        margin-top: 1px !important;
        min-width: 14px !important;
        height: 11px !important;
        padding: 0 3px !important;
        border-radius: 999px !important;
        background: rgba(255,64,64,0.95) !important;
        color: white !important;
        font-size: 8px !important;
        font-weight: 800 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
      }

      .remove-saved-button {
        position: fixed !important;
        left: 10px !important;
        top: calc(40% - 42px) !important;
        transform: translateY(-50%) !important;
        width: 30px !important;
        height: 30px !important;
        background: rgba(185,28,28,0.78) !important;
        opacity: 0.55 !important;
        font-size: 15px !important;
        border: none !important;
        border-radius: 50% !important;
        z-index: 1200 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        color: white !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
        -webkit-tap-highlight-color: transparent !important;
        touch-action: manipulation !important;
        transition: all 0.2s ease !important;
      }

      .remove-saved-button:hover,
      .remove-saved-button:active {
        opacity: 1 !important;
        transform: translateY(-50%) scale(1.1) !important;
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

  function githubHeaders() {
    const token = requireGitHubToken();

    return {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  async function fetchSharedDataFromGitHub() {
    const token = requireGitHubToken();

    if (!token) {
      throw new Error('No GitHub token configured');
    }

    const res = await fetch(`${githubApiUrl()}?ref=${encodeURIComponent(GITHUB_SYNC.branch)}&t=${Date.now()}`, {
      method: 'GET',
      headers: githubHeaders(),
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

    const file = await res.json();

    let parsed = null;
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

    if (!parsed) {
      const rawUrl = (
        typeof file?.download_url === 'string' && file.download_url.trim()
          ? file.download_url
          : ''
      ) ||
        `https://raw.githubusercontent.com/${GITHUB_SYNC.owner}/${GITHUB_SYNC.repo}/${GITHUB_SYNC.branch}/${GITHUB_SYNC.path}`;

      const rawRes = await fetch(`${rawUrl}${rawUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store'
      });

      if (!rawRes.ok) {
        throw new Error(`GitHub raw load failed: ${rawRes.status}`);
      }

      try {
        parsed = await rawRes.json();
      } catch (e) {
        throw new Error('GitHub raw JSON parse failed');
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parsed = emptySharedData();
    }

    parsed.savedVideos = parsed.savedVideos || {};
    parsed.savedArtists = parsed.savedArtists || {};

    return {
      data: parsed,
      sha: file.sha || null
    };
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
        ...githubHeaders(),
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
        const loaded = await fetchSharedDataFromGitHub();
        const data = loaded.data;
        const result = mutatorFn(data) || {};

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

  function mirrorSharedDataToLocal(data) {
    saveSavedMap(SAVED_VIDEOS_KEY, data.savedVideos || {});
    saveSavedMap(SAVED_ARTISTS_KEY, data.savedArtists || {});
    updateSaveCountersFromData(data);
  }

  function updateSaveCountersFromData(data) {
    const savedVideos = data?.savedVideos || loadSavedMap(SAVED_VIDEOS_KEY);
    const savedArtists = data?.savedArtists || loadSavedMap(SAVED_ARTISTS_KEY);

    const videoCount = document.getElementById('saved-video-count');
    const artistCount = document.getElementById('saved-artist-count');

    if (videoCount) {
      videoCount.textContent = Object.keys(savedVideos).length;
    }

    if (artistCount) {
      artistCount.textContent = Object.keys(savedArtists).length;
    }
  }

  async function updateSaveCountersOverride() {
    try {
      const loaded = await fetchSharedDataFromGitHub();
      mirrorSharedDataToLocal(loaded.data);
    } catch (e) {
      updateSaveCountersFromData();
    }
  }

  function shuffleArray(arr) {
    const copy = arr.slice();

    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
  }

  function resetSavedPlaybackMode() {
    window.PongLoadedSavedMode = 'normal';
  }

  function loadSavedListIntoPlayer(urls, message, newPasteEvents, mode) {
    if (!urls || !urls.length) {
      showMsg('No saved videos found');
      return;
    }

    if (window.currentlyPlayingVideo && !window.currentlyPlayingVideo.paused) {
      window.currentlyPlayingVideo.pause();
    }

    window.PongLoadedSavedMode = mode || 'normal';

    allVideoUrls = urls.slice();
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
      mirrorSharedDataToLocal(loaded.data);

      const urls = Object.values(loaded.data.savedVideos || {})
        .map(item => item && item.url)
        .filter(Boolean);

      if (!urls.length) {
        showMsg('No saved videos yet');
        return;
      }

      const randomizedVideos = shuffleArray([...new Set(urls)]);

      loadSavedListIntoPlayer(
        randomizedVideos,
        `Playing ${randomizedVideos.length} saved videos 🎲`,
        [],
        'savedVideos'
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
      mirrorSharedDataToLocal(loaded.data);

      const artistEntries = Object.values(loaded.data.savedArtists || {})
        .filter(item => item && Array.isArray(item.videos) && item.videos.length);

      if (!artistEntries.length) {
        showMsg('No saved artists yet');
        return;
      }

      const randomizedArtists = shuffleArray(artistEntries);
      const groupedVideos = [];
      const rebuiltPasteEvents = [];

      randomizedArtists.forEach((artist, artistIndex) => {
        const cleanVideos = shuffleArray([...new Set(artist.videos.filter(Boolean))]);

        if (!cleanVideos.length) return;

        const startIndex = groupedVideos.length;

        cleanVideos.forEach(url => {
          groupedVideos.push(url);
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
        'savedArtists'
      );
    } catch (e) {
      showMsg('Could not load saved artists');
      console.error(e);
    }
  }

  function getCurrentVideoWrapperOverride() {
    if (window.currentlyPlayingVideo) {
      const playingWrapper = window.currentlyPlayingVideo.closest('.video-wrapper');

      if (playingWrapper) {
        return playingWrapper;
      }
    }

    return (
      document.querySelector('.video-wrapper.most-visible') ||
      document.querySelector('.video-wrapper[data-playable="true"]') ||
      document.querySelector(`.video-wrapper[data-index="${currentVideoIndex}"]`)
    );
  }

  function getCurrentVideoUrlOverride() {
    const wrapper = getCurrentVideoWrapperOverride();

    if (wrapper) {
      const index = parseInt(wrapper.dataset.index || '0', 10);

      if (!isNaN(index) && videoUrls[index]) {
        return videoUrls[index];
      }

      const video = wrapper.querySelector('video');

      if (video) {
        return video.currentSrc || video.src || null;
      }
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

    let added = 0;

    urls.forEach(url => {
      if (!url) return;

      const key = String(url).trim();

      if (!key) return;

      if (!data.savedVideos[key]) {
        data.savedVideos[key] = {
          url: key,
          artistKey: artistKey || extractArtistKeyOverride(key) || null,
          savedAt: new Date().toISOString()
        };

        added++;
      }
    });

    return added;
  }

  function getCurrentGlobalVideoIndex() {
    const wrapper = getCurrentVideoWrapperOverride();

    if (!wrapper) return -1;

    const localIndex = parseInt(wrapper.dataset.index || '0', 10);

    if (isNaN(localIndex)) return -1;

    const loadedBatchIndex = Math.max(0, currentBatch - 1);

    return loadedBatchIndex * BATCH_SIZE + localIndex;
  }

  function getCurrentPasteBundleInfo() {
    const globalIndex = getCurrentGlobalVideoIndex();

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

  async function saveCurrentVideoLinkOverride() {
    const url = getCurrentVideoUrlOverride();

    if (!url) {
      showMsg('No current video found');
      return;
    }

    try {
      showMsg('Saving video...');

      const artistKey = extractArtistKeyOverride(url);

      const result = await updateSharedData(data => {
        return {
          added: addSavedVideosToData(data, [url], artistKey)
        };
      });

      if (result.result.added) {
        showMsg('Saved current video 💾');
      } else {
        showMsg('Video already saved');
      }
    } catch (e) {
      showMsg('Could not save video');
      console.error(e);
    }
  }

  async function saveCurrentArtistVideosOverride() {
    const bundleInfo = getCurrentPasteBundleInfo();

    if (!bundleInfo || !bundleInfo.urls || !bundleInfo.urls.length) {
      showMsg('No paperclip bundle found');
      return;
    }

    const artistKey = bundleInfo.bundleKey;
    const artistVideos = [...new Set(bundleInfo.urls.filter(Boolean))];

    try {
      showMsg('Saving paperclip bundle...');

      const result = await updateSharedData(data => {
        data.savedArtists = data.savedArtists || {};

        const existing = data.savedArtists[artistKey];
        const existingVideos = existing && Array.isArray(existing.videos)
          ? existing.videos
          : [];

        const newVideosOnly = artistVideos.filter(url => !existingVideos.includes(url));

        const mergedVideos = [
          ...new Set([
            ...existingVideos,
            ...artistVideos
          ])
        ];

        data.savedArtists[artistKey] = {
          artistKey,
          source: 'paperclip-bundle',
          startIndex: bundleInfo.startIndex,
          count: bundleInfo.count,
          videos: mergedVideos,
          savedAt: existing?.savedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        return {
          addedBundleVideoCount: newVideosOnly.length,
          artistVideoCount: mergedVideos.length
        };
      });

      if (result.result.addedBundleVideoCount > 0) {
        showMsg(`Saved bundle + ${result.result.addedBundleVideoCount} videos 👤`);
      } else {
        showMsg('Bundle already saved');
      }
    } catch (e) {
      showMsg('Could not save bundle');
      console.error(e);
    }
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
    btn.innerHTML = '🗑️';
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
      existing.remove();
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
      <span class="side-save-icon">🔑</span>
      <span class="side-save-label">Sync</span>
      <span class="side-save-count">GH</span>
    `;
    tokenBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      setGitHubToken();
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

    function startArtistHold() {
      artistLongPress = false;
      clearTimeout(artistHoldTimer);

      artistHoldTimer = setTimeout(() => {
        artistLongPress = true;
        playSavedArtistsRandomized();
      }, 2000);
    }

    function endArtistHold(e) {
      clearTimeout(artistHoldTimer);

      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (!artistLongPress) {
        saveCurrentArtistVideosOverride();
      }
    }

    artistBtn.addEventListener('touchstart', startArtistHold, { passive: true });
    artistBtn.addEventListener('touchend', endArtistHold);
    artistBtn.addEventListener('touchcancel', () => clearTimeout(artistHoldTimer));
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

    function startVideoHold() {
      videoLongPress = false;
      clearTimeout(videoHoldTimer);

      videoHoldTimer = setTimeout(() => {
        videoLongPress = true;
        playSavedVideosRandomized();
      }, 2000);
    }

    function endVideoHold(e) {
      clearTimeout(videoHoldTimer);

      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (!videoLongPress) {
        saveCurrentVideoLinkOverride();
      }
    }

    videoBtn.addEventListener('touchstart', startVideoHold, { passive: true });
    videoBtn.addEventListener('touchend', endVideoHold);
    videoBtn.addEventListener('touchcancel', () => clearTimeout(videoHoldTimer));
    videoBtn.addEventListener('mousedown', startVideoHold);
    videoBtn.addEventListener('mouseup', endVideoHold);
    videoBtn.addEventListener('mouseleave', () => clearTimeout(videoHoldTimer));

    panel.appendChild(tokenBtn);
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

      const timeChange = dx / SCRUB_PIXELS_PER_SECOND;
      const duration = video.duration || 0;
      const newTime = Math.max(0, Math.min(duration, state.startTime + timeChange));

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
        video.play().catch(() => {});
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
        resetSavedPlaybackMode();
      }, true);
    }
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
    removeCurrentSavedItem: removeCurrentSavedItemOverride
  };
})();
