// Runs the swap benchmark in headless Chrome over CDP and writes raw results
// plus a median/p95 summary.
// node run.mjs --label baseline-1.0 --mode single --reps 3 [--clips a.mp4,b.mp4]
//              [--face approved-8-f7bf754ac81f] [--profile tiktok-gpen512]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const LABEL = arg('label', 'run');
const MODE = arg('mode', 'single');
const REPS = Number(arg('reps', 1));
const PORT = Number(arg('port', 18800));
const STOCK = arg('stock', 'F:\\pong-claude-bench\\stock');
const OUT = path.join(arg('out', 'F:\\pong-claude-bench\\results'), LABEL);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const clips = (arg('clips', '') || readdirSync(STOCK).filter(name => name.endsWith('.mp4')).sort().join(',')).split(',');
const manifest = JSON.parse(readFileSync(path.join(STOCK, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const faceFor = Object.fromEntries(Object.entries(manifest.clips).map(([clip, info]) => [clip, manifest.faces[info.face]]));
const eligible = new Set(Object.entries(manifest.clips).filter(([, info]) => info.eligible).map(([clip]) => clip));
const options = {faceFor,
  mode: MODE, clips, faceId: arg('face', 'approved-8-f7bf754ac81f'), profile: arg('profile', 'tiktok-gpen512'),
  prefetchPolicy: arg('prefetch', 'after-presented'), dwellMs: Number(arg('dwell', MODE === 'feed' ? 5000 : 9000)),
  scrub: arg('scrub', '1') === '1', traceTicks: arg('trace', '0') === '1',
  ...(arg('fpswin') ? {fpsWindowMs: Number(arg('fpswin'))} : {})
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function percentile(values, p) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  return Math.round(list[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)] * 100) / 100;
}
const stat = values => ({n: values.filter(Number.isFinite).length, median: percentile(values, 0.5), p95: percentile(values, 0.95)});

async function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const waiting = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  };
  return {
    send(method, params = {}) {
      const messageId = ++id;
      socket.send(JSON.stringify({id: messageId, method, params}));
      return new Promise(resolve => waiting.set(messageId, resolve));
    },
    close() { socket.close(); }
  };
}

async function main() {
  mkdirSync(OUT, {recursive: true});
  const debugPort = 9333;
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=F:\\pong-claude-bench\\chrome-profile`, '--autoplay-policy=no-user-gesture-required',
    '--mute-audio', '--no-first-run', '--window-size=412,915', 'about:blank'], {stdio: 'ignore'});
  try {
    let version;
    for (let i = 0; i < 50 && !version; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(200); }
    }
    const runs = [];
    for (let rep = 1; rep <= REPS; rep++) {
      const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${PORT}/bench.html`, {method: 'PUT'})).json();
      const client = await cdp(target.webSocketDebuggerUrl);
      await client.send('Runtime.enable');
      for (let i = 0; i < 100; i++) {
        const ready = await client.send('Runtime.evaluate', {expression: 'typeof window.runBench === "function"', returnByValue: true});
        if (ready.result?.result?.value) break;
        await sleep(100);
      }
      const started = Date.now();
      const response = await client.send('Runtime.evaluate', {
        expression: `window.runBench(${JSON.stringify(options)})`, awaitPromise: true, returnByValue: true, timeout: 3_600_000});
      if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 800));
      const value = response.result.result.value;
      value.rep = rep; value.wallMs = Date.now() - started;
      runs.push(value);
      writeFileSync(path.join(OUT, `rep-${rep}.json`), JSON.stringify(value, null, 2));
      console.log(`rep ${rep}: ${value.results.length} clips in ${Math.round(value.wallMs / 1000)}s`);
      client.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => {});
    }
    const all = runs.flatMap(run => run.results);
    const elig = all.filter(r => eligible.has(r.clip));
    const swappedRows = elig.filter(r => r.firstSwappedVisibleMs);
    const scrubs = label => elig.flatMap(r => r.scrubs.filter(s => s.label === label));
    const scrubStat = label => ({...stat(scrubs(label).map(s => s.scrubToSwappedMs)),
      swappedAfterScrub: scrubs(label).filter(s => s.scrubToSwappedMs !== null).length, total: scrubs(label).length,
      misalignedVisibleMs: stat(scrubs(label).map(s => s.misalignedVisibleMs))});
    const summary = {
      label: LABEL, mode: MODE, reps: REPS, clips: clips.length, eligibleClipRuns: elig.length, options, at: new Date().toISOString(), browser: version?.Browser,
      videoLoadMs: stat(all.map(r => r.loadMs)),
      firstSwappedVisibleMs: stat(elig.map(r => r.firstSwappedVisibleMs ?? Infinity).map(v => v === Infinity ? 99999 : v)),
      firstSwappedVisibleMsSwappedOnly: stat(swappedRows.map(r => r.firstSwappedVisibleMs)),
      swappedShareWithin5s: +(elig.filter(r => r.swappedWithinDeadline).length / Math.max(1, elig.length)).toFixed(3),
      swappedShareEver: +(swappedRows.length / Math.max(1, elig.length)).toFixed(3),
      swappedFps: stat(swappedRows.map(r => r.playback.transformedVisibleFps)),
      sourcePresentedFps: stat(all.map(r => r.playback.sourcePresentedFps)),
      maxSwappedGapMs: stat(swappedRows.map(r => r.playback.maxTransformedGapMs)),
      driftMedianMs: stat(swappedRows.map(r => r.playback.driftMedianMs)),
      driftP95Ms: stat(swappedRows.map(r => r.playback.driftP95Ms)),
      alignedFraction: stat(swappedRows.map(r => r.playback.alignedFraction)),
      scrubForward: scrubStat('forward'),
      scrubBackward: scrubStat('backward'),
      catchUps: all.reduce((sum, r) => sum + r.catchUps, 0),
      server: {
        firstTransformedMs: stat(elig.map(r => r.server?.[0]?.firstTransformedMs)),
        firstByteMs: stat(all.map(r => r.server?.[0]?.firstByteMs)),
        modelsReadyMs: stat(all.map(r => r.server?.[0]?.modelsReadyMs)),
        sourceOpenMs: stat(all.map(r => r.server?.[0]?.sourceOpenMs))
      },
      perClip: Object.fromEntries(clips.map(clip => {
        const rows = all.filter(r => r.clip === clip);
        return [clip, {eligible: eligible.has(clip), firstSwappedVisibleMs: rows.map(r => r.firstSwappedVisibleMs && Math.round(r.firstSwappedVisibleMs)),
          swappedFps: rows.map(r => r.playback.transformedVisibleFps), catchUps: rows.map(r => r.catchUps),
          scrub: rows.map(r => r.scrubs.map(s => `${s.label[0]}:${s.scrubToSwappedMs ?? 'none'}/${s.misalignedVisibleMs}`).join(' ')),
          transformed: rows.map(r => r.server?.map(s => `${s.transformedFrames}/${s.frames}${s.compatibility ? ' ' + s.compatibility : ''}`).join(' | '))}];
      }))
    };
    writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    chrome.kill();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
