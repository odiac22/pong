// Ground truth must come from reviewing ORIGINAL media, not the swap detector.
// A missed detection must never become a convenient "no face" exemption.
const finite = Number.isFinite;
const inside = (time, ranges) => ranges.some(([a, b]) => time >= a && time < b);
const unique = events => [...new Map(events.map(e =>
  [`${e.videoId}:${e.session || ''}:${e.at}:${e.mediaTime}`, e])).values()];

export function validateFaceReview(review) {
  if (!review || review.reviewed !== true || review.method !== 'manual-original' ||
      !Array.isArray(review.evidence) || !review.evidence.length ||
      !review.evidence.every(e => typeof e === 'string' && e.length > 0)) return false;
  const validRanges = ranges => Array.isArray(ranges) && ranges.every((r, i) =>
    Array.isArray(r) && r.length === 2 && r.every(finite) && r[0] >= 0 && r[1] > r[0] &&
    (i === 0 || r[0] >= ranges[i - 1][1]));
  return validRanges(review.reviewedRanges) && review.reviewedRanges.length > 0 &&
    validRanges(review.eligibleFaceRanges) && review.eligibleFaceRanges.every(([a, b]) =>
      review.reviewedRanges.some(([x, y]) => a >= x && b <= y)) &&
    finite(review.boundaryUncertaintyMs) && review.boundaryUncertaintyMs >= 0 &&
    review.boundaryUncertaintyMs <= 250;
}

