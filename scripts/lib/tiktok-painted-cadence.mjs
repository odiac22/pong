// Count actual, unique media-frame presentations, never rAF callbacks or the
// nominal FPS in a session descriptor. This is decoder presentation evidence,
// not a claim that Android's physical display presented every callback.
export function paintedCadence(events, {startMs, endMs, floor = 30} = {}) {
  if (![startMs, endMs, floor].every(Number.isFinite) || endMs <= startMs || floor <= 0)
    throw Error('A finite, positive measurement window and FPS floor are required');
  const ordered = events.filter(e => Number.isFinite(e.at) && Number.isFinite(e.mediaTime)
    && e.at >= startMs && e.at <= endMs).sort((a, b) => a.at - b.at);
  const seen = new Set(), frames = [];
  for (const event of ordered) {
    const identity = `${event.session || ''}:${event.mediaTime}`;
    if (seen.has(identity)) continue;
    seen.add(identity); frames.push(event);
  }
  // Every full one-second window matters, including the trailing stall after
  // the last callback. Check both sides of each count transition, not just
  // bins aligned to the start (which can hide a boundary-spanning freeze).
  const starts = new Set([startMs, endMs - 1000]);
  for (const e of frames) { starts.add(e.at); starts.add(e.at - 1000); }
  const windows = [...starts].filter(t => t >= startMs && t + 1000 <= endMs)
    .sort((a, b) => a - b).map(t => ({startMs: t,
      frames: frames.filter(e => e.at > t && e.at <= t + 1000).length}));
  const gaps = [frames[0]?.at ?? endMs, ...frames.slice(1).map(e => e.at), endMs]
    .map((at, i) => at - (i === 0 ? startMs : frames[i - 1]?.at ?? startMs));
  return {floor, uniqueFrames: frames.length, windowMs: endMs - startMs,
    minimumRollingOneSecondFrames: windows.length ? Math.min(...windows.map(w => w.frames)) : null,
    failingWindows: windows.filter(w => w.frames < floor).length,
    evaluatedWindows: windows.length, maxPresentationGapMs: Math.max(0, ...gaps),
    floorMet: windows.length > 0 && windows.every(w => w.frames >= floor),
    evidence: 'unique-media-time-decoder-presentations-not-physical-display'};
}

export function trialPaintedCadence(trial, calibration, holdMs, floor = 30) {
  const first = trial.firstPaintUpperMs;
  if (!Number.isFinite(first)) return {floor, floorMet: false, reason: 'no-qualified-swapped-paint'};
  const sessions = new Map();
  for (const sample of trial.samples || []) {
    const b = sample.renderer, p = sample.pong;
    if (!b?.id || b.id !== p?.session || !p.videoId) continue;
    const entry = sessions.get(b.id) || {videoId: p.videoId, fps: Number(b.fps), ranges: []};
    entry.ranges.push(...(b.transformedFrameRanges || [])); sessions.set(b.id, entry);
  }
  const events = (trial.paintEvidence || []).flatMap(paint => {
    const session = sessions.get(paint.session);
    if (!session || session.videoId !== paint.videoId || !(session.fps > 0)) return [];
    if (paint.presentationKind && paint.presentationKind !== 'video-rVFC') return [];
    const frame = Math.round(paint.mediaTime * session.fps);
    if (!session.ranges.some(([a, z]) => frame >= a && frame <= z)) return [];
    return [{...paint, at: paint.at + calibration.maxOffset - trial.startedAt}];
  });
  if (first >= holdMs) return {floor, floorMet: false, reason: 'paint-outside-viewing-window'};
  return {...paintedCadence(events, {startMs: first, endMs: holdMs, floor}),
    startupExcludedMs: first, swipeToFirstSwapMs: first,
    eligibilityReviewRequired: true,
    sourceBelowFloor: [...sessions.values()].some(s => s.fps < floor),
    note: 'Counts transformed frames only, not overall video FPS; no-face intervals can reduce this count without a playback glitch. Face eligibility and physical-display tracing still required.'};
}

// Snapshots drain the browser's event queue. Polling and swiping are independent:
// the first snapshot after a swipe can contain the PREVIOUS video's last frames.
// Keep the raw report immutable and reconcile by timestamp + session ownership,
// never by the trial that happened to receive a network response.
export function reconcileRunCadence(run, floor = 30) {
  const trials = run.trials || [];
  const raw = run.paintDrains || trials.flatMap(t => (t.samples || []).map(s => s.view));
  const drains = [...new Map(raw.filter(d => Number.isFinite(d?.at))
    .map(d => [`${d.observerCost?.snapshots}:${d.at}`, d])).values()].sort((a, b) => a.at - b.at);
  const events = drains.flatMap(d => d.paintEvents || []);
  const intervals = [];
  for (let i = 1; i < drains.length; i++) {
    const previous = drains[i - 1], current = drains[i];
    // Older reports discarded late in-flight responses. A skipped sequence
    // means missing evidence, not a freeze, and must never qualify as a pass.
    if (current.observerCost?.snapshots !== previous.observerCost?.snapshots + 1) continue;
    const last = intervals.at(-1);
    if (last?.[1] === previous.at) last[1] = current.at;
    else intervals.push([previous.at, current.at]);
  }
  const calibration = run.clockCalibration;
  const allSamples = trials.flatMap(t => t.samples || []);
  return trials.map((trial, index) => {
    const endMs = Math.min(run.holdMs,
      trials[index + 1] ? trials[index + 1].startedAt - trial.startedAt
        : trial.observedDwellMs ?? run.holdMs);
    const first = trial.firstPaintUpperMs;
    if (!Number.isFinite(first)) return {index: trial.index,
      ...trialPaintedCadence(trial, calibration, endMs, floor)};
    const previousIds = new Set([trial.beforeVideoId,
      String(trial.beforePostKey || '').startsWith('video:') ? trial.beforePostKey.slice(6) : '']);
    const owned = new Set((trial.samples || []).filter(s => s.renderer?.id === s.pong?.session
      && s.pong?.videoId && !previousIds.has(s.pong.videoId)
      && s.view?.postKey === `video:${s.pong.videoId}`).map(s => s.pong.session));
    const reconciled = {...trial, paintEvidence: events,
      samples: allSamples.filter(s => owned.has(s.renderer?.id))};
    const cadence = trialPaintedCadence(reconciled, calibration, endMs, floor);
    const coverage = intervals.map(([a, b]) => [
      a + calibration.maxOffset - trial.startedAt,
      b + calibration.minOffset - trial.startedAt]);
    let cursor = first;
    const missing = [];
    for (const [a, b] of coverage) {
      if (b <= cursor || a >= endMs) continue;
      if (a > cursor) missing.push([cursor, Math.min(a, endMs)]);
      cursor = Math.max(cursor, Math.min(b, endMs));
    }
    if (cursor < endMs) missing.push([cursor, endMs]);
    return {index: trial.index, ...cadence, collectionComplete: missing.length === 0,
      missingCollectionIntervalsMs: missing,
      floorMet: missing.length === 0 && cadence.floorMet,
      ...(missing.length ? {reason: 'incomplete-event-collection-not-a-proven-playback-stall'} : {})};
  });
}
