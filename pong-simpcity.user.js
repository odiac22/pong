// ==UserScript==
// @name         Pong SimpCity Scraper
// @namespace    https://odiac22.github.io/pong/
// @version      1.2.0
// @description  Adds a Scrape button to authenticated SimpCity threads and saves creator names for Pong SC Recall.
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
  if (!/(?:^|\.)simpcity\.cr$/i.test(location.hostname) || !/\/threads\//i.test(location.pathname)) {
    alert('Open a SimpCity thread before running Pong Scrape.');
    return;
  }
  document.getElementById('pong-simpcity-scraper')?.remove();
  const panel = document.createElement('div');
  panel.id = 'pong-simpcity-scraper';
  panel.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'left:10px', 'right:10px', 'bottom:12px',
    'display:flex', 'gap:8px', 'align-items:center', 'padding:10px',
    'background:#10141eee', 'border:1px solid #5f78a8', 'border-radius:12px',
    'color:#fff', 'font:600 15px system-ui,sans-serif', 'box-shadow:0 4px 24px #000b'
  ].join(';');
  panel.innerHTML = `
    <span data-status style="flex:1">Ready to scrape this entire thread</span>
    <button data-scrape style="padding:11px 16px;font:inherit">Scrape</button>
    <button data-close style="padding:11px;font:inherit">×</button>`;
  document.body.appendChild(panel);
  panel.querySelector('[data-close]').onclick = () => panel.remove();
  const status = panel.querySelector('[data-status]');
  const button = panel.querySelector('[data-scrape]');
  const clean = value => String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:by|from|credit|credits?)\s*[:\-]\s*/i, '');
  const commonFirstNames = new Set([
    'abby','alice','alyssa','amanda','amber','amy','ana','anna','ashley','bella',
    'brianna','brooke','chloe','claire','danielle','ella','emily','emma','grace',
    'hailey','hannah','isabella','jasmine','jessica','julia','katie','kayla',
    'lauren','lily','madison','maya','mia','molly','natalie','nicole','olivia',
    'paige','rachel','rebecca','samantha','sarah','sophia','taylor','victoria','zoe'
  ]);
  button.onclick = async () => {
    button.disabled = true;
    try {
      const first = new URL(location.href);
      first.searchParams.delete('page');
      first.pathname = first.pathname.replace(/page-\d+\/?$/i, '');
      const pageNumbers = [...document.querySelectorAll('a[href*="/page-"]')]
        .map(anchor => Number(anchor.href.match(/page-(\d+)/)?.[1] || 1));
      const total = Math.max(1, ...pageNumbers);
      const htmls = [document.documentElement.outerHTML];
      for (let start = 2; start <= total; start += 4) {
        const pages = [start, start + 1, start + 2, start + 3].filter(page => page <= total);
        status.textContent = `Pages ${start}-${pages.at(-1)} of ${total}`;
        const batch = await Promise.all(pages.map(async page => {
          const url = new URL(first);
          url.pathname = url.pathname.replace(/\/$/, '') + `/page-${page}`;
          const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
          if (!response.ok) throw new Error(`page ${page} HTTP ${response.status}`);
          return response.text();
        }));
        htmls.push(...batch);
      }
      const names = new Map();
      const add = raw => {
        const name = clean(raw);
        const words = name.split(/\s+/).filter(Boolean);
        const lower = name.toLowerCase().replace(/^@/, '');
        const distinctSingle = words.length === 1 &&
          !commonFirstNames.has(lower) &&
          (lower.replace(/[^a-z0-9]+/g, '').length >= 7 || /[0-9_.]/.test(lower));
        if (
          name.length < 2 ||
          name.length > 45 ||
          words.length > 4 ||
          (words.length === 1 && !distinctSingle) ||
          /^(?:reply|report|quote|simpcity|forums?|members?|login|register)$/i.test(name)
        ) return;
        const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (key.length >= 4 && !names.has(key)) names.set(key, name);
      };
      const addAliases = raw => {
        const cleaned = clean(raw).replace(/\s*(?:\||-)\s*SimpCity.*$/i, '');
        const aliases = cleaned.split(
          /\s+(?:a\.?k\.?a\.?|aka|also\s+known\s+as)\s+|\s*[|/]\s*/i
        );
        aliases.forEach(add);
      };
      for (const html of htmls) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('blockquote,.bbCodeBlock--quote').forEach(node => node.remove());
        doc.querySelectorAll('a[href*="/threads/"]').forEach(anchor => {
          if (/page-\d+|#post-/i.test(anchor.href)) return;
          let slug = '';
          try {
            slug = decodeURIComponent(new URL(anchor.href).pathname.match(
              /^\/threads\/(.+?)(?:\.\d+)?\/?$/i
            )?.[1] || '').replace(/[-_]+/g, ' ');
          } catch (_) {}
          addAliases(anchor.title);
          addAliases(anchor.textContent);
          addAliases(slug);
        });
        doc.querySelectorAll('.message-body,.bbWrapper').forEach(body => {
          const text = body.innerText || '';
          for (const match of text.matchAll(
            /(?:aka|also known as|model|creator)\s*[:\-]?\s*([@A-Za-z0-9_. -]{2,60})/gi
          )) addAliases(match[1]);
          body.querySelectorAll(
            'a[href*="instagram.com/"],a[href*="twitter.com/"],a[href*="x.com/"],a[href*="onlyfans.com/"]'
          ).forEach(anchor => {
            try { add(new URL(anchor.href).pathname.split('/').filter(Boolean)[0]); } catch (_) {}
          });
        });
      }
      status.textContent = `${names.size} names - saving for SC Recall`;
      const payload = {
        threadUrl: first.href,
        names: [...names.values()].slice(0, 1000)
      };
      const endpoints = ['http://192.168.1.124:8787', 'http://127.0.0.1:8787'];
      let saved = false;
      let lastError = '';
      for (const endpoint of endpoints) {
        try {
          await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: 'POST',
              url: `${endpoint}/simpcity/recall`,
              headers: { 'Content-Type': 'application/json' },
              data: JSON.stringify(payload),
              timeout: 8000,
              onload: response => response.status >= 200 && response.status < 300
                ? resolve()
                : reject(new Error(`HTTP ${response.status}`)),
              onerror: () => reject(new Error('connection failed')),
              ontimeout: () => reject(new Error('connection timed out'))
            });
          });
          saved = true;
          break;
        } catch (error) {
          lastError = error?.message || String(error);
        }
      }
      if (!saved) throw new Error(`PC recall unavailable: ${lastError || 'server not reachable'}`);
      status.textContent = `${names.size} names saved — open Pong and tap SC Recall`;
      button.disabled = false;
    } catch (error) {
      status.textContent = `Failed: ${error?.message || error}`;
      button.disabled = false;
    }
  };
})();
