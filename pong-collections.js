(() => {
  'use strict';

  const STORAGE_KEY = 'pong_saved_collections_v1';
  const button = document.getElementById('pong-collection-save-button');
  const panel = document.getElementById('pong-collection-panel');
  const closeButton = document.getElementById('pong-collection-close');
  const editButton = document.getElementById('pong-collection-edit');
  const editor = document.getElementById('pong-collection-editor');
  const nameInput = document.getElementById('pong-collection-name');
  const addButton = document.getElementById('pong-collection-add');
  const list = document.getElementById('pong-collection-list');
  const saveButton = document.getElementById('pong-collection-save-links');
  const loadButton = document.getElementById('pong-collection-load');
  const removeButton = document.getElementById('pong-collection-remove');
  const status = document.getElementById('pong-collection-status');
  const scopeButtons = [...document.querySelectorAll('[data-collection-scope]')];

  if (!button || !panel || !list) return;

  let selectedId = '';
  let selectedScope = 'current';
  let syncing = false;

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = String(message || '');
    status.style.color = error ? '#fca5a5' : '';
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function collectionIdForName(name) {
    const normalized = String(name || '').normalize('NFKC').trim().toLowerCase();
    const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'list';
    return `collection-${slug}-${hashText(normalized)}`;
  }

  function canonicalUrl(rawUrl, metadata = {}) {
    const raw = String(rawUrl || '').trim();
    if (!raw) return '';
    try {
      if (typeof pongCanonicalRawMediaUrl === 'function') {
        return String(pongCanonicalRawMediaUrl(raw, metadata) || raw).trim();
      }
    } catch (_) {}
    return raw;
  }

  function mediaKeyFor(rawUrl, metadata = {}) {
    const explicit = String(metadata?.mediaKey || '').trim();
    if (explicit && !/^https?:\/\//i.test(explicit)) return explicit;
    const canonical = canonicalUrl(rawUrl, metadata);
    try {
      const parsed = new URL(canonical, location.href);
      const storageMatch = decodeURIComponent(parsed.pathname || '').match(/\/(?:storage|storager)\/(.+\.(?:mp4|m4v|mov|webm))$/i);
      if (storageMatch) return `media:${storageMatch[1].toLowerCase()}`;
      parsed.hash = '';
      return parsed.toString();
    } catch (_) {
      return canonical;
    }
  }

  function compactMetadata(metadata = {}, url = '') {
    const allowed = [
      'source', 'sourceUrl', 'artistName', 'artistDisplayName', 'artistKey',
      'artistUrl', 'bundleKey', 'bundleLabel', 'postUrl', 'postIndex',
      'mediaKey', 'canonicalMediaUrl', 'originalVideoUrl', 'duration',
      'simpCityCreatorKey', 'simpCityThreadUrl', 'tiktokUsername'
    ];
    const compact = {};
    for (const key of allowed) {
      const value = metadata?.[key];
      if (value !== undefined && value !== null && value !== '') compact[key] = value;
    }
    const canonical = canonicalUrl(url, metadata);
    compact.canonicalMediaUrl = canonical;
    compact.originalVideoUrl = canonical;
    compact.mediaKey = mediaKeyFor(canonical, compact);
    return compact;
  }

  function normalizeVideo(rawVideo) {
    const record = typeof rawVideo === 'string' ? { url: rawVideo } : { ...(rawVideo || {}) };
    const metadata = compactMetadata({
      ...record,
      ...(record.meta && typeof record.meta === 'object' ? record.meta : {}),
      mediaKey: record.mediaKey || record.meta?.mediaKey || ''
    }, record.url);
    const url = canonicalUrl(record.url, metadata);
    const mediaKey = mediaKeyFor(url, metadata);
    return url && mediaKey ? { url, mediaKey, meta: metadata } : null;
  }

  function normalizeBundle(rawBundle) {
    if (!rawBundle || typeof rawBundle !== 'object') return null;
    const id = String(rawBundle.id || '').trim().slice(0, 180);
    if (!id) return null;
    const videos = [];
    const seen = new Set();
    for (const rawVideo of Array.isArray(rawBundle.videos) ? rawBundle.videos : []) {
      const video = normalizeVideo(rawVideo);
      if (!video || seen.has(video.mediaKey)) continue;
      seen.add(video.mediaKey);
      videos.push(video);
    }
    if (!videos.length) return null;
    return {
      id,
      label: String(rawBundle.label || rawBundle.artistName || 'Bundle').trim().slice(0, 160),
      source: String(rawBundle.source || '').trim().slice(0, 80),
      artistKey: String(rawBundle.artistKey || '').trim().slice(0, 240),
      artistName: String(rawBundle.artistName || '').trim().slice(0, 160),
      artistUrl: String(rawBundle.artistUrl || '').trim().slice(0, 1000),
      bundleKey: String(rawBundle.bundleKey || '').trim().slice(0, 240),
      videos
    };
  }

  function normalizeCollections(rawValue) {
    const source = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};
    const result = {};
    for (const [rawId, rawCollection] of Object.entries(source)) {
      if (!rawCollection || typeof rawCollection !== 'object') continue;
      const id = String(rawCollection.id || rawId || '').trim().toLowerCase().slice(0, 120);
      const name = String(rawCollection.name || '').normalize('NFKC').trim().slice(0, 80);
      if (!id || !name) continue;
      const deletedAt = String(rawCollection.deletedAt || '');
      const bundles = deletedAt ? [] : (Array.isArray(rawCollection.bundles) ? rawCollection.bundles : [])
        .map(normalizeBundle)
        .filter(Boolean);
      result[id] = {
        id,
        name,
        bundles,
        createdAt: String(rawCollection.createdAt || ''),
        updatedAt: String(rawCollection.updatedAt || ''),
        deletedAt
      };
    }
    return result;
  }

  function readCollections() {
    try {
      return normalizeCollections(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch (_) {
      return {};
    }
  }

  function writeCollections(collections) {
    const normalized = normalizeCollections(collections);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch (_) {}
    return normalized;
  }

  function mergeBundles(previousBundles, incomingBundles) {
    const order = [];
    const map = new Map();
    for (const rawBundle of [...(previousBundles || []), ...(incomingBundles || [])]) {
      const bundle = normalizeBundle(rawBundle);
      if (!bundle) continue;
      if (!map.has(bundle.id)) order.push(bundle.id);
      const previous = map.get(bundle.id);
      if (!previous) {
        map.set(bundle.id, bundle);
        continue;
      }
      const videoOrder = [];
      const videos = new Map();
      for (const video of [...previous.videos, ...bundle.videos]) {
        if (!videos.has(video.mediaKey)) videoOrder.push(video.mediaKey);
        videos.set(video.mediaKey, { ...(videos.get(video.mediaKey) || {}), ...video });
      }
      map.set(bundle.id, {
        ...previous,
        ...bundle,
        videos: videoOrder.map(mediaKey => videos.get(mediaKey))
      });
    }
    return order.map(id => map.get(id));
  }

  function mergeCollections(baseValue, incomingValue) {
    const base = normalizeCollections(baseValue);
    const incoming = normalizeCollections(incomingValue);
    for (const [id, record] of Object.entries(incoming)) {
      const previous = base[id] || {};
      if (previous.deletedAt || record.deletedAt) {
        const previousTime = Date.parse(previous.updatedAt || previous.deletedAt || 0) || 0;
        const recordTime = Date.parse(record.updatedAt || record.deletedAt || 0) || 0;
        const recordWins = recordTime > previousTime || (
          recordTime === previousTime && Boolean(record.deletedAt) && !previous.deletedAt
        );
        if (!Object.keys(previous).length || recordWins) {
          base[id] = {
            ...record,
            id,
            bundles: record.deletedAt ? [] : (record.bundles || []),
            deletedAt: String(record.deletedAt || '')
          };
        }
        continue;
      }
      base[id] = {
        ...previous,
        ...record,
        id,
        bundles: mergeBundles(previous.bundles, record.bundles),
        createdAt: previous.createdAt || record.createdAt || new Date().toISOString(),
        updatedAt: record.updatedAt || previous.updatedAt || new Date().toISOString(),
        deletedAt: ''
      };
    }
    return base;
  }

  function pcEndpoint() {
    try {
      const page = new URL(location.href);
      return ['http:', 'https:'].includes(page.protocol) ? page.origin : '';
    } catch (_) {
      return '';
    }
  }

  async function publishCollection(record) {
    const endpoint = pcEndpoint();
    if (!endpoint || !record) return null;
    try {
      const response = await fetch(`${endpoint}/saved-links/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          data: {
            savedVideos: {},
            savedArtists: {},
            savedCollections: { [record.id]: record }
          }
        })
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!payload?.data || !Object.prototype.hasOwnProperty.call(payload.data, 'savedCollections')) return null;
      const serverCollections = normalizeCollections(payload?.data?.savedCollections);
      return writeCollections(mergeCollections(readCollections(), serverCollections));
    } catch (_) {
      return null;
    }
  }

  async function refreshCollections() {
    if (syncing) return readCollections();
    syncing = true;
    try {
      const localAtRequestStart = readCollections();
      const endpoint = pcEndpoint();
      if (!endpoint) return localAtRequestStart;
      const response = await fetch(`${endpoint}/saved-links/state?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return readCollections();
      const payload = await response.json();
      const server = normalizeCollections(payload?.data?.savedCollections);
      // Include edits committed while the request was in flight. Publish every
      // changed existing record and tombstone, not only IDs absent on server.
      const currentLocal = readCollections();
      const merged = writeCollections(mergeCollections(server, currentLocal));
      for (const [id, localRecord] of Object.entries(currentLocal)) {
        const mergedRecord = merged[id] || localRecord;
        if (JSON.stringify(server[id] || null) !== JSON.stringify(mergedRecord || null)) {
          await publishCollection(mergedRecord);
        }
      }
      return merged;
    } catch (_) {
      return readCollections();
    } finally {
      syncing = false;
    }
  }

  function currentUrls() {
    if (typeof allVideoUrls !== 'undefined' && Array.isArray(allVideoUrls) && allVideoUrls.length) return allVideoUrls;
    if (typeof videoUrls !== 'undefined' && Array.isArray(videoUrls)) return videoUrls;
    return [];
  }

  function currentMetadata() {
    if (typeof allVideoMetadata !== 'undefined' && Array.isArray(allVideoMetadata)) return allVideoMetadata;
    if (typeof videoMetadata !== 'undefined' && Array.isArray(videoMetadata)) return videoMetadata;
    return [];
  }

  function buildBundle(event, indexes, eventIndex = -1) {
    const urls = currentUrls();
    const metadata = currentMetadata();
    const videos = [];
    for (const index of indexes) {
      const rawUrl = urls[index];
      if (!rawUrl) continue;
      const meta = compactMetadata(metadata[index] || {}, rawUrl);
      const url = canonicalUrl(rawUrl, meta);
      const mediaKey = mediaKeyFor(url, meta);
      if (!url || !mediaKey || videos.some(video => video.mediaKey === mediaKey)) continue;
      videos.push({ url, mediaKey, meta });
    }
    if (!videos.length) return null;
    const firstMeta = videos[0].meta || {};
    const source = String(event?.source || firstMeta.source || 'links');
    const artistKey = String(event?.artistKey || event?.simpCityCreatorKey || firstMeta.artistKey || firstMeta.simpCityCreatorKey || '');
    const artistName = String(event?.artistDisplayName || event?.artistName || firstMeta.artistDisplayName || firstMeta.artistName || '');
    const artistUrl = String(event?.artistUrl || firstMeta.artistUrl || '');
    const bundleKey = String(event?.bundleKey || firstMeta.bundleKey || '');
    const stableBundleIdentity = bundleKey || artistUrl || artistKey || videos[0].mediaKey;
    const identity = [source, stableBundleIdentity].join('|');
    return {
      id: `bundle-${hashText(identity)}`,
      label: String(event?.bundleLabel || artistName || bundleKey || `Bundle ${eventIndex + 1}`).slice(0, 160),
      source,
      artistKey,
      artistName,
      artistUrl,
      bundleKey,
      videos
    };
  }

  function eventBounds(event, total) {
    const start = Number(event?.startIndex);
    const count = Number(event?.count);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count <= 0) return null;
    return { start, end: Math.min(total, start + count) };
  }

  function captureAllBundles() {
    const urls = currentUrls();
    if (!urls.length) return [];
    const events = typeof pasteEvents !== 'undefined' && Array.isArray(pasteEvents) ? pasteEvents : [];
    const covered = new Set();
    const bundles = [];
    events.forEach((event, eventIndex) => {
      const bounds = eventBounds(event, urls.length);
      if (!bounds) return;
      const indexes = [];
      for (let index = bounds.start; index < bounds.end; index++) {
        indexes.push(index);
        covered.add(index);
      }
      const bundle = buildBundle(event, indexes, eventIndex);
      if (bundle) bundles.push(bundle);
    });
    const uncovered = urls.map((_, index) => index).filter(index => !covered.has(index));
    if (uncovered.length) {
      const bundle = buildBundle({ source: 'links', bundleLabel: 'Pasted links' }, uncovered, events.length);
      if (bundle) bundles.push(bundle);
    }
    return bundles;
  }

  function currentEventIndex() {
    try {
      if (typeof syncCurrentPasteIndexFromVisibleVideo === 'function') {
        const value = Number(syncCurrentPasteIndexFromVisibleVideo());
        if (Number.isInteger(value) && value >= 0) return value;
      }
    } catch (_) {}
    if (typeof currentPasteIndex !== 'undefined' && Number.isInteger(currentPasteIndex) && currentPasteIndex >= 0) return currentPasteIndex;
    return -1;
  }

  function captureCurrentBundle() {
    const urls = currentUrls();
    if (!urls.length) return [];
    const events = typeof pasteEvents !== 'undefined' && Array.isArray(pasteEvents) ? pasteEvents : [];
    const eventIndex = currentEventIndex();
    const event = eventIndex >= 0 ? events[eventIndex] : null;
    const bounds = eventBounds(event, urls.length);
    if (bounds) {
      const indexes = [];
      for (let index = bounds.start; index < bounds.end; index++) indexes.push(index);
      const bundle = buildBundle(event, indexes, eventIndex);
      return bundle ? [bundle] : [];
    }
    const bundle = buildBundle({ source: 'links', bundleLabel: 'Pasted links' }, urls.map((_, index) => index), 0);
    return bundle ? [bundle] : [];
  }

  function collectionCounts(record) {
    const bundles = Array.isArray(record?.bundles) ? record.bundles : [];
    return {
      bundles: bundles.length,
      videos: bundles.reduce((sum, bundle) => sum + (Array.isArray(bundle?.videos) ? bundle.videos.length : 0), 0)
    };
  }

  function render() {
    const collections = readCollections();
    const records = Object.values(collections)
      .filter(record => !record.deletedAt)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (selectedId && (!collections[selectedId] || collections[selectedId].deletedAt)) selectedId = '';
    if (!selectedId && records.length === 1) selectedId = records[0].id;
    list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'pong-collection-empty';
      empty.textContent = 'No collections yet. Tap the pencil to name one.';
      list.appendChild(empty);
    }
    for (const record of records) {
      const counts = collectionCounts(record);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `pong-collection-row${record.id === selectedId ? ' selected' : ''}`;
      row.dataset.collectionId = record.id;
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', record.id === selectedId ? 'true' : 'false');
      const check = document.createElement('span');
      check.className = 'pong-collection-check';
      check.textContent = record.id === selectedId ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'pong-collection-name-label';
      label.textContent = record.name;
      const count = document.createElement('span');
      count.className = 'pong-collection-count';
      count.textContent = `${counts.bundles} clips · ${counts.videos}`;
      row.append(check, label, count);
      row.addEventListener('click', () => {
        selectedId = record.id;
        render();
        setStatus(`${record.name} selected`);
      });
      list.appendChild(row);
    }
    scopeButtons.forEach(scopeButton => {
      scopeButton.classList.toggle('selected', scopeButton.dataset.collectionScope === selectedScope);
    });
  }

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) {
      editor.hidden = true;
      setStatus('');
    }
  }

  async function addCollection() {
    const name = String(nameInput?.value || '').normalize('NFKC').trim().slice(0, 80);
    if (!name) {
      setStatus('Enter a collection name.', true);
      nameInput?.focus();
      return;
    }
    const collections = readCollections();
    const existing = Object.values(collections).find(record => !record.deletedAt && record.name.toLowerCase() === name.toLowerCase());
    let id = existing?.id || collectionIdForName(name);
    if (!existing && collections[id]?.deletedAt) id = collectionIdForName(`${name}-${Date.now()}`);
    const now = new Date().toISOString();
    const record = existing || { id, name, bundles: [], createdAt: now, updatedAt: now, deletedAt: '' };
    collections[id] = record;
    writeCollections(collections);
    selectedId = id;
    editor.hidden = true;
    if (nameInput) nameInput.value = '';
    render();
    setStatus(existing ? `${name} selected` : `${name} added`);
    await publishCollection(record);
    render();
  }

  async function saveSelection() {
    const collections = readCollections();
    const selected = collections[selectedId];
    if (!selected || selected.deletedAt) {
      setStatus('Choose or add a collection first.', true);
      return;
    }
    const bundles = selectedScope === 'all' ? captureAllBundles() : captureCurrentBundle();
    if (!bundles.length) {
      setStatus(selectedScope === 'all' ? 'No loaded links to save.' : 'No current paperclip to save.', true);
      return;
    }
    const before = collectionCounts(selected);
    const updated = {
      ...selected,
      bundles: mergeBundles(selected.bundles, bundles),
      updatedAt: new Date().toISOString()
    };
    collections[selectedId] = updated;
    writeCollections(collections);
    render();
    const after = collectionCounts(updated);
    setStatus(`Saved ${after.videos - before.videos} new link${after.videos - before.videos === 1 ? '' : 's'} to ${updated.name}`);
    await publishCollection(updated);
    render();
  }

  function shuffledBundles(bundles) {
    const result = [...bundles];
    if (result.length > 1 && typeof globalThis.crypto?.getRandomValues === 'function') {
      const random = new Uint32Array(result.length);
      globalThis.crypto.getRandomValues(random);
      for (let index = result.length - 1; index > 0; index--) {
        const target = random[index] % (index + 1);
        [result[index], result[target]] = [result[target], result[index]];
      }
      return result;
    }
    for (let index = result.length - 1; index > 0; index--) {
      const target = Math.floor(Math.random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  async function loadSelection() {
    const intentGeneration = Number(window.PongBeginSavedPlaybackLoadIntent?.() || 0);
    setStatus('Refreshing shared collections…');
    await refreshCollections();
    if (
      intentGeneration > 0 &&
      window.PongIsSavedPlaybackLoadIntentCurrent?.(intentGeneration) !== true
    ) return;
    const selected = readCollections()[selectedId];
    if (!selected || selected.deletedAt) {
      render();
      setStatus('Choose a collection first.', true);
      return;
    }
    const bundles = shuffledBundles((selected.bundles || []).filter(bundle => bundle?.videos?.length));
    const urls = [];
    const metadata = [];
    const events = [];
    bundles.forEach((bundle, bundleIndex) => {
      const startIndex = urls.length;
      bundle.videos.forEach((video, videoIndex) => {
        urls.push(video.url);
        metadata.push({
          ...(video.meta || {}),
          source: video.meta?.source || bundle.source || 'savedCollection',
          artistKey: video.meta?.artistKey || bundle.artistKey || '',
          artistName: video.meta?.artistName || bundle.artistName || bundle.label,
          artistDisplayName: video.meta?.artistDisplayName || bundle.artistName || bundle.label,
          artistUrl: video.meta?.artistUrl || bundle.artistUrl || '',
          bundleKey: bundle.bundleKey || bundle.id,
          postIndex: Number.isFinite(Number(video.meta?.postIndex)) ? Number(video.meta.postIndex) : videoIndex,
          mediaKey: video.mediaKey,
          canonicalMediaUrl: video.url,
          originalVideoUrl: video.url,
          savedCollectionId: selected.id,
          savedCollectionName: selected.name
        });
      });
      events.push({
        startIndex,
        count: urls.length - startIndex,
        source: bundle.source || 'savedCollection',
        artistKey: bundle.artistKey || bundle.id,
        artistUrl: bundle.artistUrl || '',
        bundleKey: bundle.bundleKey || bundle.id,
        artistDisplayName: bundle.artistName || bundle.label || `Bundle ${bundleIndex + 1}`,
        bundleLabel: bundle.label || bundle.artistName || `Bundle ${bundleIndex + 1}`,
        savedCollectionId: selected.id,
        savedCollectionName: selected.name,
        loadAll: false,
        ready: true,
        pending: false
      });
    });
    if (!urls.length) {
      setStatus(`${selected.name} has no links yet.`, true);
      return;
    }
    const loaded = window.PongGitHubSync?.loadNamedCollection?.(
      urls,
      events,
      metadata,
      selected.name,
      intentGeneration
    );
    if (!loaded) {
      setStatus('Player is still starting. Try Load again.', true);
      return;
    }
    setOpen(false);
  }

  async function removeSelection({ confirmRemoval = true } = {}) {
    const collections = readCollections();
    const selected = collections[selectedId];
    if (!selected || selected.deletedAt) {
      setStatus('Choose a collection to remove first.', true);
      return false;
    }
    if (confirmRemoval && typeof window.confirm === 'function' && !window.confirm(`Remove "${selected.name}"?`)) {
      return false;
    }
    const now = new Date().toISOString();
    const tombstone = {
      ...selected,
      bundles: [],
      updatedAt: now,
      deletedAt: now
    };
    collections[selected.id] = tombstone;
    writeCollections(collections);
    selectedId = '';
    render();
    setStatus(`${selected.name} removed`);
    await publishCollection(tombstone);
    render();
    return true;
  }

  button.addEventListener('click', async () => {
    const open = panel.hidden;
    setOpen(open);
    if (!open) return;
    render();
    setStatus('Loading shared collections…');
    await refreshCollections();
    render();
    setStatus('Choose one collection to save or load.');
  });
  closeButton?.addEventListener('click', () => setOpen(false));
  editButton?.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
    if (!editor.hidden) {
      setStatus('Name a new collection, then tap Add.');
      requestAnimationFrame(() => nameInput?.focus());
    }
  });
  addButton?.addEventListener('click', addCollection);
  nameInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void addCollection();
    }
  });
  scopeButtons.forEach(scopeButton => scopeButton.addEventListener('click', () => {
    selectedScope = scopeButton.dataset.collectionScope === 'all' ? 'all' : 'current';
    render();
    setStatus(selectedScope === 'all' ? 'Save every loaded bundle.' : 'Save the entire current paperclip.');
  }));
  saveButton?.addEventListener('click', () => void saveSelection());
  loadButton?.addEventListener('click', () => void loadSelection());
  removeButton?.addEventListener('click', () => void removeSelection());
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY && !panel.hidden) render();
  });

  window.PongNamedCollections = {
    open: () => button.click(),
    refresh: refreshCollections,
    snapshot: readCollections,
    captureAllBundles,
    captureCurrentBundle,
    mergeCollections,
    removeSelection
  };
})();
