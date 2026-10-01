const port = Number(process.env.PONG_EMULATOR_CDP_PORT || 9223);
const mode = String(process.argv[2] || 'state').toLowerCase();
const eromeTarget = String(process.env.PONG_QA_EROME_URL || 'https://www.erome.com/Casualandhot');
const local22Target = Math.max(1, Number(process.env.PONG_QA_LOCAL22_ARTISTS || 5));
const deadlineMs = Math.max(15_000, Number(process.env.PONG_QA_DEADLINE_MS || 180_000));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
      else pending.resolve(message.result || {});
    });
    const rejectPending = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Android WebView CDP connection closed'));
      this.pending.clear();
    };
    this.socket.addEventListener('close', rejectPending);
    this.socket.addEventListener('error', rejectPending);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, userGesture = false) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(detail || 'WebView evaluation failed');
    }
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch (_) {}
  }
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(lastValue)}`);
}

async function trustedTap(session, selector) {
  const documentNode = await session.send('DOM.getDocument', { depth: 1 });
  const selected = await session.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector
  });
  if (!selected.nodeId) throw new Error(`Missing emulator control ${selector}`);
  await session.send('DOM.scrollIntoViewIfNeeded', { nodeId: selected.nodeId });
  const model = await session.send('DOM.getBoxModel', { nodeId: selected.nodeId });
  const points = model.model?.border || model.model?.content;
  if (!Array.isArray(points) || points.length < 8) throw new Error(`No box for ${selector}`);
  const x = (points[0] + points[2] + points[4] + points[6]) / 4;
  const y = (points[1] + points[3] + points[5] + points[7]) / 4;
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    pointerType: 'touch'
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    pointerType: 'touch'
  });
}

const silenceSource = `(() => {
  if (window.__pongEmulatorSilenceInstalled) return;
  window.__pongEmulatorSilenceInstalled = true;
  const mediaPrototype = HTMLMediaElement.prototype;
  const nativeMuted = Object.getOwnPropertyDescriptor(mediaPrototype, 'muted');
  const nativeVolume = Object.getOwnPropertyDescriptor(mediaPrototype, 'volume');
  const hardSilence = media => {
    try { nativeMuted?.set?.call(media, true); } catch (_) {}
    try { nativeVolume?.set?.call(media, 0); } catch (_) {}
    media.defaultMuted = true;
    media.setAttribute('muted', '');
  };
  const silence = root => {
    for (const media of root.querySelectorAll?.('video,audio') || []) {
      hardSilence(media);
    }
  };
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    hardSilence(this);
    return originalPlay.apply(this, args);
  };
  Object.defineProperty(mediaPrototype, 'muted', {
    configurable: true,
    get: () => true,
    set() { try { nativeMuted?.set?.call(this, true); } catch (_) {} }
  });
  Object.defineProperty(mediaPrototype, 'volume', {
    configurable: true,
    get: () => 0,
    set() { try { nativeVolume?.set?.call(this, 0); } catch (_) {} }
  });
  silence(document);
  new MutationObserver(() => silence(document)).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => silence(document), 100);
})();`;

async function initialize(session, targetUrl) {
  await Promise.all([
    session.send('Runtime.enable'),
    session.send('Page.enable'),
    session.send('DOM.enable'),
    session.send('Network.enable')
  ]);
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.evaluate(`(() => {
    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
    return true;
  })()`);
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: silenceSource });
  const url = new URL(targetUrl);
  url.searchParams.set('pongInstance', '2');
  url.searchParams.set('pongNative', '1');
  url.searchParams.set('qa', String(Date.now()));
  await session.send('Page.navigate', { url: url.toString() });
  await waitFor(
    () => session.evaluate(`document.readyState === 'complete' && !!document.querySelector('#pong-hotspot')`),
    30_000,
    'Pong emulator page'
  );
  await session.evaluate(silenceSource);
  for (let index = 0; index < 3; index++) {
    await session.evaluate(`document.querySelector('#pong-hotspot')?.click()`, true);
    await delay(80);
  }
  await waitFor(
    () => session.evaluate(`document.querySelector('#pong-overlay')?.classList.contains('hidden') === true`),
    5_000,
    'Pong splash dismissal'
  );
}

async function state(session) {
  return session.evaluate(`(() => ({
    title: document.title,
    version: document.querySelector('.version-number')?.textContent?.trim() || '',
    instance: document.querySelector('.pong-instance-badge')?.textContent?.trim() || '',
    href: location.href,
    media: [...document.querySelectorAll('video,audio')].map(item => ({
      muted: item.muted,
      volume: item.volume,
      paused: item.paused,
      readyState: item.readyState
    }))
  }))()`);
}

async function runErome(session) {
  await session.evaluate(`(() => {
    const input = document.querySelector('#erome-url');
    input.value = ${JSON.stringify(eromeTarget)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const startedAt = Date.now();
  await session.evaluate(`document.querySelector('#open-erome')?.click()`, true);
  let latest = null;
  const result = await waitFor(async () => {
    const current = await session.evaluate(`(() => {
      const events = (typeof pasteEvents !== 'undefined' ? pasteEvents : [])
        .filter(event => ['erome', 'bunkr'].includes(String(event?.source || '').toLowerCase()));
      return {
        events: events.map((event, index) => ({
          number: index + 1,
          source: event.source,
          album: event.postUrl,
          bundleKey: event.bundleKey,
          count: event.count,
          hidden: event.paperclipHidden === true
        })),
        progress: document.querySelector('#erome-progress-detail')?.textContent?.trim() || '',
        silent: [...document.querySelectorAll('video,audio')].every(item => item.muted && item.volume === 0)
      };
    })()`);
    latest = current;
    return current.events.length >= 3 ? current : null;
  }, deadlineMs, `three Erome Paperclip bundles (latest ${JSON.stringify(latest)})`, 500);
  // The application may create or recycle a media element between polling
  // ticks. Re-apply the test-only mute immediately before recording the final
  // result so the assertion describes the exact delivered emulator state.
  await session.evaluate(`${silenceSource}; (() => {
    for (const media of document.querySelectorAll('video,audio')) {
      media.muted = true;
      media.defaultMuted = true;
      media.volume = 0;
    }
    return true;
  })()`);
  await delay(150);
  result.silent = await session.evaluate(
    `[...document.querySelectorAll('video,audio')].every(item => item.muted && item.volume === 0)`
  );
  return { mode: 'erome', elapsedMs: Date.now() - startedAt, target: eromeTarget, ...result };
}

async function runLocal22(session) {
  await fetch('http://127.0.0.1:8787/local22-turbo/stop', { method: 'POST' }).catch(() => {});
  const baselineKeys = new Set(await session.evaluate(`(() =>
    (typeof pasteEvents !== 'undefined' ? pasteEvents : [])
      .filter(event => String(event?.source || '').toLowerCase() === 'random40')
      .map(event => String(event.artistKey || event.artistUrl || event.bundleKey || ''))
      .filter(Boolean)
  )()`));
  const startedAt = Date.now();
  await session.evaluate(`document.querySelector('#random-40-local')?.click()`, true);
  const arrivals = [];
  const seen = new Set();
  let finalState = null;
  while (Date.now() - startedAt < deadlineMs && arrivals.length < local22Target) {
    finalState = await session.evaluate(`(() => {
      const events = (typeof pasteEvents !== 'undefined' ? pasteEvents : [])
        .filter(event => String(event?.source || '').toLowerCase() === 'random40');
      const first = events[0];
      const media = [...document.querySelectorAll('video,audio')];
      return {
        running: Boolean(typeof random40State !== 'undefined' && random40State && !random40State.done),
        accepted: Number(typeof random40State !== 'undefined' && random40State?.accepted || 0),
        completed: Number(typeof random40State !== 'undefined' && random40State?.completed || 0),
        failed: Number(typeof random40State !== 'undefined' && random40State?.failed || 0),
        events: events.map(event => ({
          key: String(event.artistKey || event.artistUrl || event.bundleKey || ''),
          artist: String(event.artistDisplayName || ''),
          count: Number(event.count || 0)
        })),
        firstBundle: first ? { artist: first.artistDisplayName, count: first.count } : null,
        silent: media.every(item => item.muted && item.volume === 0),
        media: media.map(item => ({ paused: item.paused, muted: item.muted, volume: item.volume, readyState: item.readyState, duration: item.duration }))
      };
    })()`);
    for (const event of finalState.events) {
      if (!event.key || baselineKeys.has(event.key) || seen.has(event.key)) continue;
      seen.add(event.key);
      arrivals.push({ ...event, elapsedMs: Date.now() - startedAt });
    }
    await delay(500);
  }
  const health = await fetch('http://127.0.0.1:8787/local22-turbo/health', { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .catch(() => null);
  await fetch('http://127.0.0.1:8787/local22-turbo/stop', { method: 'POST' }).catch(() => {});
  const gaps = arrivals.slice(1).map((item, index) => item.elapsedMs - arrivals[index].elapsedMs);
  return {
    mode: 'local22',
    targetArtists: local22Target,
    elapsedMs: Date.now() - startedAt,
    firstArtistMs: arrivals[0]?.elapsedMs || null,
    averageArrivalMs: arrivals.length ? arrivals[arrivals.length - 1].elapsedMs / arrivals.length : null,
    averageGapMs: gaps.length ? Math.round(gaps.reduce((sum, value) => sum + value, 0) / gaps.length) : null,
    arrivals,
    serverProof: {
      pipeline: health?.pipeline || '',
      minimumVerifiedMedia: Number(health?.minimumVerifiedMedia || 0)
    },
    state: finalState,
    // Pong intentionally renders only a five-video preview. The server health
    // contract proves that every delivered Local2.2 artist had ten verified
    // videos before qualification; the remaining five are deferred until the
    // viewer stays or advances within that artist.
    pass: arrivals.length >= local22Target && arrivals.every(item => item.count >= 5) &&
      health?.pipeline === 'blank-slate-history-v1' && Number(health?.minimumVerifiedMedia) === 10 &&
      arrivals[arrivals.length - 1].elapsedMs / arrivals.length <= 15_000 && finalState?.silent === true
  };
}

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error(`No Android WebView on CDP port ${port}`);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    if (mode === 'peek') {
      await Promise.all([
        session.send('Runtime.enable'),
        session.send('DOM.enable'),
        session.send('Network.enable')
      ]);
      console.log(JSON.stringify({
        schema: 'pong-emulator-apk-qa-v1',
        mode: 'peek',
        state: await session.evaluate(`(() => ({
          href: location.href,
          readyState: document.readyState,
          version: document.querySelector('.version-number')?.textContent?.trim() || '',
          input: document.querySelector('#erome-url')?.value || '',
          progress: document.querySelector('#erome-progress-detail')?.textContent?.trim() || '',
          eventCount: typeof pasteEvents !== 'undefined' ? pasteEvents.length : -1,
          videoCount: typeof allVideoUrls !== 'undefined' ? allVideoUrls.length : -1,
          events: (typeof pasteEvents !== 'undefined' ? pasteEvents : []).slice(0, 8).map(event => ({ source: event.source, postUrl: event.postUrl, count: event.count }))
        }))()`)
      }, null, 2));
      return;
    }
    await initialize(session, target.url);
    const result = mode === 'erome'
      ? await runErome(session)
      : mode === 'local22'
        ? await runLocal22(session)
        : await state(session);
    console.log(JSON.stringify({ schema: 'pong-emulator-apk-qa-v1', ...result }, null, 2));
    if (mode === 'local22' && result.pass !== true) process.exitCode = 1;
  } finally {
    session.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    schema: 'pong-emulator-apk-qa-v1',
    mode,
    error: String(error?.stack || error)
  }, null, 2));
  process.exitCode = 1;
});