export function faceVisibleTiming(trial, run, reviews = {}) {
  const base = {metric: 'eligible-face-visible-to-transformed-frame-presented',
    limitMs: 1000, pass: null, episodes: [], detectorUsedAsGroundTruth: false};
  if (trial.photoPost || trial.adPost) return {...base,
    status: 'excluded', reason: trial.adPost ? 'advertisement' : 'photo'};
  const ids = new Set((trial.samples || []).filter(s =>
    s.view?.postKind === 'video' && s.view.postKey === `video:${s.pong?.videoId}` &&
    s.pong.videoId !== trial.beforeVideoId && s.view.postKey !== trial.beforePostKey)
    .map(s => s.pong.videoId));
  if (ids.size !== 1) return {...base, status: 'unreviewed', reason: 'ambiguous-or-missing-video-identity'};
  const videoId = [...ids][0], review = reviews[videoId];
  if (!validateFaceReview(review)) return {...base, videoId, status: 'unreviewed', reason: 'original-face-visibility-not-reviewed'};
  const clock = run.clockCalibration;
  if (!clock || !finite(clock.minOffset) || !finite(clock.maxOffset) || clock.minOffset>clock.maxOffset)
    return {...base, videoId, status: 'unreviewed', reason: 'missing-clock-calibration'};
  const end = Math.min(run.holdMs, trial.observedDwellMs ?? run.holdMs);
  const inVisit = e => e.videoId === videoId && finite(e.at) && finite(e.mediaTime) &&
    e.at + clock.minOffset >= trial.startedAt && e.at + clock.maxOffset < trial.startedAt + end;
  const drains = run.paintDrains || [];
  const original = unique([...drains.flatMap(d => d.originalPaintEvents || []),
    ...(trial.originalPaintEvidence || [])]).filter(inVisit).sort((a, b) => a.at - b.at);
  // A button test may begin with a paused face ALREADY on screen. Waiting
  // for play()'s next callback would erase part of the user's real wait.
  const prior=trial.preActivationOriginalPaint;
  const priorAge=prior ? trial.startedAt-(prior.at+clock.minOffset) : Infinity;
  const validPrior=prior?.videoId===videoId&&prior.paused===true&&
    finite(prior.mediaTime)&&finite(prior.at)&&priorAge>=0&&priorAge<=1000;
  if(trial.kind==='current-video-activation'&&!validPrior)
    return {...base,videoId,status:'unreviewed',reason:'missing-valid-pre-activation-presentation'};
  if(trial.kind==='current-video-activation'&&validPrior) {
    original.unshift({...prior,at:trial.startedAt-clock.minOffset,alreadyVisibleAtActivation:true});
  }
  if (!original.length) return {...base, videoId, status: 'unreviewed', reason: 'no-original-frame-evidence'};
  if (original.some(e => !inside(e.mediaTime, review.reviewedRanges)))
    return {...base, videoId, status: 'unreviewed', reason: 'visible-media-outside-reviewed-range'};
  const sessions = new Map();
  for (const s of run.trials.flatMap(t => t.samples || [])) {
    const b = s.renderer, p = s.pong;
    if (b?.id && b.id === p?.session && p.videoId === videoId && b.fps > 0 &&
        s.view?.session === b.id && finite(s.view.sourceStart)) {
      const entry = sessions.get(b.id) || {fps: b.fps, start: s.view.sourceStart, ranges: []};
      entry.ranges.push(...(b.transformedFrameRanges || [])); sessions.set(b.id, entry);
    }
  }
  const swaps = unique([...drains.flatMap(d => d.paintEvents || []), ...(trial.paintEvidence || [])])
    .filter(inVisit).flatMap(paint => {
      const s = sessions.get(paint.session);
      // Canvas callbacks / green UI are not decoder presentation evidence.
      if (!s || paint.presentationKind && paint.presentationKind !== 'video-rVFC') return [];
      const frame = Math.round(paint.mediaTime * s.fps);
      if (!s.ranges.some(([a, b]) => frame >= a && frame <= b)) return [];
      return [{...paint, sourceTime: s.start + paint.mediaTime, frameSeconds: 1 / s.fps}];
    }).sort((a, b) => a.at - b.at);
  const episodes = [];
  let active = null, previous = null;
  for (const paint of original) {
    const range = review.eligibleFaceRanges.findIndex(([a, b]) => paint.mediaTime >= a && paint.mediaTime < b);
    const looped = previous && paint.mediaTime < previous.mediaTime - .1;
    if (active && (range !== active.range || looped)) { active.until = paint.at; active = null; }
    if (range >= 0) {
      if (!active) {active = {range, first: paint, last: paint, until: null}; episodes.push(active);}
      active.last = paint;
    }
    previous = paint;
  }
  if (!episodes.length) return {...base, videoId, status: 'excluded', reason: 'reviewed-no-eligible-face-in-view'};
  const uncertainty = review.boundaryUncertaintyMs;
  const scored = episodes.map(e => {
    const [mediaStart, mediaEnd] = review.eligibleFaceRanges[e.range];
    const until = e.until ?? trial.startedAt + end - clock.maxOffset;
    // If already swapped when the original face first appears, latency is 0.
    // Match the same media interval; never credit an earlier scene's face.
    const first = swaps.find(p => p.at >= e.first.at - p.frameSeconds * 1000 && p.at < until &&
      p.sourceTime >= Math.max(mediaStart, e.first.mediaTime - p.frameSeconds) && p.sourceTime < mediaEnd);
    const onsetUncertainty=e.first.alreadyVisibleAtActivation ? clock.maxOffset-clock.minOffset : uncertainty;
    const lower = first ? Math.max(0, first.at - e.first.at - onsetUncertainty) : null;
    const upper = first ? Math.max(0, first.at - e.first.at + onsetUncertainty) : null;
    const availableMs = Math.max(0, until - e.first.at - onsetUncertainty);
    const pass = first ? (upper < 1000 ? true : lower >= 1000 ? false : null) : availableMs >= 1000 ? false : null;
    return {mediaStartSeconds: e.first.mediaTime, mediaLastVisibleSeconds: e.last.mediaTime,
      faceVisibleAtMs: e.first.at + clock.maxOffset - trial.startedAt,
      firstSwapAfterFaceLowerMs: lower, firstSwapAfterFaceUpperMs: upper,
      clockStartsAt: e.first.alreadyVisibleAtActivation ? 'swap-activation-face-already-presented' : 'first-original-face-frame',
      availableMs, pass, status: first ? (pass === true ? 'pass' : pass === false ? 'slow' : 'threshold-uncertain') :
        (availableMs >= 1000 ? 'no-swap-while-face-visible' : 'face-visible-too-briefly-to-score'),
      firstSwappedSourceSeconds: first?.sourceTime ?? null};
  });
  return {...base, videoId, status: 'measured', reviewEvidence: review.evidence,
    boundaryUncertaintyMs: uncertainty, episodes: scored,
    pass: scored.some(e => e.pass === false) ? false : scored.every(e => e.pass === true) ? true : null};
}

export function reconcileFaceVisibleTiming(run, reviews = {}) {
  const trials = run.trials.map(t => ({index: t.index, ...faceVisibleTiming(t, run, reviews)}));
  const measured = trials.filter(t => t.status === 'measured');
  const unknown = trials.filter(t => t.status === 'unreviewed');
  return {schema: 1, metric: 'face-visible-to-swap-not-swipe-to-swap', trials,
    measuredVideoVisits: measured.length, excludedVisits: trials.filter(t => t.status === 'excluded').length,
    unreviewedVisits: unknown.length, failedVisits: measured.filter(t => t.pass === false).length,
    pass: measured.some(t => t.pass === false) ? false :
      measured.length && !unknown.length && measured.every(t => t.pass === true) ? true : null,
    note: 'Ads/photos excluded only from swap timing. Playback/navigation remain separately scored. Unreviewed is not no-face or pass.'};
}
