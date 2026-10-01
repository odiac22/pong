// Preparation is optional: it never changes source selection or a ready receipt.
export const STARTUP_PREFIX_BYTES = 4 * 1024 * 1024;
export const STARTUP_PREFIX_LIMIT = 2;
export const GENERIC_FAILURE_COOLDOWN_MS = 30_000;

export function startupPreparationUrl(video, ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > STARTUP_PREFIX_LIMIT) return '';
  try {
    const url = new URL(video?.videoUrl);
    return url.protocol === 'https:' && /\.(mp4|m4v|mov)$/i.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}

export function genericCacheRequestMayRetry(record, now) {
  // Repeated status/warm/player requests are not new attempts. Neither a
  // signed-query rotation nor a new browser resets a failed entity's budget.
  if (record.status !== 'error') return true;
  if (Number(record.retryNotBefore || 0) > now) return false;
  record.retries = 0;
  record.retryNotBefore = 0;
  return true;
}

export function startupPrefixRange(record, offset) {
  if (!record.startupOnly || Number(record.activeReaders || 0) > 0 || record.playbackLease) return '';
  return offset < STARTUP_PREFIX_BYTES ? `bytes=${offset}-${STARTUP_PREFIX_BYTES - 1}` : '';
}
