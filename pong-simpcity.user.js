// ==UserScript==
// @name         Pong SimpCity AI Scraper
// @namespace    https://odiac22.github.io/pong/
// @version      1.6.1
// @description  Streams direct creator handles immediately, then uses local AI only for ambiguous SimpCity post text.
// @match        https://simpcity.cr/threads/*
// @match        https://www.simpcity.cr/threads/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      192.168.1.124
// @connect      *
// @downloadURL  https://odiac22.github.io/pong/pong-simpcity.user.js
// @updateURL    https://odiac22.github.io/pong/pong-simpcity.user.js
// ==/UserScript==

(() => {
  'use strict';
  if (!/(?:^|\.)simpcity\.cr$/i.test(location.hostname) || !/\/threads\//i.test(location.pathname)) return;

  const PAGE_CONCURRENCY = 4;
  const AI_BATCH_SIZE = 10;
  const AI_CONCURRENCY = 2;
  const endpoints = ['http://192.168.1.124:8787', 'http://127.0.0.1:8787'];
  const monthDate = /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\s*$/i;

  const sendToPong = async (pathname, payload, timeout = 90000) => {
    let lastError = '';
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
        return await new Promise((resolve, reject) => {
          request({
            method: 'POST', url: `${endpoint}${pathname}`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(payload), timeout,
            onload: response => {
              let data = {};
              try { data = JSON.parse(response.responseText || '{}'); } catch (_) {}
              if (response.status >= 200 && response.status < 300 && data.ok !== false) resolve(data);
              else {
                const error = new Error(data.error || `HTTP ${response.status}`);
                error.status = response.status;
                reject(error);
              }
            },
            onerror: response => reject(new Error(
              `connection failed${response?.error ? `: ${response.error}` : ''}`
            )),
            ontimeout: () => reject(new Error('connection timed out'))
          });
        });
      } catch (error) {
        if (error?.status === 409) throw error;
        lastError = error?.message || String(error);
      }
      try {
        const response = await fetch(`${endpoint}${pathname}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.ok !== false) return data;
        if (response.status === 409) {
          const error = new Error(data.error || 'This scrape was superseded');
          error.status = 409;
          throw error;
        }
        lastError = data.error || `HTTP ${response.status}`;
      } catch (error) {
        if (error?.status === 409) throw error;
        lastError = `${lastError}; fetch ${error?.message || error}`;
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 600 * attempt));
      }
    }
    throw new Error(`PC AI unavailable: ${lastError || 'server not reachable'}`);
  };

  const absoluteUrl = (raw, base) => {
    try { return new URL(raw, base).href; } catch (_) { return ''; }
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
        const response = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (!/<(?:article|div)\b[^>]*class=["'][^"']*\bmessage\b/i.test(html)) {
          throw new Error('page contained no posts');
        }
        return html;
      } catch (nativeError) {
        lastError = nativeError?.message || String(nativeError);
      }
      try {
        const response = await userscriptRequest({
          method: 'GET',
          url,
          timeout: 30000,
          anonymous: false,
          headers: { Accept: 'text/html,application/xhtml+xml' }
        });
        const html = String(response.responseText || '');
        if (!/<(?:article|div)\b[^>]*class=["'][^"']*\bmessage\b/i.test(html)) {
          throw new Error('page contained no posts');
        }
        return html;
      } catch (userscriptError) {
        lastError = `${lastError}; ${userscriptError?.message || userscriptError}`;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
    throw new Error(`page ${pageNumber} failed after retries: ${lastError}`);
  }

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
            } else if (!/\/members\//i.test(url) && !/(?:#post-|\/page-\d+)/i.test(url)) {
              found.push({ text, url: url.slice(0, 1500) });
            }
          } catch (_) {}
        }
        return found;
      }).filter(Boolean);
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
        links: uniqueObjects(links, item => `${item.url}|${item.text}`).slice(0, 120),
        attachments: [...new Set(attachments.filter(Boolean))].slice(0, 50)
      };
    }).filter(Boolean);
  }

  document.getElementById('pong-simpcity-scraper')?.remove();
  const panel = document.createElement('div');
  panel.id = 'pong-simpcity-scraper';
  panel.style.cssText = 'position:fixed;z-index:2147483647;left:10px;right:10px;bottom:12px;display:flex;gap:8px;align-items:center;padding:10px;background:#10141eee;border:1px solid #5f78a8;border-radius:12px;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 4px 24px #000b';
  panel.innerHTML = '<span data-status style="flex:1">v1.6.1 · External videos + AI names</span><button data-scrape="1" style="padding:11px 12px;font:inherit">Pong 1 Scrape</button><button data-scrape="2" style="padding:11px 12px;font:inherit">Pong 2 Scrape</button><button data-close style="padding:11px;font:inherit">×</button>';
  document.body.appendChild(panel);
  panel.querySelector('[data-close]').onclick = () => panel.remove();
  const status = panel.querySelector('[data-status]');
  const buttons = [...panel.querySelectorAll('[data-scrape]')];
  const activeRunTokens = new Map();

  const runScrape = async channel => {
    const runToken = `${Date.now()}-${Math.random()}`;
    activeRunTokens.set(channel, runToken);
    const isCurrentRun = () => activeRunTokens.get(channel) === runToken;
    try {
      const first = new URL(location.href);
      first.searchParams.delete('page');
      first.pathname = first.pathname.replace(/page-\d+\/?$/i, '').replace(/\/$/, '') + '/';
      const scrapeId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await sendToPong('/simpcity/recall/begin', { id: scrapeId, threadUrl: first.href, channel }, 12000);
      const pageNumbers = [...document.querySelectorAll('a[href*="/page-"]')].map(a => Number(a.href.match(/page-(\d+)/)?.[1] || 1));
      const totalPages = Math.max(1, ...pageNumbers);
      const names = new Map();
      const albums = new Map();
      const aiSlots = Array.from({ length: AI_CONCURRENCY }, () => Promise.resolve());
      const aiTasks = [];
      let slotIndex = 0, pagesFetched = 0, postsSent = 0;
      const update = () => {
        if (isCurrentRun()) status.textContent = `Pong ${channel}: ${pagesFetched}/${totalPages} pages · ${postsSent} posts · ${names.size} creators · ${albums.size} albums`;
      };
      const queuePosts = posts => {
        for (let offset = 0; offset < posts.length; offset += AI_BATCH_SIZE) {
          const batch = posts.slice(offset, offset + AI_BATCH_SIZE);
          const slot = slotIndex++ % AI_CONCURRENCY;
          const task = aiSlots[slot] = aiSlots[slot].then(async () => {
            const result = await sendToPong('/simpcity/extract-creators', { id: scrapeId, channel, posts: batch });
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
      queuePosts(extractPostPayloads(document.documentElement.outerHTML, 1, first.href));
      pagesFetched = 1; update();
      for (let start = 2; start <= totalPages; start += PAGE_CONCURRENCY) {
        const pages = Array.from({ length: PAGE_CONCURRENCY }, (_, i) => start + i).filter(page => page <= totalPages);
        const fetched = await Promise.all(pages.map(async page => {
          const url = new URL(first); url.pathname = `${first.pathname.replace(/\/$/, '')}/page-${page}`;
          return { page, url: url.href, html: await fetchSimpCityPage(url.href, page) };
        }));
        for (const item of fetched) { queuePosts(extractPostPayloads(item.html, item.page, item.url)); pagesFetched++; }
        update();
      }
      await Promise.all(aiTasks);
      await sendToPong('/simpcity/recall', {
        id: scrapeId, channel, schema: 'pong-simpcity-ai-v1', threadUrl: first.href,
        names: [...names.values()].slice(0, 1000), albums: [...albums.values()], aiExtracted: true
      }, 15000);
      if (isCurrentRun()) status.textContent = `Pong ${channel}: ${names.size} immediate creators · remaining AI streams to Recall`;
    } catch (error) {
      if (isCurrentRun()) status.textContent = `Pong ${channel} failed: ${error?.message || error}`;
    }
  };
  buttons.forEach(button => {
    button.onclick = () => runScrape(Number(button.dataset.scrape) === 2 ? 2 : 1);
  });
})();
