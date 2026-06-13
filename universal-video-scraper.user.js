// ==UserScript==
// @name         Universal Video Scraper - Visible Buttons + Page Links
// @namespace    https://coomerfans.com/
// @version      7.8.1
// @description  Universal video URL scraper with external-playable filtering, Erome browser-required diagnostics, page links, and remembered minimized panel.
// @author       regginyggaf
// @match        *://*/*
// @downloadURL  https://odiac22.github.io/pong/universal-video-scraper.user.js
// @updateURL    https://odiac22.github.io/pong/universal-video-scraper.user.js
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* CONFIG */

  const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|m3u8)(\?|#|$)/i;

  const RAW_VIDEO_URL_RE =
    /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:mp4|m4v|mov|webm|mkv|m3u8)(?:\?[^\s"'<>\\]*)?/gi;

  const EROME_ALBUM_RE =
    /^https?:\/\/(?:www\.)?erome\.com\/a\/[\w-]+\/?$/i;

  const GENERIC_FOLLOW_PATH_RE =
    /\/(?:a|album|albums|post|posts|video|videos|watch|v|view|gallery|g|media|clip|clips|p)\/[^/?#]+/i;

  const PLAYBACK_DIRECT = 'direct';
  const PLAYBACK_BROWSER_REQUIRED = 'browser_required';
  const DIRECT_EXTERNAL_SAFE = 'external_player_safe';
  const DIRECT_NOT_SAFE = 'not_external_player_safe';
  const DIRECT_NOT_FOUND = 'not_found';

  // Slower = less likely to fail or trigger rate limits.
  const POST_CONCURRENCY = 4;
  const FOLLOW_CONCURRENCY = 2;

  const MAX_FOLLOW_PAGES = 60;
  const MAX_FOLLOW_LINKS = 250;
  const MAX_RETRIES = 2;

  const COPY_AFTER_SCRAPE = false;
  const CLOSE_TAB_AFTER_MANUAL_COPY = false;
  const CLOSE_DELAY_MS = 450;

  const AUTO_SCRAPE_KEY = 'uvs_auto_scrape_enabled_v1';
  const PANEL_POS_KEY = 'uvs_panel_position_v1';
  const PANEL_COLLAPSED_KEY = 'uvs_panel_collapsed_v1';

  const PONG_ARTIST_PREFIX = '#PA|';
  const PONG_VIDEO_PREFIX = '#PV|';

  const TAG = '[UVS]';

  let lastResult = null;
  let busy = false;
  let panelStatusEl = null;

  /* HELPERS */

  function log(...args) {
    console.log(TAG, ...args);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function notify(text) {
    log(text);
    setPanelStatus(text);

    try {
      if (typeof GM_notification !== 'undefined') {
        GM_notification({
          title: 'Video Scraper',
          text,
          timeout: 4000
        });
      }
    } catch (e) {}
  }

  function setPanelStatus(text) {
    try {
      if (panelStatusEl) panelStatusEl.textContent = String(text || '');
    } catch (e) {}
  }

  function getStoredBool(key, fallback) {
    try {
      if (typeof GM_getValue !== 'undefined') return GM_getValue(key, fallback);
    } catch (e) {}

    try {
      const val = localStorage.getItem(key);
      if (val === null) return fallback;
      return val === 'true';
    } catch (e) {
      return fallback;
    }
  }

  function setStoredBool(key, value) {
    try {
      if (typeof GM_setValue !== 'undefined') {
        GM_setValue(key, !!value);
        return;
      }
    } catch (e) {}

    try {
      localStorage.setItem(key, value ? 'true' : 'false');
    } catch (e) {}
  }

  function getStoredJson(key, fallback) {
    try {
      const raw = typeof GM_getValue !== 'undefined'
        ? GM_getValue(key, '')
        : localStorage.getItem(key);

      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function setStoredJson(key, value) {
    const raw = JSON.stringify(value);

    try {
      if (typeof GM_setValue !== 'undefined') {
        GM_setValue(key, raw);
        return;
      }
    } catch (e) {}

    try {
      localStorage.setItem(key, raw);
    } catch (e) {}
  }

  function absUrl(raw, base) {
    if (!raw) return '';

    let u = String(raw).trim();

    u = u
      .replace(/\\\//g, '/')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=')
      .replace(/&amp;/g, '&')
      .replace(/^["'`]+/, '')
      .replace(/["'`),;\]]+$/, '');

    if (!u) return '';

    try {
      return new URL(u, base || location.href).toString();
    } catch (e) {
      return '';
    }
  }

  function normalizeUrl(raw, base) {
    const u = absUrl(raw, base);
    if (!u) return '';

    try {
      const url = new URL(u);
      url.hash = '';
      return url.toString();
    } catch (e) {
      return u.split('#')[0];
    }
  }

  function sameSite(url, base) {
    try {
      const a = new URL(url, base);
      const b = new URL(base, location.href);

      const ah = a.hostname.replace(/^www\./, '');
      const bh = b.hostname.replace(/^www\./, '');

      return ah === bh;
    } catch (e) {
      return false;
    }
  }

  function getBaseUrl(rawUrl = location.href) {
    const u = new URL(rawUrl, location.href);

    [
      'page',
      'p',
      'offset',
      'sort',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content'
    ].forEach(k => u.searchParams.delete(k));

    u.hash = '';

    return u.toString();
  }

  function pageUrl(base, n) {
    const u = new URL(base, location.href);

    if (n > 1) u.searchParams.set('page', String(n));
    else u.searchParams.delete('page');

    return u.toString();
  }

  function detectSite(rawUrl = location.href) {
    const u = new URL(rawUrl, location.href);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;

    if (host.endsWith('coomerfans.com') && /^\/u\//i.test(path)) return 'coomerfans';

    if (host === 'erome.com') {
      if (/^\/a\/[\w-]+\/?$/i.test(path)) return 'erome-album';
      return 'erome-profile';
    }

    return 'generic';
  }

  function isPongAppPage() {
    try {
      const host = location.hostname.replace(/^www\./, '').toLowerCase();
      const path = location.pathname || '';

      if (host === 'odiac22.github.io' && /^\/pong(?:\/|$)/i.test(path)) return true;
      if (document.getElementById('video-urls') && document.getElementById('load-videos')) return true;
    } catch (e) {}

    return false;
  }

  function getPongEromeTarget() {
    const fallback = 'https://www.erome.com/';

    try {
      const input = document.getElementById('video-urls');
      const text = input?.value || '';
      const match = text.match(/https?:\/\/(?:www\.)?erome\.com\/(?:a\/[\w-]+|[\w.-]+)\/?/i);

      return match ? normalizeUrl(match[0], fallback) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function openEromeFromPong() {
    const target = getPongEromeTarget();

    try {
      const opened = window.open(target, '_blank', 'noopener,noreferrer');
      if (opened) return;
    } catch (e) {}

    location.href = target;
  }

  function cleanTitle(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+-\s+EroMe.*$/i, '')
      .replace(/\s+-\s+Porn Videos.*$/i, '')
      .trim();
  }

  function parseHeader(headers, name) {
    const needle = String(name || '').toLowerCase();

    for (const line of String(headers || '').split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;

      const key = line.slice(0, idx).trim().toLowerCase();
      if (key === needle) return line.slice(idx + 1).trim();
    }

    return '';
  }

  function isHttpUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function isEromeHost(rawUrl) {
    try {
      const host = new URL(rawUrl, location.href).hostname.replace(/^www\./, '').toLowerCase();
      return host === 'erome.com' || host.endsWith('.erome.com');
    } catch (e) {
      return false;
    }
  }

  function isEromeProtectedCdnVideoUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      const host = u.hostname.toLowerCase();
      return /^v\d+\.erome\.com$/.test(host) && VIDEO_EXT_RE.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function hasSignedLikeQuery(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      const keys = ['e', 'expires', 'expire', 'exp', 'hash', 'token', 'signature', 'sig', 'auth', 'policy', 'key-pair-id'];

      for (const key of keys) {
        if (u.searchParams.has(key)) return true;
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  function looksLikePlayableMediaResponse(status, contentType) {
    const type = String(contentType || '').toLowerCase();

    if (![200, 204, 206].includes(Number(status))) return false;

    return (
      type.startsWith('video/') ||
      type.includes('mpegurl') ||
      type.includes('vnd.apple.mpegurl') ||
      type.includes('mp2t') ||
      type.includes('octet-stream')
    );
  }

  function countExternalPlayable(entries) {
    return (entries || []).filter(isExternalPlayableEntry).length;
  }

  function countBrowserRequired(entries) {
    return (entries || []).filter(item => item?.playbackType === PLAYBACK_BROWSER_REQUIRED).length;
  }

  function isExternalPlayableEntry(item) {
    return !!(
      item &&
      item.videoUrl &&
      item.externalPlayerSafe !== false &&
      item.playbackType !== PLAYBACK_BROWSER_REQUIRED &&
      item.directVideo !== DIRECT_NOT_SAFE
    );
  }

  function getRawVideoUrl(item) {
    return item?.rawVideoUrl || item?.videoUrl || '';
  }

  function isElementVisible(el) {
    if (!el) return false;

    try {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    } catch (e) {
      return false;
    }
  }

  function isEromeGateVisible() {
    try {
      return [
        document.getElementById('home-box'),
        document.getElementById('disclaimer'),
        document.querySelector('.gate-overlay')
      ].some(isElementVisible);
    } catch (e) {
      return false;
    }
  }

  /* FETCH */

  async function fetchText(url, attempt = 1) {
    try {
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        return await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url,
            timeout: 30000,
            anonymous: false,
            withCredentials: true,
            headers: {
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            onload: res => {
              if (res.status >= 200 && res.status < 400) {
                resolve(res.responseText || '');
              } else {
                reject(new Error(`HTTP ${res.status}`));
              }
            },
            onerror: () => reject(new Error('Network error')),
            ontimeout: () => reject(new Error('Request timed out'))
          });
        });
      }

      const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store'
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return await res.text();
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;

      await sleep(400 * attempt);

      return fetchText(url, attempt + 1);
    }
  }

  async function fetchDoc(url) {
    try {
      const html = await fetchText(url);
      const doc = new DOMParser().parseFromString(html, 'text/html');

      doc.__uvsRawHtml = html;
      doc.__uvsUrl = url;

      return doc;
    } catch (e) {
      log('Fetch failed:', url, e);
      return null;
    }
  }

  async function probeExternalMediaUrl(url) {
    if (!isHttpUrl(url)) {
      return {
        ok: false,
        status: 'invalid_url',
        contentType: '',
        reason: 'URL is not HTTP(S).'
      };
    }

    if (typeof GM_xmlhttpRequest === 'undefined') {
      return {
        ok: false,
        status: 'not_checked',
        contentType: '',
        reason: 'GM_xmlhttpRequest is unavailable for a no-credentials media probe.'
      };
    }

    const run = method => new Promise(resolve => {
      const headers = {
        Accept: 'video/*,application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8'
      };

      if (method === 'GET') headers.Range = 'bytes=0-0';

      GM_xmlhttpRequest({
        method,
        url,
        timeout: 15000,
        anonymous: true,
        withCredentials: false,
        headers,
        onload: res => {
          const contentType = parseHeader(res.responseHeaders, 'content-type');
          resolve({
            ok: looksLikePlayableMediaResponse(res.status, contentType),
            status: res.status,
            contentType,
            reason: looksLikePlayableMediaResponse(res.status, contentType)
              ? ''
              : `Media probe returned HTTP ${res.status}${contentType ? ` ${contentType}` : ''}.`
          });
        },
        onerror: () => resolve({
          ok: false,
          status: 'network_error',
          contentType: '',
          reason: 'Media probe failed with a network error.'
        }),
        ontimeout: () => resolve({
          ok: false,
          status: 'timeout',
          contentType: '',
          reason: 'Media probe timed out.'
        })
      });
    });

    const head = await run('HEAD');

    if (head.ok || ![405, 501].includes(Number(head.status))) return head;

    return run('GET');
  }

  async function pool(tasks, limit) {
    const results = new Array(tasks.length);
    let idx = 0;

    async function worker() {
      while (idx < tasks.length) {
        const i = idx++;

        try {
          results[i] = await tasks[i]();
        } catch (e) {
          log('Task failed:', e);
          results[i] = null;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(limit, tasks.length) }, worker)
    );

    return results;
  }

  function shuffle(arr) {
    const a = arr.slice();

    if (!a.length) return a;

    try {
      const rnd = new Uint32Array(a.length);
      crypto.getRandomValues(rnd);

      for (let i = a.length - 1; i > 0; i--) {
        const j = rnd[i] % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
    } catch (e) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
    }

    return a;
  }

  /* LAZY LOAD HELPERS */

  async function waitForPageSettled() {
    await sleep(250);

    try {
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
    } catch (e) {}

    await sleep(350);
  }

  async function lightAutoScroll() {
    const startY = window.scrollY || 0;
    const maxY = Math.min(
      document.documentElement.scrollHeight || 0,
      startY + Math.max(window.innerHeight * 3, 1800)
    );

    try {
      for (let y = startY; y < maxY; y += Math.max(500, window.innerHeight || 700)) {
        window.scrollTo(0, y);
        await sleep(180);
      }

      window.scrollTo(0, startY);
    } catch (e) {}
  }

  /* VIDEO EXTRACTION */

  function extractVideoUrlsFromText(text, baseUrl) {
    const out = new Set();

    if (!text) return [];

    const cleanText = String(text)
      .replace(/\\\//g, '/')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=')
      .replace(/&amp;/g, '&');

    let m;
    RAW_VIDEO_URL_RE.lastIndex = 0;

    while ((m = RAW_VIDEO_URL_RE.exec(cleanText))) {
      const url = absUrl(m[0], baseUrl);
      if (url && VIDEO_EXT_RE.test(url)) out.add(url);
    }

    return [...out];
  }

  function extractVideoUrls(doc = document, baseUrl = location.href) {
    const out = new Set();

    function add(raw) {
      if (!raw) return;

      const s = String(raw);

      if (VIDEO_EXT_RE.test(s)) {
        const direct = absUrl(s, baseUrl);
        if (direct) out.add(direct);
      }

      extractVideoUrlsFromText(s, baseUrl).forEach(u => out.add(u));
    }

    try {
      doc.querySelectorAll(
        'video source[src], video source[data-src], video[src], video[data-src]'
      ).forEach(el => {
        add(el.getAttribute('src'));
        add(el.getAttribute('data-src'));
      });

      doc.querySelectorAll(
        'a[href], source[src], iframe[src], embed[src], object[data]'
      ).forEach(el => {
        add(el.getAttribute('href'));
        add(el.getAttribute('src'));
        add(el.getAttribute('data'));
      });

      const attrNames = [
        'src',
        'href',
        'data-src',
        'data-url',
        'data-video',
        'data-video-src',
        'data-mp4',
        'data-webm',
        'data-file',
        'data-href',
        'content'
      ];

      doc.querySelectorAll('*').forEach(el => {
        for (const name of attrNames) {
          if (el.hasAttribute && el.hasAttribute(name)) {
            add(el.getAttribute(name));
          }
        }
      });

      doc.querySelectorAll('script').forEach(s => add(s.textContent || ''));

      const rawHtml = doc.__uvsRawHtml || doc.documentElement?.innerHTML || '';
      add(rawHtml);
    } catch (e) {
      log('extractVideoUrls error:', e);
    }

    return [...out]
      .map(u => absUrl(u, baseUrl))
      .filter(Boolean)
      .filter(u => VIDEO_EXT_RE.test(u))
      .filter((u, i, arr) => arr.indexOf(u) === i);
  }

  async function makeEntryFromVideoUrl(videoUrl, postUrl, postIndex, artist) {
    const rawVideoUrl = videoUrl;
    const base = {
      videoUrl,
      rawVideoUrl,
      postUrl,
      postIndex,
      artistUrl: artist.artistUrl,
      artistName: artist.artistName,
      artistKey: artist.artistKey,
      source: artist.source,
      scrapedAt: artist.scrapedAt,
      playbackType: PLAYBACK_DIRECT,
      directVideo: DIRECT_EXTERNAL_SAFE,
      externalPlayerSafe: true,
      directVideoStatus: 'assumed_direct',
      diagnostic: ''
    };

    if (artist.source !== 'erome') return base;

    const protectedCdn = isEromeProtectedCdnVideoUrl(rawVideoUrl);
    const signedLike = hasSignedLikeQuery(rawVideoUrl);

    if (protectedCdn && !signedLike) {
      return {
        ...base,
        videoUrl: '',
        playbackType: PLAYBACK_BROWSER_REQUIRED,
        directVideo: DIRECT_NOT_SAFE,
        externalPlayerSafe: false,
        directVideoStatus: 'known_protected_cdn',
        diagnostic: 'Erome raw v*.erome.com MP4 URLs are page-context protected and are not external-player safe.'
      };
    }

    if (!signedLike && isEromeHost(rawVideoUrl)) {
      return {
        ...base,
        videoUrl: '',
        playbackType: PLAYBACK_BROWSER_REQUIRED,
        directVideo: DIRECT_NOT_SAFE,
        externalPlayerSafe: false,
        directVideoStatus: 'erome_context_required',
        diagnostic: 'Erome media URL is not signed or otherwise proven standalone-playable.'
      };
    }

    const probe = await probeExternalMediaUrl(rawVideoUrl);

    if (probe.ok) {
      return {
        ...base,
        directVideoStatus: String(probe.status),
        diagnostic: ''
      };
    }

    return {
      ...base,
      videoUrl: '',
      playbackType: PLAYBACK_BROWSER_REQUIRED,
      directVideo: DIRECT_NOT_SAFE,
      externalPlayerSafe: false,
      directVideoStatus: String(probe.status || 'blocked_or_unknown'),
      diagnostic: probe.reason || 'Direct media URL was not proven external-player safe.'
    };
  }

  function makePageOnlyEntry(postUrl, artist, reason) {
    return {
      videoUrl: '',
      rawVideoUrl: '',
      postUrl,
      postIndex: 0,
      artistUrl: artist.artistUrl,
      artistName: artist.artistName,
      artistKey: artist.artistKey,
      source: artist.source,
      scrapedAt: artist.scrapedAt,
      playbackType: PLAYBACK_BROWSER_REQUIRED,
      directVideo: DIRECT_NOT_FOUND,
      externalPlayerSafe: false,
      directVideoStatus: 'not_found',
      diagnostic: reason || 'No standalone media URL was found on this page.'
    };
  }

  /* FOLLOW LINKS */

  function isEromeAlbumLink(url) {
    return EROME_ALBUM_RE.test(url);
  }

  function isGenericFollowLink(url, baseUrl) {
    if (!url) return false;
    if (!sameSite(url, baseUrl)) return false;
    if (VIDEO_EXT_RE.test(url)) return false;

    try {
      const u = new URL(url, baseUrl);

      if (isEromeAlbumLink(u.toString())) return true;

      const pathAndQuery = u.pathname + u.search;

      if (GENERIC_FOLLOW_PATH_RE.test(pathAndQuery)) return true;

      const text = pathAndQuery.toLowerCase();

      return (
        text.includes('album') ||
        text.includes('video') ||
        text.includes('watch') ||
        text.includes('gallery') ||
        text.includes('post')
      );
    } catch (e) {
      return false;
    }
  }

  function collectLinksFromDoc(doc, baseUrl, mode) {
    const found = new Set();

    if (!doc) return [];

    try {
      doc.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (!href) return;

        const abs = normalizeUrl(href, baseUrl);
        if (!abs) return;

        if (mode === 'erome') {
          if (isEromeAlbumLink(abs)) found.add(abs);
          return;
        }

        if (isGenericFollowLink(abs, baseUrl)) found.add(abs);
      });
    } catch (e) {
      log('collectLinksFromDoc error:', e);
    }

    return [...found];
  }

  function pageHasNext(doc) {
    if (!doc) return false;

    try {
      if (doc.querySelector('a[rel="next"]')) return true;
      if (doc.querySelector('a[href*="page="]')) return true;
      if (doc.querySelector('.pagination a, nav[aria-label*="pagination" i] a')) return true;
    } catch (e) {}

    return false;
  }

  async function collectFollowLinks(baseUrl, mode, onProgress) {
    const found = new Set();
    let page = 1;

    while (page <= MAX_FOLLOW_PAGES && found.size < MAX_FOLLOW_LINKS) {
      onProgress(`Scanning page ${page}...`);

      let doc;

      if (
        page === 1 &&
        normalizeUrl(location.href, location.href) === normalizeUrl(baseUrl, location.href)
      ) {
        doc = document;
        doc.__uvsRawHtml = document.documentElement?.innerHTML || '';
        doc.__uvsUrl = location.href;
      } else {
        doc = await fetchDoc(pageUrl(baseUrl, page));
      }

      if (!doc) break;

      const before = found.size;

      collectLinksFromDoc(doc, pageUrl(baseUrl, page), mode).forEach(u => found.add(u));

      if (!pageHasNext(doc)) break;
      if (page > 1 && found.size === before) break;

      page++;
    }

    return [...found].slice(0, MAX_FOLLOW_LINKS);
  }

  /* ARTIST INFO */

  function getGenericArtistInfo(site, doc = document, rawUrl = location.href) {
    const base = getBaseUrl(rawUrl);
    const u = new URL(base, location.href);
    const host = u.hostname.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);

    const title = cleanTitle(
      doc.querySelector('h1')?.textContent ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      doc.title ||
      document.title ||
      ''
    );

    if (site.startsWith('erome')) {
      const isAlbum = site === 'erome-album';

      const name = isAlbum
        ? title || parts.join('/')
        : decodeURIComponent(parts[0] || title || 'erome');

      const key = isAlbum
        ? `erome:album:${parts[1] || ''}`
        : `erome:${decodeURIComponent(parts[0] || '').toLowerCase()}`;

      return {
        type: 'artist',
        source: 'erome',
        artistName: name,
        artistKey: key,
        artistUrl: base,
        scrapedAt: new Date().toISOString()
      };
    }

    return {
      type: 'artist',
      source: host,
      artistName: title || decodeURIComponent(parts[0] || '') || host,
      artistKey: `${host}:${u.pathname.toLowerCase()}`,
      artistUrl: base,
      scrapedAt: new Date().toISOString()
    };
  }

  function getCoomerArtistInfo(rawUrl = location.href, doc = document) {
    const url = new URL(getBaseUrl(rawUrl), location.href);
    const parts = url.pathname.split('/').filter(Boolean);
    const userIndex = parts.findIndex(p => p.toLowerCase() === 'u');

    const service = userIndex >= 0 ? parts[userIndex + 1] || '' : '';
    const username = userIndex >= 0 ? parts[userIndex + 2] || parts[userIndex + 1] || '' : '';

    const titleText = cleanTitle(
      doc.querySelector('h1')?.textContent ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      doc.title ||
      document.title ||
      ''
    );

    return {
      type: 'artist',
      source: 'coomerfans',
      artistName: decodeURIComponent(username || titleText || 'unknown').trim(),
      artistKey: service && username
        ? `${service.toLowerCase()}:${decodeURIComponent(username).toLowerCase()}`
        : url.pathname.toLowerCase(),
      artistUrl: url.toString(),
      scrapedAt: new Date().toISOString()
    };
  }

  /* GENERIC SCRAPER */

  async function gather(targets, artist, onProgress, liveDocForFirst) {
    let done = 0;

    const tasks = targets.map((url, i) => async () => {
      const doc = i === 0 && liveDocForFirst
        ? document
        : await fetchDoc(url);

      if (doc && i === 0 && liveDocForFirst) {
        doc.__uvsRawHtml = document.documentElement?.innerHTML || '';
        doc.__uvsUrl = location.href;
      }

      const vids = doc ? extractVideoUrls(doc, url) : [];
      let entries = await Promise.all(
        vids.map((videoUrl, index) => makeEntryFromVideoUrl(videoUrl, url, index, artist))
      );

      if (!entries.length && artist.source === 'erome') {
        entries = [
          makePageOnlyEntry(
            url,
            artist,
            'No standalone playable MP4/M3U8 URL was found; keep the album page link.'
          )
        ];
      }

      done++;
      onProgress(`${done}/${targets.length} pages`);

      return entries;
    });

    const results = await pool(tasks, FOLLOW_CONCURRENCY);

    return results
      .flat()
      .filter(Boolean)
      .filter(item => item.videoUrl || item.rawVideoUrl || item.postUrl);
  }

  async function scrapeGeneric(onProgress, forceCurrentOnly = false) {
    await waitForPageSettled();
    await lightAutoScroll();

    const site = detectSite();
    const baseUrl = getBaseUrl();
    const artist = getGenericArtistInfo(site, document, baseUrl);

    const liveVids = extractVideoUrls(document, baseUrl);

    let followMode = false;
    let followModeName = 'generic';

    if (!forceCurrentOnly) {
      if (site === 'erome-profile') {
        followMode = true;
        followModeName = 'erome';
      } else if (site === 'erome-album') {
        followMode = false;
      } else if (!liveVids.length) {
        const genericLinks = collectLinksFromDoc(document, baseUrl, 'generic');
        followMode = genericLinks.length > 0;
        followModeName = 'generic';
      }
    }

    let targets = [baseUrl];
    let liveDocForFirst = true;

    if (followMode) {
      onProgress('Finding linked pages...');

      targets = await collectFollowLinks(baseUrl, followModeName, onProgress);

      if (!targets.length) {
        targets = [baseUrl];
        liveDocForFirst = true;
      } else {
        liveDocForFirst = false;
      }
    }

    const entries = await gather(targets, artist, onProgress, liveDocForFirst);

    return shuffle(dedupeEntries(entries));
  }

  /* COOMERFANS SCRAPER */

  function extractVideoPostLinks(doc) {
    const videoLinks = [];

    try {
      for (const post of doc.querySelectorAll('div.post')) {
        if (!post.querySelector('img')) {
          const link = post.querySelector('a.view-post');
          if (link?.href) videoLinks.push(link.href);
        }
      }
    } catch (e) {}

    return videoLinks;
  }

  async function getVideoEntriesFromPost(postUrl, artistInfo) {
    const doc = await fetchDoc(postUrl);
    if (!doc) return [];

    const urls = new Set();
    const body = doc.querySelector('div.post-body') || doc;

    try {
      body.querySelectorAll('video source[src], video[src], a[href]').forEach(el => {
        const raw = el.getAttribute('src') || el.getAttribute('href');
        if (raw && VIDEO_EXT_RE.test(raw)) urls.add(absUrl(raw, postUrl));
      });
    } catch (e) {}

    extractVideoUrls(doc, postUrl).forEach(u => urls.add(u));

    return [...urls].map((videoUrl, index) => ({
      videoUrl,
      rawVideoUrl: videoUrl,
      postUrl,
      postIndex: index,
      artistUrl: artistInfo.artistUrl,
      artistName: artistInfo.artistName,
      artistKey: artistInfo.artistKey,
      source: artistInfo.source,
      scrapedAt: artistInfo.scrapedAt,
      playbackType: PLAYBACK_DIRECT,
      directVideo: DIRECT_EXTERNAL_SAFE,
      externalPlayerSafe: true,
      directVideoStatus: 'assumed_direct',
      diagnostic: ''
    }));
  }

  async function scrapeCoomerfans(onProgress, targetUrl = location.href) {
    const base = getBaseUrl(targetUrl);

    onProgress('Loading page 1...');

    const firstDoc = await fetchDoc(pageUrl(base, 1));
    if (!firstDoc) throw new Error('Failed to load page 1');

    const artistInfo = getCoomerArtistInfo(base, firstDoc);
    const allVideoPostLinks = extractVideoPostLinks(firstDoc);

    if (pageHasNext(firstDoc)) {
      let batchStart = 2;
      const BATCH = 4;

      while (true) {
        const batchNums = Array.from({ length: BATCH }, (_, i) => batchStart + i);

        onProgress(`Scanning pages ${batchStart}-${batchStart + BATCH - 1}...`);

        const batchDocs = await Promise.all(batchNums.map(n => fetchDoc(pageUrl(base, n))));

        let anyContent = false;

        for (const doc of batchDocs) {
          if (!doc) continue;

          if (doc.querySelectorAll('div.post').length > 0) anyContent = true;

          allVideoPostLinks.push(...extractVideoPostLinks(doc));
        }

        if (!anyContent) break;

        batchStart += BATCH;

        if (allVideoPostLinks.length >= MAX_FOLLOW_LINKS) break;
      }
    }

    const uniqueLinks = [...new Set(allVideoPostLinks)].slice(0, MAX_FOLLOW_LINKS);
    const shuffledPostLinks = shuffle(uniqueLinks);

    onProgress(`Found ${shuffledPostLinks.length} posts...`);

    let done = 0;

    const postTasks = shuffledPostLinks.map(link => async () => {
      const vids = await getVideoEntriesFromPost(link, artistInfo);

      done++;
      onProgress(`${done}/${shuffledPostLinks.length} posts`);

      return vids;
    });

    const results = await pool(postTasks, POST_CONCURRENCY);

    return shuffle(dedupeEntries(results.flat()));
  }

  /* DISPATCHER */

  function dedupeEntries(entries) {
    const seen = new Set();
    const out = [];

    for (const item of entries || []) {
      if (!item?.videoUrl && !item?.rawVideoUrl && !item?.postUrl) continue;

      const key = item.videoUrl ||
        (item.rawVideoUrl ? `${item.postUrl || ''}|${item.rawVideoUrl}` : `${item.postUrl || ''}|${item.playbackType || ''}`);

      if (seen.has(key)) continue;

      seen.add(key);
      out.push(item);
    }

    return out;
  }

  async function scrapeJob(onProgress, forceCurrentOnly = false) {
    const site = detectSite();

    if (site === 'coomerfans' && !forceCurrentOnly) {
      return scrapeCoomerfans(onProgress);
    }

    return scrapeGeneric(onProgress, forceCurrentOnly);
  }

  /* EXPORT / CLIPBOARD */

  function formatPongExport(entries) {
    const clean = (entries || []).filter(isExternalPlayableEntry);

    if (!clean.length) return '';

    const f = clean[0];

    const lines = [
      `${PONG_ARTIST_PREFIX}${f.source || 'unknown'}|${f.artistKey || ''}|${f.artistUrl || getBaseUrl()}|${f.artistName || ''}`
    ];

    clean.forEach(e => {
      lines.push(`${PONG_VIDEO_PREFIX}${e.postUrl || ''}|${Number(e.postIndex || 0)}`);
      lines.push(e.videoUrl);
    });

    return lines.join('\n');
  }

  function groupByPostUrl(entries) {
    const groups = new Map();

    for (const e of entries || []) {
      const key = e?.postUrl || '';
      if (!key) continue;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    return groups;
  }

  function formatStructuredExport(entries) {
    const playable = (entries || []).filter(isExternalPlayableEntry);
    const browserRequired = (entries || []).filter(e => e?.playbackType === PLAYBACK_BROWSER_REQUIRED);

    if (playable.length && !browserRequired.length) return formatPongExport(playable);

    const lines = [];

    if (playable.length) {
      lines.push(formatPongExport(playable));
      lines.push('');
    }

    for (const [postUrl, group] of groupByPostUrl(browserRequired)) {
      const first = group[0] || {};
      const rawUrls = [...new Set(group.map(getRawVideoUrl).filter(Boolean))];
      const statuses = [...new Set(group.map(e => e.directVideoStatus).filter(Boolean))];
      const diagnostics = [...new Set(group.map(e => e.diagnostic).filter(Boolean))];

      lines.push(`EROME_PAGE|${postUrl}`);
      lines.push(`PLAYBACK_TYPE|${first.playbackType || PLAYBACK_BROWSER_REQUIRED}`);
      lines.push(`DIRECT_VIDEO|${first.directVideo || DIRECT_NOT_SAFE}`);

      if (statuses.length) lines.push(`DIRECT_STATUS|${statuses.join(',')}`);

      if (rawUrls.length) {
        rawUrls.forEach(raw => lines.push(`RAW_VIDEO|${raw}`));
      } else {
        lines.push('RAW_VIDEO|not_found');
      }

      if (diagnostics.length) lines.push(`DIAGNOSTIC|${diagnostics.join(' ')}`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  function formatPongPasteExport(entries) {
    return formatStructuredExport(entries);
  }

  function formatPlainExport(entries) {
    return (entries || [])
      .filter(isExternalPlayableEntry)
      .map(item => item.videoUrl)
      .join('\n');
  }

  function formatPageLinkExport(entries) {
    const urls = [...new Set(
      (entries || [])
        .map(e => e?.postUrl)
        .filter(Boolean)
    )];

    return urls.join('\n');
  }

  function formatReadableExport(entries) {
    const clean = (entries || []).filter(item => item?.videoUrl || item?.rawVideoUrl || item?.postUrl);

    if (!clean.length) return '';

    return clean.map((e, i) => {
      return [
        `# ${i + 1}`,
        `Page: ${e.postUrl || ''}`,
        `Playback: ${e.playbackType || PLAYBACK_DIRECT}`,
        `External-player safe: ${isExternalPlayableEntry(e) ? 'yes' : 'no'}`,
        `Direct video: ${e.directVideo || (isExternalPlayableEntry(e) ? DIRECT_EXTERNAL_SAFE : DIRECT_NOT_SAFE)}`,
        `Video: ${e.videoUrl || DIRECT_NOT_SAFE}`,
        `Raw video: ${getRawVideoUrl(e) || 'not_found'}`,
        e.directVideoStatus ? `Status: ${e.directVideoStatus}` : '',
        e.diagnostic ? `Diagnostic: ${e.diagnostic}` : ''
      ].filter(Boolean).join('\n');
    }).join('\n\n');
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;

    try {
      if (typeof GM_setClipboard !== 'undefined') {
        GM_setClipboard(text, 'text');
        return true;
      }
    } catch (e) {}

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}

    try {
      const ta = document.createElement('textarea');

      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';

      document.body.appendChild(ta);

      ta.focus();
      ta.select();

      const ok = document.execCommand('copy');

      ta.remove();

      return ok;
    } catch (e) {
      return false;
    }
  }

  async function shareText(text, title = 'Video Scraper Export') {
    if (!text) return false;

    try {
      if (navigator.share) {
        await navigator.share({ title, text });
        return true;
      }
    } catch (e) {}

    return false;
  }

  async function copyOrShareText(text, title = 'Video Scraper Export') {
    const copied = await copyTextToClipboard(text);
    if (copied) return 'copied';

    const shared = await shareText(text, title);
    if (shared) return 'shared';

    return 'failed';
  }

  function closeCurrentTab() {
    try {
      window.opener = null;
    } catch (e) {}

    try {
      window.close();
    } catch (e) {}

    setTimeout(() => {
      try {
        if (!window.closed) {
          window.open('', '_self');
          window.opener = null;
          window.close();
        }
      } catch (e) {}
    }, 100);

    setTimeout(() => {
      if (!window.closed) notify('Browser blocked tab close.');
    }, 700);
  }

  /* ACTIONS */

  async function doScrape(forceCurrentOnly = false) {
    if (busy) {
      notify('Already scraping...');
      return lastResult;
    }

    busy = true;

    const origTitle = document.title;

    notify(forceCurrentOnly ? 'Scraping current page...' : 'Scraping started...');

    try {
      const videos = await scrapeJob(msg => {
        setPanelStatus(msg);

        try {
          document.title = `[UVS] ${msg}`;
        } catch (e) {}
      }, forceCurrentOnly);

      lastResult = videos || [];

      try {
        document.title = origTitle;
      } catch (e) {}

      const playable = countExternalPlayable(lastResult);
      const browserRequired = countBrowserRequired(lastResult);

      if (lastResult.length) {
        notify(`Found ${lastResult.length} entries: ${playable} external-playable, ${browserRequired} browser-required.`);
      } else {
        notify('No videos found.');
      }

      if (COPY_AFTER_SCRAPE && lastResult.length) {
        await doCopyStructured();
      }
    } catch (e) {
      try {
        document.title = origTitle;
      } catch (e2) {}

      console.error(TAG, e);

      notify('Scrape failed: ' + (e.message || e));
    }

    busy = false;

    updatePanelCount();

    return lastResult;
  }

  async function doScrapeCurrentOnly() {
    return doScrape(true);
  }

  async function doCopyStructured() {
    if (!lastResult?.length) {
      notify('Nothing to copy. Run Scrape first.');
      return;
    }

    const text = formatStructuredExport(lastResult);

    if (!text) {
      notify('No structured output available.');
      return;
    }

    const result = await copyOrShareText(text, 'Pong Import');
    const playable = countExternalPlayable(lastResult);
    const browserRequired = countBrowserRequired(lastResult);

    notify(
      result === 'copied'
        ? `Copied structured export: ${playable} playable, ${browserRequired} browser-required.`
        : result === 'shared'
          ? 'Opened Android share sheet for structured export.'
          : 'Copy/share failed.'
    );

    if (result === 'copied' && CLOSE_TAB_AFTER_MANUAL_COPY) {
      setTimeout(() => closeCurrentTab(), CLOSE_DELAY_MS);
    }
  }

  async function doCopyPongPaste() {
    if (!lastResult?.length) {
      notify('Nothing to copy. Run Scrape first.');
      return;
    }

    const text = formatPongPasteExport(lastResult);

    if (!text) {
      notify('No Pong paste output available.');
      return;
    }

    const result = await copyOrShareText(text, 'Pong Import');
    const playable = countExternalPlayable(lastResult);
    const browserRequired = countBrowserRequired(lastResult);

    notify(
      result === 'copied'
        ? `Copied Pong paste text: ${playable} playable, ${browserRequired} browser-required.`
        : result === 'shared'
          ? 'Opened Android share sheet for Pong paste text.'
          : 'Copy/share failed.'
    );
  }

  async function doCopyPlain() {
    if (!lastResult?.length) {
      notify('Nothing to copy. Run Scrape first.');
      return;
    }

    const text = formatPlainExport(lastResult);

    if (!text) {
      notify('No external-playable URLs to copy. Use Page Links or Diagnostics.');
      return;
    }

    const result = await copyOrShareText(text, 'External-Playable Video URLs');
    const count = text.split('\n').filter(Boolean).length;

    notify(
      result === 'copied'
        ? `Copied ${count} external-playable URLs.`
        : result === 'shared'
          ? 'Opened Android share sheet for external-playable URLs.'
          : 'Copy/share failed.'
    );
  }

  async function doCopyPagesOnly() {
    if (!lastResult?.length) {
      notify('Nothing to copy. Run Scrape first.');
      return;
    }

    const text = formatPageLinkExport(lastResult);
    const count = text ? text.split('\n').filter(Boolean).length : 0;
    const result = await copyOrShareText(text, 'Source Page Links');

    notify(
      result === 'copied'
        ? `Copied ${count} source page links.`
        : result === 'shared'
          ? 'Opened Android share sheet for page links.'
          : 'Copy/share failed.'
    );
  }

  async function doCopyReadable() {
    if (!lastResult?.length) {
      notify('Nothing to copy. Run Scrape first.');
      return;
    }

    const result = await copyOrShareText(formatReadableExport(lastResult), 'Video Scraper Diagnostics');

    notify(
      result === 'copied'
        ? 'Copied diagnostic page + raw video list.'
        : result === 'shared'
          ? 'Opened Android share sheet for diagnostics.'
          : 'Copy/share failed.'
    );
  }

  async function doScrapeAndCopy() {
    await doScrape(false);

    if (lastResult?.length) {
      await doCopyPongPaste();
    }
  }

  function addEromeCardVideoUrl(raw, baseUrl, urls, seen) {
    const url = absUrl(raw, baseUrl || location.href);

    if (!url || !VIDEO_EXT_RE.test(url)) return;
    if (!isEromeProtectedCdnVideoUrl(url) && !isEromeHost(url)) return;
    if (seen.has(url)) return;

    seen.add(url);
    urls.push(url);
  }

  function collectEromeVideosFromDocForCardPlayer(doc, baseUrl, urls, seen) {
    if (!doc) return;

    try {
      doc.querySelectorAll('video source[src], video[src]').forEach(el => {
        addEromeCardVideoUrl(el.getAttribute('src'), baseUrl, urls, seen);
        addEromeCardVideoUrl(el.querySelector?.('source[src]')?.getAttribute('src'), baseUrl, urls, seen);
      });
    } catch (e) {}

    extractVideoUrls(doc, baseUrl).forEach(url => {
      addEromeCardVideoUrl(url, baseUrl, urls, seen);
    });
  }

  async function collectEromeVideosForCardPlayer(onProgress) {
    const site = detectSite();
    const baseUrl = getBaseUrl();
    const urls = [];
    const seen = new Set();

    if (site === 'erome-album') {
      collectEromeVideosFromDocForCardPlayer(document, baseUrl, urls, seen);
      return urls;
    }

    if (site !== 'erome-profile') return urls;

    onProgress?.('Finding Erome albums...');

    const targets = await collectFollowLinks(baseUrl, 'erome', msg => onProgress?.(msg));
    const limitedTargets = targets.slice(0, MAX_FOLLOW_LINKS);
    let done = 0;

    const tasks = limitedTargets.map(url => async () => {
      const doc = await fetchDoc(url);
      collectEromeVideosFromDocForCardPlayer(doc, url, urls, seen);
      done++;
      onProgress?.(`${done}/${limitedTargets.length} albums`);
    });

    await pool(tasks, FOLLOW_CONCURRENCY);

    return urls;
  }

  function closeEromePagePlayer() {
    const overlay = document.getElementById('uvs-erome-player');
    const video = overlay?.querySelector('video');

    try {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    } catch (e) {}

    if (overlay) overlay.remove();

    try {
      document.documentElement.classList.remove('uvs-erome-player-open');
      document.body?.classList.remove('uvs-erome-player-open');
    } catch (e) {}
  }

  function formatEromeCardTime(value) {
    const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function getEromeAdaptiveScrubTime(startTime, dx, duration, width) {
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const safeWidth = Math.max(240, width || window.innerWidth || 360);

    if (!safeDuration) return Math.max(0, startTime + dx / 22);

    const dragRatio = dx / safeWidth;
    const secondsPerScreen = Math.min(Math.max(safeDuration * 0.18, 24), 210);

    return Math.max(0, Math.min(safeDuration, startTime + dragRatio * secondsPerScreen));
  }

  async function openEromePagePlayer() {
    const site = detectSite();

    if (site !== 'erome-album' && site !== 'erome-profile') {
      notify('Open an Erome profile or album page first.');
      return;
    }

    if (isEromeGateVisible()) {
      notify('Erome gate is visible. Verify/login on Erome first, then open Player.');
      return;
    }

    const urls = await collectEromeVideosForCardPlayer(msg => setPanelStatus(msg));

    if (!urls.length) {
      notify('No Erome videos found.');
      return;
    }

    closeEromePagePlayer();

    const pageLabel = cleanTitle(
      document.querySelector('h1')?.textContent ||
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      document.title ||
      'Erome'
    );
    const overlay = document.createElement('div');

    overlay.id = 'uvs-erome-player';
    overlay.innerHTML = `
      <button class="uvs-erome-close" type="button" title="Close" aria-label="Close">x</button>
      <div class="uvs-erome-container deck-mode">
        <div class="video-wrapper deck-active" data-index="0" data-ready-playable="false">
          <video class="video-player" playsinline webkit-playsinline preload="metadata"></video>
          <div class="video-loading-indicator"></div>
          <div class="video-ready-loader"><div class="video-ready-percent">0%</div></div>
          <div class="artist-label"></div>
          <div class="video-progress-container">
            <div class="video-progress-bar">
              <div class="video-progress-fill"><div class="scrubber-handle"></div></div>
            </div>
            <div class="video-duration">0:00</div>
          </div>
          <div class="seek-flash left"><span>&lt;&lt; 10s</span></div>
          <div class="seek-flash right"><span>10s &gt;&gt;</span></div>
          <div class="tap-area"></div>
        </div>
        <div class="uvs-erome-status"></div>
      </div>
    `;

    document.body.appendChild(overlay);

    try {
      document.documentElement.classList.add('uvs-erome-player-open');
      document.body?.classList.add('uvs-erome-player-open');
    } catch (e) {}

    const wrapper = overlay.querySelector('.video-wrapper');
    const video = overlay.querySelector('.video-player');
    const tapArea = overlay.querySelector('.tap-area');
    const status = overlay.querySelector('.uvs-erome-status');
    const loadingIndicator = overlay.querySelector('.video-loading-indicator');
    const readyLoader = overlay.querySelector('.video-ready-loader');
    const readyPercent = overlay.querySelector('.video-ready-percent');
    const progressBar = overlay.querySelector('.video-progress-bar');
    const progressFill = overlay.querySelector('.video-progress-fill');
    const scrubberHandle = overlay.querySelector('.scrubber-handle');
    const durationText = overlay.querySelector('.video-duration');
    const artistLabel = overlay.querySelector('.artist-label');
    const leftFlash = overlay.querySelector('.seek-flash.left');
    const rightFlash = overlay.querySelector('.seek-flash.right');
    let index = 0;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let isDragging = false;
    let isDeckSwipe = false;
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTouchAt = 0;
    let flashTimer = null;
    let statusTimer = null;

    function updateLabel() {
      const countText = `${index + 1}/${urls.length}`;

      artistLabel.dataset.artistName = pageLabel;
      artistLabel.textContent = pageLabel ? `${pageLabel}  ${countText}` : countText;
    }

    function showStatus(text, timeout = 1300) {
      clearTimeout(statusTimer);
      status.textContent = text || '';
      status.style.display = text ? 'flex' : 'none';

      if (text && timeout) {
        statusTimer = setTimeout(() => {
          status.textContent = '';
          status.style.display = 'none';
        }, timeout);
      }
    }

    function getReadyPercent() {
      if (video.readyState >= 3) return 100;

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      if (!duration || !video.buffered) return 0;

      let bufferedEnd = 0;

      try {
        for (let i = 0; i < video.buffered.length; i++) {
          bufferedEnd = Math.max(bufferedEnd, video.buffered.end(i));
        }
      } catch (e) {}

      return Math.max(0, Math.min(100, (bufferedEnd / duration) * 100));
    }

    function updateReadyLoader(forceReady = false) {
      const percent = forceReady ? 100 : getReadyPercent();
      const rounded = Math.round(percent);

      wrapper.style.setProperty('--ready-pct', rounded);
      readyPercent.textContent = `${rounded}%`;
      readyPercent.classList.toggle('not-ready', percent < 100);

      if (percent >= 100) {
        wrapper.dataset.readyPlayable = 'true';
        readyLoader.classList.add('ready');
        setTimeout(() => {
          if (readyLoader.classList.contains('ready')) readyLoader.style.display = 'none';
        }, 220);
      } else {
        wrapper.dataset.readyPlayable = 'false';
        readyLoader.style.display = '';
        readyLoader.classList.remove('ready');
      }
    }

    function updateProgress() {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const pct = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;

      progressFill.style.width = `${pct}%`;
      durationText.textContent = duration > 0
        ? `${formatEromeCardTime(current)} / ${formatEromeCardTime(duration)}`
        : '0:00';
    }

    function showFlash(el) {
      el.classList.add('show');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        leftFlash.classList.remove('show');
        rightFlash.classList.remove('show');
      }, 500);
    }

    function setDeckAnimation(direction) {
      wrapper.classList.remove('deck-enter-up', 'deck-enter-down', 'deck-enter-ready');
      void wrapper.offsetWidth;

      if (direction) wrapper.classList.add(`deck-enter-${direction}`);
    }

    function setPlayingUi(playing) {
      wrapper.classList.toggle('video-playing', !!playing);
      loadingIndicator.style.display = playing && video.readyState < 2 ? '' : 'none';
    }

    function playVideoCleanly() {
      if (video.dataset.playRequestPending === 'true') return Promise.resolve();

      video.dataset.playRequestPending = 'true';
      video.muted = false;
      video.volume = 1;
      setPlayingUi(true);

      const playPromise = video.play();

      if (!playPromise || typeof playPromise.catch !== 'function') {
        video.dataset.playRequestPending = 'false';
        return Promise.resolve();
      }

      return playPromise
        .catch(() => {
          setPlayingUi(false);
          showStatus('Tap to play', 0);
        })
        .finally(() => {
          video.dataset.playRequestPending = 'false';
        });
    }

    function show(nextIndex, direction = 'ready', shouldPlay = true) {
      index = (nextIndex + urls.length) % urls.length;
      setDeckAnimation(direction);
      showStatus('');
      setPlayingUi(false);

      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (e) {}

      wrapper.dataset.index = String(index);
      wrapper.dataset.readyPlayable = 'false';
      video.preload = 'auto';
      video.src = urls[index];
      video.currentTime = 0;
      video.load();
      progressFill.style.width = '0';
      durationText.textContent = '0:00';
      readyPercent.textContent = '0%';
      readyLoader.style.display = '';
      readyLoader.classList.remove('ready');
      scrubberHandle.style.display = '';
      updateLabel();
      updateProgress();
      updateReadyLoader(false);

      if (shouldPlay) {
        setTimeout(() => playVideoCleanly(), 40);
      }
    }

    function next() {
      show(index + 1, 'up', true);
    }

    function prev() {
      show(index - 1, 'down', true);
    }

    function scrubTo(clientX) {
      const rect = progressBar.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

      if (video.duration) video.currentTime = pos * video.duration;
      progressFill.style.width = `${pos * 100}%`;
      updateProgress();
    }

    overlay.querySelector('.uvs-erome-close').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      closeEromePagePlayer();
    });

    progressBar.addEventListener('mousedown', e => {
      e.stopPropagation();
      e.preventDefault();
      scrubberHandle.style.display = 'block';
      progressFill.classList.add('active-scrubbing');
      scrubTo(e.clientX);

      const onMove = ev => {
        ev.preventDefault();
        scrubTo(ev.clientX);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        progressFill.classList.remove('active-scrubbing');
        setTimeout(() => {
          if (!progressBar.matches(':hover')) scrubberHandle.style.display = '';
        }, 1500);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    });

    progressBar.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      scrubberHandle.style.display = 'block';
      scrubTo(e.clientX);
      setTimeout(() => {
        if (!progressBar.matches(':hover')) scrubberHandle.style.display = '';
      }, 1500);
    });

    progressBar.addEventListener('mouseenter', () => {
      scrubberHandle.style.display = 'block';
    });

    progressBar.addEventListener('mouseleave', () => {
      if (!progressFill.classList.contains('active-scrubbing')) scrubberHandle.style.display = '';
    });

    progressBar.addEventListener('touchstart', e => {
      e.stopPropagation();
      e.preventDefault();

      if (document.activeElement) document.activeElement.blur();

      progressFill.classList.add('active-scrubbing');
      scrubberHandle.style.display = 'block';
      scrubTo(e.touches[0].clientX);

      const onMove = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        scrubTo(ev.touches[0].clientX);
      };
      const onEnd = () => {
        document.removeEventListener('touchmove', onMove);
        progressFill.classList.remove('active-scrubbing');
        setTimeout(() => {
          scrubberHandle.style.display = '';
        }, 1500);
      };

      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd, { once: true });
    }, { passive: false });

    tapArea.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      isDragging = false;
      isDeckSwipe = false;
    }, { passive: true });

    tapArea.addEventListener('touchmove', e => {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (absY > 28 && absY > absX * 1.05) {
        isDeckSwipe = true;
        isDragging = false;
        e.preventDefault();
        return;
      }

      if (!isDeckSwipe && absX > 8 && absX > absY * 1.05) {
        isDragging = true;

        const newTime = getEromeAdaptiveScrubTime(
          startTime,
          dx,
          video.duration || 0,
          wrapper.offsetWidth
        );

        wrapper.dataset.pendingTime = newTime;

        if (video.duration && !isNaN(newTime)) {
          let previewFill = wrapper.querySelector('.preview-fill');

          if (!previewFill) {
            previewFill = document.createElement('div');
            previewFill.className = 'preview-fill';
            progressBar.appendChild(previewFill);
          }

          previewFill.style.width = `${(newTime / video.duration) * 100}%`;
          scrubberHandle.style.display = 'block';
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
        timeIndicator.textContent = `${dx > 0 ? '>' : '<'} ${formatEromeCardTime(newTime)} / ${formatEromeCardTime(video.duration)}`;
        e.preventDefault();
      }
    }, { passive: false });

    tapArea.addEventListener('touchend', e => {
      lastTouchAt = Date.now();

      if (isDeckSwipe) {
        const endY = e.changedTouches?.[0]?.clientY ?? startY;
        const dy = endY - startY;

        isDeckSwipe = false;
        isDragging = false;

        if (Math.abs(dy) > 24) {
          if (dy < 0) next();
          else prev();

          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      if (isDragging) {
        isDragging = false;

        const pendingTime = parseFloat(wrapper.dataset.pendingTime);

        if (!isNaN(pendingTime) && pendingTime >= 0) {
          video.currentTime = pendingTime;
          updateProgress();
          delete wrapper.dataset.pendingTime;
        }

        const previewFill = wrapper.querySelector('.preview-fill');
        const timeIndicator = wrapper.querySelector('.time-indicator');

        if (previewFill) previewFill.remove();
        if (timeIndicator) {
          timeIndicator.classList.add('fade-out');
          setTimeout(() => {
            timeIndicator.style.display = 'none';
          }, 1000);
        }

        setTimeout(() => {
          scrubberHandle.style.display = '';
        }, 1500);

        e.preventDefault();
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      const tapX = e.changedTouches[0].clientX;
      const isDoubleTap = now - lastTapTime < 300 && Math.abs(tapX - lastTapX) < 80;

      if (isDoubleTap) {
        if (tapX < wrapper.offsetWidth * 0.4) {
          video.currentTime = Math.max(0, (video.currentTime || 0) - 10);
          showFlash(leftFlash);
        } else if (tapX > wrapper.offsetWidth * 0.6) {
          video.currentTime = Math.min(video.duration || 0, (video.currentTime || 0) + 10);
          showFlash(rightFlash);
        }

        lastTapTime = 0;
        updateProgress();
        return;
      }

      lastTapTime = now;
      lastTapX = tapX;

      if (video.paused) playVideoCleanly();
      else video.pause();
    }, { passive: false });

    tapArea.addEventListener('click', e => {
      if (Date.now() - lastTouchAt < 650) return;

      e.preventDefault();
      e.stopPropagation();

      if (video.paused) playVideoCleanly();
      else video.pause();
    });

    video.addEventListener('play', () => setPlayingUi(true));
    video.addEventListener('pause', () => setPlayingUi(false));
    video.addEventListener('waiting', () => {
      loadingIndicator.style.display = 'none';
      updateReadyLoader(false);
    });
    video.addEventListener('progress', () => updateReadyLoader(false));
    video.addEventListener('canplay', () => {
      loadingIndicator.style.display = 'none';
      updateReadyLoader(true);
    });
    video.addEventListener('playing', () => {
      loadingIndicator.style.display = 'none';
      setPlayingUi(true);
      updateReadyLoader(true);
    });
    video.addEventListener('loadedmetadata', () => {
      updateProgress();
      updateReadyLoader(false);
    });
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('ended', next);
    video.addEventListener('error', () => {
      setPlayingUi(false);
      loadingIndicator.style.display = 'none';
      updateReadyLoader(false);
      showStatus('Video did not load in this Erome page context.', 0);
    });

    show(0, 'ready', false);
    setPanelStatus(`${urls.length} Erome videos loaded.`);
    notify(`Opened Erome Player with ${urls.length} videos.`);
  }

  function toggleAuto() {
    const next = !getStoredBool(AUTO_SCRAPE_KEY, false);

    setStoredBool(AUTO_SCRAPE_KEY, next);

    notify(`Auto-scrape on load is now ${next ? 'ON' : 'OFF'}.`);

    updatePanelCount();
  }

  /* FLOATING PANEL */

  function setPanelCollapsed(panel, collapsed) {
    const mini = panel.querySelector('#uvs-mini');

    if (collapsed) {
      panel.classList.add('uvs-collapsed');
      if (mini) mini.textContent = '+';
    } else {
      panel.classList.remove('uvs-collapsed');
      if (mini) mini.textContent = '-';
    }

    setStoredBool(PANEL_COLLAPSED_KEY, collapsed);
  }

  function addPongEromeLauncher() {
    if (document.getElementById('uvs-open-erome')) return;

    const css = `
      #uvs-open-erome {
        background: rgba(91,71,200,0.34) !important;
        border-color: rgba(167,139,250,0.38) !important;
      }

      #uvs-open-erome.uvs-floating-pong-erome {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483647;
        min-height: 38px;
        border: 0;
        border-radius: 8px;
        padding: 0 12px;
        color: #fff;
        font: 700 12px Arial, sans-serif;
        background: rgba(91,71,200,0.88) !important;
        box-shadow: 0 4px 18px rgba(0,0,0,0.45);
      }
    `;

    try {
      if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(css);
      } else {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      }
    } catch (e) {}

    const button = document.createElement('button');

    button.id = 'uvs-open-erome';
    button.type = 'button';
    button.textContent = 'Open Erome';
    button.addEventListener('click', openEromeFromPong);

    const loadButton = document.getElementById('load-videos');

    if (loadButton?.parentNode) {
      loadButton.parentNode.insertBefore(button, loadButton.nextSibling);
    } else {
      button.className = 'uvs-floating-pong-erome';
      document.body.appendChild(button);
    }
  }

  function addFloatingButtons() {
    if (isPongAppPage()) {
      addPongEromeLauncher();
      return;
    }

    if (document.getElementById('uvs-panel')) return;

    const css = `
      #uvs-panel {
        position: fixed;
        z-index: 2147483647;
        right: 12px;
        bottom: 12px;
        width: 206px;
        background: rgba(17, 17, 17, 0.96);
        color: #fff;
        font-family: Arial, sans-serif;
        font-size: 12px;
        line-height: 1.25;
        border-radius: 8px;
        box-shadow: 0 4px 18px rgba(0,0,0,.45);
        padding: 8px;
        box-sizing: border-box;
      }

      #uvs-panel * {
        box-sizing: border-box;
      }

      #uvs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: move;
        user-select: none;
        margin-bottom: 6px;
        font-weight: bold;
        color: #fff;
      }

      #uvs-mini {
        background: #333;
        color: #fff;
        border: 0;
        border-radius: 6px;
        width: 25px;
        height: 22px;
        cursor: pointer;
        font-weight: bold;
      }

      #uvs-panel.uvs-collapsed {
        width: 54px;
        padding: 7px;
      }

      #uvs-panel.uvs-collapsed #uvs-body {
        display: none;
      }

      #uvs-panel.uvs-collapsed #uvs-title {
        display: none;
      }

      #uvs-panel button.uvs-btn {
        width: 100%;
        margin: 3px 0;
        padding: 8px 6px;
        border: 0;
        border-radius: 7px;
        color: #fff;
        font-size: 12px;
        font-weight: bold;
        cursor: pointer;
        background: #2d6cdf;
      }

      #uvs-panel button.uvs-btn:hover {
        filter: brightness(1.12);
      }

      #uvs-panel button.uvs-copy {
        background: #168a3a;
      }

      #uvs-panel button.uvs-page {
        background: #5b47c8;
      }

      #uvs-panel button.uvs-warn {
        background: #8a5a16;
      }

      #uvs-panel button.uvs-close {
        background: #8a1c1c;
      }

      #uvs-status {
        margin-top: 6px;
        color: #ddd;
        min-height: 16px;
        word-break: break-word;
      }

      #uvs-count {
        margin-top: 4px;
        color: #9fe29f;
        font-weight: bold;
      }

      #uvs-note {
        margin-top: 5px;
        color: #aaa;
        font-size: 11px;
      }

      html.uvs-erome-player-open,
      body.uvs-erome-player-open {
        overflow: hidden !important;
        touch-action: none !important;
      }

      #uvs-erome-player {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: #000;
        color: #fff;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        overflow: hidden;
        touch-action: none;
      }

      #uvs-erome-player * {
        box-sizing: border-box;
      }

      #uvs-erome-player .uvs-erome-close {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 50;
        width: 34px;
        height: 34px;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 999px;
        background: rgba(8,12,16,0.42);
        color: rgba(255,255,255,0.72);
        font-size: 18px;
        line-height: 1;
        font-weight: 700;
        cursor: pointer;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      #uvs-erome-player .uvs-erome-container {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
        touch-action: none;
      }

      #uvs-erome-player .video-wrapper {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
        transition: opacity 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
        cursor: pointer;
      }

      #uvs-erome-player .video-wrapper.deck-enter-up {
        animation: uvsDeckEnterUp 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      #uvs-erome-player .video-wrapper.deck-enter-down {
        animation: uvsDeckEnterDown 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      #uvs-erome-player .video-wrapper.deck-enter-ready {
        animation: uvsDeckEnterReady 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      @keyframes uvsDeckEnterUp {
        from { opacity: 0; transform: translate3d(0, 34px, 0) scale(0.992); }
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }

      @keyframes uvsDeckEnterDown {
        from { opacity: 0; transform: translate3d(0, -34px, 0) scale(0.992); }
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }

      @keyframes uvsDeckEnterReady {
        from { opacity: 0; transform: translate3d(0, 12px, 0) scale(0.992); }
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }

      #uvs-erome-player .video-wrapper.video-playing {
        box-shadow: inset 0 0 0 2px rgba(103,232,249,0.38);
      }

      #uvs-erome-player .video-wrapper[data-ready-playable="true"] {
        box-shadow: inset 0 0 0 2px rgba(34,197,94,0.55);
      }

      #uvs-erome-player .video-player {
        width: 100%;
        height: 100%;
        object-fit: contain;
        background: #000;
        outline: none;
        transform: translateZ(0);
        backface-visibility: hidden;
        will-change: transform;
        pointer-events: auto !important;
        -webkit-appearance: none;
        appearance: none;
        cursor: pointer !important;
        touch-action: none !important;
      }

      #uvs-erome-player .tap-area {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 30px;
        z-index: 5;
        background: transparent;
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
        pointer-events: auto;
        user-select: none;
        -webkit-user-select: none;
      }

      #uvs-erome-player .video-wrapper:not(.video-playing) .tap-area::before {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        border-style: solid;
        border-width: 30px 0 30px 50px;
        border-color: transparent transparent transparent rgba(255,255,255,0.6);
        opacity: 0.7;
        z-index: 3;
      }

      #uvs-erome-player .seek-flash {
        position: absolute;
        top: 0;
        bottom: 30px;
        width: 40%;
        z-index: 8;
        pointer-events: none;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.15s;
        background: rgba(255,255,255,0.1);
      }

      #uvs-erome-player .seek-flash.left {
        left: 0;
        border-radius: 0 50% 50% 0;
      }

      #uvs-erome-player .seek-flash.right {
        right: 0;
        border-radius: 50% 0 0 50%;
      }

      #uvs-erome-player .seek-flash.show {
        opacity: 1;
      }

      #uvs-erome-player .seek-flash span {
        color: #fff;
        font-size: 20px;
        font-weight: 700;
        text-shadow: 0 0 8px rgba(0,0,0,0.9);
      }

      #uvs-erome-player .video-progress-container {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 30px;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        z-index: 20;
        opacity: 1;
        pointer-events: auto;
        background: linear-gradient(to top, rgba(0,0,0,0.6), transparent);
        padding: 5px 0;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }

      #uvs-erome-player .video-progress-bar {
        width: 100%;
        height: 8px;
        background: rgba(255,255,255,0.3);
        border-radius: 4px;
        overflow: visible;
        cursor: pointer;
        position: relative;
        margin-bottom: 2px;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }

      #uvs-erome-player .video-progress-fill {
        height: 100%;
        width: 0;
        background: #67e8f9;
        border-radius: 5px;
        transition: width 0.1s linear;
        position: relative;
        will-change: width;
        z-index: 1;
      }

      #uvs-erome-player .video-progress-fill.active-scrubbing {
        transition: none;
        background: #a7f3d0;
      }

      #uvs-erome-player .scrubber-handle {
        position: absolute;
        right: -8px;
        top: -4px;
        width: 16px;
        height: 16px;
        background: #67e8f9;
        border-radius: 50%;
        box-shadow: 0 0 6px rgba(0,0,0,0.7);
        display: none;
        pointer-events: none;
        z-index: 5;
      }

      #uvs-erome-player .preview-fill {
        position: absolute;
        height: 100%;
        width: 0;
        background: rgba(103,232,249,0.34);
        border-radius: 5px;
        top: 0;
        left: 0;
        z-index: 0;
        pointer-events: none;
      }

      #uvs-erome-player .video-duration {
        color: #fff;
        font-size: 12px;
        text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
        text-align: right;
        padding-right: 5px;
      }

      #uvs-erome-player .artist-label {
        position: absolute;
        left: 50%;
        bottom: 36px;
        transform: translateX(-50%);
        max-width: min(66vw, 280px);
        padding: 2px 7px;
        border-radius: 999px;
        background: rgba(8,12,16,0.34);
        color: rgba(255,255,255,0.58);
        border: 1px solid rgba(255,255,255,0.08);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        font-size: 9px;
        line-height: 1.2;
        font-weight: 600;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        z-index: 22;
        pointer-events: none;
        text-shadow: 0 1px 2px rgba(0,0,0,0.55);
      }

      #uvs-erome-player .video-ready-loader {
        position: absolute;
        left: 50%;
        top: calc(50% + 42px);
        transform: translate(-50%,-50%);
        z-index: 24;
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        opacity: 0.84;
        transition: opacity 0.18s ease, transform 0.18s ease;
      }

      #uvs-erome-player .video-ready-loader.ready {
        opacity: 0;
        transform: translate(-50%,-50%) scale(0.9);
      }

      #uvs-erome-player .video-ready-percent {
        min-width: 24px;
        text-align: center;
        font-size: 9px;
        line-height: 1;
        color: rgba(255,255,255,0.66);
        background: rgba(8,12,16,0.32);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 999px;
        padding: 2px 4px;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      #uvs-erome-player .video-ready-percent.not-ready {
        color: rgba(255,255,255,0.92);
        background: rgba(239,68,68,0.58);
        border-color: rgba(248,113,113,0.68);
        box-shadow: 0 0 12px rgba(239,68,68,0.28);
      }

      #uvs-erome-player .video-loading-indicator {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 36px;
        height: 36px;
        margin: -18px 0 0 -18px;
        border: 3px solid rgba(255,255,255,0.25);
        border-top-color: #67e8f9;
        border-radius: 50%;
        animation: uvsEromeSpin 0.9s linear infinite;
        display: none;
        z-index: 23;
        pointer-events: none;
      }

      @keyframes uvsEromeSpin {
        to { transform: rotate(360deg); }
      }

      #uvs-erome-player .time-indicator,
      #uvs-erome-player .uvs-erome-status {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 30;
        min-width: 128px;
        min-height: 42px;
        padding: 8px 12px;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: rgba(8,12,16,0.64);
        border: 1px solid rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.86);
        font-size: 13px;
        font-weight: 700;
        text-align: center;
        pointer-events: none;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        text-shadow: 0 1px 2px rgba(0,0,0,0.65);
      }

      #uvs-erome-player .time-indicator.fade-out {
        opacity: 0 !important;
        transition: opacity 0.35s ease;
      }

      #uvs-erome-player .uvs-erome-status {
        display: none;
        max-width: 80vw;
      }
    `;

    try {
      if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(css);
      } else {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      }
    } catch (e) {}

    const panel = document.createElement('div');
    const site = detectSite();
    const isEromePage = site === 'erome-album' || site === 'erome-profile';
    const panelButtons = isEromePage
      ? `
        <button id="uvs-erome-play" class="uvs-btn uvs-copy">Player</button>
        <button id="uvs-copy-pages" class="uvs-btn uvs-page">Copy Page Links</button>
      `
      : `
        <button id="uvs-scrape-copy" class="uvs-btn uvs-copy">Scrape + Copy</button>
        <button id="uvs-copy-pong" class="uvs-btn uvs-copy">Copy Last</button>
      `;

    panel.id = 'uvs-panel';

    panel.innerHTML = `
      <div id="uvs-header">
        <span id="uvs-title">${isEromePage ? 'Erome' : 'Video Scraper'}</span>
        <button id="uvs-mini" title="Minimize / Expand">+</button>
      </div>

      <div id="uvs-body">
        ${panelButtons}

        <div id="uvs-count">0 playable / 0 entries</div>
        <div id="uvs-status">Ready</div>
        <div id="uvs-note">${isEromePage ? 'Swipe up/down. Tap to play.' : 'For Coomer/direct links.'}</div>
      </div>
    `;

    document.body.appendChild(panel);

    panelStatusEl = panel.querySelector('#uvs-status');

    const savedPos = getStoredJson(PANEL_POS_KEY, null);

    if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
      panel.style.left = `${savedPos.left}px`;
      panel.style.top = `${savedPos.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    panel.querySelector('#uvs-scrape')?.addEventListener('click', () => doScrape(false));
    panel.querySelector('#uvs-current')?.addEventListener('click', () => doScrapeCurrentOnly());
    panel.querySelector('#uvs-erome-play')?.addEventListener('click', () => openEromePagePlayer());

    panel.querySelector('#uvs-copy')?.addEventListener('click', () => doCopyStructured());
    panel.querySelector('#uvs-copy-pong')?.addEventListener('click', () => doCopyPongPaste());
    panel.querySelector('#uvs-copy-plain')?.addEventListener('click', () => doCopyPlain());
    panel.querySelector('#uvs-copy-pages')?.addEventListener('click', () => doCopyPagesOnly());
    panel.querySelector('#uvs-copy-readable')?.addEventListener('click', () => doCopyReadable());

    panel.querySelector('#uvs-scrape-copy')?.addEventListener('click', () => doScrapeAndCopy());
    panel.querySelector('#uvs-auto')?.addEventListener('click', () => toggleAuto());
    panel.querySelector('#uvs-close')?.addEventListener('click', () => closeCurrentTab());

    panel.querySelector('#uvs-mini').addEventListener('click', e => {
      e.stopPropagation();

      const collapsed = !panel.classList.contains('uvs-collapsed');

      setPanelCollapsed(panel, collapsed);
    });

    makePanelDraggable(panel, panel.querySelector('#uvs-header'));

    // Erome needs the Player button visible; other sites keep the remembered state.
    setPanelCollapsed(panel, isEromePage ? false : getStoredBool(PANEL_COLLAPSED_KEY, true));

    updatePanelCount();
  }

  function updatePanelCount() {
    try {
      const count = document.getElementById('uvs-count');
      const auto = document.getElementById('uvs-auto');

      if (count) {
        count.textContent = `${countExternalPlayable(lastResult)} playable / ${lastResult?.length || 0} entries`;
      }

      if (auto) {
        auto.textContent = `Auto: ${getStoredBool(AUTO_SCRAPE_KEY, false) ? 'ON' : 'OFF'}`;
      }
    } catch (e) {}
  }

  function makePanelDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function getPoint(e) {
      const t = e.touches?.[0] || e.changedTouches?.[0];

      return {
        x: t ? t.clientX : e.clientX,
        y: t ? t.clientY : e.clientY
      };
    }

    function down(e) {
      if (e.target?.id === 'uvs-mini') return;

      const p = getPoint(e);
      const rect = panel.getBoundingClientRect();

      dragging = true;
      startX = p.x;
      startY = p.y;
      startLeft = rect.left;
      startTop = rect.top;

      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';

      e.preventDefault();
    }

    function move(e) {
      if (!dragging) return;

      const p = getPoint(e);

      let left = startLeft + (p.x - startX);
      let top = startTop + (p.y - startY);

      const rect = panel.getBoundingClientRect();

      left = Math.max(0, Math.min(window.innerWidth - rect.width, left));
      top = Math.max(0, Math.min(window.innerHeight - rect.height, top));

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;

      e.preventDefault();
    }

    function up() {
      if (!dragging) return;

      dragging = false;

      const rect = panel.getBoundingClientRect();

      setStoredJson(PANEL_POS_KEY, {
        left: rect.left,
        top: rect.top
      });
    }

    handle.addEventListener('mousedown', down);
    handle.addEventListener('touchstart', down, { passive: false });

    window.addEventListener('mousemove', move, true);
    window.addEventListener('touchmove', move, { passive: false, capture: true });

    window.addEventListener('mouseup', up, true);
    window.addEventListener('touchend', up, true);
  }

  /* WIRING */

  try {
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('Scrape videos', () => doScrape(false));
      GM_registerMenuCommand('Scrape current page only', () => doScrapeCurrentOnly());
      GM_registerMenuCommand('Open Erome card player', () => openEromePagePlayer());
      GM_registerMenuCommand('Open Erome from Pong', () => openEromeFromPong());

      GM_registerMenuCommand('Copy Pong paste text', () => doCopyPongPaste());
      GM_registerMenuCommand('Copy structured', () => doCopyStructured());
      GM_registerMenuCommand('Copy external-playable URLs only', () => doCopyPlain());
      GM_registerMenuCommand('Copy source page links', () => doCopyPagesOnly());
      GM_registerMenuCommand('Copy diagnostic page + raw video list', () => doCopyReadable());

      GM_registerMenuCommand('Scrape + copy Pong paste text', () => doScrapeAndCopy());
      GM_registerMenuCommand('Close tab', () => closeCurrentTab());
      GM_registerMenuCommand('Toggle auto-scrape', () => toggleAuto());
    }
  } catch (e) {
    console.error(TAG, 'Menu registration failed:', e);
  }

  window.addEventListener('keydown', e => {
    if (!e.altKey || !e.shiftKey) return;

    const k = (e.key || '').toLowerCase();

    if (k === 's') {
      e.preventDefault();
      doScrape(false);
    } else if (k === 'c') {
      e.preventDefault();
      doCopyStructured();
    } else if (k === 'x') {
      e.preventDefault();
      closeCurrentTab();
    }
  }, true);

  const apiWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  apiWindow.UniversalVideoScraper = {
    scrape: () => doScrape(false),
    scrapeCurrentOnly: () => doScrapeCurrentOnly(),

    copyStructured: doCopyStructured,
    copyPongPaste: doCopyPongPaste,
    copyExternalPlayable: doCopyPlain,
    copyPlain: doCopyPlain,
    copyPagesOnly: doCopyPagesOnly,
    copyDiagnostics: doCopyReadable,
    copyReadable: doCopyReadable,

    scrapeAndCopy: doScrapeAndCopy,
    openEromePagePlayer,
    openEromeFromPong,

    extractVideoUrls: (doc = document) => extractVideoUrls(doc, getBaseUrl()),

    formatPongExport,
    formatPongPasteExport,
    formatStructuredExport,
    formatPlainExport,
    formatPageLinkExport,
    formatReadableExport,

    get last() {
      return lastResult;
    }
  };

  if (document.body) {
    addFloatingButtons();
  } else {
    window.addEventListener('DOMContentLoaded', addFloatingButtons, { once: true });
  }

  log('Universal Video Scraper v7.8.1 loaded on', location.href);

  if (getStoredBool(AUTO_SCRAPE_KEY, false)) {
    setTimeout(() => doScrape(false), 800);
  }
})();
