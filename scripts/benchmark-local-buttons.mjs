import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const LOCAL_AI = process.env.PONG_BENCH_LOCAL_AI || 'http://127.0.0.1:8787';
const CHROME = process.env.PONG_BENCH_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEADLINE_MS = Math.max(30_000, Number(process.env.PONG_BENCH_DEADLINE_MS || 900_000));
const PAGES = [...new Set(String(process.env.PONG_BENCH_PAGES || '')
  .split(',')
  .map(Number)
  .filter(value => Number.isInteger(value) && value >= 1 && value <= 3500))];
const MODES = String(process.env.PONG_BENCH_MODES || 'local,local2')
  .split(',')
  .map(value => value.trim().toLowerCase())
  .filter(value => value === 'local' || value === 'local2');

if (PAGES.length !== 3) throw new Error('PONG_BENCH_PAGES must contain exactly three distinct pages from 1-3500');
if (!MODES.length) throw new Error('PONG_BENCH_MODES must include local and/or local2');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
        return;
      }
      if (!this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result || {});
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(detail || 'browser evaluation failed');
    }
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch (_) {}
  }
}

async function startStaticServer() {
  const html = await readFile(INDEX_PATH);
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/index.html')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

async function startChrome() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pong-buttons-bench-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=MediaRouter,Translate',
    '--disk-cache-size=1',
    '--media-cache-size=1',
    '--autoplay-policy=user-gesture-required',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const port = await waitFor(async () => {
    const raw = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(raw.split(/\r?\n/)[0]) || 0;
  }, 15_000, 'Chrome DevTools');
  return { child, profile, port };
}

async function stopChromeTree(child) {
  if (!child?.pid) return;
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await Promise.race([
    new Promise(resolve => killer.once('close', resolve)),
    delay(5_000),
  ]);
}

async function openPage(chromePort, url) {
  const target = await fetch(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  }).then(response => response.json());
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await Promise.all([
    session.send('Runtime.enable'),
    session.send('Page.enable'),
    session.send('Network.enable'),
    session.send('DOM.enable'),
  ]);
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.send('Network.setBlockedURLs', {
    urls: ['*.mp4*', '*.m3u8*', '*.mpd*', '*.webm*', '*.mov*', '*.m4v*', '*.ts*', '*.mp3*', '*.m4a*', '*.aac*', '*.wav*', '*.ogg*'],
  });
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const audit = { created: 0, playCalls: 0, loadCalls: 0 };
      Object.defineProperty(window, '__pongMediaAudit', { value: audit, configurable: false });
      const originalCreate = Document.prototype.createElement;
      Document.prototype.createElement = function(name, options) {
        const element = originalCreate.call(this, name, options);
        if (/^(?:video|audio)$/i.test(String(name || ''))) audit.created++;
        return element;
      };
      HTMLMediaElement.prototype.play = function() {
        audit.playCalls++;
        return Promise.reject(new DOMException('Benchmark blocks playback', 'NotAllowedError'));
      };
      HTMLMediaElement.prototype.load = function() { audit.loadCalls++; };
    })();`,
  });
  await session.send('Page.navigate', { url });
  return { target, session };
}

async function trustedClick(session, selector) {
  const visible = await session.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button) return false;
    const box = button.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  })()`);
  if (!visible) throw new Error(`button ${selector} is not visible`);
  const documentNode = await session.send('DOM.getDocument', { depth: 1 });
  const buttonNode = await session.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!buttonNode.nodeId) throw new Error(`button ${selector} was not found`);
  await session.send('DOM.scrollIntoViewIfNeeded', { nodeId: buttonNode.nodeId });
  const model = await session.send('DOM.getBoxModel', { nodeId: buttonNode.nodeId });
  const points = model.model?.border || model.model?.content;
  if (!Array.isArray(points) || points.length < 8) throw new Error(`button ${selector} has no box model`);
  const x = (points[0] + points[2] + points[4] + points[6]) / 4;
  const y = (points[1] + points[3] + points[5] + points[7]) / 4;
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function dismissPongSplash(session) {
  for (let index = 0; index < 3; index++) {
    await trustedClick(session, '#pong-hotspot');
    await delay(80);
  }
  await waitFor(
    () => session.evaluate(`document.querySelector('#pong-overlay')?.classList.contains('hidden') === true`),
    3_000,
    'Pong splash dismissal'
  );
}

