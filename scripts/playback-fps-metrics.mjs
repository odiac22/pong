// Rendering headroom is not source cadence, and a callback is not necessarily
// one presented frame. Preserve these separate quantities in every report.
export function median(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const i = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[i] : (ordered[i - 1] + ordered[i]) / 2;
}

export function playbackFpsMetrics(row) {
  const session = row.finalSession ?? {};
  const work = session.timingTotals?.frameWorkSeconds;
  const frames = row.frames ?? [];
  const first = frames[0], last = frames.at(-1);
  const dt = first && last ? (last.t - first.t) / 1000 : 0;
  const presented = first && last ? last.presentedFrames - first.presentedFrames : 0;
  const valid = !row.error && row.fullPlaybackCompleted === true && session.complete === true && session.frames > 0;
  return {
    clip: row.clip,
    complete: valid,
    sourceFps: session.sourceFps ?? null,
    encodedFps: session.fps ?? null,
    renderWorkFps: work > 0 && Number.isFinite(work) ? session.frames / work : null,
    renderWorkScope: 'Includes measured exact/reuse work and encoder writes; excludes decode starvation, startup and intentional pacing. Not end-to-end throughput.',
    browserPresentedFps: dt > 0 && presented > 0 ? presented / dt : null,
    browserCallbackFps: dt > 0 ? (frames.length - 1) / dt : null,
    transformedFrames: session.transformedFrames ?? null,
    totalFrames: session.frames ?? null,
    transformedRatio: session.frames > 0 ? session.transformedFrames / session.frames : null,
    bufferCount: row.rebufferCount ?? null,
    bufferSeconds: row.bufferedWaitSeconds ?? null,
    zeroBuffering: valid && row.rebufferCount === 0 && row.bufferedWaitSeconds === 0,
    renderWorkAtLeast34: valid && work > 0 && session.frames / work >= 34,
    error: row.error ?? null,
  };
}

export function summarizePlaybackFps(report) {
  const clips = report.clips.map(playbackFpsMetrics);
  const rates = clips.map(c => c.renderWorkFps);
  const complete = report.completed === true && clips.length > 0 && clips.every(c => c.complete);
  const medianFps = median(rates);
  return {
    clips,
    sourceReportComplete: report.completed === true,
    medianRenderWorkFps: medianFps,
    targetMinimumRenderWorkFps: 34,
    targetMedianRenderWorkFps: 40,
    medianRenderWorkAtLeast40: complete && Number.isFinite(medianFps) && medianFps >= 40,
    minimumRenderWorkFps: rates.length && rates.every(Number.isFinite) ? Math.min(...rates) : null,
    allComplete: complete,
    allRenderWorkAtLeast34: report.completed === true && clips.length > 0 && clips.every(c => c.renderWorkAtLeast34),
    allZeroBuffering: report.completed === true && clips.length > 0 && clips.every(c => c.zeroBuffering),
    totalBufferSeconds: clips.every(c => Number.isFinite(c.bufferSeconds)) ? clips.reduce((n, c) => n + c.bufferSeconds, 0) : null,
  };
}
