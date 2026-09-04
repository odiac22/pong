// ==UserScript==
// @name         Pong SimpCity AI Scraper
// @namespace    https://odiac22.github.io/pong/
// @version      1.12.5
// @description  Streams direct creator handles immediately, then uses local AI only for ambiguous SimpCity post text.
// @match        https://simpcity.cr/threads/*
// @match        https://www.simpcity.cr/threads/*
// @match        https://simpcity.cr/tags/*
// @match        https://www.simpcity.cr/tags/*
// @match        https://simpcity.cr/search/*
// @match        https://www.simpcity.cr/search/*
// @match        https://simpcity.cr/forums/*
// @match        https://www.simpcity.cr/forums/*
// @match        https://simpcity.cr/*
// @match        https://www.simpcity.cr/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_cookie
// @grant        GM.cookie
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @connect      127.0.0.1
// @connect      192.168.1.124
// @connect      *
// @downloadURL  https://odiac22.github.io/pong/pong-simpcity.user.js
// @updateURL    https://odiac22.github.io/pong/pong-simpcity.user.js
// ==/UserScript==

(() => {
  'use strict';
  if (!/(?:^|\.)simpcity\.cr$/i.test(location.hostname) || !/^\/(?:threads|tags|search|forums)\//i.test(location.pathname)) return;

  const PAGE_CONCURRENCY = 2;
  const SCRIPT_VERSION = '1.12.1';
  const FORUM_CREATOR_CONCURRENCY = 2;
  // Use a conservative source pace. The PC worker still delegates
  // to the server's shared adaptive limiter, so both Recall channels remain
  // globally coordinated and back off on 403/429 responses.
  const SIMPCITY_REQUEST_GAP_MS = 1200;
  const SIMPCITY_RATE_LIMIT_PAUSE_MS = 60_000;
  const AI_BATCH_SIZE = 10;
  const AI_CONCURRENCY = 2;
  const MAX_LINKED_THREADS = 24;
  const MAX_LINKED_THREAD_DEPTH = 2;
  const MAX_LINKED_THREAD_PAGES = 40;
  const endpoints = Array.isArray(globalThis.PONG_LOCAL_ENDPOINTS)
    ? globalThis.PONG_LOCAL_ENDPOINTS
    : ['http://192.168.1.124:8787', 'http://127.0.0.1:8787'];
  const monthDate = /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\s*$/i;
  let diagnosticSink = () => {};
  let simpCityNextRequestAt = 0;
  let simpCityRateLimitUntil = 0;
  const diagnostic = (message, details = '') => {
    try { diagnosticSink(message, details); } catch (_) {}
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  const paceSimpCityRequest = async () => {
    if (globalThis.PONG_PC_BACKGROUND_CONTEXT) {
      try {
        const permit = await sendToPong('/simpcity/source/permit', {
          channel: Number(globalThis.PONG_SIMPCITY_CHANNEL || 1)
        }, 10000);
        if (Number(permit?.waitMs) > 0) await delay(Number(permit.waitMs));
        return;
      } catch (error) {
        diagnostic('Shared PC pacing unavailable; using local pacing', error?.message || String(error));
      }
    }
    const now = Date.now();
    const slot = Math.max(now, simpCityNextRequestAt, simpCityRateLimitUntil);
    simpCityNextRequestAt = slot + SIMPCITY_REQUEST_GAP_MS + Math.floor(Math.random() * 200);
    if (slot > now) await delay(slot - now);
  };
  const waitForDiscoveryCapacity = async channel => {
    // Artist Lookup channel 3 is browser-driven but must still honor Pong's
    // five-artist unseen buffer. Recall 1/2 browser runs retain their legacy
    // behavior; PC background runs continue using the shared permit.
    if (!globalThis.PONG_PC_BACKGROUND_CONTEXT && Number(channel) !== 3) return;
    while (true) {
      const permit = await sendToPong('/simpcity/discovery/permit', { channel }, 10000);
      const unseen = Math.max(0, Number(permit?.unseen || 0));
      // Enforce five client-side too so the active queue adopts the new cap
      // without requiring a server restart that would discard queued names.
      if (!permit?.paused && unseen < 5) return;
      diagnostic('Discovery paused', `${permit.unseen} unseen profiles ready in Pong ${channel}`);
      await delay(Math.max(500, Number(permit.waitMs || 1000)));
    }
  };
  const noteSimpCityRateLimit = error => {
    const message = error?.message || String(error || '');
    if (!/HTTP\s*(?:403|429)|rate.?limit|too many requests/i.test(message)) return false;
    simpCityRateLimitUntil = Math.max(simpCityRateLimitUntil, Date.now() + SIMPCITY_RATE_LIMIT_PAUSE_MS);
    diagnostic('SimpCity rate limit detected', `pause=${SIMPCITY_RATE_LIMIT_PAUSE_MS}ms; ${message}`);
    if (globalThis.PONG_PC_BACKGROUND_CONTEXT) {
      void sendToPong('/simpcity/source/rate-limit', {
        durationMs: SIMPCITY_RATE_LIMIT_PAUSE_MS
      }, 10000).catch(() => {});
    }
    return true;
  };

  const terminalPongServerError = error => {
    if (error?.status === 409) return true;
    if (!error?.serverResponse) return false;
    return ![408, 429, 502, 503, 504].includes(Number(error.status || 0));
  };

  const sendToPong = async (pathname, payload, timeout = 90000) => {
    let lastError = '';
    diagnostic('API request started', `POST ${pathname}; timeout=${timeout}ms; endpoints=${endpoints.join(', ')}`);
    for (const endpoint of endpoints) {
      for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const modernRequest = globalThis.GM?.xmlHttpRequest;
        const legacyRequest = globalThis.GM_xmlhttpRequest;
        const request = typeof modernRequest === 'function'
          ? modernRequest.bind(globalThis.GM)
          : typeof legacyRequest === 'function'
            ? legacyRequest
            : null;
        if (!request) throw new Error('Tampermonkey network permission is unavailable');
        diagnostic('Tampermonkey request attempt', `${endpoint}${pathname}; attempt ${attempt}/4`);
        return await new Promise((resolve, reject) => {
          request({
            method: 'POST', url: `${endpoint}${pathname}`,
            headers: {
              'Content-Type': 'application/json',
              'X-Pong-SimpCity-Controller': '1'
            },
            data: JSON.stringify(payload), timeout,
            onload: response => {
              let data = {};
              try { data = JSON.parse(response.responseText || '{}'); } catch (_) {}
              const successful = response.status >= 200 && response.status < 300 && data.ok !== false;
              diagnostic('Tampermonkey response', `${endpoint}${pathname}; HTTP ${response.status}; ok=${successful}`);
              if (successful) resolve(data);
              else {
                const error = new Error(data.error || `HTTP ${response.status}`);
                error.status = response.status;
                error.serverResponse = Boolean(data.error);
                reject(error);
              }
            },
            onerror: response => {
              diagnostic('Tampermonkey connection error', `${endpoint}${pathname}; ${response?.error || 'no detail'}`);
              reject(new Error(`connection failed${response?.error ? `: ${response.error}` : ''}`));
            },
            ontimeout: () => {
              diagnostic('Tampermonkey timeout', `${endpoint}${pathname}; ${timeout}ms`);
              reject(new Error('connection timed out'));
            }
          });
        });
      } catch (error) {
        if (terminalPongServerError(error)) throw error;
        lastError = error?.message || String(error);
        diagnostic('Tampermonkey attempt failed', `${endpoint}${pathname}; ${lastError}`);
      }
      try {
        diagnostic('Browser fetch fallback attempt', `${endpoint}${pathname}; attempt ${attempt}/4`);
        const response = await fetch(`${endpoint}${pathname}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Pong-SimpCity-Controller': '1'
          },
          body: JSON.stringify(payload),
          cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        diagnostic('Browser fetch response', `${endpoint}${pathname}; HTTP ${response.status}; ok=${data.ok !== false}`);
        if (response.ok && data.ok !== false) return data;
        const responseError = new Error(data.error || `HTTP ${response.status}`);
        responseError.status = response.status;
        responseError.serverResponse = Boolean(data.error);
        if (terminalPongServerError(responseError)) throw responseError;
        lastError = responseError.message;
      } catch (error) {
        if (terminalPongServerError(error)) throw error;
        lastError = `${lastError}; fetch ${error?.message || error}`;
        diagnostic('Browser fetch failed', `${endpoint}${pathname}; ${error?.message || error}`);
      }
      if (attempt < 4) {
        diagnostic('Retry scheduled', `${endpoint}${pathname}; wait=${600 * attempt}ms`);
        await new Promise(resolve => setTimeout(resolve, 600 * attempt));
      }
      }
    }
    diagnostic('API request exhausted', `${pathname}; ${lastError || 'server not reachable'}`);
    throw new Error(`PC AI unavailable: ${lastError || 'server not reachable'}`);
  };

  const getFromPong = async (pathname, timeout = 12000) => {
    let lastError = '';
    for (const endpoint of endpoints) {
      try {
        const modernRequest = globalThis.GM?.xmlHttpRequest;
        const legacyRequest = globalThis.GM_xmlhttpRequest;
        const request = typeof modernRequest === 'function'
          ? modernRequest.bind(globalThis.GM)
          : typeof legacyRequest === 'function'
            ? legacyRequest
            : null;
        if (!request) throw new Error('Tampermonkey network permission is unavailable');
        return await new Promise((resolve, reject) => request({
          method: 'GET',
          url: `${endpoint}${pathname}`,
          headers: { 'X-Pong-SimpCity-Controller': '1' },
          timeout,
          onload: response => {
            let data = {};
            try { data = JSON.parse(response.responseText || '{}'); } catch (_) {}
            if (response.status >= 200 && response.status < 300 && data.ok !== false) resolve(data);
            else reject(new Error(data.error || `HTTP ${response.status}`));
          },
          onerror: response => reject(new Error(response?.error || 'connection failed')),
          ontimeout: () => reject(new Error('connection timed out'))
        }));
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
    throw new Error(lastError || 'PC server not reachable');
  };

  const absoluteUrl = (raw, base) => {
    try { return new URL(raw, base).href; } catch (_) { return ''; }
  };

  const readSimpCitySessionCookies = async () => {
    try {
      if (globalThis.GM?.cookie?.list) {
        return await globalThis.GM.cookie.list({ url: location.href });
      }
      if (globalThis.GM_cookie?.list) {
        return await new Promise((resolve, reject) => {
          globalThis.GM_cookie.list({ url: location.href }, (cookies, error) => {
            if (error) reject(new Error(error));
            else resolve(cookies || []);
          });
        });
      }
    } catch (_) {}
    return [];
  };
  const hasSimpCityLoginCookie = cookies => (cookies || []).some(cookie =>
    /(?:^|_)(?:user|member)$/i.test(String(cookie?.name || ''))
  );
  const canonicalSimpCityThreadUrl = raw => {
    try {
      const url = new URL(raw, location.href);
      if (!/(?:^|\.)simpcity\.cr$/i.test(url.hostname)) return '';
      const match = url.pathname.match(/^\/threads\/([^/?#]+)/i);
      if (!match) return '';
      url.protocol = 'https:';
      url.hostname = 'simpcity.cr';
      url.pathname = `/threads/${match[1]}/`;
      url.search = '';
      url.searchParams.set('order', 'reaction_score');
      url.hash = '';
      return url.toString();
    } catch (_) { return ''; }
  };
  const canonicalSimpCityListingUrl = raw => {
    try {
      const url = new URL(raw, location.href);
      if (!/(?:^|\.)simpcity\.cr$/i.test(url.hostname) || !/^\/(?:tags|search|forums)\//i.test(url.pathname)) return '';
      url.protocol = 'https:';
      url.hostname = 'simpcity.cr';
      url.pathname = url.pathname.replace(/\/page-\d+\/?$/i, '/');
      url.searchParams.delete('page');
      url.hash = '';
      return url.toString();
    } catch (_) { return ''; }
  };
  const fileLabel = raw => {
    try { return decodeURIComponent(new URL(raw, location.href).pathname.split('/').filter(Boolean).at(-1) || ''); }
    catch (_) { return ''; }
  };
  const uniqueObjects = (items, keyFn) => [...new Map(items.filter(Boolean).map(item => [keyFn(item), item])).values()];

  const userscriptRequest = options => new Promise((resolve, reject) => {
    const modernRequest = globalThis.GM?.xmlHttpRequest;
    const legacyRequest = globalThis.GM_xmlhttpRequest;
    const request = typeof modernRequest === 'function'
      ? modernRequest.bind(globalThis.GM)
      : typeof legacyRequest === 'function'
        ? legacyRequest
        : null;
    if (!request) return reject(new Error('Tampermonkey request API unavailable'));
    request({
      ...options,
      onload: response => response.status >= 200 && response.status < 300
        ? resolve(response)
        : reject(new Error(`HTTP ${response.status}`)),
      onerror: response => reject(new Error(response?.error || 'connection failed')),
      ontimeout: () => reject(new Error('connection timed out'))
    });
  });

  async function fetchSimpCityPage(url, pageNumber) {
    let lastError = '';
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        // Tampermonkey owns this request outside the page lifecycle, so work
        // is much less likely to stall when Firefox is backgrounded on Android.
        await paceSimpCityRequest();
        const response = await userscriptRequest({
          method: 'GET', url, timeout: 30000, anonymous: false,
          headers: { Accept: 'text/html,application/xhtml+xml' }
        });
        const html = String(response.responseText || '');
        if (!/<(?:article|div)\b[^>]*class=["'][^"']*\bmessage\b/i.test(html)) {
          throw new Error('page contained no posts');
        }
        return html;
      } catch (userscriptError) {
        lastError = userscriptError?.message || String(userscriptError);
        if (noteSimpCityRateLimit(userscriptError)) continue;
      }
      try {
        await paceSimpCityRequest();
        const response = await fetch(url, {
          credentials: 'include', cache: 'no-store', redirect: 'follow'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (!/<(?:article|div)\b[^>]*class=["'][^"']*\bmessage\b/i.test(html)) {
          throw new Error('page contained no posts');
        }
        return html;
      } catch (nativeError) {
        lastError = `${lastError}; ${nativeError?.message || nativeError}`;
        noteSimpCityRateLimit(nativeError);
      }
      await delay(1000 * attempt);
    }
    throw new Error(`page ${pageNumber} failed after retries: ${lastError}`);
  }

  async function fetchSimpCityListingPage(url, pageNumber) {
    let lastError = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await paceSimpCityRequest();
        const response = await userscriptRequest({
          method: 'GET', url, timeout: 30000, anonymous: false,
          headers: { Accept: 'text/html,application/xhtml+xml' }
        });
        const html = String(response.responseText || '');
        if (!/href=["'][^"']*\/threads\//i.test(html)) throw new Error('page contained no thread results');
        return { html, url: String(response.finalUrl || url) };
      } catch (error) {
        lastError = error?.message || String(error);
        if (noteSimpCityRateLimit(error)) continue;
      }
      try {
        await paceSimpCityRequest();
        const response = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (!/href=["'][^"']*\/threads\//i.test(html)) throw new Error('page contained no thread results');
        return { html, url: String(response.url || url) };
      } catch (error) {
        lastError = `${lastError}; ${error?.message || error}`;
        noteSimpCityRateLimit(error);
      }
      await delay(1000 * attempt);
    }
    throw new Error(`search page ${pageNumber} failed: ${lastError}`);
  }

  const listingThreadUrls = (html, baseUrl) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const threads = [];
    const seen = new Set();
    // XenForo result titles are the authoritative visible ordering. Restrict
    // forum/search scans to those rows so sidebar/recent-thread links cannot
    // jump ahead of the first creator in the listing.
    const resultAnchors = doc.querySelectorAll(
      '.structItem-title a[href*="/threads/"], .contentRow-title a[href*="/threads/"], h3.contentRow-title a[href*="/threads/"]'
    );
    const anchors = resultAnchors.length
      ? resultAnchors
      : doc.querySelectorAll('main a[href*="/threads/"], .p-body-main a[href*="/threads/"]');
    for (const anchor of anchors) {
      const threadUrl = canonicalSimpCityThreadUrl(absoluteUrl(anchor.getAttribute('href'), baseUrl));
      if (!threadUrl || seen.has(threadUrl)) continue;
      const slug = decodeURIComponent(new URL(threadUrl).pathname.split('/').filter(Boolean)[1] || '');
      if (/\b(?:rules?|guidelines?|who-is-this|request|posting-etiquette|community-rules|help)\b/i.test(slug)) continue;
      seen.add(threadUrl);
      threads.push(threadUrl);
    }
    return threads;
  };

  const listingPageCount = html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pages = [1];
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') || '';
      const value = Number(href.match(/\/page-(\d+)/i)?.[1] || href.match(/[?&]page=(\d+)/i)?.[1] || 0);
      if (value > 0) pages.push(value);
    }
    return Math.max(...pages);
  };

  const listingPageUrl = (rootUrl, page) => {
    const url = new URL(rootUrl);
    if (/^\/search\//i.test(url.pathname)) {
      if (page > 1) url.searchParams.set('page', String(page));
      else url.searchParams.delete('page');
    } else if (page > 1) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/page-${page}`;
    }
    return url.toString();
  };

  const listingPageIdentity = raw => {
    try {
      const url = new URL(raw, location.href);
      url.protocol = 'https:';
      url.hostname = 'simpcity.cr';
      url.hash = '';
      url.searchParams.sort();
      return url.toString();
    } catch (_) { return ''; }
  };

  const listingPageNumber = raw => {
    try {
      const url = new URL(raw, location.href);
      return Number(url.searchParams.get('page') || url.pathname.match(/\/page-(\d+)/i)?.[1] || 1);
    } catch (_) { return 1; }
  };

  const listingContinuationUrls = (html, baseUrl, rootUrl) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const currentSearch = new URL(baseUrl, rootUrl);
    const currentPage = listingPageNumber(baseUrl);
    const candidates = new Map();
    // XenForo search pages show only a small numbered window and then a
    // "View older posts" continuation. Follow the site's href until it ends.
    const anchors = doc.querySelectorAll(
      '.pageNavWrapper a[href], .pageNav a[href], a.pageNav-jump[href], a[rel="next"][href], a[href]'
    );
    for (const anchor of anchors) {
      const label = String(anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '').trim();
      const inPager = Boolean(anchor.closest?.('.pageNavWrapper,.pageNav')) ||
        anchor.matches?.('a.pageNav-jump,a[rel="next"]');
      const isOlder = /\b(?:view\s+)?older\s+(?:posts?|results?)\b/i.test(label);
      if (!inPager && !isOlder) continue;
      let candidate;
      try { candidate = new URL(anchor.getAttribute('href'), baseUrl); }
      catch (_) { continue; }
      if (!/(?:^|\.)simpcity\.cr$/i.test(candidate.hostname) || !/^\/search\//i.test(candidate.pathname)) continue;
      // "View older posts" creates a new /search/{id}/ window. Its numbered
      // pages must be compared with that current window, not the original ID.
      const sameSearch = candidate.pathname.replace(/\/$/, '') === currentSearch.pathname.replace(/\/$/, '');
      const candidatePage = listingPageNumber(candidate.href);
      if (!isOlder && (!sameSearch || candidatePage <= currentPage)) continue;
      candidate.protocol = 'https:';
      candidate.hostname = 'simpcity.cr';
      candidate.hash = '';
      const identity = listingPageIdentity(candidate.href);
      if (identity) candidates.set(identity, candidate.href);
    }
    return [...candidates.values()].sort((left, right) => listingPageNumber(left) - listingPageNumber(right));
  };

  function extractPostPayloads(html, pageNumber, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let articles = [...doc.querySelectorAll('article.message')];
    if (!articles.length) articles = [...doc.querySelectorAll('.message')];
    return articles.map((article, index) => {
      const body = article.querySelector('.message-body .bbWrapper, .message-body, .bbWrapper');
      if (!body) return null;
      const clone = body.cloneNode(true);
      clone.querySelectorAll('blockquote,.bbCodeBlock--quote,.message-signature,.message-footer,.reactionsBar,button,script,style').forEach(node => node.remove());
      const links = [...clone.querySelectorAll('a[href]')].flatMap(anchor => {
        const text = String(anchor.textContent || anchor.title || '').trim().slice(0, 240);
        const pending = [anchor.getAttribute('href'), anchor.dataset?.url, anchor.dataset?.href, anchor.getAttribute('data-target'), anchor.outerHTML];
        const found = [];
        const seen = new Set();
        while (pending.length && found.length < 12) {
          const raw = String(pending.shift() || '').replace(/&amp;/gi, '&').trim();
          if (!raw || seen.has(raw)) continue;
          seen.add(raw);
          let decoded = raw;
          try { decoded = decodeURIComponent(raw.replace(/\+/g, '%20')); } catch (_) {}
          if (decoded !== raw) pending.push(decoded);
          if (/^[a-z0-9_-]{12,}={0,2}$/i.test(raw)) {
            try {
              const base64 = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=');
              const unwrapped = atob(base64);
              if (/^https?:\/\//i.test(unwrapped)) pending.push(unwrapped);
            } catch (_) {}
          }
          for (const match of raw.matchAll(/https?(?::|%3a)(?:\/\/|%2f%2f)[^\s<>'"\])}]+/gi)) pending.push(match[0]);
          const url = absoluteUrl(raw, pageUrl);
          if (!url) continue;
          try {
            const parsed = new URL(url);
            if (/^(?:www\.)?simpcity\.cr$/i.test(parsed.hostname)) {
              for (const key of ['link', 'url', 'target', 'to', 'u', 'redirect']) {
                const target = parsed.searchParams.get(key);
                if (target) pending.push(target);
              }
              const linkedThreadUrl = canonicalSimpCityThreadUrl(parsed);
              if (linkedThreadUrl) {
                found.push({ text, url: linkedThreadUrl.slice(0, 1500), simpcityThread: true });
              }
            } else if (!/\/members\//i.test(url) && !/(?:#post-|\/page-\d+)/i.test(url)) {
              found.push({ text, url: url.slice(0, 1500) });
            }
          } catch (_) {}
        }
        return found;
      }).filter(Boolean);
      const hiddenMarkupCandidates = [clone.outerHTML.replace(/&amp;/gi, '&')];
      try { hiddenMarkupCandidates.push(decodeURIComponent(hiddenMarkupCandidates[0])); } catch (_) {}
      for (const markup of hiddenMarkupCandidates) {
        for (const match of markup.matchAll(/https?:\/\/[^\s<>'"\])}]+/gi)) {
          const rawUrl = match[0].replace(/&(?:quot|amp);.*$/i, '').replace(/[),.;]+$/, '');
          try {
            const parsed = new URL(rawUrl);
            const linkedThreadUrl = canonicalSimpCityThreadUrl(parsed);
            if (linkedThreadUrl) {
              links.push({ text: '', url: linkedThreadUrl, simpcityThread: true });
            } else if (!/(?:^|\.)simpcity\.cr$/i.test(parsed.hostname)) {
              parsed.hash = '';
              links.push({ text: '', url: parsed.toString().slice(0, 1500) });
            }
          } catch (_) {}
        }
      }
      const attachments = [];
      clone.querySelectorAll('img').forEach(image => {
        [image.alt, image.title, fileLabel(image.getAttribute('src'))].forEach(value => {
          value = String(value || '').trim();
          if (value) attachments.push(value.slice(0, 300));
        });
      });
      clone.querySelectorAll('a[href]').forEach(anchor => {
        const href = anchor.getAttribute('href') || '';
        if (/\.(?:jpe?g|png|webp|gif|mp4|mov|webm)(?:\?|$)/i.test(href)) attachments.push(fileLabel(href));
      });
      let lines = String(clone.innerText || clone.textContent || '').split(/\r?\n/).map(line => line.trim());
      while (lines.length && (!lines[0] || monthDate.test(lines[0]) || /^Add bookmark$/i.test(lines[0]) || /^#\d+$/.test(lines[0]))) lines.shift();
      const edited = lines.findIndex(line => /^Last edited\s*:/i.test(line));
      if (edited >= 0) lines = lines.slice(0, edited);
      const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 14000);
      if (!text && !links.length && !attachments.length) return null;
      return {
        postId: String(article.id || article.dataset?.content || `page-${pageNumber}-post-${index + 1}`),
        page: pageNumber, text,
        links: uniqueObjects(links, item => item.url).slice(0, 180),
        attachments: [...new Set(attachments.filter(Boolean))].slice(0, 50)
      };
    }).filter(Boolean);
  }

  document.getElementById('pong-simpcity-scraper')?.remove();
  const panel = document.createElement('div');
  panel.id = 'pong-simpcity-scraper';
  panel.style.cssText = 'position:fixed;z-index:2147483647;left:10px;right:10px;bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px;background:#10141ef5;border:1px solid #5f78a8;border-radius:12px;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 4px 24px #000b';
  panel.innerHTML = `<span data-status style="flex:1;min-width:180px">v${SCRIPT_VERSION} · streaming PC handoff</span><button data-scrape="1" style="padding:11px 12px;font:inherit">Pong 1 Scrape</button><button data-scrape="2" style="padding:11px 12px;font:inherit">Pong 2 Scrape</button><button data-copy style="padding:11px;font:inherit">Copy Log</button><button data-close style="padding:11px;font:inherit">×</button>`;
  document.body.appendChild(panel);
  const resumeLabel = document.createElement('label');
  resumeLabel.style.cssText = 'display:flex;align-items:center;gap:5px;font:inherit;white-space:nowrap';
  resumeLabel.innerHTML = '<input data-resume type="checkbox" style="width:18px;height:18px"> Resume';
  panel.insertBefore(resumeLabel, panel.querySelector('[data-scrape]'));
  panel.querySelector('[data-close]').onclick = () => panel.remove();
  const status = panel.querySelector('[data-status]');
  const resumeCheckbox = panel.querySelector('[data-resume]');
  const logLines = [];
  diagnosticSink = (message, details = '') => {
    const stamp = new Date().toISOString();
    const line = `[${stamp}] ${message}${details ? ` | ${details}` : ''}`;
    logLines.push(line);
    if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  };
  panel.querySelector('[data-copy]').onclick = async event => {
    const text = logLines.join('\n');
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
      else await navigator.clipboard.writeText(text);
      event.currentTarget.textContent = 'Copied';
      setTimeout(() => { event.currentTarget.textContent = 'Copy Log'; }, 1200);
    } catch (error) {
      diagnostic('Copy failed', error?.message || String(error));
      event.currentTarget.textContent = 'Copy Failed';
    }
  };
  const buttons = [...panel.querySelectorAll('[data-scrape]')];
  const activeRunTokens = new Map();
  diagnostic('Script initialized', `version=${SCRIPT_VERSION}; page=${location.href}; mode=${globalThis.PONG_PC_BACKGROUND_CONTEXT ? 'PC worker' : 'Android controller'}; pageConcurrency=${PAGE_CONCURRENCY}; creatorConcurrency=${FORUM_CREATOR_CONCURRENCY}; requestGap=${SIMPCITY_REQUEST_GAP_MS}ms`);
  if (!globalThis.PONG_PC_BACKGROUND_CONTEXT) {
    sendToPong('/simpcity/resume/status', { sourceUrl: location.href }, 10000).then(result => {
      resumeCheckbox.checked = result?.available === true;
      resumeCheckbox.title = result?.available
        ? `Continue this exact URL after the last profile passed in Pong${Number(result?.passedProfiles || 0) ? ` (${Number(result.passedProfiles)} remembered)` : ''}`
        : 'No saved position exists for this exact URL yet';
      if (result?.available) {
        diagnostic('Exact profile resume recognized', `remembered=${Number(result?.passedProfiles || 0)}; source=${location.href}`);
      }
    }).catch(error => {
      diagnostic('Resume check unavailable', error?.message || String(error));
    });
  }

  const monitorPcWorker = async (channel, workerId, runToken) => {
    let consecutiveConnectionFailures = 0;
    let lastSummary = '';
    while (activeRunTokens.get(channel) === runToken) {
      await delay(3000);
      try {
        const response = await getFromPong(`/simpcity/background/status?channel=${channel}`);
        consecutiveConnectionFailures = 0;
        const run = response?.run;
        if (!run || run.id !== workerId) {
          const message = run ? `worker replaced by ${run.id}` : 'worker record is missing';
          status.textContent = `Pong ${channel}: PC worker unavailable · tap Copy Log`;
          diagnostic('PC worker unavailable', `channel=${channel}; expected=${workerId}; ${message}`);
          return;
        }
        const summary = `${run.state || 'unknown'}; ${run.status || 'no progress text'}; ${run.error || 'no error'}`;
        if (summary !== lastSummary) {
          diagnostic('PC worker status', `channel=${channel}; id=${workerId}; ${summary}`);
          lastSummary = summary;
        }
        if (run.state === 'error' || run.error) {
          status.textContent = `Pong ${channel}: PC error · tap Copy Log`;
          return;
        }
        if (run.state === 'complete') {
          status.textContent = `Pong ${channel}: PC scrape complete`;
          return;
        }
        if (run.state === 'cancelled') {
          status.textContent = `Pong ${channel}: PC scrape cancelled · tap Copy Log`;
          return;
        }
        status.textContent = run.status || `Pong ${channel}: PC running in background`;
      } catch (error) {
        consecutiveConnectionFailures++;
        diagnostic('PC status connection failed', `channel=${channel}; attempt=${consecutiveConnectionFailures}; ${error?.message || error}`);
        if (consecutiveConnectionFailures >= 2) {
          status.textContent = `Pong ${channel}: PC connection lost · tap Copy Log`;
        }
      }
    }
  };

  const runScrape = async channel => {
    const runToken = `${Date.now()}-${Math.random()}`;
    activeRunTokens.set(channel, runToken);
    const isCurrentRun = () => activeRunTokens.get(channel) === runToken;
    diagnostic('Scrape button pressed', `channel=${channel}; runToken=${runToken}`);
    try {
      const requestedSourceUrl = String(globalThis.PONG_SIMPCITY_SOURCE_URL || location.href);
      const resumeSkipProfiles = globalThis.PONG_PC_BACKGROUND_CONTEXT
        ? Math.max(0, Math.floor(Number(globalThis.PONG_SIMPCITY_RESUME_SKIP_PROFILES || 0)))
        : 0;
      const rootThreadUrl = canonicalSimpCityThreadUrl(requestedSourceUrl);
      const listingRootUrl = canonicalSimpCityListingUrl(requestedSourceUrl);
      diagnostic('Source URL classified', `thread=${rootThreadUrl || 'none'}; listing=${listingRootUrl || 'none'}`);
      if (!rootThreadUrl && !listingRootUrl) throw new Error('Open a SimpCity thread, tag, or search page');
      // A one-time browser-cookie handoff lets the PC run this exact userscript
      // in a hidden, muted browser. Firefox can be minimized or closed after
      // this succeeds. Android deliberately stops and exposes a diagnostic log
      // if PC startup fails; only the injected PC worker runs the scraper.
      if (!globalThis.PONG_PC_BACKGROUND_CONTEXT) {
        const cookies = await readSimpCitySessionCookies();
        const hasLoginCookie = hasSimpCityLoginCookie(cookies);
        diagnostic('Android cookie inspection complete', `count=${cookies.length}; loginCookie=${hasLoginCookie}; names=${cookies.map(cookie => cookie?.name || '?').join(',') || 'none'}; values omitted`);
        try {
          status.textContent = `Pong ${channel}: starting PC scrape…`;
          let background;
          try {
            // Prefer the PC's already-authenticated encrypted session. Android
            // Tampermonkey often exposes only a partial cookie set, and must
            // not overwrite a healthy PC session on every scrape.
            diagnostic('Starting PC worker with stored session', `channel=${channel}`);
            background = await sendToPong('/simpcity/background/start', {
              url: location.href,
              channel,
              resumeFromSaved: resumeCheckbox.checked === true
            }, 30000);
          } catch (firstError) {
            diagnostic('Stored-session PC start failed', firstError?.message || String(firstError));
            if (!cookies.length) throw firstError;
            if (/login cookie is missing/i.test(firstError?.message || '') && !hasLoginCookie) {
              throw new Error('Firefox did not expose the HttpOnly SimpCity login cookie. Enable Tampermonkey HttpOnly cookie access, then retry');
            }
            status.textContent = `Pong ${channel}: refreshing PC session…`;
            diagnostic('Sending Android cookies to PC', `count=${cookies.length}; values omitted`);
            await sendToPong('/simpcity/session/handoff', {
              cookies,
              userAgent: navigator.userAgent
            }, 20000);
            diagnostic('Cookie handoff accepted; retrying PC worker', `channel=${channel}`);
            background = await sendToPong('/simpcity/background/start', {
              url: location.href,
              channel,
              resumeFromSaved: resumeCheckbox.checked === true
            }, 30000);
          }
          if (!background?.sourceCaptureRequired) {
            status.textContent = background?.profileResume
              ? `Pong ${channel}: resuming after last passed profile`
              : `Pong ${channel}: PC running in background · ${background.id}`;
            diagnostic(
              'PC worker started successfully',
              `channel=${channel}; id=${background.id}; target=${background.targetUrl || location.href}; state=${background.state || 'running'}; profileResume=${background?.profileResume === true}; remembered=${Number(background?.passedProfiles || 0)}`
            );
            void monitorPcWorker(channel, background.id, runToken);
            return;
          }
          status.textContent = `Pong ${channel}: transferring authenticated pages to PC…`;
          diagnostic('PC requested authenticated source capture', `channel=${channel}; id=${background.id}; Firefox fetches pages; PC performs downstream processing`);
        } catch (error) {
          const message = error?.message || String(error);
          status.textContent = /login|access check|403|forbidden/i.test(message)
            ? `Pong ${channel}: SimpCity PC login failed · tap Copy Log`
            : `Pong ${channel}: PC handoff failed · tap Copy Log`;
          diagnostic('Authenticated source capture could not start', `channel=${channel}; error=${message}`);
          return;
        }
      }
      let listingHtml = '';
      let initialThreads = [];
      if (listingRootUrl) {
        listingHtml = document.documentElement.outerHTML;
        initialThreads = listingThreadUrls(listingHtml, location.href);
        if (!initialThreads.length) throw new Error('No creator threads were found in this search');
      }
      const first = new URL(rootThreadUrl || initialThreads[0]);
      const scrapeId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const recallSourceUrl = listingRootUrl || rootThreadUrl || first.href;
      await sendToPong('/simpcity/recall/begin', { id: scrapeId, threadUrl: recallSourceUrl, channel }, 12000);
      const names = new Map();
      const albums = new Map();
      const aiSlots = Array.from({ length: AI_CONCURRENCY }, () => Promise.resolve());
      const aiTasks = [];
      const linkedThreadQueue = [];
      const seenThreads = new Set(listingRootUrl ? [] : [first.href]);
      let slotIndex = 0, pagesFetched = 0, totalPages = 0, postsSent = 0, listingPagesFetched = 0;
      const saveResumeCursor = async cursorUrl => {
        if (!listingRootUrl || !cursorUrl) return;
        try {
          await sendToPong('/simpcity/resume/progress', {
            sourceUrl: listingRootUrl,
            cursorUrl
          }, 12000);
        } catch (error) {
          diagnostic('Resume cursor save failed', error?.message || String(error));
        }
      };
      const update = () => {
        if (isCurrentRun()) status.textContent = `Pong ${channel}: ${pagesFetched}/${Math.max(totalPages, pagesFetched)} pages · ${postsSent} posts · ${names.size} creators · ${albums.size} albums · ${seenThreads.size} threads`;
      };
      const normalizeLinkedThread = rawUrl => {
        try {
          const canonical = canonicalSimpCityThreadUrl(rawUrl);
          if (!canonical) return '';
          const url = new URL(canonical);
          const slug = decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '');
          if (/\b(?:rules?|guidelines?|who-is-this|request|posting-etiquette|community-rules|help)\b/i.test(slug)) return '';
          return url.toString();
        } catch (_) { return ''; }
      };
      const queuePosts = (posts, depth = 0, batchSize = AI_BATCH_SIZE, orderedPair = false, allowExisting = false) => {
        if (depth < MAX_LINKED_THREAD_DEPTH && seenThreads.size <= MAX_LINKED_THREADS) {
          for (const post of posts) {
            for (const link of post?.links || []) {
              if (!link?.simpcityThread) continue;
              const threadUrl = normalizeLinkedThread(link.url);
              if (!threadUrl || seenThreads.has(threadUrl) || seenThreads.size >= MAX_LINKED_THREADS + 1) continue;
              seenThreads.add(threadUrl);
              linkedThreadQueue.push({ url: threadUrl, depth: depth + 1 });
            }
          }
        }
        const safeBatchSize = Math.max(1, Number(batchSize || AI_BATCH_SIZE));
        for (let offset = 0; offset < posts.length; offset += safeBatchSize) {
          const batch = posts.slice(offset, offset + safeBatchSize);
          const slot = orderedPair ? 0 : slotIndex++ % AI_CONCURRENCY;
          const task = aiSlots[slot] = aiSlots[slot].then(async () => {
            const result = await sendToPong('/simpcity/extract-creators', {
              id: scrapeId, channel, posts: batch, orderedPair, allowExisting
            });
            postsSent += batch.length;
            for (const creator of result.creators || []) {
              for (const raw of [creator.primaryName, ...(creator.aliases || []), ...(creator.usernames || [])]) {
                const value = String(raw || '').trim();
                const key = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
                if (key.length >= 2 && value.length <= 100 && !names.has(key)) names.set(key, value);
              }
            }
            for (const album of result.albums || []) if (album?.url) albums.set(album.url, album);
            update();
          });
          aiTasks.push(task);
        }
      };
      const pageCountFromHtml = html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const pages = [...doc.querySelectorAll('a[href*="/page-"]')]
          .map(anchor => Number(anchor.getAttribute('href')?.match(/page-(\d+)/i)?.[1] || 1));
        return Math.max(1, ...pages);
      };
      const scanThread = async ({ url: threadUrl, depth, maxPages = 0, atomic = false, deferSubmit = false, streamFirstPage = false }, currentHtml = '') => {
        if (!isCurrentRun()) throw Object.assign(new Error('This scrape was superseded'), { status: 409 });
        const firstHtml = currentHtml || await fetchSimpCityPage(threadUrl, 1);
        const discoveredPages = pageCountFromHtml(firstHtml);
        const depthLimitedPages = depth ? Math.min(discoveredPages, MAX_LINKED_THREAD_PAGES) : discoveredPages;
        const threadPages = maxPages > 0 ? Math.min(depthLimitedPages, maxPages) : depthLimitedPages;
        totalPages += threadPages;
        const collectedPosts = [];
        const firstPosts = extractPostPayloads(firstHtml, 1, threadUrl);
        const submitPosts = posts => atomic ? collectedPosts.push(...posts) : queuePosts(posts, depth);
        submitPosts(firstPosts);
        if (atomic && streamFirstPage && firstPosts.length) {
          // Publish from page 1 immediately; deeper pages enrich the same
          // creator bundle instead of blocking time-to-first-artist.
          const probePosts = [{
            postId: `thread-title-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            page: 1, text: '',
            links: [{ text: '', url: threadUrl, simpcityThread: true }],
            attachments: []
          }, ...firstPosts];
          queuePosts(probePosts, depth, probePosts.length, true, true);
        }
        pagesFetched++;
        update();
        for (let start = 2; start <= threadPages; start += PAGE_CONCURRENCY) {
          const pages = Array.from({ length: PAGE_CONCURRENCY }, (_, i) => start + i).filter(page => page <= threadPages);
          const fetched = await Promise.all(pages.map(async page => {
            const pageUrl = new URL(threadUrl);
            pageUrl.pathname = `${pageUrl.pathname.replace(/\/$/, '')}/page-${page}`;
            return { page, url: pageUrl.href, html: await fetchSimpCityPage(pageUrl.href, page) };
          }));
          for (const item of fetched) {
            const pagePosts = extractPostPayloads(item.html, item.page, item.url);
            submitPosts(pagePosts);
            if (atomic && streamFirstPage && pagePosts.length) {
              const enrichPosts = [{
                postId: `thread-title-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                page: 1, text: '',
                links: [{ text: '', url: threadUrl, simpcityThread: true }],
                attachments: []
              }, ...pagePosts];
              queuePosts(enrichPosts, depth, enrichPosts.length, true, true);
            }
            pagesFetched++;
          }
          update();
        }
        if (atomic && collectedPosts.length) {
          collectedPosts.unshift({
            postId: `thread-title-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            page: 1,
            text: '',
            links: [{ text: '', url: threadUrl, simpcityThread: true }],
            attachments: []
          });
          // One request marks the complete creator thread. The PC can resolve
          // every host concurrently without releasing a partial pair.
          if (deferSubmit) return collectedPosts;
          queuePosts(collectedPosts, depth, collectedPosts.length, true, streamFirstPage);
        }
        return collectedPosts;
      };
      const currentPage = Number(location.pathname.match(/\/page-(\d+)/i)?.[1] || 1);
      const rootIsSinglePageThread = /\/threads\/who-is-this-identify-unknown-models-in-here\./i.test(first.pathname);
      if (listingRootUrl) {
        listingPagesFetched = 1;
        const pageTotal = listingPageCount(listingHtml);
        const listingIsForum = /^\/forums\//i.test(new URL(listingRootUrl).pathname);
        const listingIsSearch = /^\/search\//i.test(new URL(listingRootUrl).pathname);
        const listingContentThreads = [];
        const completedThreads = [];
        const creatorWaiters = [];
        let creatorCursor = 0;
        let nextCreatorToSubmit = 0;
        let resumeCheckpointChain = Promise.resolve();
        const listingNeedsCreatorScan = listingIsForum || listingIsSearch;
        let listingDiscoveryComplete = !listingNeedsCreatorScan;
        const wakeCreatorWorkers = () => {
          while (creatorWaiters.length) creatorWaiters.shift()();
        };
        const waitForCreatorWork = () => new Promise(resolve => creatorWaiters.push(resolve));
        const checkpointListingCursor = (cursorUrl, requiredCreatorCount) => {
          resumeCheckpointChain = resumeCheckpointChain.then(async () => {
            while (
              listingNeedsCreatorScan &&
              isCurrentRun() &&
              nextCreatorToSubmit < requiredCreatorCount
            ) await delay(250);
            if (isCurrentRun()) await saveResumeCursor(cursorUrl);
          });
          return resumeCheckpointChain;
        };
        let resumedProfilesSkipped = 0;
        const flushCompletedCreators = () => {
          while (completedThreads[nextCreatorToSubmit]) {
            const posts = completedThreads[nextCreatorToSubmit];
            completedThreads[nextCreatorToSubmit] = null;
            if (nextCreatorToSubmit < resumeSkipProfiles) {
              resumedProfilesSkipped++;
              if (resumedProfilesSkipped === resumeSkipProfiles) {
                diagnostic('Resume cursor reached', `continued after ${resumeSkipProfiles} Pong profiles`);
              }
            } else {
              // A complete profile becomes one ordered server job. The server
              // resolves SimpCity hosts, TikTok and Balbums concurrently and
              // publishes Videos then TikTok as adjacent Pong bundles.
              queuePosts(posts, MAX_LINKED_THREAD_DEPTH, posts.length, true);
            }
            nextCreatorToSubmit++;
          }
        };
        const queueListingThreads = threadUrls => {
          const posts = [];
          for (const threadUrl of threadUrls) {
            if (seenThreads.has(threadUrl)) continue;
            seenThreads.add(threadUrl);
            listingContentThreads.push(threadUrl);
            posts.push({
              postId: `search-thread-${seenThreads.size}`,
              page: 1,
              text: '',
              links: [{ text: '', url: threadUrl, simpcityThread: true }],
              attachments: []
            });
          }
          if (listingNeedsCreatorScan && posts.length) wakeCreatorWorkers();
          if (posts.length && !listingNeedsCreatorScan) queuePosts(posts, MAX_LINKED_THREAD_DEPTH);
        };
        queueListingThreads(initialThreads);
        void checkpointListingCursor(location.href, listingContentThreads.length);
        const creatorWorkers = listingNeedsCreatorScan
          ? Array.from({ length: FORUM_CREATOR_CONCURRENCY }, async () => {
            while (isCurrentRun()) {
              if (creatorCursor >= listingContentThreads.length) {
                if (listingDiscoveryComplete) return;
                await waitForCreatorWork();
                continue;
              }
              const index = creatorCursor++;
              const threadUrl = listingContentThreads[index];
              // Resume is an ordered cursor, not a replay filter. Profiles the
              // user already passed in Pong do not need their threads fetched,
              // parsed, classified, or resolved again.
              if (index < resumeSkipProfiles) {
                completedThreads[index] = [];
                flushCompletedCreators();
                continue;
              }
              if (isCurrentRun()) {
                status.textContent = `Pong ${channel}: creator ${index + 1}/${Math.max(index + 1, listingContentThreads.length)} · discovering more listings`;
              }
              try {
                completedThreads[index] = await scanThread({
                url: threadUrl,
                depth: 0,
                atomic: true,
                deferSubmit: true,
                streamFirstPage: true
              });
              } catch (error) {
                diagnostic('Creator thread failed', `index=${index + 1}; url=${threadUrl}; ${error?.message || error}`);
                completedThreads[index] = [];
              }
              flushCompletedCreators();
            }
          })
          : [];
        if (listingIsSearch) {
          const seenListingPages = new Set([listingPageIdentity(location.href)]);
          const pendingListingPages = listingContinuationUrls(listingHtml, location.href, listingRootUrl)
            .filter(pageUrl => !seenListingPages.has(listingPageIdentity(pageUrl)));
          while (pendingListingPages.length && isCurrentRun()) {
            await waitForDiscoveryCapacity(channel);
            const batchUrls = pendingListingPages.splice(0, PAGE_CONCURRENCY);
            batchUrls.forEach(pageUrl => seenListingPages.add(listingPageIdentity(pageUrl)));
            const pages = await Promise.all(batchUrls.map(async pageUrl => {
              const fetched = await fetchSimpCityListingPage(pageUrl, listingPageNumber(pageUrl));
              return { url: fetched.url || pageUrl, html: fetched.html };
            }));
            listingPagesFetched += pages.length;
            for (const page of pages) {
              queueListingThreads(listingThreadUrls(page.html, page.url));
              for (const continuation of listingContinuationUrls(page.html, page.url, listingRootUrl)) {
                const identity = listingPageIdentity(continuation);
                if (!identity || seenListingPages.has(identity) || pendingListingPages.some(item => listingPageIdentity(item) === identity)) continue;
                pendingListingPages.push(continuation);
              }
            }
            if (pages.length) void checkpointListingCursor(
              pages[pages.length - 1].url,
              listingContentThreads.length
            );
            pendingListingPages.sort((left, right) => listingPageNumber(left) - listingPageNumber(right));
            if (isCurrentRun()) {
              status.textContent = `Pong ${channel}: ${listingPagesFetched} search pages · ${seenThreads.size} threads · following older posts`;
            }
          }
        } else {
          const resumeListingPage = listingPageNumber(location.href);
          for (let start = Math.max(2, resumeListingPage + 1); start <= pageTotal; start += PAGE_CONCURRENCY) {
            await waitForDiscoveryCapacity(channel);
            const pageNumbers = Array.from({ length: PAGE_CONCURRENCY }, (_, index) => start + index)
              .filter(page => page <= pageTotal);
            const pages = await Promise.all(pageNumbers.map(async page => {
              const url = listingPageUrl(listingRootUrl, page);
              const fetched = await fetchSimpCityListingPage(url, page);
              return { url: fetched.url || url, html: fetched.html };
            }));
            listingPagesFetched += pages.length;
            pages.forEach(page => queueListingThreads(listingThreadUrls(page.html, page.url)));
            if (pages.length) void checkpointListingCursor(
              pages[pages.length - 1].url,
              listingContentThreads.length
            );
            if (isCurrentRun()) {
              status.textContent = `Pong ${channel}: ${Math.min(start + pageNumbers.length - 1, pageTotal)}/${pageTotal} search pages · ${seenThreads.size} threads`;
            }
          }
        }
        if (listingNeedsCreatorScan) {
          listingDiscoveryComplete = true;
          wakeCreatorWorkers();
          await Promise.all(creatorWorkers);
          flushCompletedCreators();
          await resumeCheckpointChain;
        }
      } else if (rootIsSinglePageThread) {
        totalPages = 1;
        queuePosts(extractPostPayloads(document.documentElement.outerHTML, currentPage, location.href), 0);
        pagesFetched = 1;
        update();
      } else {
        await scanThread({ url: first.href, depth: 0 }, currentPage === 1 ? document.documentElement.outerHTML : '');
      }
      while (linkedThreadQueue.length && isCurrentRun()) {
        const linked = linkedThreadQueue.shift();
        try {
          // A linked creator profile is one artist unit. Collect its pages as
          // one ordered batch so its own media stays attached to its title.
          await scanThread({ ...linked, atomic: true });
        } catch (error) {
          // Deleted/moved utility or creator threads are normal in old
          // megathreads. One 404 must not abort every remaining artist.
          diagnostic('Linked creator thread skipped', `url=${linked?.url || 'unknown'}; ${error?.message || error}`);
        }
      }
      await Promise.all(aiTasks);
      await sendToPong('/simpcity/recall', {
        id: scrapeId, channel, schema: 'pong-simpcity-ai-v1', threadUrl: first.href,
        names: [...names.values()].slice(0, 1000), albums: [...albums.values()], aiExtracted: true
      }, 15000);
      if (isCurrentRun()) status.textContent = `Pong ${channel}: ${names.size} immediate creators · ${listingPagesFetched || pagesFetched} source pages · remaining AI streams to Recall`;
    } catch (error) {
      if (isCurrentRun()) status.textContent = `Pong ${channel} failed: ${error?.message || error}`;
    }
  };
  buttons.forEach(button => {
    button.onclick = () => runScrape(Number(button.dataset.scrape) === 2 ? 2 : 1);
  });

  // Pong Artist Lookup queue. One open SimpCity tab is enough: the userscript
  // picks up each queued name, submits the authenticated site search, runs the
  // normal Recall 2 pipeline, then advances to the next name automatically.
  const LOOKUP_STORAGE_KEY = 'pong-artist-lookup-current-v1';
  const LOOKUP_CONTROLLER_LEASE_KEY = 'pong-artist-lookup-controller-v1';
  const LOOKUP_CONTROLLER_PARAM = 'pong_artist_lookup';
  const LOOKUP_CONTROLLER_WINDOW_NAME = 'pong-artist-lookup-controller-v2';
  const LOOKUP_CONTROLLER_LEASE_MS = 15_000;
  const LOOKUP_TAB_ID = sessionStorage.getItem('pong-artist-lookup-tab-id') ||
    `lookup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem('pong-artist-lookup-tab-id', LOOKUP_TAB_ID);
  const initialControllerToken = new URLSearchParams(location.hash.replace(/^#/, '')).get(LOOKUP_CONTROLLER_PARAM) || '';
  let lookupControllerToken = sessionStorage.getItem('pong-artist-lookup-controller-token') || '';
  if (initialControllerToken) {
    lookupControllerToken = initialControllerToken;
    sessionStorage.setItem('pong-artist-lookup-controller-token', lookupControllerToken);
    window.name = LOOKUP_CONTROLLER_WINDOW_NAME;
    document.title = `Pong Lookup · ${document.title}`;
  }
  const gmGet = async key => typeof GM_getValue === 'function' ? await GM_getValue(key, null) : null;
  const gmSet = async (key, value) => { if (typeof GM_setValue === 'function') await GM_setValue(key, value); };
  const gmDelete = async key => { if (typeof GM_deleteValue === 'function') await GM_deleteValue(key); };
  const isArtistLookupController = () =>
    window.name === LOOKUP_CONTROLLER_WINDOW_NAME && Boolean(lookupControllerToken);
  const artistLookupSearchUrl = (query, token = lookupControllerToken) =>
    `https://simpcity.cr/search/?q=${encodeURIComponent(query)}&o=date#${LOOKUP_CONTROLLER_PARAM}=${encodeURIComponent(token)}`;
  const touchArtistLookupController = async () => {
    await gmSet(LOOKUP_CONTROLLER_LEASE_KEY, {
      tabId: LOOKUP_TAB_ID,
      token: lookupControllerToken,
      at: Date.now()
    });
  };
  const submitArtistSearch = query => {
    location.assign(artistLookupSearchUrl(query));
  };
  const waitForRecall2Completion = async () => {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const state = await getFromPong('/simpcity/background/status?channel=3').catch(() => null);
      const run = state?.run;
      if (run && ['complete', 'empty', 'error', 'cancelled'].includes(String(run.state || ''))) return run;
      await delay(2000);
    }
    throw new Error('Artist Lookup timed out waiting for Recall 2');
  };
  const processArtistLookupQueue = async () => {
    if (globalThis.PONG_PC_BACKGROUND_CONTEXT) return;
    if (!isArtistLookupController()) {
      const lease = await gmGet(LOOKUP_CONTROLLER_LEASE_KEY);
      if (lease?.token && lease?.at && Date.now() - Number(lease.at) < LOOKUP_CONTROLLER_LEASE_MS) {
        setTimeout(processArtistLookupQueue, 4000);
        return;
      }
      let pendingItem = await gmGet(LOOKUP_STORAGE_KEY);
      if (!pendingItem?.id) {
        const next = await getFromPong('/simpcity/artist-lookup/next').catch(() => null);
        pendingItem = next?.item || null;
      }
      if (!pendingItem?.id) {
        setTimeout(processArtistLookupQueue, 4000);
        return;
      }
      pendingItem = { ...pendingItem, navigated: true };
      await gmSet(LOOKUP_STORAGE_KEY, pendingItem);
      const controllerToken = `controller-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await gmSet(LOOKUP_CONTROLLER_LEASE_KEY, {
        tabId: LOOKUP_TAB_ID,
        token: controllerToken,
        at: Date.now()
      });
      const controllerUrl = artistLookupSearchUrl(pendingItem.query, controllerToken);
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(controllerUrl, { active: false, insert: true, setParent: true });
      } else {
        window.open(controllerUrl, '_blank', 'noopener,noreferrer');
      }
      status.textContent = `Pong Artist Lookup: background tab started for ${pendingItem.query}`;
      setTimeout(processArtistLookupQueue, 4000);
      return;
    }
    const controllerLease = await gmGet(LOOKUP_CONTROLLER_LEASE_KEY);
    if (controllerLease?.token !== lookupControllerToken) {
      // A stale or copied tab can never inherit navigation authority.
      window.name = '';
      lookupControllerToken = '';
      sessionStorage.removeItem('pong-artist-lookup-controller-token');
      setTimeout(processArtistLookupQueue, 4000);
      return;
    }
    await touchArtistLookupController();
    let item = await gmGet(LOOKUP_STORAGE_KEY);
    if (!item?.id) {
      const next = await getFromPong('/simpcity/artist-lookup/next').catch(() => null);
      item = next?.item || null;
      if (!item?.id) { setTimeout(processArtistLookupQueue, 4000); return; }
      await gmSet(LOOKUP_STORAGE_KEY, item);
    }
    const currentQuery = new URL(location.href).searchParams.get('q') || '';
    if (!/^\/search\//i.test(location.pathname) || currentQuery.toLowerCase() !== String(item.query).toLowerCase()) {
      status.textContent = `Pong Artist Lookup: searching ${item.query}`;
      item = { ...item, navigated: true };
      await gmSet(LOOKUP_STORAGE_KEY, item);
      submitArtistSearch(item.query);
      return;
    }
    status.textContent = `Pong Artist Lookup: scanning ${item.query}`;
    await runScrape(3);
    await waitForRecall2Completion();
    await sendToPong('/simpcity/artist-lookup/complete', { id: item.id }, 15000);
    await gmDelete(LOOKUP_STORAGE_KEY);
    status.textContent = `Pong Artist Lookup: finished ${item.query}`;
    setTimeout(processArtistLookupQueue, 1000);
  };
  if (isArtistLookupController()) {
    setInterval(() => touchArtistLookupController().catch(() => {}), 4000);
  }
  setTimeout(() => processArtistLookupQueue().catch(error => {
    diagnostic('Artist Lookup automation failed', error?.message || String(error));
    status.textContent = `Pong Artist Lookup failed: ${error?.message || error}`;
    setTimeout(processArtistLookupQueue, 10000);
  }), 1500);
})();
