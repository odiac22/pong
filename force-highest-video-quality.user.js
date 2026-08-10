// ==UserScript==
// @name         Force Highest Video Quality
// @namespace    https://odiac22.github.io/pong/
// @version      1.2.0
// @description  Select the highest video quality exposed by HTML5, Playerjs, Video.js, Plyr, HLS, and common web players.
// @match        *://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const page = typeof unsafeWindow === 'object' ? unsafeWindow : window;
  const WRAPPED = Symbol('force-highest-quality');
  const processed = new WeakMap();

  const qualityScore = value => {
    const text = String(value || '').toLowerCase().trim();
    const dimensions = [...text.matchAll(/(?:^|[^0-9])(\d{3,4})(?:p|px|\s*[xÃ—]\s*\d{3,4})?/g)]
      .map(match => Number(match[1] || 0));
    const height = Math.max(0, ...dimensions);
    if (/\b(?:8k|4320p?)\b/.test(text)) return Math.max(height, 4320);
    if (/\b(?:4k|uhd|2160p?)\b/.test(text)) return Math.max(height, 2160);
    if (/\b(?:2k|qhd|1440p?)\b/.test(text)) return Math.max(height, 1440);
    if (/\b(?:full\s*hd|fhd|1080p?)\b/.test(text)) return Math.max(height, 1080);
    if (/\bhd\b/.test(text)) return Math.max(height, 720);
    return height;
  };

  // Unlike a scene ID or timestamp, a resolution must have a quality suffix,
  // dimensions, or a recognized quality name. This prevents paths such as
  // /19127/video.mp4 from outranking 720p/HD.
  const explicitQualityScore = value => {
    const text = String(value || '').toLowerCase().trim();
    const heights = [...text.matchAll(/(?:^|[^0-9])(\d{3,4})\s*(?:p|px)\b/g)]
      .map(match => Number(match[1] || 0));
    for (const match of text.matchAll(/(?:^|[^0-9])(\d{3,4})\s*(?:x|\u00d7)\s*(\d{3,4})(?:[^0-9]|$)/g)) {
      heights.push(Math.min(Number(match[1] || 0), Number(match[2] || 0)));
    }
    const height = Math.max(0, ...heights);
    if (/\b(?:8k|4320p?)\b/.test(text)) return Math.max(height, 4320);
    if (/\b(?:4k|uhd|2160p?)\b/.test(text)) return Math.max(height, 2160);
    if (/\b(?:2k|qhd|1440p?)\b/.test(text)) return Math.max(height, 1440);
    if (/\b(?:full\s*hd|fhd|1080p?)\b/.test(text)) return Math.max(height, 1080);
    if (/\bhd\b/.test(text)) return Math.max(height, 720);
    return height;
  };

  const playerJsVariants = file => String(file || '').split(',').map(part => {
      const match = part.trim().match(/^\[([^\]]+)]\s*(.+)$/);
      return match ? { label: match[1].trim(), url: match[2].trim() } : null;
    }).filter(Boolean).sort((a, b) => explicitQualityScore(b.label) - explicitQualityScore(a.label));

  const playerJsHighestLabel = file => playerJsVariants(file)[0]?.label || '';

  const highestPlayerJsUrlFromMarkup = () => {
    for (const script of document.scripts || []) {
      const text = String(script.textContent || '');
      if (!/new\s+Playerjs\s*\(/i.test(text)) continue;
      const file = text.match(/\bfile\s*:\s*(["'`])([\s\S]*?)\1/i)?.[2] || '';
      const highest = playerJsVariants(file)[0];
      if (highest?.url) return { ...highest, url: new URL(highest.url, location.href).href };
    }
    return null;
  };

  const wrapConstructor = (Original, mutate) => {
    if (typeof Original !== 'function' || Original[WRAPPED]) return Original;
    const Wrapped = function (...args) {
      let after = null;
      try {
        const change = mutate(args);
        if (Array.isArray(change)) args = change;
        else if (change && typeof change === 'object') {
          if (Array.isArray(change.args)) args = change.args;
          if (typeof change.after === 'function') after = change.after;
        }
      } catch (_) {}
      const instance = Reflect.construct(Original, args, new.target || Original);
      try { after?.(instance, Original); } catch (_) {}
      return instance;
    };
    try { Object.setPrototypeOf(Wrapped, Original); } catch (_) {}
    try { Wrapped.prototype = Original.prototype; } catch (_) {}
    Object.defineProperty(Wrapped, WRAPPED, { value: true });
    return Wrapped;
  };

  const interceptGlobalConstructor = (name, mutate) => {
    let current;
    try { current = page[name]; } catch (_) {}
    const wrap = value => wrapConstructor(value, mutate);
    if (typeof current === 'function') {
      try { page[name] = wrap(current); } catch (_) {}
      return;
    }
    try {
      Object.defineProperty(page, name, {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: value => { current = wrap(value); }
      });
    } catch (_) {}
  };

  interceptGlobalConstructor('Playerjs', args => {
    const options = args[0];
    if (!options || typeof options !== 'object') return args;
    const highest = playerJsHighestLabel(options.file);
    if (highest) options.default_quality = highest;
    return args;
  });

  interceptGlobalConstructor('Hls', args => ({
    args,
    after(instance, Original) {
      const event = Original?.Events?.MANIFEST_PARSED;
      if (!event || typeof instance?.on !== 'function') return;
      instance.on(event, () => {
        const levels = Array.isArray(instance.levels) ? instance.levels : [];
        if (!levels.length) return;
        const highest = levels.reduce((best, level, index) => {
          const score = Number(level?.height || 0) * 1e9 + Number(level?.bitrate || 0);
          return score > best.score ? { index, score } : best;
        }, { index: levels.length - 1, score: -1 }).index;
        try { instance.autoLevelCapping = highest; } catch (_) {}
        try { instance.currentLevel = highest; } catch (_) {}
        try { instance.nextLevel = highest; } catch (_) {}
        try { instance.loadLevel = highest; } catch (_) {}
        try { instance.nextAutoLevel = highest; } catch (_) {}
      });
    }
  }));

  const sourceScore = source => {
    const width = Number(source.videoWidth || source.getAttribute?.('width') || source.dataset?.width || 0);
    const height = Number(source.videoHeight || source.getAttribute?.('height') || source.dataset?.height || 0);
    const bitrate = Number(source.dataset?.bitrate || source.getAttribute?.('bitrate') || 0);
    const text = [
      source.src,
      source.getAttribute?.('src'),
      source.label,
      source.title,
      source.dataset?.quality,
      source.dataset?.res,
      source.getAttribute?.('size'),
      source.getAttribute?.('res')
    ].filter(Boolean).join(' ');
    return Math.max(height, width > 0 ? Math.round(width * 9 / 16) : 0, explicitQualityScore(text)) * 1e9 + bitrate;
  };

  const forceNativeSources = video => {
    if (!(video instanceof HTMLVideoElement)) return;
    const sources = [...video.querySelectorAll('source[src]')]
      .filter(source => /^(?:https?:|\/)/i.test(source.getAttribute('src') || ''))
      .sort((a, b) => sourceScore(b) - sourceScore(a));
    if (sources.length < 2 || sourceScore(sources[0]) <= 0) return;
    const best = new URL(sources[0].getAttribute('src'), location.href).href;
    const marker = `${best}|${sources.length}`;
    if (processed.get(video) === marker || video.currentSrc === best || video.src === best) return;
    processed.set(video, marker);
    const time = Number(video.currentTime || 0);
    const shouldPlay = !video.paused;
    video.src = best;
    video.load();
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(time) && time > 0 && time < video.duration) video.currentTime = time;
      if (shouldPlay) video.play().catch(() => {});
    }, { once: true });
  };

  // Runtime fallback for pages that create Playerjs in an isolated page
  // world before a userscript manager can intercept the constructor. Read the
  // same public configuration the page gives Playerjs, then replace its video
  // source with the highest declared rendition.
  const forcePlayerJsMarkup = () => {
    const highest = highestPlayerJsUrlFromMarkup();
    if (!highest?.url) return;
    let videos = [...document.querySelectorAll('#player video, [id*="player" i] video, video')];
    // Some Playerjs pages publish all renditions but their custom player never
    // initializes (common after mobile/desktop redirects or blocked ads). Once
    // the document is fully loaded, provide a native player using the highest
    // published source instead of leaving an empty player box.
    if (!videos.length && document.readyState === 'complete') {
      const host = document.querySelector('#player,[id*="player" i]');
      if (host && !host.dataset.forceHighestNativePlayer) {
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = highest.url;
        video.dataset.forceHighestPlayerJs = highest.url;
        video.style.cssText = 'display:block;width:100%;height:100%;max-width:100%;background:#000';
        host.dataset.forceHighestNativePlayer = 'true';
        host.replaceChildren(video);
        video.load();
        videos = [video];
      }
    }
    videos.forEach(video => {
      if (!(video instanceof HTMLVideoElement)) return;
      if (video.dataset.forceHighestPlayerJs === highest.url || video.currentSrc === highest.url || video.src === highest.url) return;
      const time = Number(video.currentTime || 0);
      const shouldPlay = !video.paused || video.autoplay;
      video.dataset.forceHighestPlayerJs = highest.url;
      video.src = highest.url;
      video.querySelectorAll('source').forEach(source => source.remove());
      video.load();
      video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(time) && time > 0 && time < video.duration) video.currentTime = time;
        if (shouldPlay) video.play().catch(() => {});
      }, { once: true });
    });
  };

  const forceVideoJs = () => {
    try {
      const players = page.videojs?.getPlayers?.() || {};
      Object.values(players).forEach(player => {
        const representations = player?.tech?.()?.vhs?.representations?.() ||
          player?.tech?.()?.hls?.representations?.() || [];
        if (!representations.length) return;
        const best = [...representations].sort((a, b) =>
          Number(b.height || 0) - Number(a.height || 0) || Number(b.bandwidth || 0) - Number(a.bandwidth || 0)
        )[0];
        representations.forEach(item => item.enabled?.(item === best));
      });
    } catch (_) {}
  };

  const forcePlyr = () => {
    try {
      const players = [page.player, page.plyr, ...(Array.isArray(page.players) ? page.players : [])].filter(Boolean);
      players.forEach(player => {
        const options = player?.options?.quality?.options || player?.config?.quality?.options || [];
        const highest = Math.max(0, ...options.map(Number).filter(Number.isFinite));
        if (highest) player.quality = highest;
      });
    } catch (_) {}
  };

  const clickHighestQuality = root => {
    const containers = root.querySelectorAll?.(
      '.quality-selector,.quality-menu,.vjs-menu-content,.jw-settings-content-item,.plyr__menu,[class*="quality" i],[data-quality]'
    ) || [];
    containers.forEach(container => {
      const choices = [...container.querySelectorAll('button,[role="menuitemradio"],[data-quality],li,a')]
        .map(element => ({ element, score: explicitQualityScore(`${element.textContent} ${element.title} ${element.dataset?.quality || ''}`) }))
        .filter(item => item.score > 0 && !item.element.disabled)
        .sort((a, b) => b.score - a.score);
      const best = choices[0];
      if (!best || best.element.matches('.active,[aria-checked="true"],[aria-selected="true"]')) return;
      best.element.click();
    });
  };

  const forceEverything = (root = document) => {
    if (root instanceof HTMLVideoElement) forceNativeSources(root);
    root.querySelectorAll?.('video').forEach(forceNativeSources);
    forcePlayerJsMarkup();
    forceVideoJs();
    forcePlyr();
    clickHighestQuality(root);
  };

  const start = () => {
    forceEverything();
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) forceEverything(node);
        });
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('loadedmetadata', event => forceNativeSources(event.target), true);
    setInterval(forceEverything, 2000);
  };

  if (document.documentElement) start();
  else addEventListener('DOMContentLoaded', start, { once: true });

  try { GM_registerMenuCommand('Force highest quality now', () => forceEverything()); } catch (_) {}
})();
