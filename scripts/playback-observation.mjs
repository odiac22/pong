// A naturally ended short source is not a stall, and also cannot satisfy a
// longer requested observation window. Keep these outcomes separate.
export function classifyPlaybackObservation(row, requestedSeconds) {
  const completedSource = row.ended === true && Number.isFinite(row.durationSeconds) &&
    row.durationSeconds > 0 && row.currentTimeSeconds >= row.durationSeconds - .1;
  const observationWindowComplete = row.mediaAdvanceSeconds >= requestedSeconds;
  // A clock that advances despite frozen pixels, or a run that buffers between
  // short bursts, must not satisfy the real-player acceptance requirement.
  const presentationVerified = row.presentedFrames >= 2 &&
    Number.isFinite(row.presentedMediaAdvanceSeconds) &&
    row.presentedMediaAdvanceSeconds >= requestedSeconds;
  const startupPassed = Number.isFinite(row.startupMs) && row.startupMs >= 0 && row.startupMs < 1500;
  const uninterrupted = presentationVerified && row.waitingAfterFirstFrame === 0 &&
    Number.isFinite(row.maxPresentedGapMs) && row.maxPresentedGapMs <= 250 &&
    Number.isFinite(row.playbackWallMs) && row.playbackWallMs <= requestedSeconds * 1000 + 500;
  const passed = row.muted === true && observationWindowComplete && startupPassed && uninterrupted;
  const shortSource = completedSource && !observationWindowComplete;
  return {completedSource, observationWindowComplete, presentationVerified, startupPassed, uninterrupted, passed,
    error: passed ? '' : shortSource ? 'source ended before the requested observation window completed'
      : 'did not meet uninterrupted muted playback threshold'};
}
