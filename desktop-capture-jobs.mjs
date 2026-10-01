import crypto from 'node:crypto';

const SAFE_ERRORS = new Set([
  'identity_unverified', 'no_video', 'source_unavailable', 'duration_unverified',
  'vpn_unavailable', 'resolution_failed', 'page_challenge', 'quality_unverified', 'superseded', 'timeout'
]);

export function createDesktopCaptureJobs({ resolve, commit, finish, active, concurrency = 2, maxJobs = 32, timeoutMs = 120_000 }) {
  const jobs = new Map();
  let activeResolutions = 0;
  const waiters = [];
  const withSlot = async task => {
    if (activeResolutions >= concurrency) await new Promise(resolveSlot => waiters.push(resolveSlot));
    activeResolutions++;
    try { return await task(); }
    finally {
      activeResolutions--;
      waiters.shift()?.();
    }
  };
  const withTimeout = async (task, milliseconds, onTimeout) => {
    const controller = new AbortController();
    const work = Promise.resolve().then(() => task(controller.signal));
    // The resolver may ignore abort and settle after its target has timed out.
    // Consume that result, but retain the global slot until it actually settles.
    work.catch(() => {});
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        controller.abort();
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, milliseconds);
      timer.unref?.();
    });
    try { return await Promise.race([work, deadline]); }
    finally {
      clearTimeout(timer);
      await work.catch(() => {});
    }
  };
  function status(job) {
    if (job.state === 'running' && !active(job.context)) {
      job.state = 'superseded';
      for (const target of job.targets) {
        if (target.state !== 'ready' && target.state !== 'failed') {
          target.state = 'failed'; target.error = 'superseded';
        }
      }
    }
    return {
      id: job.id,
      state: job.state,
      readyCount: job.targets.filter(target => target.state === 'ready').length,
      failedCount: job.targets.filter(target => target.state === 'failed').length,
      total: job.targets.length,
      targets: job.targets.map(({ index, state, error, durationSeconds, resolutionMs, verificationMs, sourceSelection }) => ({
        index, state, ...(error ? { error } : {}),
        ...(state === 'ready' ? { durationSeconds, resolutionMs, verificationMs,
          ...(sourceSelection ? { sourceSelection } : {}) } : {})
      }))
    };
  }
  function get(id) { const job = jobs.get(id); return job ? status(job) : null; }
  function canStart() { return jobs.size < maxJobs || [...jobs.values()].some(item => item.state !== 'running'); }
  function start({ id, fingerprint, targets, context }) {
    const existing = jobs.get(id);
    if (existing) return { status: status(existing), duplicate: existing.fingerprint === fingerprint };
    if (jobs.size >= maxJobs) {
      const old = [...jobs.values()].find(item => item.state !== 'running');
      if (!old) return { full: true };
      jobs.delete(old.id);
    }
    const job = {
      id, fingerprint, context, state: 'running',
      targets: targets.map((target, index) => ({ ...target, index, state: 'queued', error: '' }))
    };
    jobs.set(id, job);
    setImmediate(() => { void run(job).catch(() => {
      job.state = 'failed';
      for (const target of job.targets) {
        if (target.state !== 'ready' && target.state !== 'failed') {
          target.state = 'failed'; target.error = 'resolution_failed';
        }
      }
    }); });
    return { status: status(job), duplicate: false };
  }
  async function run(job) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < job.targets.length) {
        const target = job.targets[cursor++];
        if (!active(job.context)) {
          target.state = 'failed'; target.error = 'superseded';
          continue;
        }
        target.state = 'resolving';
        try {
          const result = await withSlot(() => withTimeout(
            signal => {
              if (!active(job.context)) throw Object.assign(new Error('superseded'), { code: 'superseded' });
              return resolve(target, job.context, () => { if (target.state === 'resolving') target.state = 'verifying'; }, signal);
            },
            timeoutMs,
            () => { target.state = 'failed'; target.error = 'timeout'; }
          ));
          // Abort listeners may reject or even return a value before the
          // deadline rejection wins Promise.race. Timeout still owns the result.
          if (target.error === 'timeout') throw Object.assign(new Error('timeout'), { code: 'timeout' });
          if (!active(job.context)) throw Object.assign(new Error('superseded'), { code: 'superseded' });
          if (!result?.video) throw Object.assign(new Error('source_unavailable'), { code: result?.error || 'source_unavailable' });
          await commit(job.context, result.video, target.index + 1);
          target.state = 'ready';
          target.durationSeconds = Math.max(0, Number(result.video.durationSeconds || 0));
          target.resolutionMs = Math.max(0, Number(result.resolutionMs || 0));
          target.verificationMs = Math.max(0, Number(result.verificationMs || 0));
          if (['selected-source-upgrade', 'selected-source-fallback'].includes(result.sourceSelection?.mode)) {
            const details = result.sourceSelection;
            const dimension = value => Number.isInteger(value) && value > 0 && value <= 16384 ? value : null;
            target.sourceSelection = { mode: details.mode,
              width: dimension(details.width), height: dimension(details.height),
              evidence: 'advertised-dimensions', verificationScope: 'response-headers',
              probesOverlappedResolution: details.probesOverlappedResolution === true };
          }
        } catch (error) {
          target.state = 'failed';
          target.error = target.error === 'timeout' ? 'timeout'
            : SAFE_ERRORS.has(error?.code) ? error.code : 'resolution_failed';
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, job.targets.length) }, worker));
    if (active(job.context)) {
      try { await finish(job.context, status(job)); }
      catch (_) { job.state = 'failed'; return; }
    }
    job.state = !active(job.context) ? 'superseded'
      : job.targets.some(target => target.state === 'ready') ? 'complete' : 'failed';
  }
  return { start, get, canStart };
}

