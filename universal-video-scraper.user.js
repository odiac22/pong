// ==UserScript==
// @name         Universal Video Scraper - Visible Buttons + Page Links
// @namespace    https://coomerfans.com/
// @version      7.29.0
// @description  Tap Pong, select red video/thumbnail boxes, then Send. Copy log for troubleshooting.
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
// @connect      localhost
// @connect      127.0.0.1
// @connect      192.168.1.124
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* CONFIG */

  const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|ogv)(\?|#|$)/i;

  const RAW_VIDEO_URL_RE =
    /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:mp4|m4v|mov|webm|mkv|m3u8|mpd|ogv)(?:\?[^\s"'<>\\]*)?/gi;

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
  const RECALL_CAPTURE_CONCURRENCY = 10;

  const MAX_FOLLOW_PAGES = 60;
  const MAX_FOLLOW_LINKS = 250;
  const MAX_RETRIES = 2;

  const COPY_AFTER_SCRAPE = false;
  const CLOSE_TAB_AFTER_MANUAL_COPY = false;
  const CLOSE_DELAY_MS = 450;

  const AUTO_SCRAPE_KEY = 'uvs_auto_scrape_enabled_v1';
  const PANEL_POS_KEY = 'uvs_panel_position_v1';
  const PANEL_COLLAPSED_KEY = 'uvs_panel_collapsed_v1';
  const RECALL_CHANNEL_KEY = 'uvs_recall_channel_v1';
  const LAUNCHER_POS_KEY = 'uvs_launcher_position_v1';
  const VPN_PAIR_KEY = 'uvs_vpn_pair_v1';
  const VPN_USER_ACTION = Symbol('trusted VPN action');
  const RECALL_MIN_30_KEY = 'uvs_recall_min_30_v1';
  const PONG_ENDPOINTS = Array.isArray(globalThis.PONG_LOCAL_ENDPOINTS)
    ? globalThis.PONG_LOCAL_ENDPOINTS
    : ['http://192.168.1.124:8787', 'http://127.0.0.1:8787'];

  const PONG_ARTIST_PREFIX = '#PA|';
  const PONG_VIDEO_PREFIX = '#PV|';

  const TAG = '[UVS]';

  let lastResult = null;
  let busy = false;
  let panelStatusEl = null;
  let activeTargetPreview = null;
  const DETECTION_FEEDBACK_KEY = 'uvs_detection_feedback_pending_v1';
  let browserMediaRelayGeneration = 0;
  const browserMediaRelayRuns = new Map();
  const browserMediaRelayPreferredCandidates = new Map();

  // BEGIN SHARED PRIMARY VIDEO POLICY
function primaryVideoEvidence(html, pageUrl) {
  const source=String(html||'');
  const canonical=value=>{try{const u=new URL(typeof value==='object'?value?.['@id']||value?.url:value,pageUrl);u.hash='';return u.href.replace(/\/$/,'');}catch{return '';}};
  const page=canonical(pageUrl),objects=[];
  const walk=(v,depth=0)=>{
    if(!v||typeof v!=='object'||depth>12)return;
    if([v['@type']].flat().some(t=>/(?:^|\/)VideoObject$/.test(String(t))))objects.push(v);
    for(const [k,item]of Object.entries(v))if(k==='@graph'||k==='mainEntity'||Array.isArray(v))walk(item,depth+1);
  };
  for(const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(!/\btype\s*=\s*["']application\/ld\+json["']/i.test(m[1]))continue;
    try{walk(JSON.parse(m[2]));}catch{}
  }
  const matched=objects.filter(o=>[o.url,o['@id'],o.mainEntityOfPage,o.acquireLicensePage].some(v=>v&&canonical(v)===page));
  const chosen=matched.length===1?matched[0]:objects.length===1?objects[0]:null;
  if(!chosen)return null;
  const content=typeof chosen.contentUrl==='string'?chosen.contentUrl:'';
  let anchor;try{anchor=new URL(content,pageUrl);if(!/^https?:$/.test(anchor.protocol)||!content)return null;}catch{return null;}
  const media=/\.(?:mp4|m4v|mov|webm|mkv|m3u8|ogv)(?:[?#]|$)/i;
  if(!media.test(anchor.href))return null;
  // Alternate encodes may share the authoritative content's asset directory.
  // Generic /video/ or /media/ buckets are NOT an identity proof.
  const parent=anchor.pathname.slice(0,anchor.pathname.lastIndexOf('/')+1);
  const parts=parent.split('/').filter(Boolean);
  const safeDirectory=parts.length>=2&&!/^(?:videos?|media|files?|assets?|uploads?|download|mp4|hd|sd|(?:19|20)\d{2})$/i.test(parts.at(-1)||'');
  const decoded=source.replace(/\\u002f/gi,'/').replace(/\\u0026/gi,'&').replace(/\\\//g,'/').replace(/&amp;/gi,'&');
  const urls=[anchor.href];
  if(safeDirectory){
    for(const m of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m4v|mov|webm|mkv|m3u8|ogv)(?:\?[^\s"'<>\\]*)?/gi)){
      try{const u=new URL(m[0]);if(u.origin===anchor.origin&&u.pathname.startsWith(parent)&&u.pathname.slice(parent.length).indexOf('/')<0&&!/(?:preview|trailer|thumb|watermark)/i.test(u.pathname)&&!urls.includes(u.href))urls.push(u.href);}catch{}
    }
  }
  const score=value=>{
    const pathname=new URL(value).pathname;
    const dimensions=pathname.match(/(?:^|[_/-])(\d{3,4})[_x](\d{3,4})(?:[_./-]|$)/i);
    if(dimensions)return Number(dimensions[1])*Number(dimensions[2]);
    const height=Number(pathname.match(/(?:^|[_/-])(\d{3,4})p?(?:\.[a-z0-9]+$|[_/-])/i)?.[1]||0);
    return height>=144&&height<=4320?height*height*16/9:0;
  };
  // Known rendition sizes rank above unknown progressive files; the declared
  // content remains the tie-breaker. HLS masters are kept authoritative.
  urls.sort((a,b)=>Number(/master\.m3u8/i.test(b))-Number(/master\.m3u8/i.test(a))||score(b)-score(a));
  const rawDuration=String(chosen.duration||'');
  const iso=rawDuration.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  const durationSeconds=iso&&!Number(iso[1])&&!Number(iso[2])?Number(iso[3]||0)*86400+Number(iso[4]||0)*3600+Number(iso[5]||0)*60+Number(iso[6]||0):Number(rawDuration)||0;
  return {videoUrls:urls.slice(0,12),title:String(chosen.name||'').trim(),durationSeconds,contentUrl:anchor.href,identityEvidence:'page-video-object'};
}
  // END SHARED PRIMARY VIDEO POLICY

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

  async function fetchText(url, attempt = 1, options = {}) {
    const timeout = Math.max(3000, Number(options.timeout || 30000));
    const trace = diagnosticRequest(options.diagnostics, 'page_fetch', timeout);
    trace.credentialsEnabled = true; trace.refererSupplied = !!options.headers?.Referer;
    const maxRetries = Math.max(1, Number(options.maxRetries || MAX_RETRIES));
    let requestUrl = url;
    if (options.cacheBust) {
      try {
        const freshUrl = new URL(url, location.href);
        freshUrl.searchParams.set('_pong_relay', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        requestUrl = freshUrl.toString();
      } catch (_) {}
    }
    try {
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        return await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: requestUrl,
            timeout,
            anonymous: false,
            withCredentials: true,
            headers: {
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              ...(options.cacheBust ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } : {}),
              ...(options.headers || {})
            },
            onload: res => {
              trace.httpStatus = res.status; trace.contentType = diagnosticMime(responseHeaderValue(res.responseHeaders, 'content-type'));
              trace.redirected = res.finalUrl ? res.finalUrl !== requestUrl : null;
              finishDiagnosticRequest(trace, res.status >= 200 && res.status < 400 ? 'none' : 'http_error');
              if (res.status >= 200 && res.status < 400) {
                resolve(res.responseText || '');
              } else {
                reject(new Error(`HTTP ${res.status}`));
              }
            },
            onerror: () => { finishDiagnosticRequest(trace, 'network_error'); reject(new Error('Network error')); },
            ontimeout: () => { finishDiagnosticRequest(trace, 'timeout'); reject(new Error('Request timed out')); }
          });
        });
      }

      const res = await fetch(requestUrl, {
        credentials: 'include',
        cache: 'no-store'
      });

      trace.httpStatus = res.status; trace.contentType = diagnosticMime(res.headers.get('content-type')); trace.redirected = res.redirected;
      finishDiagnosticRequest(trace, res.ok ? 'none' : 'http_error');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return await res.text();
    } catch (e) {
      finishDiagnosticRequest(trace, 'request_error');
      if (attempt >= maxRetries) throw e;

      await sleep(400 * attempt);

      return fetchText(url, attempt + 1, options);
    }
  }

  async function fetchDoc(url, options = {}) {
    try {
      const html = await fetchText(url, 1, options);
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

  function extractPageDurationSeconds(doc = document) {
    const youtube = youtubePlayerData(doc, doc.__uvsUrl || location.href);
    if (youtube) return Number(youtube.videoDetails?.lengthSeconds || 0);
    const evidence = primaryVideoEvidence(String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || ''), doc.__uvsUrl || location.href);
    if (evidence?.durationSeconds > 0) return evidence.durationSeconds;
    const add = value => {
      const seconds = Number(value || 0);
      return Number.isFinite(seconds) && seconds > 0 && seconds < 86400 ? seconds : 0;
    };
    try {
      // The largest duration in the document is not necessarily the active
      // movie: watch pages commonly preload many recommendation cards. Prefer
      // the visible/largest player, then authoritative page metadata, then the
      // first player configuration value.
      const media = [...doc.querySelectorAll('video,audio')]
        .map(element => ({
          element,
          seconds: add(element.duration),
          area: Math.max(0, Number(element.clientWidth || 0) * Number(element.clientHeight || 0)),
          visible: element.getClientRects?.().length > 0
        }))
        .filter(item => item.seconds > 0)
        .sort((left, right) => Number(right.visible) - Number(left.visible) || right.area - left.area);
      if (media[0]?.seconds) return media[0].seconds;

      for (const meta of doc.querySelectorAll('meta[itemprop="duration"],meta[property="video:duration"],meta[name="duration"]')) {
        const value = String(meta.getAttribute('content') || '').trim();
        const iso = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
        const seconds = iso
          ? add((Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0))
          : add(value);
        if (seconds) return seconds;
      }
      const source = String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || '');
      const numeric = source.match(/["'](?:video_)?duration["']\s*:\s*["']?(\d+(?:\.\d+)?)/i);
      if (numeric && add(numeric[1])) return add(numeric[1]);
      const iso = source.match(/["']duration["']\s*:\s*["']PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)/i);
      if (iso) return add((Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0));
    } catch (_) {}
    return 0;
  }

  function scoreMediaQuality(value, label = '') {
    const text = `${value || ''} ${label || ''}`;
    if (/\b(?:4k|uhd|2160p?)\b/i.test(text)) return 2160;
    if (/\b(?:full\s*hd|fhd|1080p?)\b/i.test(text)) return 1080;
    if (/\b(?:hd|720p?)\b/i.test(text)) return 720;
    const dimensions = text.match(/(?:^|[_/-])(\d{3,4})[_x](\d{3,4})(?:[_./-]|$)/i);
    if (dimensions) return Math.max(Number(dimensions[1] || 0), Number(dimensions[2] || 0));
    const height = Number(text.match(/(?:^|[^a-z0-9])(\d{3,4})p?(?:[^a-z0-9]|$)/i)?.[1] || 0);
    return height >= 144 && height <= 4320 ? height : 0;
  }

  function decodeLiteralMediaValue(raw) {
    return String(raw || '')
      .replace(/\\\//g, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\u003d/gi, '=')
      .replace(/&amp;/gi, '&')
      .trim();
  }

  function literalSourceRecordsFromText(text, baseUrl) {
    const source = String(text || '');
    const records = [];
    const seen = new Set();
    const addRecord = (rawValue, label = '', order = records.length, declaredMedia = false) => {
      const value = absUrl(decodeLiteralMediaValue(rawValue), baseUrl);
      if (!value || !/^https?:\/\//i.test(value)) return;
      if (!declaredMedia && !VIDEO_EXT_RE.test(value)) return;
      if (/(?:^|[/_-])(?:ad|ads|advert|advertising|poster|preview|promo|sprite|thumb|thumbnail|trailer|watermark)(?:[/_.-]|$)/i.test(new URL(value).pathname)) return;
      const key = value;
      if (seen.has(key)) return;
      seen.add(key);
      records.push({ value, height: scoreMediaQuality(value, label), label: String(label || ''), order });
    };
    const literalValue = /(?:^|,)\s*["']?(?:file|src|url|videoUrl|video_url|contentUrl|hls|dash|mp4)["']?\s*:\s*(["'])(.*?)\1/gi;
    for (const arrays of source.matchAll(/["']?(?:sources|mediaDefinitions|media_definitions|files|qualities|renditions)["']?\s*:\s*\[([\s\S]*?)\]/gi)) {
      for (const object of arrays[1].matchAll(/\{([^{}]*)\}/g)) {
        const body = object[1];
        let value = '';
        literalValue.lastIndex = 0;
        const valueMatch = literalValue.exec(body);
        if (valueMatch) value = valueMatch[2];
        const label = [
          body.match(/["']?(?:label|quality|res|resolution|height|format)["']?\s*:\s*(["']?)([^"',}]+)\1/i)?.[2],
          body.match(/["']?type["']?\s*:\s*(["'])(.*?)\1/i)?.[2]
        ].filter(Boolean).join(' ');
        const declaredMedia = /(?:video\/|mpegurl|dash\+xml|mp4|webm|mov|hls|dash)/i.test(label) || VIDEO_EXT_RE.test(value);
        addRecord(value, label, records.length, declaredMedia);
      }
    }
    for (const match of source.matchAll(/\b(?:file|src|url|videoUrl|video_url|contentUrl|hls|dash|mp4)\b\s*:\s*(["'])(https?:\/\/.*?)\1/gi)) {
      const windowText = source.slice(Math.max(0, match.index - 120), Math.min(source.length, match.index + match[0].length + 160));
      if (/\b(?:advertising|adTag|poster|image|thumbnail|sprite|preview|trailer)\b/i.test(windowText)) continue;
      const declaredMedia = VIDEO_EXT_RE.test(match[2]) || /\b(?:video\/|mpegurl|dash\+xml|mp4|webm|mov|m3u8|mpd)\b/i.test(windowText);
      addRecord(match[2], windowText, records.length, declaredMedia);
    }
    return records
      .sort((left, right) => right.height - left.height || left.order - right.order)
      .filter((record, index, array) => array.findIndex(item => item.value === record.value) === index);
  }

  function responseHeaderValue(rawHeaders, name) {
    const wanted = String(name || '').toLowerCase();
    for (const line of String(rawHeaders || '').split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 1 || line.slice(0, separator).trim().toLowerCase() !== wanted) continue;
      return line.slice(separator + 1).trim();
    }
    return '';
  }

  function relaySafeHeader(value, maxLength = 3000) {
    return String(value || '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, maxLength);
  }

  function browserRelayRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload: response => resolve(response),
        onerror: () => reject(new Error('Browser relay request failed')),
        ontimeout: () => reject(new Error('Browser relay request timed out')),
        onabort: () => reject(new Error('Browser relay request was aborted'))
      });
    });
  }

  async function fetchBrowserMediaRelayRange(job) {
    const preferred = browserMediaRelayPreferredCandidates.get(job.sourceId);
    const candidates = [...new Set([
      ...(job.pinCandidate ? [] : [preferred]),
      ...(Array.isArray(job.candidates) ? job.candidates : [])
    ].map(value => String(value || '').trim()).filter(value => /^https?:\/\//i.test(value)))];
    let lastError = 'No captured media candidate was available';
    const tryCandidates = async values => {
      for (const candidate of values) {
        try {
          const response = await browserRelayRequest({
            method: 'GET',
            url: candidate,
            headers: {
              'Accept': 'video/*,application/octet-stream;q=0.9,*/*;q=0.5',
              'Range': String(job.range || 'bytes=0-2097151'),
              'Referer': String(job.pageUrl || location.href),
              ...(job.validator ? { 'If-Range': String(job.validator) } : {})
            },
            responseType: 'arraybuffer',
            timeout: 12000,
            anonymous: false
          });
          const body = response.response;
          const byteLength = Number(body?.byteLength || 0);
          const contentType = responseHeaderValue(response.responseHeaders, 'content-type');
          if (![200, 206].includes(Number(response.status)) || !byteLength) {
            throw new Error(`HTTP ${response.status || 0} from ${candidate}`);
          }
          if (/\b(?:text\/html|application\/json)\b/i.test(contentType)) {
            throw new Error(`Unexpected ${contentType}`);
          }
          if (Number(response.status) === 200 && byteLength > 2 * 1024 * 1024 + 64 * 1024) {
            throw new Error('The media host ignored the requested byte range');
          }
          browserMediaRelayPreferredCandidates.set(job.sourceId, candidate);
          return {
            status: Number(response.status),
            body,
            sourceUrl: candidate,
            contentType: contentType || 'video/mp4',
            contentRange: responseHeaderValue(response.responseHeaders, 'content-range'),
            etag: responseHeaderValue(response.responseHeaders, 'etag'),
            lastModified: responseHeaderValue(response.responseHeaders, 'last-modified'),
            acceptRanges: responseHeaderValue(response.responseHeaders, 'accept-ranges') || 'bytes'
          };
        } catch (error) {
          lastError = error?.message || String(error);
        }
      }
      return null;
    };
    // HQPorner's nested player URLs are intentionally short-lived. Trying all
    // captured resolutions first adds several doomed round trips before the
    // useful refresh, so go straight to the fresh-player path for this host.
    const forceFreshPlayer = /(?:^|\.)hqporner\.com\b/i.test(String(job.pageUrl || ''));
    const capturedResult = forceFreshPlayer && !job.pinCandidate ? null : await tryCandidates(job.pinCandidate ? candidates.slice(0, 1) : candidates);
    if (capturedResult) return capturedResult;
    // Never mix a refreshed/lower-quality rendition into an in-progress file.
    if (job.pinCandidate) throw new Error('The selected file could not be transferred. Keep Firefox open and send again.');

    // Some HQPorner CDN URLs are short-lived per-page grants: the 1 KiB proof
    // succeeds, but the same path can become 404 before Android requests its
    // first frame. Refresh that exact logical page inside the authenticated
    // source browser and retry the requested range against newly minted URLs.
    try {
      const pageUrl = String(job.pageUrl || location.href);
      // A normal HTTP/browser cache hit is harmful here. The nested HQPorner
      // player intentionally mints a different short-lived CDN path on every
      // fresh request, so force both the watch page and its player document to
      // be fetched again for each relay recovery.
      const pageDoc = await fetchDoc(pageUrl, {
        timeout: 12000,
        maxRetries: 2,
        cacheBust: true,
        headers: { Referer: pageUrl }
      }) || (pageUrl === location.href ? document : null);
      const refreshedEntries = pageDoc
        ? await browserResolvedMediaEntries(
            pageDoc,
            pageUrl,
            extractPageDurationSeconds(pageDoc),
            0,
            new Set(),
            { cacheBust: true }
          )
        : [];
      // Reloading an HQPorner page can refresh the browser-side grant/cookie
      // while deliberately returning the *same* CDN URL. Do not discard that
      // URL as a duplicate: it must be retried after the page refresh. Keep the
      // page's freshly observed order first, then retry the captured fallbacks.
      const refreshedCandidates = [...new Set([
        ...refreshedEntries.flatMap(entry => [entry?.videoUrl, entry?.rawVideoUrl]),
        ...candidates
      ].map(value => String(value || '').trim()).filter(value => /^https?:\/\//i.test(value)))];
      const refreshedResult = await tryCandidates(refreshedCandidates);
      if (refreshedResult) return refreshedResult;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    throw new Error(lastError);
  }

  async function completeBrowserMediaRelayJob(endpoint, job) {
    let result;
    try {
      result = await fetchBrowserMediaRelayRange(job);
    } catch (error) {
      result = {
        status: 502,
        body: new ArrayBuffer(0),
        contentType: 'text/plain',
        contentRange: '',
        acceptRanges: 'bytes',
        sourceUrl: '',
        error: error?.message || String(error)
      };
    }
    const response = await browserRelayRequest({
      method: 'POST',
      url: `${endpoint}/media-browser-relay/jobs/${encodeURIComponent(job.id)}/result`,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Pong-SimpCity-Controller': '1',
        'X-Pong-Relay-Status': String(result.status || 502),
        'X-Pong-Relay-Content-Type': relaySafeHeader(result.contentType, 200),
        'X-Pong-Relay-Content-Range': relaySafeHeader(result.contentRange, 200),
        'X-Pong-Relay-Accept-Ranges': relaySafeHeader(result.acceptRanges, 40),
        'X-Pong-Relay-Source-Url': relaySafeHeader(result.sourceUrl),
        'X-Pong-Relay-Etag': relaySafeHeader(result.etag, 300),
        'X-Pong-Relay-Last-Modified': relaySafeHeader(result.lastModified, 100),
        'X-Pong-Relay-Error': relaySafeHeader(result.error, 500)
      },
      data: result.body,
      timeout: 30000
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Relay upload HTTP ${response.status}`);
    }
  }

  function startBrowserMediaRelay(rawEndpoint, clientId, channel = 0) {
    const endpoint = String(rawEndpoint || '').replace(/\/+$/, '');
    const generation = ++browserMediaRelayGeneration;
    const key = `${endpoint}|${channel}`;
    browserMediaRelayRuns.set(key, generation);
    const worker = async () => {
      while (generation === browserMediaRelayRuns.get(key)) {
        try {
          const response = await browserRelayRequest({
            method: 'GET',
            url: `${endpoint}/media-browser-relay/jobs?clientId=${encodeURIComponent(clientId)}`,
            headers: { 'X-Pong-SimpCity-Controller': '1' },
            timeout: 30000
          });
          if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
          const payload = JSON.parse(response.responseText || '{}');
          if (payload?.expired) {
            if (generation === browserMediaRelayRuns.get(key)) browserMediaRelayRuns.delete(key);
            if (location.pathname === '/browser-relay-keeper') setTimeout(() => window.close(), 100);
            return;
          }
          if (payload?.job) await completeBrowserMediaRelayJob(endpoint, payload.job);
        } catch (_) {
          if (generation === browserMediaRelayRuns.get(key)) await sleep(500);
        }
      }
    };
    // Two Recall channels can coexist without six idle long-polls occupying
    // every browser connection slot needed for capture acknowledgements.
    for (let index = 0; index < (channel ? 2 : 3); index++) worker();
  }

  function canonicalWatchPageUrl(rawUrl, baseUrl = location.href) {
    try {
      // Firefox extension compartments do not reliably coerce a page-owned URL
      // object when it crosses into the userscript world. Normalize explicitly.
      const raw = typeof rawUrl === 'object' && rawUrl?.href ? rawUrl.href : String(rawUrl || '');
      const base = typeof baseUrl === 'object' && baseUrl?.href ? baseUrl.href : String(baseUrl || location.href);
      const url = new URL(raw, base);
      url.hash = '';
      if (/(^|\.)youtube\.com$/i.test(url.hostname) && url.pathname === '/watch' && url.searchParams.get('v')) {
        const videoId = url.searchParams.get('v'); url.search = ''; url.searchParams.set('v', videoId);
      }
      const queryKeys = [];
      url.searchParams.forEach((_value, key) => queryKeys.push(key));
      for (const key of queryKeys) {
        if (/^(?:utm_.+|ref|src|source|track|click)$/i.test(key)) url.searchParams.delete(key);
      }
      return url.toString();
    } catch (error) {
      try { document.documentElement.dataset.uvsCanonicalError = error?.message || String(error); } catch (_) {}
      return '';
    }
  }

  function parseDurationHintSeconds(rawText) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) return 0;
    const words = text.match(/(?:(\d{1,2})\s*h(?:ours?)?\s*)?(?:(\d{1,3})\s*m(?:in(?:ute)?s?)?\.?\s*)?(\d{1,2})\s*s(?:ec(?:ond)?s?)?\.?/i);
    if (words && (words[1] || words[2])) {
      const seconds = Number(words[1] || 0) * 3600 + Number(words[2] || 0) * 60 + Number(words[3] || 0);
      if (seconds > 0 && seconds < 86400) return seconds;
    }
    const clock = text.match(/(?:^|\s)(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\s|$)/);
    if (clock) {
      const seconds = Number(clock[1] || 0) * 3600 + Number(clock[2] || 0) * 60 + Number(clock[3] || 0);
      if (Number(clock[3]) < 60 && seconds > 0 && seconds < 86400) return seconds;
    }
    return 0;
  }

  function logicalPageDurationHint(anchor) {
    if (!anchor) return 0;
    const candidates = [
      anchor.textContent,
      anchor.closest('article,li,[class*="video-card" i],[class*="thumb" i]')?.textContent
    ];
    // HQPorner puts the clock in the second sibling after the image link.
    let sibling = anchor.parentElement;
    for (let index = 0; sibling && index < 3; index++) {
      sibling = sibling.nextElementSibling;
      if (sibling) candidates.push(sibling.textContent);
    }
    return candidates.reduce((best, value) => Math.max(best, parseDurationHintSeconds(value)), 0);
  }

  function isLogicalVideoPageUrl(rawUrl, baseUrl = location.href, anchor = null) {
    try {
      const url = new URL(rawUrl, baseUrl);
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      const path = url.pathname + url.search;
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (/(^|\.)youtube\.com$/i.test(url.hostname) || /(^|\.)youtu\.be$/i.test(url.hostname)) return !!youtubeVideoId(url.href);
      if (host === 'pornhub.com') return /\/view_video\.php\?[^#]*\bviewkey=[^&#]+/i.test(path);
      if (host.endsWith('hqporner.com')) return /^\/hdporn\/[^/?#]+/i.test(url.pathname);
      if (host.endsWith('suj.mobi')) return /\/(?:[a-z]{2}\/)?scene\/[^/?#]+/i.test(url.pathname);
      if (host === 'porneec.com') {
        if (anchor?.closest?.('article.thumb-block,article.video-preview-item')) return true;
        const reserved = /^(?:channels?|actors?|disclaimer|privacy-policy|dmca|2257-statement|page|c|category|tag|wp-|feed)(?:\/|$)/i;
        const slug = url.pathname.replace(/^\/+|\/+$/g, '');
        return !!slug && !slug.includes('/') && !reserved.test(slug);
      }
      if (/\/(?:free-stock-video|free-video|premium-video)\/[^/?#]*[-_]\d+\/?$/i.test(url.pathname)) return true;
      if (/\/[^/]+\/\d+-[^/]+\/?$/.test(url.pathname)) return true;
      if (/\/wiki\/File:[^/]+\.(?:webm|mp4|ogv)$/i.test(url.pathname)) return true;
      if (/^(?:www\.)?vimeo\.com$/.test(url.hostname) && /^\/\d+$/.test(url.pathname)) return true;
      if (/(?:^|\.)youtube\.com$/.test(url.hostname) && url.pathname === '/watch' && url.searchParams.get('v')) return true;
      return /\/(?:watch|videos?|scene|post|talks|details)\/(?!search(?:[/?#]|$)|category(?:[/?#]|$)|tags?(?:[/?#]|$))[^/?#]+/i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function collectLogicalWatchPageTargets(doc = document, rawUrl = location.href, limit = 80) {
    const currentUrl = canonicalWatchPageUrl(rawUrl, rawUrl);
    const current = new URL(currentUrl || rawUrl, rawUrl);
    const isPornhubWatch = /(^|\.)pornhub\.com$/i.test(current.hostname) &&
      /\/view_video\.php\?[^#]*\bviewkey=/i.test(current.pathname + current.search);
    let collectError = '';
    let collectStats = {};
    const collect = (selector, prevalidated = false) => {
      const found = [];
      const seen = new Map();
      const stats = { matched: 0, foreign: 0, invalid: 0, empty: 0, same: 0, added: 0 };
      for (const anchor of doc.querySelectorAll(selector)) {
        stats.matched++;
        try {
          const url = new URL(anchor.getAttribute('href') || anchor.href, current);
          if (url.hostname.toLowerCase() !== current.hostname.toLowerCase()) { stats.foreign++; continue; }
          if (!prevalidated && !isLogicalVideoPageUrl(url, current, anchor)) { stats.invalid++; continue; }
          const normalized = canonicalWatchPageUrl(url, current);
          if (!normalized) { stats.empty++; continue; }
          if (normalized === currentUrl) { stats.same++; continue; }
          const durationSeconds = logicalPageDurationHint(anchor);
          if (seen.has(normalized)) {
            const existing = found[seen.get(normalized)];
            existing.durationSeconds = Math.max(existing.durationSeconds, durationSeconds);
            continue;
          }
          seen.set(normalized, found.length);
          found.push({ url: normalized, durationSeconds });
          stats.added++;
        } catch (error) {
          collectError = error?.message || String(error);
        }
      }
      collectStats = stats;
      return found;
    };

    let related = [];
    if (isPornhubWatch) {
      const selectors = [
        '#relatedVideosCenter li.pcVideoListItem a[href*="view_video.php?viewkey="]',
        '#relatedVideosVPage li.pcVideoListItem a[href*="view_video.php?viewkey="]',
        '[id*="related" i] li.pcVideoListItem a[href*="view_video.php?viewkey="]',
        'li.pcVideoListItem a[href*="view_video.php?viewkey="]'
      ];
      for (const selector of selectors) {
        const candidates = collect(selector, true);
        if (candidates.length >= 2) {
          related = candidates;
          break;
        }
      }
      // Main plus the first nineteen genuine recommendation cards is the
      // twenty-video watch-page Recall contract. Hidden carousels stay out.
      related = related.slice(0, 19);
    } else {
      const host = current.hostname.replace(/^www\./i, '').toLowerCase();
      const selector = host.endsWith('hqporner.com')
        ? 'a[href*="/hdporn/"]'
        : host.endsWith('suj.mobi')
          ? 'a[href*="/scene/"]'
          : host === 'porneec.com'
            ? 'article.thumb-block a[href],article.video-preview-item a[href]'
            : host === 'pornhub.com'
              ? 'li.pcVideoListItem a[href*="view_video.php?viewkey="],a.latestThumb[href*="view_video.php?viewkey="],[data-video-vkey] a[href]'
              : 'li.videoBox a[href],li.pcVideoListItem a[href],article a[href],[data-video-vkey] a[href],[class*="video-card" i] a[href]';
      related = collect(selector, host.endsWith('hqporner.com') || host.endsWith('suj.mobi'));
      if (!related.length) related = collect('a[href]');
      try {
        document.documentElement.dataset.uvsTargetDiagnostics = JSON.stringify({
          host,
          selector,
          matched: doc.querySelectorAll(selector).length,
          related: related.length,
          collectError,
          collectStats,
          canonicalError: document.documentElement.dataset.uvsCanonicalError || ''
        });
      } catch (_) {}
    }
    const groups = related.length ? [] : independentVideoGroupsFromDoc(doc, currentUrl);
    const hasPlayer = primaryMediaEntriesFromDoc(doc, currentUrl).length > 0 || embeddedPlayerPageUrls(doc, currentUrl).length > 0;
    const currentTarget = groups.length > 1
      ? groups.map(group => ({ url: currentUrl, durationSeconds: group.durationSeconds, logicalVideoId: group.logicalVideoId }))
      : isLogicalVideoPageUrl(current, current) || (!related.length && hasPlayer)
        ? [{ url: currentUrl, durationSeconds: extractPageDurationSeconds(doc) }]
        : [];
    return [...currentTarget, ...related]
      .slice(0, Math.max(1, Number(limit || 80)));
  }

  function collectLogicalWatchPageUrls(doc = document, rawUrl = location.href, limit = 80) {
    return collectLogicalWatchPageTargets(doc, rawUrl, limit).map(target => target.url);
  }

  function primaryMediaEntriesFromDoc(doc = document, pageUrl = location.href) {
    const evidence = primaryVideoEvidence(String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || ''), pageUrl);
    if (evidence) return enrichRenditionQuality(doc, pageUrl, evidence.videoUrls.map(videoUrl => ({
      videoUrl, rawVideoUrl: videoUrl, postUrl: pageUrl, pageUrl,
      title: evidence.title, durationSeconds: evidence.durationSeconds,
      identityEvidence: evidence.identityEvidence
    })));
    const durationSeconds = extractPageDurationSeconds(doc);
    const prioritized = [];
    const add = (rawValue, declaredMedia = false) => {
      const value = absUrl(rawValue, pageUrl);
      if (!value || !/^https?:\/\//i.test(value) || (!declaredMedia && !VIDEO_EXT_RE.test(value))) return;
      if (/(?:^|[/_-])(?:preview|trailer|thumb)(?:[/_.-]|$)/i.test(new URL(value).pathname)) return;
      if (!prioritized.includes(value)) prioritized.push(value);
    };
    try {
      // Playerjs/KVS pages often put every rendition in one labelled `file`
      // string while the live <video> element points at the site's low default.
      // Preserve those labels and put the highest declared rendition first;
      // opaque filenames such as `_7.mp4` do not otherwise reveal that they
      // are HD while `_3.mp4` is only 360p.
      const rawHtml = String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || '');
      const labelledSources = [];
      for (const match of rawHtml.matchAll(/\bfile\s*:\s*["']([^"']+)["']/gi)) {
        for (const item of match[1].split(',')) {
          const labelled = item.match(/^\s*\[([^\]]+)]\s*(https?:\/\/.+)\s*$/i);
          if (!labelled) continue;
          const label = labelled[1].trim().toLowerCase();
          const height = scoreMediaQuality(labelled[2], label);
          labelledSources.push({ value: labelled[2], height, order: labelledSources.length });
        }
      }
      labelledSources
        .sort((left, right) => right.height - left.height || left.order - right.order)
        .forEach(source => add(source.value));
      literalSourceRecordsFromText(rawHtml, pageUrl)
        .forEach(source => add(source.value, true));

      const media = [...doc.querySelectorAll('video')]
        .map(element => ({
          element,
          area: Math.max(0, Number(element.clientWidth || 0) * Number(element.clientHeight || 0)),
          visible: element.getClientRects?.().length > 0
        }))
        .sort((left, right) => Number(right.visible) - Number(left.visible) || right.area - left.area);
      for (const item of media.slice(0, 2)) {
        add(item.element.currentSrc, true);
        add(item.element.getAttribute('src'), true);
        item.element.querySelectorAll('source[src]').forEach(source => add(source.getAttribute('src'), true));
      }
      if (doc === document && typeof performance?.getEntriesByType === 'function') {
        performance.getEntriesByType('resource')
          .map(entry => String(entry?.name || ''))
          .filter(value => /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(value))
          .reverse()
          .slice(0, 4)
          .forEach(add);
      }
      doc.querySelectorAll(
        'meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[itemprop="contentUrl"]'
      ).forEach(meta => add(meta.getAttribute('content')));

      const identity = rawHtml.match(/["']?video[_-]?id["']?\s*[:=]\s*["']?(\d{5,})/i)?.[1] || '';
      const scriptCandidates = [];
      for (const script of doc.querySelectorAll('script')) {
        const text = String(script.textContent || '');
        // Read literal source records only; never evaluate a page's player code.
        // Restrict this to sources arrays so advertising.file and poster URLs
        // cannot masquerade as the main JW Player/video.js source.
        for (const sources of text.matchAll(/["']?sources["']?\s*:\s*\[([^\]]*)\]/gi)) {
          const literalSources = [];
          for (const object of sources[1].matchAll(/\{([^{}]*)\}/g)) {
            const raw = object[1].match(/(?:^|,)\s*["']?(?:file|src)["']?\s*:\s*(["'])(.*?)\1\s*(?=,|$)/i)?.[2];
            if (!raw) continue;
            const value = raw.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
            const label = object[1].match(/["']?(?:label|res|height)["']?\s*:\s*["']?(\d{3,4})/i)?.[1];
            literalSources.push({ value, height: Number(label || 0) });
          }
          literalSources.sort((a, b) => b.height - a.height).forEach(item => add(item.value, true));
          // Explicit resolution labels outrank a live player's low default.
          for (const item of literalSources.filter(item => item.height > 0).reverse()) {
            const value = absUrl(item.value, pageUrl), index = prioritized.indexOf(value);
            if (index >= 0) { prioritized.splice(index, 1); prioritized.unshift(value); }
          }
        }
        literalSourceRecordsFromText(text, pageUrl).forEach(source => add(source.value, true));
        if (!/(?:mediaDefinitions|flashvars|videoUrl|video_url|contentUrl)/i.test(text)) continue;
        extractVideoUrlsFromText(text, pageUrl).forEach(value => {
          const normalized = absUrl(value, pageUrl);
          if (normalized && !scriptCandidates.includes(normalized)) scriptCandidates.push(normalized);
        });
      }
      const ownCandidates = identity
        ? scriptCandidates.filter(value => value.includes(`/${identity}/`) || value.includes(`_${identity}.`))
        : [];
      const ranked = (ownCandidates.length ? ownCandidates : scriptCandidates)
        .filter(value => !/(?:^|[/_-])(?:preview|trailer|thumb)(?:[/_.-]|$)/i.test(new URL(value).pathname))
        .map((value, index) => ({
          value,
          index,
          score: (/master\.m3u8(?:[?#]|$)/i.test(value) ? 10_000_000 : 0) +
            (/\.m3u8(?:[?#]|$)/i.test(value) ? 1_000_000 : 0) +
            Number(value.match(/(?:^|[/_-])(\d{3,4})P(?:[_./-]|$)/i)?.[1] || 0)
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index);
      ranked.slice(0, 4).forEach(item => add(item.value));
    } catch (_) {}
    return enrichRenditionQuality(doc, pageUrl, prioritized.slice(0, 12).map(videoUrl => ({
      videoUrl,
      rawVideoUrl: videoUrl,
      postUrl: pageUrl,
      pageUrl,
      durationSeconds
    })));
  }

  // Enrich only identity-admitted renditions. Page-wide quality labels must
  // never import a recommendation/ad as an alternate encode of the main video.
  function enrichRenditionQuality(doc, pageUrl, entries) {
    const byUrl = new Map(entries.map(entry => [entry.videoUrl, { ...entry }]));
    const html = String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || '');
    const label = (rawUrl, value) => {
      const entry = byUrl.get(absUrl(decodeLiteralMediaValue(rawUrl), pageUrl));
      const height = scoreMediaQuality('', value);
      if (entry && height && !entry.height) Object.assign(entry, { height, qualityEvidence: 'player_label' });
    };
    for (const item of literalSourceRecordsFromText(html, pageUrl)) label(item.value, item.label);
    for (const match of html.matchAll(/\bfile\s*:\s*["']([^"']+)["']/gi)) {
      for (const item of match[1].split(',')) {
        const pair = item.match(/^\s*\[([^\]]+)]\s*(https?:\/\/.+)\s*$/i);
        if (pair) label(pair[2], pair[1]);
      }
    }
    for (const video of doc.querySelectorAll('video')) {
      if (video.closest?.('aside,[role="complementary"],[data-ad],.advertisement,.ad-container')) continue;
      const sources = [...video.querySelectorAll('source[src]')];
      const urls = [video.currentSrc, video.getAttribute('src'), ...sources.map(s => s.getAttribute('src'))]
        .filter(Boolean).map(value => absUrl(value, pageUrl)).filter(value => /^https?:\/\//i.test(value));
      const anchor = urls.map(url => byUrl.get(url)).find(Boolean);
      if (!anchor) continue; // A shared duration alone is not identity evidence.
      for (const url of urls) {
        if (/(?:^|[/_-])(?:preview|trailer|thumb)(?:[/_.-]|$)/i.test(new URL(url).pathname)) continue;
        if (!byUrl.has(url)) byUrl.set(url, { ...anchor, videoUrl: url, rawVideoUrl: url,
          width: null, height: null, browserCurrent: false, qualityEvidence: 'unknown' });
      }
      for (const source of sources) label(source.getAttribute('src'),
        source.getAttribute('label') || source.getAttribute('res') || source.getAttribute('data-res') || source.getAttribute('size'));
      const current = byUrl.get(absUrl(video.currentSrc || '', pageUrl));
      if (current && video.videoWidth > 0 && video.videoHeight > 0) {
        Object.assign(current, { width: video.videoWidth, height: video.videoHeight,
          qualityEvidence: 'live_decoder', browserCurrent: true });
      }
    }
    return [...byUrl.values()];
  }

  function independentVideoGroupsFromDoc(doc, pageUrl) {
    if (primaryVideoEvidence(String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || ''), pageUrl)) return [];
    const groups = [];
    for (const [index, video] of [...doc.querySelectorAll('video')].entries()) {
      if (video.closest('aside,[role="complementary"],[data-ad],.advertisement,.ad-container')) continue;
      const isolated = doc.implementation.createHTMLDocument('');
      const base = isolated.createElement('base'); base.href = pageUrl; isolated.head.appendChild(base);
      isolated.body.appendChild(video.cloneNode(true));
      isolated.__uvsUrl = pageUrl;
      const durationSeconds = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration : Number(video.getAttribute('data-duration') || 0);
      const entries = primaryMediaEntriesFromDoc(isolated, pageUrl).map(entry => ({
        ...entry, durationSeconds,
        title: video.getAttribute('title') || video.getAttribute('aria-label') || ''
      }));
      if (entries.length) groups.push({ logicalVideoId: `inline-video-${index + 1}`, durationSeconds, entries });
    }
    return groups;
  }

  function embeddedPlayerPageUrls(doc, pageUrl, limit = 4) {
    const values = [];
    const add = rawValue => {
      try {
        const url = new URL(rawValue, pageUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return;
        if (/(?:adtng|doubleclick|googlesyndication|trafficjunky|smartpop|splash\.php)/i.test(url.href)) return;
        url.hash = '';
        const normalized = url.toString();
        if (normalized !== pageUrl && !values.includes(normalized)) values.push(normalized);
      } catch (_) {}
    };
    try {
      doc.querySelectorAll(
        '#playerWrapper iframe[src],.video-container iframe[src],[class*="player" i] iframe[src],' +
        'iframe[src*="/video/"],iframe[src*="/embed/"],iframe[src*="player"]'
      ).forEach(frame => add(frame.getAttribute('src') || frame.src));
      // Public players are often declared in metadata before an iframe exists.
      // Use only explicitly declared player links, never arbitrary script URLs.
      doc.querySelectorAll('meta[name="twitter:player"],meta[property="og:video"],meta[property="og:video:secure_url"],link[itemprop="embedUrl"]')
        .forEach(element => {
          const value = element.getAttribute('content') || element.getAttribute('href');
          if (value && !VIDEO_EXT_RE.test(value)) add(value);
        });
      const rawHtml = String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || '');
      const patterns = [
        /(?:nativeplayer|altplayer)\.php\?i=([^"'&\s<>]+)/gi,
        /<iframe[^>]+src=["']([^"']*(?:\/video\/|\/embed\/|player)[^"']*)["']/gi
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(rawHtml))) add(match[1]);
      }
    } catch (_) {}
    return values.slice(0, Math.max(1, Number(limit || 4)));
  }

  function youtubeVideoId(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!/(^|\.)youtube\.com$/i.test(url.hostname) && url.hostname !== 'youtu.be') return '';
      const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1];
      return /^[\w-]{11}$/.test(id || '') ? id : '';
    } catch (_) { return ''; }
  }

  function youtubePlayerData(doc, pageUrl) {
    const id = youtubeVideoId(pageUrl);
    if (!id) return null;
    const matches = value => value?.videoDetails?.videoId === id;
    if (doc === document) {
      try {
        const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
        const live = pageWindow.document?.getElementById('movie_player')?.getPlayerResponse?.();
        if (matches(live)) return live;
        if (matches(pageWindow.ytInitialPlayerResponse)) return pageWindow.ytInitialPlayerResponse;
      } catch (_) {}
    }
    const html = String(doc.__uvsRawHtml || doc.documentElement?.innerHTML || '');
    for (const match of html.matchAll(/(?:ytInitialPlayerResponse\s*=|["']ytInitialPlayerResponse["']\s*\]\s*=)\s*\{/g)) {
      const start = match.index + match[0].lastIndexOf('{');
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < Math.min(html.length, start + 2000000); i++) {
        const char = html[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try { const value = JSON.parse(html.slice(start, i + 1)); if (matches(value)) return value; } catch (_) {}
          break;
        }
      }
    }
    return null;
  }

  async function youtubeMediaEntries(doc, pageUrl, options = {}) {
    const player = youtubePlayerData(doc, pageUrl);
    const status = player?.playabilityStatus?.status;
    if (status && status !== 'OK') throw Object.assign(new Error('YouTube requires access in the browser'), { code: 'youtube_access' });
    const durationSeconds = Number(player?.videoDetails?.lengthSeconds || 0);
    const entry = url => ({ videoUrl: url, postUrl: pageUrl, pageUrl, contextUrl: pageUrl,
      durationSeconds, title: String(player?.videoDetails?.title || ''), identityEvidence: 'youtube-video-id' });
    if (player?.streamingData?.hlsManifestUrl) return [entry(player.streamingData.hlsManifestUrl)];
    // Public YouTube commonly exposes SABR rather than reusable URLs. Resolve
    // its public HLS master on the Pong PC, preserving video AND audio tracks.
    const receivers = PONG_ENDPOINTS.map(endpoint => { const url = new URL(endpoint); url.port = '8797'; return url.origin; });
    let helperNeedsUpdate = false;
    for (const receiver of receivers) {
      if (options.signal?.aborted) throw Object.assign(new Error('Timed out'), { code: 'timeout' });
      const trace = diagnosticRequest(options.diagnostics, 'platform_resolve', 25000);
      try {
        const payload = await new Promise((resolve, reject) => {
          let request, settled = false;
          const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); finishDiagnosticRequest(trace, error ? error.code || 'request_error' : 'none'); error ? reject(error) : resolve(value); };
          const abort = () => { finish(Object.assign(new Error('Timed out'), { code: 'timeout' })); try { request?.abort(); } catch (_) {} };
          const timer = setTimeout(abort, 26000);
          options.signal?.addEventListener('abort', abort, { once: true });
          try { request = GM_xmlhttpRequest({ method: 'POST', url: `${receiver}/media-page/youtube-resolve`,
            headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ videoId: youtubeVideoId(pageUrl) }), timeout: 25000,
            onload: response => { try {
              trace.httpStatus = response.status;
              if (response.status === 404) throw Object.assign(new Error('Pong capture helper needs restart'), { code: 'youtube_helper_update' });
              const data = JSON.parse(response.responseText || '{}');
              trace.parsedResponse = true; trace.helperVersion = data.helperVersion;
              if (response.status !== 200 || data.videoId !== youtubeVideoId(pageUrl) || !data.videoUrl) throw new Error('No YouTube stream');
              finish(null, data);
            } catch (error) { finish(error); } },
            onerror: () => finish(Object.assign(new Error('YouTube resolver unavailable'), { code: 'network_error' })), ontimeout: abort, onabort: abort
          }); } catch (error) { finish(error); }
        });
        return [{ ...entry(payload.videoUrl), durationSeconds: Number(payload.durationSeconds || durationSeconds), height: diagnosticNumber(payload.height, 32768), qualityEvidence: 'resolver', title: payload.title || entry('').title }];
      } catch (error) { if (options.signal?.aborted) throw error; if (error?.code === 'youtube_helper_update') helperNeedsUpdate = true; }
    }
    const formats = (player?.streamingData?.formats || []).filter(format => format.url && /^video\//.test(format.mimeType || '')).sort((a,b) => (b.height || 0) - (a.height || 0));
    if (formats.length) return formats.map(format => ({ ...entry(format.url), width: format.width, height: format.height,
      fps: format.fps, bitrate: format.bitrate, qualityEvidence: 'resolver' }));
    throw Object.assign(new Error(helperNeedsUpdate ? 'Restart the updated Pong capture helper; Copy log for details' : 'YouTube stream unavailable; Copy log for details'), { code: helperNeedsUpdate ? 'youtube_helper_update' : 'youtube_stream' });
  }

  async function browserResolvedMediaEntries(doc, pageUrl, durationHint = 0, depth = 0, seen = new Set(), options = {}) {
    if (options.signal?.aborted) throw Object.assign(new Error('Timed out'), { code: 'timeout' });
    if (youtubeVideoId(pageUrl)) return youtubeMediaEntries(doc, pageUrl, options);
    const durationSeconds = Math.max(Number(durationHint || 0), extractPageDurationSeconds(doc));
    const direct = primaryMediaEntriesFromDoc(doc, pageUrl).map(entry => ({
      ...entry,
      durationSeconds: Math.max(Number(entry.durationSeconds || 0), durationSeconds),
      contextUrl: pageUrl
    }));
    if (direct.length) return direct;
    if (depth >= 2) {
      return extractVideoUrls(doc, pageUrl)
        .filter(value => !/(?:^|[/_-])(?:preview|trailer|thumb)(?:[/_.-]|$)/i.test(new URL(value).pathname))
        .slice(0, 8)
        .map(videoUrl => ({
          videoUrl,
          rawVideoUrl: videoUrl,
          postUrl: pageUrl,
          pageUrl,
          contextUrl: pageUrl,
          durationSeconds
        }));
    }
    for (const playerUrl of embeddedPlayerPageUrls(doc, pageUrl)) {
      if (options.signal?.aborted) throw Object.assign(new Error('Timed out'), { code: 'timeout' });
      if (seen.has(playerUrl)) continue;
      seen.add(playerUrl);
      const playerDoc = await fetchDoc(playerUrl, {
        timeout: 12000,
        maxRetries: Math.max(1, Number(options.maxRetries || 2)),
        cacheBust: options.cacheBust === true,
        diagnostics: options.diagnostics,
        headers: { Referer: pageUrl }
      });
      if (!playerDoc) continue;
      const broad = extractVideoUrls(playerDoc, playerUrl)
        .filter(value => !/(?:^|[/_-])(?:preview|trailer|thumb)(?:[/_.-]|$)/i.test(new URL(value).pathname))
        .slice(0, 8)
        .map(videoUrl => ({
          videoUrl,
          rawVideoUrl: videoUrl,
          postUrl: pageUrl,
          pageUrl,
          contextUrl: playerUrl,
          durationSeconds
        }));
      if (broad.length) return broad;
      const nested = await browserResolvedMediaEntries(playerDoc, playerUrl, durationSeconds, depth + 1, seen, options);
      if (nested.length) return nested.map(entry => ({ ...entry, postUrl: pageUrl, pageUrl }));
    }
    return [];
  }

  function isLikelyWatchPage(rawUrl = location.href) {
    try {
      const url = new URL(rawUrl, location.href);
      return isLogicalVideoPageUrl(url, location.href) || Boolean(document.querySelector(
        'meta[property="og:type"][content^="video" i],meta[property="og:video"],meta[itemprop="contentUrl"]'
      ));
    } catch (_) {
      return false;
    }
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
      const durationSeconds = doc ? extractPageDurationSeconds(doc) : 0;
      if (durationSeconds > 0) {
        entries = entries.map(entry => ({ ...entry, durationSeconds }));
      }

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

  // Diagnostic output is an allowlist: never copy URLs, headers, response
  // bodies, page text, cookie values, or exception messages into a shared log.
  function diagnosticNumber(value, max = 86400000) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Math.min(max, Math.max(0, Number(value))) : null;
  }

  function diagnosticFailure(value) {
    const aliases = { youtube_access: 'platform_access', youtube_stream: 'platform_stream', youtube_helper_update: 'helper_update' };
    const code = aliases[value] || value;
    return ['none','pending','timeout','aborted','network_error','request_error','http_error','server_rejected','invalid_response','not_accepted',
      'platform_access','platform_stream','helper_update','extraction_error','no_media','duration_filter','media_unverified','page_fetch',
      'non_media_response','invalid_url','delivery_failed'].includes(code) ? code : 'request_error';
  }

  function diagnosticMime(value) {
    const type = String(value || '').split(';')[0].trim().toLowerCase();
    if (type === 'unknown' || type === 'other') return type;
    return ['video/mp4','video/webm','video/quicktime','video/ogg','video/x-matroska','application/vnd.apple.mpegurl','application/x-mpegurl',
      'audio/mpegurl','audio/x-mpegurl','application/dash+xml','application/octet-stream','text/html','text/plain','application/json','application/xml'].includes(type) ? type : type ? 'other' : 'unknown';
  }

  function diagnosticStreamType(value) {
    const url = String(value || '');
    if (/\.m3u8(?:[?#]|$)|\/manifest\/hls|\/api\/manifest\/hls/i.test(url)) return 'hls';
    if (/\.mpd(?:[?#]|$)|\/manifest\/dash/i.test(url)) return 'dash';
    if (/\.mp4(?:[?#]|$)/i.test(url)) return 'mp4';
    if (/\.webm(?:[?#]|$)/i.test(url)) return 'webm';
    return /^blob:/i.test(url) ? 'blob' : 'unknown';
  }

  function diagnosticRequest(list, phase, timeoutMs) {
    const record = { phase, timeoutMs, startedAt: performance.now(), state: 'pending', httpStatus: null, failure: 'pending' };
    if (Array.isArray(list) && list.length < 40) list.push(record);
    return record;
  }

  function finishDiagnosticRequest(record, failure = 'none') {
    if (record.state !== 'pending') return;
    record.elapsedMs = Math.round(performance.now() - record.startedAt);
    record.state = failure === 'none' ? 'complete' : 'failed'; record.failure = diagnosticFailure(failure);
  }

  function requestDiagnosticOutput(record) {
    return {
      phase: ['start','append','complete','page_fetch','platform_resolve','media_probe','duration_probe','quality_probe'].includes(record.phase) ? record.phase : 'unknown',
      state: ['pending','complete','failed'].includes(record.state) ? record.state : 'unknown',
      elapsedMs: diagnosticNumber(record.state === 'pending' ? Math.round(performance.now() - record.startedAt) : record.elapsedMs),
      timeoutMs: diagnosticNumber(record.timeoutMs), httpStatus: diagnosticNumber(record.httpStatus, 599), failure: diagnosticFailure(record.failure),
      credentialsEnabled: typeof record.credentialsEnabled === 'boolean' ? record.credentialsEnabled : null,
      refererSupplied: typeof record.refererSupplied === 'boolean' ? record.refererSupplied : null,
      rangeRequested: record.rangeRequested === true, partialResponse: record.httpStatus === 206,
      redirected: typeof record.redirected === 'boolean' ? record.redirected : null,
      contentType: diagnosticMime(record.contentType), contentLength: diagnosticNumber(record.contentLength, 1e13),
      responseBytes: diagnosticNumber(record.responseBytes, 1e13), loadedBytes: diagnosticNumber(record.loadedBytes, 1e13),
      totalBytes: diagnosticNumber(record.totalBytes, 1e13),
      headersOnly: record.headersOnly === true,
      streamType: ['hls','dash','mp4','webm','blob','unknown'].includes(record.streamType) ? record.streamType : 'unknown',
      serverAccepted: diagnosticNumber(record.serverAccepted, 500), serverVideoCount: diagnosticNumber(record.serverVideoCount, 10000),
      parsedResponse: typeof record.parsedResponse === 'boolean' ? record.parsedResponse : null,
      helperVersion: /^\d+\.\d+\.\d+$/.test(record.helperVersion || '') ? record.helperVersion : null,
      mediaErrorCode: diagnosticNumber(record.mediaErrorCode, 4), mediaReadyState: diagnosticNumber(record.mediaReadyState, 4),
      videoWidth: diagnosticNumber(record.videoWidth, 32768), videoHeight: diagnosticNumber(record.videoHeight, 32768), durationSeconds: diagnosticNumber(record.durationSeconds),
      contentRange: record.contentRange ? { start: diagnosticNumber(record.contentRange.start, 1e13), end: diagnosticNumber(record.contentRange.end, 1e13), total: diagnosticNumber(record.contentRange.total, 1e13) } : null
    };
  }

  function videoDiagnosticSnapshot(element) {
    const video = element?.tagName === 'VIDEO' ? element : element?.querySelector?.('video');
    if (!video) return null;
    const ranges = value => {
      const out = []; for (let i = 0; value && i < Math.min(value.length, 12); i++) out.push([diagnosticNumber(value.start(i)), diagnosticNumber(value.end(i))]); return out;
    };
    let quality; try { quality = video.getVideoPlaybackQuality?.(); } catch (_) {}
    return { readyState: video.readyState, networkState: video.networkState, paused: video.paused, ended: video.ended,
      seeking: video.seeking, muted: video.muted, autoplay: video.autoplay, loop: video.loop,
      currentTime: diagnosticNumber(video.currentTime), durationSeconds: diagnosticNumber(video.duration),
      playbackRate: diagnosticNumber(video.playbackRate, 100), videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      buffered: ranges(video.buffered), seekable: ranges(video.seekable), mediaErrorCode: video.error?.code || 0,
      sourceKind: /^blob:/i.test(video.currentSrc) ? 'blob' : /^https?:/i.test(video.currentSrc) ? 'network' : video.currentSrc ? 'other' : 'none',
      totalVideoFrames: diagnosticNumber(quality?.totalVideoFrames, 1e12), droppedVideoFrames: diagnosticNumber(quality?.droppedVideoFrames, 1e12),
      decodedVideoFrames: diagnosticNumber(video.webkitDecodedFrameCount, 1e12), encryptedMediaAttached: !!video.mediaKeys };
  }

  function postRecallCapturePayload(endpoint, payload, timeout = 45000, diagnostics = null) {
    const trace = diagnosticRequest(diagnostics, payload.capturePhase, timeout);
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        finishDiagnosticRequest(trace, error ? (error.code || 'request_error') : 'none');
        if (error) reject(error); else resolve(data);
      };
      // A manager permission dialog can pause GM's own network timeout.
      const deadline = setTimeout(() => {
        finish(Object.assign(new Error('Pong capture timed out. Check Tampermonkey permission to access the Pong server.'), { code: 'timeout' }));
        try { request?.abort(); } catch (_) {}
      }, timeout + 1000);
      try { request = GM_xmlhttpRequest({
        method: 'POST',
        url: `${String(endpoint).replace(/\/+$/, '')}/media-page/recall`,
        headers: {
          'Content-Type': 'application/json',
          'X-Pong-SimpCity-Controller': '1'
        },
        data: JSON.stringify(payload),
        timeout,
        onload: response => {
          trace.httpStatus = response.status;
          let data = {};
          try { data = JSON.parse(response.responseText || '{}'); trace.parsedResponse = true; } catch (_) { trace.parsedResponse = false; }
          trace.serverAccepted = data.accepted; trace.serverVideoCount = data.videos;
          if (response.status >= 200 && response.status < 300 && data.ok !== false) finish(null, data);
          else finish(Object.assign(new Error(data.error || `HTTP ${response.status}`), { code: data.ok === false ? 'server_rejected' : 'http_error' }));
        },
        onerror: response => finish(Object.assign(new Error(
          `Pong server connection failed${response?.error ? `: ${response.error}` : ''}`
        ), { code: 'network_error' })),
        ontimeout: () => finish(Object.assign(new Error('Pong capture timed out'), { code: 'timeout' })),
        onabort: () => finish(Object.assign(new Error('Pong capture aborted'), { code: 'aborted' }))
      }); } catch (error) { finish(error); }
    });
  }

  async function postRecallCapturePayloadWithRetry(endpoint, payload, timeout = 45000, attempts = 3, diagnostics = null) {
    let lastError = null;
    const maximumAttempts = Math.max(1, Number(attempts || 1));
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
      try {
        return await postRecallCapturePayload(endpoint, payload, timeout, diagnostics);
      } catch (error) {
        lastError = error;
        if (attempt < maximumAttempts) await sleep(250 * attempt);
      }
    }
    throw lastError || new Error('Pong capture failed');
  }

  function probeCapturedMediaUrl(rawUrl, pageUrl, diagnostics = null) {
    const url = String(rawUrl || '').trim();
    const trace = diagnosticRequest(diagnostics, 'media_probe', 8000);
    Object.assign(trace, { credentialsEnabled: true, refererSupplied: !!pageUrl, rangeRequested: true, streamType: diagnosticStreamType(url) });
    if (!/^https?:\/\//i.test(url)) { finishDiagnosticRequest(trace, 'invalid_url'); return Promise.resolve(false); }
    return new Promise(resolve => {
      let settled = false, request = null;
      const finish = (value, failure = 'none') => {
        if (settled) return; settled = true; clearTimeout(deadline);
        finishDiagnosticRequest(trace, failure); resolve(value === true);
      };
      const deadline = setTimeout(() => { finish(false, 'timeout'); try { request?.abort?.(); } catch (_) {} }, 9000);
      const recordResponse = response => {
        trace.httpStatus = Number(response?.status || 0);
        trace.contentType = diagnosticMime(responseHeaderValue(response?.responseHeaders, 'content-type'));
        const length = responseHeaderValue(response?.responseHeaders, 'content-length');
        trace.contentLength = length ? diagnosticNumber(length, 1e13) : null;
        const range = responseHeaderValue(response?.responseHeaders, 'content-range').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
        if (range) trace.contentRange = { start: Number(range[1]), end: Number(range[2]), total: range[3] === '*' ? null : Number(range[3]) };
        trace.redirected = response?.finalUrl ? response.finalUrl !== url : null;
        trace.responseBytes = response?.response?.byteLength ?? null;
      };
      const check = response => {
        recordResponse(response);
        if (![200,206].includes(trace.httpStatus)) { finish(false, 'http_error'); return; }
        // Redaction must not change which valid media MIME types we accept.
        const rawType = responseHeaderValue(response?.responseHeaders, 'content-type');
        const accepted = !/(?:text\/html|application\/(?:json|xml))/i.test(rawType) &&
          (/^video\//i.test(rawType) || /mpegurl|dash\+xml|octet-stream/i.test(rawType) || VIDEO_EXT_RE.test(url));
        finish(accepted, accepted ? 'none' : 'non_media_response');
      };
      try { request = GM_xmlhttpRequest({
        method: 'GET', url, anonymous: false, withCredentials: true, responseType: 'arraybuffer', timeout: 8000,
        headers: { Accept: 'video/*,application/vnd.apple.mpegurl,application/x-mpegURL,application/octet-stream;q=0.8,*/*;q=0.2',
          Referer: String(pageUrl || location.href), Range: 'bytes=0-1023' },
        onreadystatechange: response => {
          if (settled || Number(response?.readyState || 0) !== 2) return;
          recordResponse(response);
          if (trace.httpStatus === 200 && trace.contentLength > 131072) {
            trace.headersOnly = true; check(response); try { request?.abort?.(); } catch (_) {}
          }
        },
        onprogress: event => { if (!settled) { trace.loadedBytes = diagnosticNumber(event.loaded, 1e13); trace.totalBytes = event.lengthComputable ? diagnosticNumber(event.total, 1e13) : null; } },
        onload: response => { if (!settled) check(response); },
        onerror: () => finish(false, 'network_error'), ontimeout: () => finish(false, 'timeout'), onabort: () => finish(false, 'aborted')
      }); } catch (_) { finish(false, 'request_error'); }
    });
  }

  function probeCapturedMetadata(url, diagnostics = null, phase = 'quality_probe', signal = null) {
    const trace = diagnosticRequest(diagnostics, phase, 3500);
    // Unknown metadata is not proof that a video is missing. Ask the actual
    // media decoder, without playing or enabling sound, with a strict deadline.
    return new Promise(resolve => {
      const video = document.createElement('video');
      video.muted = true; video.defaultMuted = true; video.volume = 0;
      video.preload = 'metadata';
      let settled = false;
      const done = (value, failure = 'none') => {
        if (settled) return; settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        Object.assign(trace, { durationSeconds: diagnosticNumber(value), mediaReadyState: video.readyState, mediaErrorCode: video.error?.code || 0, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
        const metadata = { durationSeconds: Number.isFinite(value) && value > 0 ? value : 0,
          width: video.videoWidth || 0, height: video.videoHeight || 0, failure };
        finishDiagnosticRequest(trace, failure);
        video.onloadedmetadata = null; video.onerror = null;
        video.removeAttribute('src'); try { video.load(); } catch (_) {}
        resolve(metadata);
      };
      const timer = setTimeout(() => done(0, 'timeout'), 3500);
      const abort = () => done(0, 'aborted');
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      video.onloadedmetadata = () => done(video.duration);
      video.onerror = () => done(0, 'media_unverified');
      video.src = url;
    });
  }

  async function probeCapturedDuration(url, diagnostics = null) {
    return (await probeCapturedMetadata(url, diagnostics, 'duration_probe')).durationSeconds;
  }

  function renditionQualitySummary(entry) {
    return { width: diagnosticNumber(entry?.width, 32768), height: diagnosticNumber(entry?.height, 32768),
      fps: diagnosticNumber(entry?.fps, 1000), bitrate: diagnosticNumber(entry?.bitrate, 1e12),
      evidence: ['live_decoder','metadata_decoder','player_label','resolver'].includes(entry?.qualityEvidence) ? entry.qualityEvidence : 'unknown' };
  }

  function compareRenditionQuality(a, b) {
    // Leave adaptive manifest handling to Pong's existing highest-rendition
    // policy. Never pretend a manifest URL is a measured progressive encode.
    const adaptive = entry => /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(entry.videoUrl);
    const pixels = entry => adaptive(entry) && !entry.height ? Infinity :
      Number(entry.width || 0) * Number(entry.height || 0) || Number(entry.height || 0) ** 2 * 16 / 9;
    return pixels(b) - pixels(a) ||
      Number(b.fps || 0) - Number(a.fps || 0) || Number(b.bitrate || 0) - Number(a.bitrate || 0) ||
      Number(adaptive(b)) - Number(adaptive(a)) ||
      Number(b.browserCurrent === true) - Number(a.browserCurrent === true);
  }

  async function firstVerifiedRecallEntry(entries, pageUrl, durationHint = 0, minimumDurationSeconds = 30, diagnostics = null, signal = null) {
    let durationSeconds = Math.max(
      0,
      Number(durationHint || 0),
      ...(entries || []).map(entry => Number(entry?.durationSeconds || entry?.duration || 0))
    );
    // Unknown duration is rejected too: otherwise an autoplay preview can
    // masquerade as a full movie merely because its URL ends in .mp4.
    if (!durationSeconds && entries?.[0]?.videoUrl) durationSeconds = await probeCapturedDuration(entries[0].videoUrl, diagnostics);
    if (durationSeconds < Math.max(1, Number(minimumDurationSeconds || 0))) return null;
    // URLs often have opaque names (_3.mp4, _7.mp4); a response-range check
    // cannot measure quality. Read metadata, never play, and rank BEFORE send.
    const renditions = (entries || []).map(entry => ({ ...entry }));
    const pending = renditions.length > 1 ? renditions.filter(entry =>
      !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(entry.videoUrl) && entry.qualityEvidence !== 'live_decoder') : [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (next < pending.length) {
        if (signal?.aborted) return;
        const entry = pending[next++];
        const metadata = await probeCapturedMetadata(entry.videoUrl, diagnostics, 'quality_probe', signal);
        if (metadata.durationSeconds && Math.abs(metadata.durationSeconds - durationSeconds) > Math.max(2, durationSeconds * 0.02)) {
          entry.qualityRejected = true; continue; // Preview/wrong-duration asset.
        }
        if (metadata.width > 0 && metadata.height > 0) Object.assign(entry, {
          width: metadata.width, height: metadata.height, qualityEvidence: 'metadata_decoder' });
      }
    }));
    if (signal?.aborted) return null;
    const ranked = renditions.filter(entry => !entry.qualityRejected).sort(compareRenditionQuality);
    const verifiedUrls = [];
    let verifiedContextUrl = '';
    let selected = null, failedHigher = 0;
    for (const entry of ranked) {
      const mediaUrl = String(entry?.videoUrl || entry?.rawVideoUrl || '').trim();
      const contextUrl = String(entry?.contextUrl || pageUrl || location.href);
      if (!mediaUrl || !await probeCapturedMediaUrl(mediaUrl, contextUrl, diagnostics)) { failedHigher++; continue; }
      if (!verifiedUrls.includes(mediaUrl)) verifiedUrls.push(mediaUrl);
      if (!verifiedContextUrl) verifiedContextUrl = contextUrl;
      selected = entry;
      // Quality ordered: deliver the best verified source without waiting for
      // lower-quality alternates or promoting unrelated recommendation clips.
      break;
    }
    if (!verifiedUrls.length) return null;
    const qualitySelection = {
      policy: 'highest_known_accessible', selected: renditionQualitySummary(selected),
      candidateCount: renditions.length, rejectedDurationCount: renditions.filter(entry => entry.qualityRejected).length,
      unresolvedQualityCount: ranked.filter(entry => !entry.height).length,
      unmeasuredQualityCount: ranked.filter(entry => !['live_decoder','metadata_decoder'].includes(entry.qualityEvidence)).length,
      failedHigherRankedCount: failedHigher, fallback: failedHigher > 0,
      adaptiveManifest: /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(selected.videoUrl),
      browser: renditionQualitySummary(renditions.find(entry => entry.browserCurrent)),
      candidates: renditions.map(entry => ({ ...renditionQualitySummary(entry), selected: entry === selected, rejectedDuration: !!entry.qualityRejected }))
    };
    return {
      width: selected.width || null, height: selected.height || null,
      qualitySelection,
      videoUrl: verifiedUrls[0],
      rawVideoUrl: verifiedUrls[0],
      videoUrls: verifiedUrls,
      postUrl: String(pageUrl || entries?.[0]?.postUrl || location.href),
      pageUrl: String(pageUrl || entries?.[0]?.postUrl || location.href),
      contextUrl: verifiedContextUrl || String(pageUrl || location.href),
      title: String(selected.title || entries?.[0]?.title || ''),
      identityEvidence: String(selected.identityEvidence || entries?.[0]?.identityEvidence || ''),
      durationSeconds
    };
  }

  function requiresCaliforniaVpn(value) {
    try { const host = new URL(value).hostname; return ['pornhub.com','phncdn.com'].some(d => host === d || host.endsWith('.' + d)); } catch (_) { return false; }
  }

  function vpnEndpoint() {
    // Never send a pairing secret to a page-provided public endpoint.
    return PONG_ENDPOINTS.map(value => { try {
      const u = new URL(value), h = u.hostname;
      const octets = h.split('.').map(Number);
      const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(h) && octets.every(n => n >= 0 && n <= 255);
      const local = h === 'localhost' || h === '[::1]' || (ipv4 && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)));
      return local && ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u.origin : '';
    } catch (_) { return ''; } }).find(Boolean) || '';
  }

  function vpnPairings() {
    // Credentials must NEVER fall back to website-readable localStorage.
    try { const value = GM_getValue(VPN_PAIR_KEY, '{}'); const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch (_) { return {}; }
  }

  function vpnSafeStatus(value = {}) {
    const phases = ['unknown','checking','finding_servers','connecting','connected','disconnecting','disconnected','error'];
    const safeCode = v => /^[a-z_]{1,48}$/.test(String(v || '')) ? v : null;
    return {
      phase: phases.includes(value.phase) ? value.phase : 'unknown', verified: value.verified === true,
      protected: typeof value.protected === 'boolean' ? value.protected : null,
      city: ['San Francisco','San Jose','Los Angeles'].includes(value.city) ? value.city : null,
      helperVersion: /^\d+\.\d+(?:\.\d+)?$/.test(value.helperVersion || '') ? value.helperVersion : null,
      attempt: Math.max(0, Math.min(3, Number(value.attempt) || 0)), maxAttempts: Math.max(0, Math.min(3, Number(value.maxAttempts) || 0)),
      server: /^United States #\d+$/.test(value.server || '') ? value.server : null,
      elapsedMs: Math.max(0, Number(value.elapsedMs) || 0), checkedAt: Number(value.checkedAt) || null,
      busy: value.busy === true, error: safeCode(value.error),
      events: (Array.isArray(value.events) ? value.events : []).slice(-16).map(e => ({ phase: phases.includes(e.phase) ? e.phase : 'unknown', elapsedMs: Math.max(0, Number(e.elapsedMs) || 0), attempt: Math.max(0, Math.min(3, Number(e.attempt) || 0)) }))
    };
  }

  function vpnMessage(status) {
    const errors = {
      pairing_required: 'Copy pairing link, open it in your browser, copy the key, then tap Paste key & connect.',
      helper_update: 'PC helper needs version 30.14 and a restart. The userscript update alone is not enough.',
      pc_unreachable: 'PC helper unreachable. Keep PC awake, use the same Wi-Fi, and allow local-network access in NordVPN. A VPN switch may briefly interrupt the connection.',
      nord_not_installed: 'NordVPN is not installed at its standard Windows location. Install it and sign in on the PC.',
      launch_failed: 'Cannot launch NordVPN. Check the PC for login or Windows approval.',
      catalog_unavailable: 'California server list unavailable. Check PC internet and try again.',
      verification_unavailable: 'Cannot verify the PC VPN location. Source requests are blocked.',
      connection_timeout: 'California connection not confirmed. NordVPN may need login or approval on the PC. No video was sent.',
      disconnect_timeout: 'Disconnect not confirmed. Check NordVPN on the PC.',
      local_network_required: 'VPN control needs a direct home-network connection to the PC.',
      vpn_required: 'PC VPN is not verified in California. Connect California before sending.',
      user_action_required: 'Tap Send or Connect California yourself to authorize PC VPN connection.',
      vpn_unavailable: 'VPN control failed. Copy log and check NordVPN on the PC.'
    };
    if (status.error) return errors[status.error] || errors.vpn_unavailable;
    if (status.busy) return `${status.phase.replaceAll('_',' ')} · ${Math.round(status.elapsedMs / 1000)}s${status.attempt ? ` · attempt ${status.attempt}/${status.maxAttempts}` : ''}${status.server ? ` · ${status.server}` : ''}`;
    if (status.verified) return `PC protected · ${status.city}, California · helper ${status.helperVersion || '?'}${status.checkedAt ? ' · checked ' + new Date(status.checkedAt).toLocaleTimeString() : ''}`;
    return status.phase === 'disconnected' ? 'PC VPN not connected in California. VPN-dependent videos may stop.' : 'PC VPN not checked. Phone VPN is separate.';
  }

  async function vpnRequest(action, endpoint = vpnEndpoint()) {
    const fail = code => Object.assign(new Error(vpnMessage({error:code})), {code});
    const key = vpnPairings()[endpoint];
    if (!endpoint) throw fail('local_network_required');
    if (!/^[a-f0-9]{64}$/.test(key || '')) throw fail('pairing_required');
    let response;
    try { response = await browserRelayRequest({method:action === 'status' ? 'GET' : 'POST',url:`${endpoint}/vpn/${action}`,headers:{'X-Pong-Vpn-Key':key},timeout:12000}); }
    catch (_) { throw fail('pc_unreachable'); }
    let body; try { body = JSON.parse(response.responseText || '{}'); } catch (_) { body = {}; }
    if (response.status === 404) throw fail('helper_update');
    if (response.status === 401) throw fail('pairing_required');
    if (response.status < 200 || response.status >= 300) throw fail(/^[a-z_]+$/.test(body.error || '') ? body.error : 'vpn_unavailable');
    return vpnSafeStatus(body.status);
  }

  async function runVpnAction(action, onStatus, endpoint = vpnEndpoint()) {
    let state = await vpnRequest(action, endpoint); onStatus?.(state);
    const deadline = Date.now() + 120000;
    let networkRetries = 0;
    while (state.busy && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { state = await vpnRequest('status', endpoint); networkRetries = 0; }
      catch (error) {
        if (error.code !== 'pc_unreachable' || ++networkRetries > 3) throw error;
        onStatus?.({...state,error:'pc_unreachable',busy:true}); continue;
      }
      onStatus?.(state);
    }
    if (state.busy) state = {...state, error:action === 'disconnect' ? 'disconnect_timeout' : 'connection_timeout'};
    if (state.error) { onStatus?.(state); throw Object.assign(new Error(vpnMessage(state)), {code:state.error}); }
    if (action === 'connect' || action === 'verify') {
      state = await vpnRequest('verify', endpoint); onStatus?.(state);
      if (!state.verified || state.busy) throw Object.assign(new Error(vpnMessage({error:'vpn_required'})), {code:'vpn_required'});
    }
    return state;
  }

  async function sendCaptureToRecall(mode, channel, _ignoreUnder30 = true, selection = null) {
    if (busy) throw new Error('A capture is already running');
    const captureTrace = { startedAt: performance.now(), requests: [] };
    selection?.onCaptureDiagnostics?.(captureTrace);
    const captureMode = mode === 'main' ? 'main' : 'all';
    // A complete, authoritative VideoObject does not need the 600 ms lazy-load
    // delay. Dynamic players and All listings still get their settling pass.
    const declaredMain = captureMode === 'main' && document.readyState !== 'loading' &&
      primaryVideoEvidence(document.documentElement?.innerHTML || '', location.href);
    if (!declaredMain) await waitForPageSettled();
    const ignoreUnder30 = _ignoreUnder30 !== false;
    const minimumDurationSeconds = ignoreUnder30 ? 30 : 1;
    const currentUrl = canonicalWatchPageUrl(location.href, location.href) || location.href;
    const targets = selection?.targets || (captureMode === 'main'
      ? [{ url: currentUrl, durationSeconds: extractPageDurationSeconds(document) }]
      : collectLogicalWatchPageTargets(document, location.href, 80));
    if (!targets.length) throw new Error('No logical video pages were found');
    const captureId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const bundleId = globalThis.crypto?.randomUUID?.() || `bundle-${Date.now()}`;
    const captureChannel = Number(channel) === 2 ? 2 : 1;
    const phoneConnectionOnly = selection?.phoneConnectionOnly === true;
    let requiredVpnEndpoint = '';
    if (!phoneConnectionOnly && (requiresCaliforniaVpn(currentUrl) || targets.some(t => requiresCaliforniaVpn(t.url)))) {
      requiredVpnEndpoint = vpnEndpoint();
      // Custom DOM events cannot authorize launching a system VPN. They may
      // proceed only if the paired PC is already verified.
      try { await runVpnAction(selection?.vpnAuthorization === VPN_USER_ACTION ? 'connect' : 'verify', selection?.onVpnStatus, requiredVpnEndpoint); }
      catch (error) { selection?.onVpnStatus?.({phase:'error',error:error.code || 'vpn_unavailable'}); throw error; }
    }
    if (phoneConnectionOnly && targets.some(target => youtubeVideoId(target.url))) {
      throw new Error('Phone connection currently supports direct MP4/WebM files, not YouTube or playlists. Uncheck it to use normal routing.');
    }
    // Keep authenticated relay workers for sites whose media commonly depends
    // on browser cookies. Public CDNs play faster through Pong's range proxy
    // and should not spend Firefox's per-host sockets on idle relay polls.
    const browserRelayClientId = (phoneConnectionOnly || /(?:^|\.)(?:pornhub\.com|hqporner\.com|erome\.com|simpcity\.[a-z]+)$/i.test(location.hostname))
      ? (globalThis.crypto?.randomUUID?.() || `relay-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      : '';
    const basePayload = {
      id: captureId,
      captureId,
      bundleId,
      channel: captureChannel,
      mode: captureMode,
      sourceUrl: location.href,
      title: cleanTitle(document.title || location.hostname),
      ignoreUnder30,
      sourceIsWatchPage: isLikelyWatchPage(),
      browserRelayClientId,
      phoneConnectionOnly,
      // Phone routing is streaming again; never start a full-file download.
      phoneTransferBeforeReady: false,
      browserRelayBrowser: /firefox/i.test(navigator.userAgent)
        ? 'firefox'
        : /edg\//i.test(navigator.userAgent)
          ? 'edge'
          : 'chrome'
    };
    const endpointErrors = [];
    let endpoint = '';
    let started = null;
    for (const candidate of PONG_ENDPOINTS) {
      if (requiredVpnEndpoint && String(candidate).replace(/\/+$/, '') !== requiredVpnEndpoint) continue;
      try {
        if (phoneConnectionOnly) {
          const preflight = await browserRelayRequest({ method: 'GET', url: `${String(candidate).replace(/\/+$/, '')}/media-browser-relay/capabilities`, headers: { 'X-Pong-SimpCity-Controller': '1' }, timeout: 5000 });
          if (preflight.status !== 200 || JSON.parse(preflight.responseText || '{}').phoneConnectionFiles !== true) {
            throw new Error('Restart the updated Pong server to enable phone connection. Recall was not changed.');
          }
        }
        started = await postRecallCapturePayload(candidate, {
          ...basePayload,
          capturePhase: 'start',
          totalPages: targets.length,
          pageUrls: [],
          entries: []
        }, 8000, captureTrace.requests);
        endpoint = String(candidate).replace(/\/+$/, '');
        break;
      } catch (error) {
        endpointErrors.push(error?.message || String(error));
      }
    }
    if (!endpoint) {
      const usefulError = endpointErrors.find(message => !/connection failed/i.test(message));
      throw new Error(usefulError || endpointErrors.at(-1) || 'Pong PC server is unreachable');
    }
    if (phoneConnectionOnly && !started?.capabilities?.phoneConnectionFiles) {
      await postRecallCapturePayload(endpoint, { ...basePayload, capturePhase: 'complete', completedPages: 0, pageUrls: [], entries: [] }, 8000);
      throw new Error('Restart the updated Pong server before using the phone connection. Nothing was sent.');
    }
    if (targets.some(target => target.logicalVideoId) && !started?.capabilities?.independentVideoIdentity) {
      await postRecallCapturePayload(endpoint, { ...basePayload, capturePhase: 'complete', completedPages: 0, pageUrls: [], entries: [] }, 8000);
      throw new Error('This page has multiple videos. Restart the updated Pong 30.07 server to capture them separately.');
    }

    let completedPages = 0;
    let deliveredVideos = Number(started?.videos || 0);
    let verifiedSentThisRun = 0;
    let relayStarted = false;
    const phoneRouteErrors = [];
    let appendChain = Promise.resolve();
    const captureDiagnostics = [];
    const publishCaptureDiagnostics = () => {
      try { document.documentElement.dataset.uvsCaptureDiagnostics = JSON.stringify(captureDiagnostics); } catch (_) {}
    };
    const queueAppend = (target, entry, diagnostic) => {
      if (phoneConnectionOnly && entry) {
        // Do not replace a selected high-quality playlist with a lower MP4.
        if (!/\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(String(entry.videoUrl || ''))) {
          throw new Error('Phone connection supports direct video files only; this source needs normal routing.');
        }
        entry = { ...entry, rawVideoUrl: entry.videoUrl, videoUrls: [entry.videoUrl] };
      }
      const completedAtQueue = ++completedPages;
      const queuedAt = performance.now();
      appendChain = appendChain.catch(error => {
        endpointErrors.push(error?.message || String(error));
        return null;
      }).then(async () => {
        diagnostic.queueWaitMs = Math.round(performance.now() - queuedAt);
        const deliveryStart = performance.now();
        try {
        const result = await postRecallCapturePayloadWithRetry(endpoint, {
          ...basePayload,
          capturePhase: 'append',
          completedPages: completedAtQueue,
          pageUrls: [target.url],
          entries: entry ? [entry] : []
        }, 12000, 2, diagnostic.deliveryRequests);
        if (entry && Number(result?.accepted || 0) < 1) throw Object.assign(new Error('Pong could not verify this video; Copy log for details'), { code: 'not_accepted' });
        if (entry && phoneConnectionOnly && result?.browserRelay?.phoneConnectionOnly !== true) {
          throw new Error('Pong did not confirm phone-only routing');
        }
        deliveredVideos = Math.max(deliveredVideos, Number(result?.videos || 0));
        if (!relayStarted && result?.browserRelay?.enabled) {
          relayStarted = true;
          startBrowserMediaRelay(endpoint, browserRelayClientId, captureChannel);
        }
        if (entry) verifiedSentThisRun++;
        setPanelStatus(`${verifiedSentThisRun}/${targets.length} sent · ${completedAtQueue}/${targets.length} checked`);
        return result;
        } finally { diagnostic.deliveryMs = Math.round(performance.now() - deliveryStart); }
      });
      return appendChain;
    };

    const tasks = targets.map((target, index) => async () => {
      selection?.onStatus?.(target, 'Checking');
      const targetStarted = performance.now();
      const targetUrl = target.url;
      let verified = null;
      const diagnostic = {
        index,
        startedAt: targetStarted,
        targetDuration: Number(target.durationSeconds || 0),
        attempts: [], deliveryRequests: [], mediaBefore: videoDiagnosticSnapshot(target.element),
        queueWaitMs: 0, deliveryMs: 0, resolutionTimeoutMs: 35000, done: false
      };
      selection?.onResult?.(target, diagnostic);
      const controller = new AbortController();
      let deadline;
      const timedOut = new Promise((_, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Target resolution timed out'), { code: 'timeout' }));
        }, 35000);
      });
      const resolveAttempt = async cacheBust => {
        const attemptStarted = performance.now();
        const attempt = { cacheBust: cacheBust === true, fetched: false, verified: false, requests: [], startedAt: attemptStarted, stage: 'page_fetch' };
        diagnostic.attempts.push(attempt);
        if (controller.signal.aborted) throw Object.assign(new Error('Timed out'), { code: 'timeout' });
        if (target.element && (!target.element.isConnected || (target.logicalVideoId &&
          [...document.querySelectorAll('video')][Number(target.logicalVideoId.match(/(\d+)$/)?.[1]) - 1] !== target.element))) {
          throw new Error('The selected target changed; reopen selection');
        }
        const doc = target.directMedia ? document : targetUrl === currentUrl
          ? document
          : youtubeVideoId(targetUrl) ? document.implementation.createHTMLDocument('YouTube selection')
          : await fetchDoc(targetUrl, { timeout: 12000, maxRetries: cacheBust ? 1 : 2, cacheBust, diagnostics: attempt.requests });
        attempt.fetched = !!doc;
        attempt.fetchMs = Math.round(performance.now() - attemptStarted);
        attempt.pageFetchMode = target.directMedia || targetUrl === currentUrl ? 'current_document' : youtubeVideoId(targetUrl) ? 'resolver_only' : 'network';
        if (!doc) { attempt.failure = 'page_fetch'; attempt.stage = 'complete'; return null; }
        if (doc === document) {
          doc.__uvsRawHtml = document.documentElement?.innerHTML || '';
          doc.__uvsUrl = location.href;
        }
        const inlineGroup = target.logicalVideoId
          ? independentVideoGroupsFromDoc(doc, targetUrl).find(group => group.logicalVideoId === target.logicalVideoId)
          : null;
        if (target.logicalVideoId && !inlineGroup) throw new Error('The selected video element changed; capture this page again');
        attempt.stage = 'extract'; const extractionStarted = performance.now();
        const extracted = target.directMedia ? [{ videoUrl: target.url, durationSeconds: target.durationSeconds }] : inlineGroup ? inlineGroup.entries : await browserResolvedMediaEntries(
          doc,
          targetUrl,
          Math.max(Number(target.durationSeconds || 0), extractPageDurationSeconds(doc)),
          0,
          new Set(),
          { cacheBust, maxRetries: 1, signal: controller.signal, diagnostics: attempt.requests }
        );
        attempt.extractionMs = Math.round(performance.now() - extractionStarted);
        attempt.extracted = extracted.length;
        attempt.streams = extracted.slice(0, 12).map(entry => ({ type: diagnosticStreamType(entry.videoUrl), signedQueryPresent: hasSignedLikeQuery(entry.videoUrl), durationSeconds: diagnosticNumber(entry.durationSeconds),
          width: diagnosticNumber(entry.width, 32768), height: diagnosticNumber(entry.height, 32768), fps: diagnosticNumber(entry.fps, 1000), bitrate: diagnosticNumber(entry.bitrate, 1e12) }));
        if (controller.signal.aborted) throw Object.assign(new Error('Timed out'), { code: 'timeout' });
        attempt.stage = 'verify'; const verificationStarted = performance.now();
        const resolved = await firstVerifiedRecallEntry(
          extracted,
          targetUrl,
          youtubeVideoId(targetUrl) ? Number(extracted[0]?.durationSeconds || 0) : target.directMedia ? Number(target.durationSeconds || 0) : inlineGroup ? inlineGroup.durationSeconds : Math.max(Number(target.durationSeconds || 0), extractPageDurationSeconds(doc)),
          minimumDurationSeconds, attempt.requests, controller.signal
        );
        attempt.qualitySelection = resolved?.qualitySelection || null;
        attempt.verificationMs = Math.round(performance.now() - verificationStarted);
        attempt.elapsedMs = Math.round(performance.now() - attemptStarted); attempt.stage = 'complete';
        if (resolved && target.logicalVideoId) resolved.logicalVideoId = target.logicalVideoId;
        if (resolved && !resolved.title) resolved.title = cleanTitle(
          doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || ''
        );
        attempt.pageDuration = extractPageDurationSeconds(doc);
        attempt.embeddedPlayers = embeddedPlayerPageUrls(doc, targetUrl).length;
        attempt.extracted = extracted.length;
        attempt.verified = !!resolved;
        attempt.failure = resolved ? 'none' : !extracted.length ? 'no_media'
          : Math.max(Number(target.durationSeconds || 0), inlineGroup?.durationSeconds || 0, extractPageDurationSeconds(doc)) > 0 &&
            Math.max(Number(target.durationSeconds || 0), inlineGroup?.durationSeconds || 0, extractPageDurationSeconds(doc)) < minimumDurationSeconds
            ? 'duration_filter' : 'media_unverified';
        return resolved;
      };
      try {
        verified = await Promise.race([timedOut, (async () => {
          const first = await resolveAttempt(false);
          if (first || targetUrl === currentUrl || youtubeVideoId(targetUrl)) return first;
          await sleep(250 + index * 20);
          return resolveAttempt(true);
        })()]);
      } catch (error) {
        diagnostic.error = true;
        diagnostic.failure = ['timeout','youtube_access','youtube_stream','youtube_helper_update'].includes(error?.code) ? error.code : 'extraction_error';
      } finally { clearTimeout(deadline); controller.abort(); }
      diagnostic.verified = !!verified;
      diagnostic.resolutionMs = Math.round(performance.now() - targetStarted);
      diagnostic.verificationFailure = verified ? 'none' : diagnostic.failure || diagnostic.attempts.at(-1)?.failure || 'media_unverified';
      diagnostic.failure ||= diagnostic.verificationFailure;
      diagnostic.fetchFailed = diagnostic.attempts.every(attempt => !attempt.fetched);
      captureDiagnostics[index] = diagnostic;
      publishCaptureDiagnostics();
      const failureLabel = diagnostic.failure === 'timeout' ? 'Timed out' : diagnostic.failure === 'youtube_access' ? 'Browser access required' : diagnostic.failure === 'youtube_helper_update' ? 'Pong helper needs restart' : 'Not verified';
      selection?.onStatus?.(target, verified ? 'Sending' : failureLabel);
      try {
        await queueAppend(target, verified, diagnostic);
        diagnostic.delivered = !!verified;
        selection?.onStatus?.(target, verified ? 'Sent' : failureLabel);
      } catch (error) {
        diagnostic.appendError = true;
        if (phoneConnectionOnly) phoneRouteErrors.push(error?.message || 'Phone routing failed');
        diagnostic.deliveryFailure = diagnosticFailure(error?.code || 'delivery_failed');
        diagnostic.failure = diagnostic.deliveryFailure;
        selection?.onStatus?.(target, 'Delivery failed');
        publishCaptureDiagnostics();
      }
      diagnostic.elapsedMs = Math.round(performance.now() - targetStarted);
      diagnostic.mediaAfter = videoDiagnosticSnapshot(target.element); diagnostic.done = true;
      selection?.onResult?.(target, diagnostic);
      return verified;
    });
    // Porneec's player host can strand Firefox requests once a large burst
    // fills its per-origin socket pool. Four concurrent page/probe pipelines
    // keep results streaming without the last ten cards sitting indefinitely
    // behind stale sockets; other sources retain the faster ten-way capture.
    const captureConcurrency = targets.some(target => youtubeVideoId(target.url)) ? 2 : /(?:^|\.)porneec\.com$/i.test(location.hostname)
      ? Math.min(4, RECALL_CAPTURE_CONCURRENCY)
      : RECALL_CAPTURE_CONCURRENCY;
    await pool(tasks, Math.min(captureConcurrency, tasks.length));
    await appendChain.catch(error => { endpointErrors.push(error?.message || String(error)); });
    const result = await postRecallCapturePayloadWithRetry(endpoint, {
      ...basePayload,
      capturePhase: 'complete',
      completedPages: targets.length,
      pageUrls: [],
      entries: []
    }, 12000, 2, captureTrace.requests);
    captureTrace.elapsedMs = Math.round(performance.now() - captureTrace.startedAt);
    deliveredVideos = Number(result?.videos || deliveredVideos || 0);
    try {
      document.documentElement.dataset.uvsCaptureSummary = JSON.stringify({
        checkedTargets: targets.length,
        sentThisRun: verifiedSentThisRun,
        recallVideosAfterRun: deliveredVideos,
        skippedTargets: Math.max(0, targets.length - verifiedSentThisRun),
        ignoreUnder30
      });
    } catch (_) {}
    if (!verifiedSentThisRun && phoneRouteErrors.length) throw new Error(phoneRouteErrors[0]);
    if (!verifiedSentThisRun) throw new Error(ignoreUnder30
      ? 'No verified playable video of at least 30 seconds was found; uncheck Skip <30s for short clips'
      : 'No verified playable video was found');
    notify(
      `Recall ${captureChannel} ready: ${verifiedSentThisRun}/${targets.length} sent this run` +
      (deliveredVideos !== verifiedSentThisRun ? ` (${deliveredVideos} total in Recall)` : '') +
      (phoneConnectionOnly ? '. Link received, not playback-tested. Firefox must remain active for phone streaming.' : relayStarted ? '. Keep this source tab open for authenticated fallback playback.' : '')
    );
    return result;
  }

  // Keep DOM references only in this short-lived selection session. Feedback is
  // constructed from an allowlist, never from outerHTML, URLs, or error text.
  function selectableLinkUrl(element) {
    const raw = element?.getAttribute('href') || element?.getAttribute('data-href') ||
      element?.getAttribute('data-video-url') || element?.getAttribute('data-watch-url') || '';
    if (!raw || raw.trim().startsWith('#')) return '';
    try { const url = new URL(raw, location.href); return /^https?:$/.test(url.protocol) ? url.href : ''; }
    catch (_) { return ''; }
  }

  function videoLinkEvidence(element, url) {
    if (!url || element.closest('#uvs-recall-capture,#uvs-panel,#uvs-target-preview,[data-ad],.advertisement,.ad-container')) return '';
    try { if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(url).hostname) && !youtubeVideoId(url)) return ''; } catch (_) { return ''; }
    if (/\.(?:jpe?g|png|gif|webp|svg|avif|pdf|zip)(?:[?#]|$)/i.test(url)) return '';
    if (VIDEO_EXT_RE.test(url)) return 'direct';
    if (isLogicalVideoPageUrl(url, location.href, element)) return 'path';
    // A thumbnail, play affordance or duration is evidence of a potential video
    // even when its destination is an opaque slug, redirect, or another host.
    // Never execute onclick handlers or navigate to establish that evidence.
    if (element.closest('nav,header,footer,[role="navigation"]')) return '';
    const card = element.closest('ytm-video-with-context-renderer,ytd-compact-video-renderer,ytd-rich-item-renderer,ytm-compact-video-renderer,article,li,[class*="card" i],[class*="thumb" i]') || element;
    const text = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.textContent || ''}`;
    if (element.hasAttribute('data-video-url') || element.hasAttribute('data-watch-url')) return 'video_attribute';
    if (/\b(?:watch|play)\b.{0,32}\b(?:video|clip|film)\b|\b(?:video|clip)\b.{0,32}\b(?:watch|play)\b/i.test(text)) return 'text';
    if (card.querySelector('[class*="play" i],[aria-label*="play" i],[data-duration],time') || parseDurationHintSeconds(card.textContent)) return 'play_or_duration';
    if (card.querySelector('img,picture,video,[poster]')) return 'thumbnail';
    if (/url\(/i.test(getComputedStyle(element).backgroundImage || '')) return 'thumbnail';
    return '';
  }

  function collectSelectableTargets(mode = 'all', includeAllLinks = false) {
    const currentUrl = canonicalWatchPageUrl(location.href, location.href) || location.href;
    const videos = [...document.querySelectorAll('video')];
    const groups = independentVideoGroupsFromDoc(document, currentUrl);
    const links = [...document.querySelectorAll('a[href],[role="link"][data-href],[data-video-url],[data-watch-url]')];
    const visibleArea = element => {
      const rect = element?.getBoundingClientRect();
      return rect && targetElementVisible(element) ? rect.width * rect.height : 0;
    };
    // YouTube parks its <video> above the poster before playback. Highlight
    // the visible player surface, not that offscreen decoder element.
    const youtubeSurface = youtubeVideoId(currentUrl) ? ['#movie_player','#player-container-id','#player-container','ytd-player','ytm-player']
      .map(selector => document.querySelector(selector)).find(item => visibleArea(item) > 0) : null;
    const mainElement = youtubeSurface || videos.slice().filter(item => visibleArea(item) > 0).sort((a, b) => visibleArea(b) - visibleArea(a))[0];
    const embeddedUrls = embeddedPlayerPageUrls(document, currentUrl, 80);
    const players = [...document.querySelectorAll('iframe[src],embed[src],object[data]')].filter(element => {
      const value = element.getAttribute('src') || element.getAttribute('data');
      return embeddedUrls.includes(absUrl(value, currentUrl));
    });
    let targets = collectLogicalWatchPageTargets(document, currentUrl, 80);
    if (groups.length > 1) {
      targets = targets.filter(target => target.url !== currentUrl);
      targets.unshift(...groups.map(group => ({ url: currentUrl, logicalVideoId: group.logicalVideoId, durationSeconds: group.durationSeconds })));
    }
    if (mainElement && !targets.some(target => target.url === currentUrl)) {
      targets.unshift({ url: currentUrl, durationSeconds: extractPageDurationSeconds(document) });
    }
    if (mode !== 'main' && !mainElement && players.length > 1) {
      targets = targets.filter(target => target.url !== currentUrl);
      targets.unshift(...players.map(element => ({ url: absUrl(element.getAttribute('src') || element.getAttribute('data'), currentUrl), durationSeconds: logicalPageDurationHint(element) })));
    }
    if (mode === 'main') {
      const index = videos.indexOf(mainElement);
      const group = groups.find(item => item.logicalVideoId === `inline-video-${index + 1}`);
      targets = mainElement || players.length || primaryMediaEntriesFromDoc(document, currentUrl).length
        ? [{ url: currentUrl, durationSeconds: group?.durationSeconds || extractPageDurationSeconds(document),
          ...(groups.length > 1 && group ? { logicalVideoId: group.logicalVideoId } : {}) }]
        : targets.slice(0, 1);
    }
    const candidates = targets.map(target => {
      const index = Number(target.logicalVideoId?.match(/^inline-video-(\d+)$/)?.[1] || 0) - 1;
      const matches = links.filter(link => canonicalWatchPageUrl(selectableLinkUrl(link), currentUrl) === target.url);
      const embedded = players.find(element => absUrl(element.getAttribute('src') || element.getAttribute('data'), currentUrl) === target.url);
      const element = target.url === currentUrl ? (index >= 0 ? videos[index] : mainElement || players[0])
        : embedded || matches.sort((a, b) => visibleArea(b) - visibleArea(a))[0];
      return { ...target, element, kind: ['IFRAME','EMBED','OBJECT'].includes(element?.tagName) ? 'embed' : target.url === currentUrl ? 'player' : 'link' };
    });
    for (const link of links) {
      const url = selectableLinkUrl(link);
      const evidence = videoLinkEvidence(link, url) || (includeAllLinks && url &&
        !link.closest('#uvs-recall-capture,#uvs-panel,#uvs-target-preview') ? 'manual_link' : '');
      if (!evidence || canonicalWatchPageUrl(url, currentUrl) === currentUrl) continue;
      const duplicate = candidates.find(item => canonicalWatchPageUrl(item.url, currentUrl) === canonicalWatchPageUrl(url, currentUrl));
      if (duplicate) {
        duplicate.linkEvidence ||= evidence;
        // Prefer the clickable thumbnail over a duplicate short title anchor.
        if (duplicate.kind === 'link' && visibleArea(link) > visibleArea(duplicate.element)) duplicate.element = link;
        continue;
      }
      candidates.push({ url, durationSeconds: logicalPageDurationHint(link), element: link,
        kind: evidence === 'direct' ? 'direct' : 'link', directMedia: evidence === 'direct', linkEvidence: evidence });
    }
    // An inline autoplay preview inside a linked card represents the linked
    // destination, not a second movie. Keep the card as the selectable target.
    const filtered = candidates.filter(candidate => candidate.kind !== 'player' ||
      !candidates.some(other => other.kind === 'link' && other.element?.contains(candidate.element)));
    return filtered.slice(0, mode === 'main' ? 1 : 80).map((candidate, index) => ({ ...candidate,
      ...(candidate.url === currentUrl && youtubeVideoId(currentUrl) ? { durationSeconds: extractPageDurationSeconds(document) } : {}), previewId: index + 1 }));
  }

  function targetElementVisible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  function buildDetectionFeedback(session) {
    return {
      schema: 1, diagnosticsVersion: 4, version: '7.29.0', id: session.id, createdAt: session.createdAt,
      vpn: vpnSafeStatus(session.vpn || {}),
      phoneConnectionOnly: session.phoneConnectionOnly === true,
      verificationScope: 'metadata_and_bounded_response_probe_not_playback',
      mode: session.mode, channel: session.channel,
      ignoreUnder30: session.ignoreUnder30, stage: session.stage,
      environment: {
        browser: /firefox/i.test(navigator.userAgent) ? 'firefox' : /edg\//i.test(navigator.userAgent) ? 'edge' : /chrome/i.test(navigator.userAgent) ? 'chrome' : 'other',
        browserMajor: diagnosticNumber(navigator.userAgent.match(/(?:Firefox|Edg|Chrome)\/(\d+)/i)?.[1], 1000),
        mobile: /android|iphone|ipad/i.test(navigator.userAgent), online: navigator.onLine,
        cookiesEnabled: navigator.cookieEnabled, secureContext: window.isSecureContext,
        visibility: ['visible','hidden'].includes(document.visibilityState) ? document.visibilityState : 'unknown',
        viewportWidth: innerWidth, viewportHeight: innerHeight, pixelRatio: devicePixelRatio,
        connectionType: ['slow-2g','2g','3g','4g'].includes(navigator.connection?.effectiveType) ? navigator.connection.effectiveType : null,
        saveData: typeof navigator.connection?.saveData === 'boolean' ? navigator.connection.saveData : null,
        downlinkMbps: diagnosticNumber(navigator.connection?.downlink, 100000), rttMs: diagnosticNumber(navigator.connection?.rtt)
      },
      capture: {
        elapsedMs: diagnosticNumber(session.captureTrace ? session.captureTrace.elapsedMs ?? Math.round(performance.now() - session.captureTrace.startedAt) : null),
        failure: session.captureFailure ? diagnosticFailure(session.captureFailure) : 'none',
        requests: (session.captureTrace?.requests || []).map(requestDiagnosticOutput)
      },
      evidence: {
        videoElements: document.querySelectorAll('video').length,
        iframeElements: document.querySelectorAll('iframe').length,
        structuredDataBlocks: document.querySelectorAll('script[type="application/ld+json"]').length,
        players: [
          ['videojs', '.video-js'], ['plyr', '.plyr'], ['jwplayer', '.jwplayer'],
          ['platform-player', '#movie_player,ytm-player,ytd-player'],
          ['flowplayer', '.flowplayer'], ['mediaelement', '.mejs-container']
        ].filter(([, selector]) => document.querySelector(selector)).map(([name]) => name)
      },
      candidates: session.candidates.map(candidate => {
        const result = session.results.get(candidate.previewId);
        const rect = candidate.element?.getBoundingClientRect();
        return {
          index: candidate.previewId, kind: candidate.kind,
          linkEvidence: candidate.linkEvidence || 'none',
          tag: ['VIDEO','IFRAME','A','EMBED','OBJECT'].includes(candidate.element?.tagName) ? candidate.element.tagName : 'OTHER',
          selected: session.selected.has(candidate.previewId),
          durationSeconds: Number(candidate.durationSeconds || 0),
          width: Math.round(rect?.width || 0), height: Math.round(rect?.height || 0),
          mapped: !!candidate.element, independent: !!candidate.logicalVideoId,
          outcome: result ? (!result.done ? 'in_progress' : result.appendError ? 'delivery_failed' : result.delivered ? 'sent' : result.fetchFailed ? 'fetch_failed' : 'not_verified') : 'not_checked',
          elapsedMs: result ? diagnosticNumber(result.elapsedMs ?? Math.round(performance.now() - result.startedAt)) : 0,
          failure: diagnosticFailure(result?.failure || (result && !result.done ? 'pending' : 'none')),
          verificationFailure: diagnosticFailure(result?.verificationFailure || 'none'),
          deliveryFailure: diagnosticFailure(result?.deliveryFailure || 'none'),
          timing: { resolutionMs: diagnosticNumber(result?.resolutionMs), resolutionTimeoutMs: diagnosticNumber(result?.resolutionTimeoutMs),
            queueWaitMs: diagnosticNumber(result?.queueWaitMs), deliveryMs: diagnosticNumber(result?.deliveryMs) },
          mediaBefore: result?.mediaBefore || null, mediaNow: videoDiagnosticSnapshot(candidate.element), mediaAfter: result?.mediaAfter || null,
          deliveryRequests: (result?.deliveryRequests || []).map(requestDiagnosticOutput),
          attempts: (result?.attempts || []).map(attempt => ({
            fetched: !!attempt.fetched, verified: !!attempt.verified,
            extracted: Number(attempt.extracted || 0), embeddedPlayers: Number(attempt.embeddedPlayers || 0),
            pageDuration: Number(attempt.pageDuration || 0), retry: !!attempt.cacheBust,
            failure: diagnosticFailure(attempt.failure || (attempt.stage === 'complete' ? 'none' : result?.done ? result.verificationFailure : 'pending')),
            stage: ['page_fetch','extract','verify','complete'].includes(attempt.stage) ? attempt.stage : 'unknown',
            pageFetchMode: ['current_document','resolver_only','network'].includes(attempt.pageFetchMode) ? attempt.pageFetchMode : 'unknown',
            qualitySelection: attempt.qualitySelection || null,
            timing: { fetchMs: diagnosticNumber(attempt.fetchMs), extractionMs: diagnosticNumber(attempt.extractionMs), verificationMs: diagnosticNumber(attempt.verificationMs),
              elapsedMs: diagnosticNumber(attempt.elapsedMs ?? (result.done ? result.resolutionMs : Math.round(performance.now() - attempt.startedAt))) },
            streams: (attempt.streams || []).map(stream => ({ type: ['hls','dash','mp4','webm','blob','unknown'].includes(stream.type) ? stream.type : 'unknown', signedQueryPresent: stream.signedQueryPresent === true,
              durationSeconds: diagnosticNumber(stream.durationSeconds), width: diagnosticNumber(stream.width, 32768), height: diagnosticNumber(stream.height, 32768),
              fps: diagnosticNumber(stream.fps, 1000), bitrate: diagnosticNumber(stream.bitrate, 1e12) })),
            requests: (attempt.requests || []).map(requestDiagnosticOutput)
          }))
        };
      })
    };
  }

  async function sendDetectionFeedback(report) {
    // Preserve an unsent report across refreshes; no browsing history is stored.
    setStoredJson(DETECTION_FEEDBACK_KEY, report);
    const receivers = [...PONG_ENDPOINTS];
    // The small feedback receiver can run alongside an older Pong process so
    // collecting reports never requires discarding its in-memory Recall queue.
    for (const endpoint of PONG_ENDPOINTS) {
      try { const url = new URL(endpoint); url.port = '8797'; receivers.push(url.origin); } catch (_) {}
    }
    for (const endpoint of [...new Set(receivers)]) {
      try {
        const result = await new Promise((resolve, reject) => GM_xmlhttpRequest({
          method: 'POST', url: `${String(endpoint).replace(/\/+$/, '')}/media-page/detection-feedback`,
          headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(report), timeout: 5000,
          onload: response => {
            try {
              const body = JSON.parse(response.responseText);
              if (response.status !== 200 || body.saved !== true) throw new Error('Report not saved');
              resolve(body);
            } catch (error) { reject(error); }
          },
          onerror: () => reject(new Error('Pong unavailable')), ontimeout: () => reject(new Error('Pong unavailable'))
        }));
        setStoredJson(DETECTION_FEEDBACK_KEY, null);
        return result;
      } catch (_) {}
    }
    throw new Error('Report saved in this browser. Pong needs the updated receiver; tap Retry report later.');
  }

  function openTargetPreview(mode = 'all', channel = 1, ignoreUnder30 = false) {
    if (activeTargetPreview?.sending) return activeTargetPreview;
    activeTargetPreview?.close();
    channel = Number(channel) === 2 ? 2 : 1;
    const session = {
      id: globalThis.crypto?.randomUUID?.() || `selection-${Date.now()}`,
      createdAt: new Date().toISOString(), mode, channel, ignoreUnder30,
      // The phone-only option was removed. Ignore its old saved preference.
      phoneConnectionOnly: false,
      candidates: [], selected: new Set(), results: new Map(), stage: 'selection', sending: false
    };
    const host = document.createElement('div');
    host.id = 'uvs-target-preview';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'open' });
    // Use DOM nodes, not HTML sinks: YouTube enforces Trusted Types.
    const previewStyle = document.createElement('style');
    previewStyle.textContent = `
      :host{font:10.5px system-ui;color:white}button{font:inherit;cursor:pointer;color:white;border:1px solid #ffffff44;border-radius:6px;background:#263244;padding:4px 7px}
      .box{position:fixed;background:#ff22222b;border:2px solid #ff5757;border-radius:6px;pointer-events:auto;padding:0;text-align:left;touch-action:manipulation}
      .box[aria-pressed=true]{background:#ff22224a;border-color:#fff}.box span{position:absolute;left:0;top:0;background:#851e24;padding:3px 5px;border-radius:3px;font-size:11px}
      .bar{position:fixed;left:8px;right:8px;bottom:54px;margin:auto;max-width:380px;background:#101723f5;border:1px solid #ffffff33;border-radius:10px;padding:6px;pointer-events:auto;box-shadow:0 3px 16px #0008}
      .row{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.row button{padding:4px 7px;min-height:25px}.summary{flex:1;font-size:10px}.status{font-size:10px;line-height:1.3;color:#cbd5e1;margin-top:3px}button:disabled{opacity:.5;cursor:default}
      .bar{background:linear-gradient(145deg,#17243bf5,#18182cf5);border-color:#818cf85c}
      .bar button{transition:filter .12s ease,border-color .12s ease}.bar button:hover:not(:disabled){filter:brightness(1.18)}
      [data-do=channel]{background:#6744aa;border-color:#c4b5fd88}[data-do=send]{background:#166b49;border-color:#6ee7b788}
      [data-do=copy]{background:#155e87;border-color:#7dd3fc88}[data-do=close]{background:#9b3547;border-color:#fda4af88}
      [data-vpn=connect]{background:#0d6565;border-color:#5eead488}[data-vpn=disconnect]{background:#9a4c20;border-color:#fdba7488}
      [data-vpn=status]{background:#3d51a7;border-color:#a5b4fc88}[data-vpn=pair]{background:#8d367f;border-color:#f0abfc88}
      [data-do=pair-copy]{background:#775521;border-color:#fde68a88}
    `;
    const node = (tag, className, parent, text = '') => {
      const element = document.createElement(tag); element.className = className; element.textContent = text; parent.appendChild(element); return element;
    };
    shadow.appendChild(previewStyle);
    node('div', 'boxes', shadow);
    const bar = node('div', 'bar', shadow); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Select video targets');
    const row = node('div', 'row', bar); node('div', 'summary', row);
    const channelButton = node('button', '', row); channelButton.type = 'button'; channelButton.dataset.do = 'channel';
    node('button', '', row, 'Send').dataset.do = 'send';
    node('button', '', row, 'Copy log').dataset.do = 'copy';
    const close = node('button', '', row, '×'); close.type = 'button'; close.dataset.do = 'close';
    close.setAttribute('aria-label', 'Close video selection');
    close.title = 'Close panel; an active send continues in the background';
    const statusNode = node('div', 'status', bar, 'Tap red boxes to select, then Send.');
    statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
    const vpnRow = node('div', 'row vpn-row', bar); vpnRow.style.marginTop = '4px';
    for (const [action,label] of [['connect','Connect California'],['disconnect','Disconnect'],['status','VPN status'],['pair','Paste key & connect']]) {
      const button = node('button', '', vpnRow, label); button.type = 'button'; button.dataset.vpn = action;
    }
    const pairingLink = node('button', '', vpnRow, 'Copy pairing link');
    pairingLink.type = 'button'; pairingLink.dataset.do = 'pair-copy';
    pairingLink.title = 'Copy the PC pairing page address to open in your browser';
    const vpnStatus = node('div', 'vpn-status', bar, 'PC VPN not checked. Phone VPN is separate.');
    vpnStatus.style.cssText = 'font-size:10px;line-height:1.3;color:#cbd5e1;margin-top:3px;overflow-wrap:anywhere';
    vpnStatus.setAttribute('role','status'); vpnStatus.setAttribute('aria-live','polite');
    const showVpn = value => {
      session.vpn = vpnSafeStatus(value); vpnStatus.textContent = vpnMessage(session.vpn);
    };
    pairingLink.onclick = async event => {
      event.preventDefault(); event.stopPropagation();
      const endpoint = vpnEndpoint();
      if (!endpoint) { showVpn({phase:'error',error:'local_network_required'}); return; }
      const copied = await copyTextToClipboard(`${endpoint}/vpn/setup`);
      vpnStatus.textContent = copied ? 'Pairing link copied. Paste it into your browser, copy the key there, then use Paste key & connect.' : 'Could not copy the pairing link. Allow clipboard access and try again.';
    };
    const vpnButtons = [...vpnRow.querySelectorAll('[data-vpn]')];
    let vpnWorking = false;
    for (const button of vpnButtons) button.onclick = async event => {
      event.preventDefault(); event.stopPropagation();
      if (!(event instanceof MouseEvent) || !event.isTrusted || session.sending || vpnWorking) return;
      const action = button.dataset.vpn;
      if (action === 'pair') {
        // Read only on this explicit click. Browsers that block clipboard reads
        // use a native paste prompt, never a website-readable input field.
        let key = '';
        try { if (navigator.clipboard?.readText) key = await navigator.clipboard.readText(); } catch (_) {}
        if (!/^[a-f0-9]{64}$/.test(key.trim())) key = window.prompt('Paste the key from the PC pairing page. Press OK to save it and automatically connect the PC VPN to California.');
        if (key === null) return;
        if (!/^[a-f0-9]{64}$/.test(key.trim())) { vpnStatus.textContent = 'Pairing key must be the 64-character key from your PC. Never paste your NordVPN password.'; return; }
        if (typeof GM_setValue !== 'function') { vpnStatus.textContent = 'Tampermonkey private storage is unavailable. Pairing was not saved.'; return; }
        GM_setValue(VPN_PAIR_KEY, JSON.stringify({...vpnPairings(), [vpnEndpoint()]:key.trim()}));
      }
      if (action === 'disconnect' && !window.confirm('Disconnect the PC VPN? This affects other PC apps and can interrupt video playback.')) return;
      vpnWorking = true; vpnButtons.forEach(b => b.disabled = true); send.disabled = true;
      showVpn({phase:action === 'disconnect' ? 'disconnecting' : 'checking',busy:true});
      try { await runVpnAction(action === 'pair' ? 'connect' : action, showVpn); }
      catch (error) { showVpn({...session.vpn,phase:'error',busy:false,error:error.code || 'vpn_unavailable'}); }
      finally { vpnWorking = false; vpnButtons.forEach(b => b.disabled = session.sending); update(); }
    };
    document.body.appendChild(host);
    const boxRoot = shadow.querySelector('.boxes'), status = shadow.querySelector('.status');
    const send = shadow.querySelector('[data-do=send]'), controls = new Map();
    let animation = 0, rescanTimer = 0, closed = false, pageUrl = canonicalWatchPageUrl(location.href, location.href);
    const key = candidate => canonicalWatchPageUrl(candidate.url, location.href) + '\n' + (candidate.logicalVideoId || '');
    const update = () => {
      shadow.querySelector('.summary').textContent = `${session.selected.size} selected`;
      channelButton.textContent = `Recall ${channel}`;
      channelButton.setAttribute('aria-label', `Destination: Recall ${channel}. Switch to Recall ${channel === 1 ? 2 : 1}`);
      channelButton.title = session.sending ? 'Destination is fixed while sending' : 'Tap to switch Recall destination';
      channelButton.disabled = session.sending;
      send.disabled = !session.selected.size || session.sending || vpnWorking;
      vpnButtons.forEach(button => button.disabled = session.sending || vpnWorking);
      for (const candidate of session.candidates) {
        const box = controls.get(candidate.previewId);
        const selected = session.selected.has(candidate.previewId);
        box.setAttribute('aria-pressed', String(selected));
        const label = candidate.kind === 'player' ? 'Video' : 'Video link';
        const seconds = Math.round(candidate.durationSeconds || 0);
        const duration = seconds ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
        box.firstChild.textContent = `${selected ? '✓ ' : ''}${label}${duration}${candidate.status ? ' · ' + candidate.status : ''}`;
        box.disabled = session.sending;
      }
    };
    const position = () => {
      animation = 0;
      if (closed) return;
      for (const candidate of session.candidates) {
        const box = controls.get(candidate.previewId);
        const rect = candidate.element?.isConnected ? candidate.element.getBoundingClientRect() : null;
        const visible = rect && targetElementVisible(candidate.element) && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        box.hidden = !visible;
        if (visible) Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      }
    };
    const schedulePosition = () => { if (!animation && !closed) animation = requestAnimationFrame(position); };
    const resize = new ResizeObserver(schedulePosition);
    const rescan = () => {
      if (closed || session.sending) return;
      if (pageUrl !== canonicalWatchPageUrl(location.href, location.href)) { session.close(); return; }
      document.__uvsRawHtml = document.documentElement?.innerHTML || '';
      document.__uvsUrl = location.href;
      const found = collectSelectableTargets(mode);
      for (const candidate of found) {
        const existing = session.candidates.find(item => key(item) === key(candidate));
        if (existing) {
          if (existing.element !== candidate.element) { if (existing.element) resize.unobserve(existing.element); existing.element = candidate.element; if (existing.element) resize.observe(existing.element); }
          existing.durationSeconds = candidate.durationSeconds || existing.durationSeconds;
          continue;
        }
        candidate.previewId = (session.candidates.at(-1)?.previewId || 0) + 1;
        session.candidates.push(candidate);
        const box = document.createElement('button');
        box.type = 'button'; box.className = 'box'; box.dataset.target = String(candidate.previewId);
        box.appendChild(document.createElement('span'));
        box.onclick = event => {
          event.preventDefault(); event.stopPropagation();
          if (session.sending) return;
          if (session.selected.has(candidate.previewId)) session.selected.delete(candidate.previewId);
          else session.selected.add(candidate.previewId);
          update();
        };
        boxRoot.appendChild(box); controls.set(candidate.previewId, box);
        if (candidate.element) resize.observe(candidate.element);
      }
      // Keep a selected, disappeared target so it can fail explicitly at Send.
      for (const candidate of [...session.candidates]) {
        if (!session.selected.has(candidate.previewId) && !found.some(item => key(item) === key(candidate))) {
          controls.get(candidate.previewId).remove(); controls.delete(candidate.previewId);
          if (candidate.element) resize.unobserve(candidate.element);
          session.candidates = session.candidates.filter(item => item !== candidate);
        }
      }
      update(); schedulePosition();
    };
    const mutation = new MutationObserver(records => {
      schedulePosition();
      if (records.some(record => !host.contains(record.target) && record.type === 'childList')) {
        clearTimeout(rescanTimer); rescanTimer = setTimeout(rescan, 350);
      }
    });
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','style','hidden'] });
    window.addEventListener('scroll', schedulePosition, true); window.addEventListener('resize', schedulePosition);
    const onKey = event => { if (event.key === 'Escape') session.dismiss(); };
    window.addEventListener('keydown', onKey);
    session.close = () => {
      closed = true; resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(animation); clearTimeout(rescanTimer);
      window.removeEventListener('scroll', schedulePosition, true); window.removeEventListener('resize', schedulePosition); window.removeEventListener('keydown', onKey);
      host.remove(); if (activeTargetPreview === session) activeTargetPreview = null;
    };
    session.dismiss = () => {
      if (session.sending) host.hidden = true;
      else session.close();
    };
    session.isHidden = () => host.hidden;
    session.show = () => { host.hidden = false; position(); };
    close.onclick = event => { event.preventDefault(); event.stopPropagation(); session.dismiss(); };
    channelButton.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      if (session.sending) return;
      channel = channel === 1 ? 2 : 1;
      session.channel = channel;
      setStoredJson(RECALL_CHANNEL_KEY, channel);
      const launcher = document.getElementById('uvs-recall-capture');
      if (launcher) launcher.dataset.channel = String(channel);
      // Keep checkmarks, but never relabel an earlier destination's receipt.
      session.id = globalThis.crypto?.randomUUID?.() || `selection-${Date.now()}`;
      session.createdAt = new Date().toISOString(); session.stage = 'selection';
      session.results.clear(); session.captureTrace = null; session.captureFailure = null;
      for (const candidate of session.candidates) candidate.status = '';
      status.textContent = `Selected videos will go to Recall ${channel}.`;
      update();
    };
    shadow.querySelector('[data-do=copy]').onclick = async () => {
      const copied = await copyTextToClipboard(JSON.stringify(buildDetectionFeedback(session), null, 2));
      status.textContent = copied ? 'Log copied. Paste it in chat; no cookies or media URLs included.' : 'Clipboard blocked. Allow clipboard access and try again.';
    };
    send.onclick = async event => {
      if (session.sending || !session.selected.size) return;
      session.sending = true; session.stage = 'capture';
      session.captureTrace = null; session.captureFailure = null;
      const targets = session.candidates.filter(candidate => session.selected.has(candidate.previewId));
      for (const target of targets) { target.status = 'Queued'; session.results.delete(target.previewId); }
      status.textContent = 'Checking selected videos…'; update();
      try {
        await sendCaptureToRecall(mode, channel, ignoreUnder30, {
          targets,
          vpnAuthorization: event instanceof MouseEvent && event.isTrusted ? VPN_USER_ACTION : null,
          onVpnStatus: showVpn,
          phoneConnectionOnly: session.phoneConnectionOnly,
          onCaptureDiagnostics: trace => { session.captureTrace = trace; },
          onStatus: (target, text) => { target.status = text; update(); },
          onResult: (target, result) => session.results.set(target.previewId, result)
        });
        status.textContent = `${[...session.results.values()].filter(item => item.delivered).length}/${targets.length} sent to Recall ${channel}.`;
        if (session.phoneConnectionOnly) status.textContent += ' Phone streaming needs Firefox active; playback not yet tested.';
        session.stage = 'complete';
      } catch (error) {
        status.textContent = error.message; session.stage = 'failed';
        session.captureFailure = error?.code || 'request_error';
        for (const target of targets) if (['Queued','Checking','Sending'].includes(target.status)) target.status = 'Not sent';
      } finally { if (session.captureTrace) session.captureTrace.elapsedMs = Math.round(performance.now() - session.captureTrace.startedAt); session.sending = false; update(); }
    };
    session.update = update;
    activeTargetPreview = session; rescan(); position();
    return session;
  }

  function addRecallCaptureButton() {
    if (document.getElementById('uvs-recall-capture')) return;
    const root = document.createElement('div');
    root.id = 'uvs-recall-capture';
    root.style.cssText = 'position:fixed;left:34%;bottom:10px;z-index:2147483647';
    root.dataset.channel = String(Number(getStoredJson(RECALL_CHANNEL_KEY, 1)) === 2 ? 2 : 1);
    const open = document.createElement('button');
    open.id = 'uvs-recall-open'; open.type = 'button'; open.textContent = 'Pong';
    open.style.cssText = 'height:36px;border:1px solid #ffffff33;border-radius:999px;background:#1d4ed8de;color:white;padding:0 14px;font:700 12px system-ui;cursor:pointer';
    root.appendChild(open); document.body.appendChild(root);
    open.style.touchAction = 'none'; open.style.userSelect = 'none';
    open.title = 'Tap to select videos. Drag to move; position is remembered.';
    let drag = null, suppressClickUntil = 0;
    let savedPosition = getStoredJson(LAUNCHER_POS_KEY, null);
    const bounds = () => ({x:Math.max(0, innerWidth-root.offsetWidth-8), y:Math.max(0, innerHeight-root.offsetHeight-8)});
    const move = (x,y) => { const b = bounds(); root.style.left = `${Math.max(4,Math.min(b.x,x))}px`; root.style.top = `${Math.max(4,Math.min(b.y,y))}px`; root.style.bottom = 'auto'; };
    const restore = () => { if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) { const b = bounds(); move(savedPosition.x*b.x,savedPosition.y*b.y); } };
    restore(); window.addEventListener('resize',restore);
    open.addEventListener('pointerdown',event => {
      if (!event.isPrimary || event.button !== 0) return;
      const r = root.getBoundingClientRect(); drag = {id:event.pointerId,x:event.clientX,y:event.clientY,left:r.left,top:r.top,moved:false};
      open.setPointerCapture(event.pointerId);
    });
    open.addEventListener('pointermove',event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX-drag.x, dy = event.clientY-drag.y;
      if (!drag.moved && Math.hypot(dx,dy)<7) return;
      drag.moved = true; event.preventDefault(); move(drag.left+dx,drag.top+dy);
    });
    const finishDrag = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (drag.moved) {
        suppressClickUntil = performance.now()+500;
        const r = root.getBoundingClientRect(), b = bounds(); savedPosition = {x:r.left/(b.x||1),y:r.top/(b.y||1)};
        setStoredJson(LAUNCHER_POS_KEY,savedPosition);
      }
      drag = null;
      if (open.hasPointerCapture(event.pointerId)) open.releasePointerCapture(event.pointerId);
    };
    open.addEventListener('pointerup',finishDrag); open.addEventListener('pointercancel',finishDrag);
    open.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      if (performance.now()<suppressClickUntil) return;
      if (activeTargetPreview?.isHidden()) activeTargetPreview.show();
      else if (activeTargetPreview) activeTargetPreview.dismiss();
      else openTargetPreview('all', Number(root.dataset.channel), false);
    };
    // Preserve the silent qualification hook without adding visible controls.
    document.addEventListener('pong:universal-video-recall', async event => {
      if (root.dataset.busy === 'true' || activeTargetPreview?.sending) return;
      root.dataset.busy = 'true';
      try {
        await sendCaptureToRecall(event.detail?.mode || 'all', event.detail?.channel || Number(root.dataset.channel), event.detail?.ignoreUnder30 === true);
      } catch (error) { root.dataset.error = String(error.message).slice(0, 120); }
      finally { root.dataset.busy = 'false'; }
    });
  }

  function addFloatingButtons() {
    if (isPongAppPage()) { addPongEromeLauncher(); return; }
    addRecallCaptureButton();
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

  const browserRelayKeeperClientId = location.pathname === '/browser-relay-keeper'
    ? String(new URL(location.href).searchParams.get('pongBrowserRelayClientId') || '')
    : '';
  if (/^[a-z0-9-]{8,100}$/i.test(browserRelayKeeperClientId)) {
    startBrowserMediaRelay(location.origin, browserRelayKeeperClientId);
    document.documentElement.dataset.pongBrowserRelayKeeper = 'active';
    log('Universal Video Scraper v7.17.0 browser relay keeper active');
    return;
  }

  try {
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('Select videos for Pong', () => openTargetPreview('all', Number(getStoredJson(RECALL_CHANNEL_KEY, 1)), false));
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
    extractPageDurationSeconds,
    parseDurationHintSeconds,
    collectLogicalWatchPageTargets,
    collectLogicalWatchPageUrls,
    primaryMediaEntriesFromDoc,
    independentVideoGroupsFromDoc,
    youtubeVideoId,
    youtubePlayerData,
    youtubeMediaEntries,
    sendCaptureToRecall,
    collectSelectableTargets,
    openTargetPreview,
    buildDetectionFeedback,
    requestDiagnosticOutput,

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

  log('Universal Video Scraper v7.29.0 loaded on', location.href);

  // Capture is now explicit: no saved legacy auto-scrape setting starts work.
})();
