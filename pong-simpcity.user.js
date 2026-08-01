// ==UserScript==
// @name         Pong SimpCity AI Scraper
// @namespace    https://odiac22.github.io/pong/
// @version      1.4.0
// @description  Extracts creator identities from every post with the local Pong AI and prepares Balbums matches as pages arrive.
// @match        https://simpcity.cr/threads/*
// @match        https://www.simpcity.cr/threads/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      192.168.1.124
// @downloadURL  https://odiac22.github.io/pong/pong-simpcity.user.js
// @updateURL    https://odiac22.github.io/pong/pong-simpcity.user.js
// ==/UserScript==

(() => {
  'use strict';
  if (!/(?:^|\.)simpcity\.cr$/i.test(location.hostname) || !/\/threads\//i.test(location.pathname)) return;

  const PAGE_CONCURRENCY = 4;
  const AI_BATCH_SIZE = 6;
  const AI_CONCURRENCY = 2;
  const endpoints = ['http://192.168.1.124:8787', 'http://127.0.0.1:8787'];
  const monthDate = /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\s*$/i;

  const sendToPong = async (pathname, payload, timeout = 90000) => {
    let lastError = '';
    for (const endpoint of endpoints) {
      try {
        return await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'POST', url: `${endpoint}${pathname}`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(payload), timeout,
            onload: response => {
              let data = {};
              try { data = JSON.parse(response.responseText || '{}'); } catch (_) {}
              if (response.status >= 200 && response.status < 300 && data.ok !== false) resolve(data);
              else reject(new Error(data.error || `HTTP ${response.status}`));
            },
            onerror: () => reject(new Error('connection failed')),
            ontimeout: () => reject(new Error('connection timed out'))
          });
        });
      } catch (error) { lastError = error?.message || String(error); }
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

  function extractPostPayloads(html, pageNumber, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let articles = [...doc.querySelectorAll('article.message')];
    if (!articles.length) articles = [...doc.querySelectorAll('.message')];
    return articles.map((article, index) => {
      const body = article.querySelector('.message-body .bbWrapper, .message-body, .bbWrapper');
      if (!body) return null;
      const clone = body.cloneNode(true);
      clone.querySelectorAll('blockquote,.bbCodeBlock--quote,.message-signature,.message-footer,.reactionsBar,button,script,style').forEach(node => node.remove());
      const links = [...clone.querySelectorAll('a[href]')].map(anchor => {
        const url = absoluteUrl(anchor.getAttribute('href'), pageUrl);
        if (!url || /\/members\//i.test(url) || /(?:#post-|\/page-\d+)/i.test(url)) return null;
        return { text: String(anchor.textContent || anchor.title || '').trim().slice(0, 240), url: url.slice(0, 1500) };
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
        links: uniqueObjects(links, item => `${item.url}|${item.text}`).slice(0, 60),
        attachments: [...new Set(attachments.filter(Boolean))].slice(0, 50)
      };
    }).filter(Boolean);
  }

  document.getElementById('pong-simpcity-scraper')?.remove();
  const panel = document.createElement('div');
  panel.id = 'pong-simpcity-scraper';
  panel.style.cssText = 'position:fixed;z-index:2147483647;left:10px;right:10px;bottom:12px;display:flex;gap:8px;align-items:center;padding:10px;background:#10141eee;border:1px solid #5f78a8;border-radius:12px;color:#fff;font:600 15px system-ui,sans-serif;box-shadow:0 4px 24px #000b';
  panel.innerHTML = '<span data-status style="flex:1">Ready: all pages, local AI extraction</span><button data-scrape style="padding:11px 16px;font:inherit">Scrape</button><button data-close style="padding:11px;font:inherit">×</button>';
  document.body.appendChild(panel);
  panel.querySelector('[data-close]').onclick = () => panel.remove();
  const status = panel.querySelector('[data-status]');
  const button = panel.querySelector('[data-scrape]');

  button.onclick = async () => {
    button.disabled = true;
    try {
      const first = new URL(location.href);
      first.searchParams.delete('page');
      first.pathname = first.pathname.replace(/page-\d+\/?$/i, '').replace(/\/$/, '') + '/';
      const scrapeId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await sendToPong('/simpcity/recall/begin', { id: scrapeId, threadUrl: first.href }, 12000);
      const pageNumbers = [...document.querySelectorAll('a[href*="/page-"]')].map(a => Number(a.href.match(/page-(\d+)/)?.[1] || 1));
      const totalPages = Math.max(1, ...pageNumbers);
      const names = new Map();
      const albums = new Map();
      const aiSlots = Array.from({ length: AI_CONCURRENCY }, () => Promise.resolve());
      const aiTasks = [];
      let slotIndex = 0, pagesFetched = 0, postsSent = 0;
      const update = () => { status.textContent = `${pagesFetched}/${totalPages} pages · ${postsSent} posts · ${names.size} creators · ${albums.size} albums`; };
      const queuePosts = posts => {
        for (let offset = 0; offset < posts.length; offset += AI_BATCH_SIZE) {
          const batch = posts.slice(offset, offset + AI_BATCH_SIZE);
          const slot = slotIndex++ % AI_CONCURRENCY;
          const task = aiSlots[slot] = aiSlots[slot].then(async () => {
            const result = await sendToPong('/simpcity/extract-creators', { id: scrapeId, posts: batch });
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
          const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
          if (!response.ok) throw new Error(`page ${page} HTTP ${response.status}`);
          return { page, url: url.href, html: await response.text() };
        }));
        for (const item of fetched) { queuePosts(extractPostPayloads(item.html, item.page, item.url)); pagesFetched++; }
        update();
      }
      await Promise.all(aiTasks);
      if (!names.size) throw new Error('Local AI found no creator identities in the thread posts');
      await sendToPong('/simpcity/recall', {
        id: scrapeId, schema: 'pong-simpcity-ai-v1', threadUrl: first.href,
        names: [...names.values()].slice(0, 1000), albums: [...albums.values()], aiExtracted: true
      }, 15000);
      status.textContent = `Saved: ${names.size} AI names · ${albums.size} ready albums — tap SC Recall`;
    } catch (error) {
      status.textContent = `Failed: ${error?.message || error}`;
    } finally { button.disabled = false; }
  };
})();
