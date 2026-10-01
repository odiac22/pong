// Swap benchmark page. Plays stock clips like the TikTok WebView does and
// drives the phone's real overlay scripts (tiktok-stream.js, frame-sync,
// stable-handoff) against an isolated renderer. Native Android glue that the
// overlay depends on (catch-up rule, playback credit, warm adoption) is
// reproduced here from MainActivity.java / index.html of Baseline 1.0.
'use strict';
(() => {
  const now = () => performance.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clientEpoch = 'bench-' + Math.random().toString(36).slice(2, 12);
  let activationSequence = 0, playbackSequence = 0;
  let current = null;            // {clip, card, video, pageUrl, sessionId, start, rec}
  const sessionsUsed = new Set();
  const prepared = new Map();    // clip -> {id, streamUrl}

  const api = async (path, options = {}) => {
    const response = await fetch('/pong-swap' + path, {cache: 'no-store', ...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  };
  const post = (path, body) => api(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

  // MainActivity.tikTokSwapStartSeconds
  const swapStart = (position, duration) => {
    position = Number.isFinite(position) ? Math.max(0, position) : 0;
    if (position <= 0.8) return 0;
    if (Number.isFinite(duration) && duration > 0 && duration - position <= 0.8) return 0;
    const remaining = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - position - 0.1) : 0.6;
    return position + Math.min(0.6, remaining);
  };

  let config = {};
  async function createSession(clip, startSeconds, prefetch) {
    const sequence = prefetch ? 0 : ++activationSequence;
    const payload = await post('/sessions', {
      channel: 'bench', sourceUrl: `${config.sourceBase}/stock/${encodeURIComponent(clip)}`, sourceUrls: [],
      faceId: config.faceFor?.[clip] || config.faceId, faceIds: [config.faceFor?.[clip] || config.faceId], startSeconds,
      prefetch, prebufferSeconds: prefetch ? 1.0 : 0.25,
      navigationClass: prefetch ? 'prefetch' : 'foreground',
      externalPlaybackClock: true, restorationProfile: config.profile,
      clientEpoch, activationSequence: sequence
    });
    const id = payload.session.id;
    sessionsUsed.add(id);
    const streamUrl = prefetch
      ? `/pong-swap/sessions/${id}/stream?attach=1`
      : `/pong-swap/sessions/${id}/stream?clientEpoch=${clientEpoch}&activationSequence=${sequence}`;
    return {id, streamUrl, sequence};
  }

  // ---- presentation evidence -------------------------------------------
  window.PongTikTokSwap = {
    presented(id) { if (current?.sessionId === id && !current.rec.firstVisibleMs) current.rec.firstVisibleMs = now() - current.t0; current?.rec.events.push(['presented', Math.round(now() - current.t0), id.slice(0, 8)]); },
    hidden(id) { current?.rec.events.push(['hidden', Math.round(now() - current.t0), id.slice(0, 8)]); },
    failed(id) { current?.rec.events.push(['failed', Math.round(now() - current.t0), id.slice(0, 8)]); current && (current.rec.failures += 1); }
  };

  let watchedOverlay = null;
  function watchOverlay() {
    const s = window.__pongDomSwap;
    if (!s || !current || s.overlay === watchedOverlay || typeof s.overlay.requestVideoFrameCallback !== 'function') return;
    watchedOverlay = s.overlay;
    const rec = current.rec, video = current.video, overlay = s.overlay;
    const paint = (_t, meta) => {
      if (window.__pongDomSwap?.overlay !== overlay) return;
      const owner = window.__pongDomSwap;
      rec.paints.push({t: now() - current.t0, media: meta.mediaTime, visible: overlay.style.opacity === '1',
        orig: Number(video.currentTime) - owner.start, start: owner.start, disp: meta.expectedDisplayTime, session: owner.sessionId});
      overlay.requestVideoFrameCallback(paint);
    };
    overlay.requestVideoFrameCallback(paint);
  }

  // ---- native glue: catch-up rule + playback credit ---------------------
  const gate = {pendingAt: 0, acceptedKey: '', acceptedAt: 0};
  async function nativeTick() {
    if (!current) return;
    watchOverlay();
    let state = {};
    try { state = window.__pongDomSwapSync ? window.__pongDomSwapSync() : {}; } catch (_) {}
    if (state.visible !== current.lastVisible || state.needsReseek) {
      current.lastVisible = state.visible;
      const o = window.__pongDomSwap?.overlay, ranges = [];
      for (let i = 0; o && i < o.buffered.length; i++) ranges.push([+o.buffered.start(i).toFixed(2), +o.buffered.end(i).toFixed(2)]);
      if (current.rec.syncLog.length < 60) current.rec.syncLog.push({t: Math.round(now() - current.t0), visible: !!state.visible, needsReseek: !!state.needsReseek,
        target: +(state.target ?? -1).toFixed(2), overlayTime: o ? +o.currentTime.toFixed(2) : null, bufferEnd: +(state.bufferEnd ?? -1).toFixed(2), ranges, session: (state.sessionId || '').slice(0, 8)});
    }
    const missed = (!state.visible && (state.readyState || 0) >= 2 && (state.ageMs || 0) >= 2500 && (state.lag || 0) >= 1.25) ||
      state.needsReseek === true;   // Baseline 1.2 native rule (MainActivity.syncTikTokNativeTimeline)
    if (!missed || state.sessionId !== current.sessionId) return;
    const key = current.pageUrl + '|' + current.sessionId, t = now();
    if (t - gate.pendingAt < 2000 || (key === gate.acceptedKey && t - gate.acceptedAt < 8000)) return;
    gate.pendingAt = t;
    const owner = current;
    const start = swapStart(owner.video.currentTime, owner.video.duration);
    owner.rec.catchUps += 1;
    try {
      owner.rec.retired.push(...await serverStats([owner.sessionId]));
      const session = await createSession(owner.clip, start, false);
      if (current !== owner) return;
      owner.sessionId = session.id; owner.start = start;
      window.__pongDomSwapAttach(session.streamUrl, session.id, start, owner.video, owner.pageUrl);
      gate.acceptedKey = key; gate.acceptedAt = now();   // cooldown keyed by the replaced session, as TikTokCatchUpReceiptGate
    } catch (error) { owner.rec.errors.push(String(error.message || error)); }
    gate.pendingAt = 0;
  }
  async function creditTick() {
    const owner = current;
    if (!owner?.sessionId) return;
    try {
      await post(`/sessions/${owner.sessionId}/playback`, {
        positionSeconds: Math.max(0, owner.video.currentTime - owner.start), paused: owner.video.paused,
        clientEpoch, playbackSequence: ++playbackSequence});
    } catch (_) {}
  }
  setInterval(nativeTick, 250);
  setInterval(creditTick, 500);
  setInterval(() => {
    if (!config.traceTicks || !current || current.rec.ticks.length >= 600) return;
    const s = window.__pongDomSwap, o = s?.overlay;
    current.rec.ticks.push([Math.round(now() - current.t0), +current.video.currentTime.toFixed(3), o ? +o.currentTime.toFixed(3) : null,
      s?.visible ? 1 : 0, o ? +o.playbackRate.toFixed(2) : null, o?.seeking ? 1 : 0]);
  }, 40);

  // ---- cards -------------------------------------------------------------
  function mountCard(clip, index) {
    document.querySelectorAll('.card').forEach(card => { card.querySelector('video')?.pause(); card.remove(); });
    const card = document.createElement('div'); card.className = 'card';
    const video = document.createElement('video');
    Object.assign(video, {muted: true, defaultMuted: true, loop: true, playsInline: true, autoplay: true, preload: 'auto'});
    card.appendChild(video); document.body.appendChild(card);
    const t0 = now();
    const rec = {clip, index, loadMs: null, sessionCreateMs: null, firstVisibleMs: null, prepared: false,
      catchUps: 0, failures: 0, errors: [], events: [], paints: [], origPaints: [], scrubs: [], retired: [], syncLog: [], ticks: []};
    const pageUrl = `https://www.tiktok.com/@bench/video/${7000000000000000000 + index}`;
    const owner = {clip, card, video, pageUrl, sessionId: '', start: 0, rec, t0};
    const origPaint = (_t, meta) => {
      if (rec.loadMs === null) rec.loadMs = now() - t0;
      rec.origPaints.push({t: now() - t0, media: meta.mediaTime, disp: meta.expectedDisplayTime});
      if (card.isConnected) video.requestVideoFrameCallback(origPaint);
    };
    video.requestVideoFrameCallback(origPaint);
    video.src = `/stock/${encodeURIComponent(clip)}`;
    video.play().catch(() => {});
    window.__pongTikTokObservedVideo = {pageUrl, video};
    return owner;
  }

  async function startSwap(owner, preparedSession) {
    if (preparedSession) {
      owner.rec.prepared = true;
      owner.sessionId = preparedSession.id; owner.start = 0;
      const sequence = ++activationSequence;
      post(`/sessions/${preparedSession.id}/activate`, {clientEpoch, activationSequence: sequence}).catch(error => owner.rec.errors.push(String(error.message)));
      const adopted = window.__pongDomSwapObserveVideo?.(owner.pageUrl, owner.video);
      if (!adopted) window.__pongDomSwapAttach(`/pong-swap/sessions/${preparedSession.id}/stream?clientEpoch=${clientEpoch}&activationSequence=${sequence}`,
        preparedSession.id, 0, owner.video, owner.pageUrl);
      owner.rec.sessionCreateMs = now() - owner.t0;
      return;
    }
    const session = await createSession(owner.clip, 0, false);
    owner.rec.sessionCreateMs = now() - owner.t0;
    if (current !== owner) return;
    owner.sessionId = session.id; owner.start = 0;
    window.__pongDomSwapAttach(session.streamUrl, session.id, 0, owner.video, owner.pageUrl);
  }

  async function waitFor(predicate, timeoutMs) {
    const end = now() + timeoutMs;
    while (now() < end) { if (predicate()) return true; await sleep(20); }
    return false;
  }

  async function scrub(owner, fraction, label) {
    const video = owner.video, rec = owner.rec;
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration < 2) return;
    const target = Math.max(0.1, Math.min(duration - 0.6, duration * fraction));
    const from = Number(video.currentTime);
    const tS = now() - owner.t0;
    video.currentTime = target;
    const ok = await waitFor(() => rec.paints.some(p => p.t > tS + 1 && p.visible && Math.abs(p.media - p.orig) <= 0.1), config.scrubTimeoutMs);
    const settled = rec.paints.find(p => p.t > tS + 1 && p.visible && Math.abs(p.media - p.orig) <= 0.1);
    const span = rec.paints.filter(p => p.t > tS && (!settled || p.t <= settled.t));
    const wrong = span.filter(p => p.visible && Math.abs(p.media - p.orig) > 0.15);
    rec.scrubs.push({label, atMs: Math.round(tS), from: +from.toFixed(2), target: +target.toFixed(2), ok,
      scrubToSwapMs: settled ? Math.round(settled.t - tS) : null,
      misalignedVisiblePaints: wrong.length,
      misalignedVisibleMs: wrong.length ? Math.round(wrong[wrong.length - 1].t - wrong[0].t + 33) : 0});
    await sleep(800);
  }

  function summarizePaints(rec, fromMs, toMs) {
    const visible = rec.paints.filter(p => p.visible && p.t >= fromMs && p.t <= toMs);
    const orig = rec.origPaints.filter(p => p.t >= fromMs && p.t <= toMs);
    let maxGap = 0;
    for (let i = 1; i < visible.length; i++) maxGap = Math.max(maxGap, visible[i].t - visible[i - 1].t);
    const seconds = Math.max(0.001, (toMs - fromMs) / 1000);
    return {windowMs: Math.round(toMs - fromMs), swappedFps: +(visible.length / seconds).toFixed(2),
      sourcePresentedFps: +(orig.length / seconds).toFixed(2), maxSwapGapMs: Math.round(maxGap),
      alignedFraction: visible.length ? +(visible.filter(p => Math.abs(p.media - p.orig) <= 0.1).length / visible.length).toFixed(3) : 0};
  }

  async function serverStats(ids) {
    const out = [];
    for (const id of ids) {
      try {
        const s = (await api(`/sessions/${id}`)).session;
        const rel = key => s[key] && s.createdAt ? Math.round((s[key] - s.createdAt) * 1000) : null;
        out.push({id: id.slice(0, 8), prefetch: s.prefetch, start: s.startSeconds, frames: s.frames, transformedFrames: s.transformedFrames,
          sourceOpenMs: rel('sourceOpenedAt'), modelsReadyMs: rel('modelsReadyAt'), embeddingReadyMs: rel('embeddingReadyAt'),
          firstSourceFrameMs: rel('firstSourceFrameAt'), firstTransformedMs: rel('firstTransformedFrameAt'),
          firstByteMs: rel('firstByteAt'), playableMs: rel('playableAt'), compatibility: s.compatibilityStatus,
          restorer: s.adaptiveRestoration?.model || null, error: s.error || null, state: s.state,
          fullId: id, fps: s.fps, ranges: s.transformedFrameRanges || [],
          inferenceFrames: s.inferenceFrames, temporalReuseFrames: s.temporalReuseFrames, timing: s.timingTotals || null});
      } catch (error) { out.push({id: id.slice(0, 8), error: String(error.message)}); }
    }
    return out;
  }

  function sessionIdsFor(rec) { return [...new Set(rec.paints.map(p => p.session).concat(rec.sessionIds || []))]; }

  async function runClip(clip, index, nextClips) {
    const owner = mountCard(clip, index);
    current = owner; watchedOverlay = null;
    owner.rec.sessionIds = [];
    const preparedSession = prepared.get(clip) || null;
    prepared.delete(clip);
    await startSwap(owner, preparedSession);
    owner.rec.sessionIds.push(owner.sessionId);
    // Feed mode: the next posts are known as soon as the card is shown.
    const prefetchNext = async () => {
      for (const next of nextClips.slice(0, config.prefetchCount)) {
        if (prepared.has(next) || current !== owner) continue;
        try {
          const session = await createSession(next, 0, true);
          prepared.set(next, session);
          if (next === nextClips[0]) window.__pongDomSwapPrepare?.(session.streamUrl, session.id,
            `https://www.tiktok.com/@bench/video/${7000000000000000000 + index + 1}`);
        } catch (error) { owner.rec.errors.push(String(error.message)); }
      }
    };
    if (config.mode === 'feed' && config.prefetchPolicy === 'immediate') prefetchNext();
    const dwellEnd = owner.t0 + config.dwellMs;
    let prefetchStarted = false;
    while (now() < dwellEnd) {
      if (config.mode === 'feed' && config.prefetchPolicy === 'after-presented' && !prefetchStarted && owner.rec.firstVisibleMs) {
        prefetchStarted = true; prefetchNext();
      }
      if (config.mode === 'single' && owner.rec.firstVisibleMs && now() - owner.t0 > owner.rec.firstVisibleMs + config.fpsWindowMs) break;
      await sleep(25);
    }
    const rec = owner.rec;
    rec.swappedWithinDeadline = Boolean(rec.firstVisibleMs && rec.firstVisibleMs <= config.swapDeadlineMs);
    const from = rec.firstVisibleMs || rec.loadMs || 0;
    rec.playback = summarizePaints(rec, from, now() - owner.t0);
    if (config.mode === 'single' && config.scrub && rec.firstVisibleMs) {
      await scrub(owner, 0.75, 'forward');
      await scrub(owner, 0.15, 'backward');
    }
    const live = await serverStats(sessionIdsFor(rec).filter(id => id && !rec.retired.some(s => s.fullId === id)));
    rec.server = [...rec.retired, ...live.filter(s => !s.error)];
    // True drift: pair each swapped paint with the original frame shown at the same refresh.
    const origByDisp = rec.origPaints.filter(q => Number.isFinite(q.disp));
    let j = 0;
    for (const p of rec.paints) {
      while (j + 1 < origByDisp.length && Math.abs(origByDisp[j + 1].disp - p.disp) <= Math.abs(origByDisp[j].disp - p.disp)) j++;
      const q = origByDisp[j];
      p.drift = q && Math.abs(q.disp - p.disp) < 20 ? p.media - (q.media - p.start) : null;
    }
    // A revealed overlay is not a swap: count only paints of frames the
    // renderer actually transformed (per-session output frame ranges).
    const bySession = new Map(rec.server.map(s => [s.fullId, s]));
    const transformedPaint = p => {
      const s = bySession.get(p.session);
      if (!s?.fps) return false;
      const frame = Math.floor(p.media * s.fps + 0.5);
      return s.ranges.some(([a, b]) => frame >= a && frame <= b);
    };
    for (const p of rec.paints) p.transformed = transformedPaint(p);
    // Aligned = the swapped frame shown is the original's frame (+-1 frame).
    // Scrub success: shown swapped frame within 200 ms of the original (normal
    // playback drift is reported separately). Wrong: more than 500 ms off.
    const aligned = p => Number.isFinite(p.drift) ? Math.abs(p.drift) <= 0.2 : Math.abs(p.media - p.orig) <= 0.2;
    const wrong = p => Number.isFinite(p.drift) ? Math.abs(p.drift) > 0.5 : Math.abs(p.media - p.orig) > 0.5;
    const firstSwapped = rec.paints.find(p => p.visible && p.transformed);
    rec.firstSwappedVisibleMs = firstSwapped ? firstSwapped.t : null;
    rec.swappedWithinDeadline = Boolean(rec.firstSwappedVisibleMs && rec.firstSwappedVisibleMs <= config.swapDeadlineMs);
    const fpsFrom = rec.firstSwappedVisibleMs ?? from;
    const fpsTo = Math.min(fpsFrom + config.fpsWindowMs, rec.scrubs[0] ? rec.scrubs[0].atMs : Infinity, now() - owner.t0);
    const swapped = rec.paints.filter(p => p.visible && p.transformed && p.t >= fpsFrom && p.t <= fpsTo);
    let gap = 0;
    for (let i = 1; i < swapped.length; i++) gap = Math.max(gap, swapped[i].t - swapped[i - 1].t);
    rec.playback.transformedVisibleFps = +(swapped.length / Math.max(0.001, (fpsTo - fpsFrom) / 1000)).toFixed(2);
    rec.playback.maxTransformedGapMs = Math.round(gap);
    const drifts = swapped.map(p => p.drift).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
    rec.playback.driftMedianMs = drifts.length ? Math.round(drifts[Math.floor(drifts.length / 2)] * 1000) : null;
    rec.playback.driftP95Ms = drifts.length ? Math.round(drifts[Math.min(drifts.length - 1, Math.ceil(drifts.length * .95) - 1)] * 1000) : null;
    rec.playback.alignedFraction = swapped.length ? +(swapped.filter(p => Number.isFinite(p.drift) && Math.abs(p.drift) <= 0.06).length / swapped.length).toFixed(3) : 0;
    // Scrub success = first visible, aligned AND transformed paint after the seek.
    for (const sc of rec.scrubs) {
      const hit = rec.paints.find(p => p.t > sc.atMs + 1 && p.visible && p.transformed && aligned(p));
      sc.scrubToSwappedMs = hit ? Math.round(hit.t - sc.atMs) : null;
      const wrongAfter = rec.paints.filter(p => p.t > sc.atMs && p.t < sc.atMs + 8000 && p.visible && wrong(p));
      sc.misalignedVisibleMs = wrongAfter.length ? Math.round(wrongAfter[wrongAfter.length - 1].t - wrongAfter[0].t + 33) : 0;
    }
    for (const s of rec.server) delete s.ranges;
    const result = {...rec};
    delete result.paints; delete result.origPaints;
    result.paintCount = rec.paints.length;
    return result;
  }

  window.runBench = async options => {
    config = {mode: 'single', profile: 'tiktok-gpen512', dwellMs: 9000, fpsWindowMs: 5000, swapDeadlineMs: 5000,
      scrub: true, scrubTimeoutMs: 6000, prefetchPolicy: 'after-presented', prefetchCount: 2,
      sourceBase: location.origin, ...options};
    const results = [];
    for (let i = 0; i < config.clips.length; i++) {
      results.push(await runClip(config.clips[i], i, config.clips.slice(i + 1)));
      if (config.mode === 'single') {
        window.__pongDomSwapClear?.(); window.__pongDomSwapWarmClear?.();
        await api('/sessions', {method: 'DELETE'}).catch(() => {});
        await sleep(config.betweenClipsMs ?? 1500);
      }
    }
    window.__pongDomSwapClear?.(); window.__pongDomSwapWarmClear?.(); current = null;
    await api('/sessions', {method: 'DELETE'}).catch(() => {});
    return {config, userAgent: navigator.userAgent, results};
  };
})();