export function desktopCaptureFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function rankDesktopCaptureMediaUrls(videoUrls, sourceMetadata = []) {
  const metadataByUrl = new Map((Array.isArray(sourceMetadata) ? sourceMetadata : [])
    .filter(source => source && typeof source.url === 'string').map(source => [source.url, source]));
  const labelHeight = label => {
    const text = String(label || '');
    const numeric = Number(text.match(/(?:^|\b)(\d{3,4})\s*p\b/i)?.[1] || 0);
    return numeric >= 144 && numeric <= 4320 ? numeric
      : /\b(?:4k|uhd)\b/i.test(text) ? 2160
      : /\b(?:full\s*hd|fhd)\b/i.test(text) ? 1080
      : /\bhd\b/i.test(text) ? 720 : 0;
  };
  const filenameQuality = mediaUrl => {
    const name = new URL(mediaUrl).pathname.split('/').at(-1) || '';
    const pair = name.match(/(?:^|[_-])(\d{3,4})[_x](\d{3,4})(?:[_./-]|$)/i);
    if (pair) return { width: Number(pair[1]), height: Number(pair[2]), evidence: 'filename_dimensions' };
    const heights = name.split(/[_-]/).map(part => Number(part.match(/^(\d{3,4})p?(?:\.[a-z0-9]+)?$/i)?.[1] || 0))
      .filter(value => value >= 144 && value <= 4320);
    const height = heights.at(-1) || 0;
    return { width: height ? Math.round(height * 16 / 9) : 0, height,
      evidence: height ? 'filename_height' : 'unknown' };
  };
  const ranked = [...new Set((videoUrls || []).filter(Boolean))]
    .filter(mediaUrl => {
      try { return metadataByUrl.get(mediaUrl)?.selectedInline === true ||
        !/(?:^|[/_-])(?:preview|trailer|thumb)(?:[/_.-]|$)/i.test(new URL(mediaUrl).pathname); }
      catch (_) { return false; }
    })
    .map((mediaUrl, index) => {
      const source = metadataByUrl.get(mediaUrl) || {};
      const width = Number(source.width), height = Number(source.height);
      const explicit = Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;
      const labelled = !explicit && labelHeight(source.label);
      const quality = explicit ? { width, height, evidence: 'selected_source_dimensions' }
        : labelled ? { width: Math.round(labelled * 16 / 9), height: labelled, evidence: 'selected_source_label' }
        : filenameQuality(mediaUrl);
      return { mediaUrl, index, ...quality, known: quality.height > 0,
        score: quality.width * quality.height,
        master: /master\.m3u8(?:[?#]|$)/i.test(mediaUrl) };
    })
    .sort((left, right) => right.score - left.score || Number(right.master) - Number(left.master) || left.index - right.index);
  return ranked;
}

export function preferredDesktopCaptureMediaUrls(videoUrls, sourceMetadata = []) {
  const ranked = rankDesktopCaptureMediaUrls(videoUrls, sourceMetadata);
  // Once the highest advertised rendition is known, a lower rendition must
  // not silently take its place when probing the preferred source fails.
  return ranked.filter(item => item.score === ranked[0]?.score && (!ranked[0]?.master || item.master)).map(item => item.mediaUrl);
}