function compactResult(state, mode, mediaElements, mediaRequests, mediaAudit, clickAudit) {
  const audits = Array.isArray(state.verdictAudit) ? state.verdictAudit : [];
  const accepted = audits.filter(item => item?.decision === 'accept');
  const publishedAccepted = accepted.filter(item => item?.hardVerified === true);
  const hardSafe = publishedAccepted.length === Number(state.accepted || 0) && publishedAccepted.every(item => {
    const checks = item?.checks || {};
    const anatomy = item?.anatomyAssessment || {};
    return item?.hardVerified === true && item?.requiresQwenReview !== true &&
      checks.male_present !== true && checks.male_only !== true &&
      checks.feet_dominant !== true && checks.logo_or_placeholder !== true &&
      checks.appears_over_50 !== true && checks.appears_over_60 !== true &&
      anatomy.attached_male_anatomy !== true && anatomy.ambiguous !== true;
  });
  return {
    mode,
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: state.timestamp,
    elapsedMs: Number(state.elapsedMs || 0),
    pages: Number(state.pages || 0),
    pagePlan: state.pagePlan,
    accepted: Number(state.accepted || 0),
    videos: Number(state.videos || 0),
    modelDecisions: audits.length,
    modelAccepted: accepted.length,
    publishedAccepted: publishedAccepted.length,
    modelRejected: audits.filter(item => item?.decision === 'reject').length,
    hardSafe,
    mediaElements,
    mediaRequests,
    mediaAudit,
    clickAudit,
    trustedButtonPass: clickAudit?.isTrusted === true && Math.abs(Number(state.startedAt || 0) - Number(clickAudit.timestamp || 0)) <= 100,
    noMediaPass: mediaElements === 0 && mediaRequests === 0 &&
      Number(mediaAudit?.created || 0) === 0 && Number(mediaAudit?.playCalls || 0) === 0 && Number(mediaAudit?.loadCalls || 0) === 0,
    stageTimings: state.stageTimings || {},
    verdicts: audits.map(item => ({
      artistUrl: item.artistUrl,
      decision: item.decision,
      reason: item.reason,
      preference: item.preference,
      preferenceThreshold: item.preferenceThreshold,
      actualVideos: item.actualVideos,
      hardVerified: item.hardVerified,
      checks: item.checks,
      anatomyAssessment: item.anatomyAssessment,
      qwenReviewCodes: item.qwenReviewCodes,
      qwenReviewReasons: item.qwenReviewReasons,
      screenedImages: item.screenedImages,
      clearBodyImages: item.clearBodyImages,
    })),
  };
}

async function runMode(chromePort, appUrl, mode) {
  const url = `${appUrl}?pongNoMedia=1&pongLiveScan=1&pongPages=${PAGES.join(',')}&mode=${mode}&t=${Date.now()}`;
  const { target, session } = await openPage(chromePort, url);
  let mediaRequests = 0;
  session.on('Network.requestWillBeSent', params => {
    if (params.type === 'Media') mediaRequests++;
  });
  const selector = mode === 'local2' ? '#random-40-local2' : '#random-40-local';
  let lastProgressAt = 0;
  try {
    await waitFor(() => session.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector(${JSON.stringify(selector)}))`), 20_000, `${mode} page`);
    await dismissPongSplash(session);
    await session.evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      window.__pongBenchmarkClickAudit = null;
      button.addEventListener('click', event => {
        window.__pongBenchmarkClickAudit = { isTrusted: event.isTrusted, timestamp: Date.now() };
      }, { capture: true, once: true });
      return true;
    })()`);
    await trustedClick(session, selector);
    const state = await waitFor(async () => {
      const raw = await session.evaluate(`document.querySelector('#random40-benchmark-state')?.textContent || ''`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - lastProgressAt >= 15_000) {
        lastProgressAt = Date.now();
        console.log(JSON.stringify({ progress: mode, elapsedMs: parsed.elapsedMs, pages: parsed.pages, accepted: parsed.accepted, detail: parsed.detail }));
      }
      return parsed.done ? parsed : null;
    }, DEADLINE_MS, `${mode} three-page button run`, 500);
    const mediaElements = await session.evaluate(`document.querySelectorAll('video,audio').length`);
    const mediaAudit = await session.evaluate(`window.__pongMediaAudit || {}`);
    const clickAudit = await session.evaluate(`window.__pongBenchmarkClickAudit || {}`);
    return compactResult(state, mode, Number(mediaElements || 0), mediaRequests, mediaAudit, clickAudit);
  } finally {
    session.close();
    await fetch(`http://127.0.0.1:${chromePort}/json/close/${target.id}`).catch(() => {});
  }
}

async function main() {
  const health = await fetch(`${LOCAL_AI}/health`).then(response => response.json());
  if (!health?.ok || !health?.ready) throw new Error('Pong Local AI core is not ready');
  const { server, url } = await startStaticServer();
  const results = [];
  try {
    for (const mode of MODES) {
      const chrome = await startChrome();
      try {
        results.push(await runMode(chrome.port, url, mode));
      } finally {
        await stopChromeTree(chrome.child);
        await delay(250);
        await rm(chrome.profile, { recursive: true, force: true });
      }
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  const byMode = Object.fromEntries(results.map(result => [result.mode, result]));
  const comparisonPass = !byMode.local || !byMode.local2 || byMode.local2.elapsedMs < byMode.local.elapsedMs;
  const passed = comparisonPass && results.every(result =>
    result.hardSafe && result.noMediaPass && result.trustedButtonPass &&
    result.pages === PAGES.length * 2 && result.modelDecisions > 0 &&
    result.accepted > 0 && result.videos >= result.accepted * 15 &&
    result.pagePlan.join(',') === PAGES.join(',')
  );
  console.log(JSON.stringify({
    benchmark: 'actual Random40 button, same deterministic three-page live scan',
    timestamp: new Date().toISOString(),
    pages: PAGES,
    passed,
    local2Faster: comparisonPass,
    speedup: byMode.local && byMode.local2 ? Number((byMode.local.elapsedMs / byMode.local2.elapsedMs).toFixed(3)) : null,
    results,
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
