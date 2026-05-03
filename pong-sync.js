// Pong GitHub shared saved videos/artists sync override.
// This file loads after index.html and replaces the local-only save buttons.

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

    let parsed = emptySharedData();

    if (file && file.content) {
      try {
        parsed = JSON.parse(base64DecodeUnicode(file.content));
      } catch (e) {
        parsed = emptySharedData();
      }
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
      content: base64EncodeUnicode(JSON.stringify(data, null, 2)),
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

  function loadSavedListIntoPlayer(urls, message) {
    if (!urls || !urls.length) {
      showMsg('No saved videos found');
      return;
    }

    if (window.currentlyPlayingVideo && !window.currentlyPlayingVideo.paused) {
      window.currentlyPlayingVideo.pause();
    }

    allVideoUrls = urls.slice();
    videoUrls = [];
    videoMetadata = [];
    currentBatch = 0;
    currentVideoIndex = 0;

    if (typeof saveSession === 'function') {
      saveSession();
    }

    videoContainer.innerHTML = '<div class="loading-message">Loading saved videos...</div>';

    setTimeout(() => {
      loadNextBatch();

      if (typeof hideControls === 'function') {
        hideControls();
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
        `Playing ${randomizedVideos.length} saved videos 🎲`
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

      const groupedVideos = [];

      shuffleArray(artistEntries).forEach(artist => {
        artist.videos.forEach(url => {
          if (url && !groupedVideos.includes(url)) {
            groupedVideos.push(url);
          }
        });
      });

      loadSavedListIntoPlayer(
        groupedVideos,
        `Playing ${artistEntries.length} saved artists 👤🎲`
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
    const currentUrl = getCurrentVideoUrlOverride();

    if (!currentUrl) {
      showMsg('No current video found');
      return;
    }

    const artistKey = extractArtistKeyOverride(currentUrl);

    if (!artistKey) {
      showMsg('Could not detect artist from this URL');
      return;
    }

    const sourceUrls = allVideoUrls && allVideoUrls.length ? allVideoUrls : videoUrls;

    const artistVideos = [...new Set(
      sourceUrls.filter(url => extractArtistKeyOverride(url) === artistKey)
    )];

    if (!artistVideos.length) {
      showMsg('No artist videos found');
      return;
    }

    try {
      showMsg('Saving artist...');

      const result = await updateSharedData(data => {
        data.savedArtists = data.savedArtists || {};

        const existing = data.savedArtists[artistKey];

        const mergedVideos = existing && Array.isArray(existing.videos)
          ? [...new Set([...existing.videos, ...artistVideos])]
          : artistVideos;

        data.savedArtists[artistKey] = {
          artistKey,
          videos: mergedVideos,
          savedAt: existing?.savedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        return {
          addedVideoCount: addSavedVideosToData(data, artistVideos, artistKey),
          artistVideoCount: mergedVideos.length
        };
      });

      if (result.result.addedVideoCount > 0) {
        showMsg(`Saved artist + ${result.result.addedVideoCount} videos 👤`);
      } else {
        showMsg('Artist already saved');
      }
    } catch (e) {
      showMsg('Could not save artist');
      console.error(e);
    }
  }

  function createSaveButtonsOverride() {
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

    const artistBtn = document.createElement('button');
    artistBtn.id = 'save-current-artist-button';
    artistBtn.className = 'side-save-button';
    artistBtn.type = 'button';
    artistBtn.title = 'Press to save current artist. Hold 2 seconds to play saved artists randomized.';
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

    panel.appendChild(tokenBtn);
    panel.appendChild(videoBtn);
    panel.appendChild(artistBtn);
    document.body.appendChild(panel);

    updateSaveCountersOverride();
  }

  try {
    updateSaveCounters = updateSaveCountersOverride;
    saveCurrentVideoLink = saveCurrentVideoLinkOverride;
    saveCurrentArtistVideos = saveCurrentArtistVideosOverride;
    createSaveButtons = createSaveButtonsOverride;
  } catch (e) {
    console.warn('Could not override original save functions:', e);
  }

  function bootSyncButtons() {
    setTimeout(() => {
      createSaveButtonsOverride();
    }, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootSyncButtons);
  } else {
    bootSyncButtons();
  }

  window.PongGitHubSync = {
    setGitHubToken,
    playSavedVideosRandomized,
    playSavedArtistsRandomized,
    saveCurrentVideoLink: saveCurrentVideoLinkOverride,
    saveCurrentArtistVideos: saveCurrentArtistVideosOverride
  };
})();
