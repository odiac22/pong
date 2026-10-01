function cleanUrl(rawValue) {
  return String(rawValue || '').trim();
}

export function local2MediaCdnMirrorUrl(rawUrl) {
  try {
    const url = new URL(cleanUrl(rawUrl));
    const match = url.hostname.match(/^img(\d+)\.(coomerfans|onlyfaphouse)\.com$/i);
    if (!match || url.protocol !== 'https:') return '';
    const counterpart = match[2].toLowerCase() === 'coomerfans'
      ? 'onlyfaphouse'
      : 'coomerfans';
    url.hostname = `img${match[1]}.${counterpart}.com`;
    return url.toString();
  } catch (_) {
    return '';
  }
}

export function local2MediaPlaybackCandidates(entry = {}) {
  const originals = [
    entry?.videoUrl,
    ...(Array.isArray(entry?.alternateVideoUrls) ? entry.alternateVideoUrls : [])
  ].map(cleanUrl).filter(Boolean);
  const candidates = [];
  const seen = new Set();
  const add = rawUrl => {
    const url = cleanUrl(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push(url);
  };
  // Keep the currently authoritative clone URL first, then its exact CDN-host
  // counterpart. Existing alternates retain their relative order and receive
  // the same counterpart treatment.
  for (const original of originals) {
    add(original);
    add(local2MediaCdnMirrorUrl(original));
  }
  return candidates;
}

function local2GeneratedMediaMirrorUrls(entry = {}) {
  return new Set([
    entry?.videoUrl,
    ...(Array.isArray(entry?.alternateVideoUrls) ? entry.alternateVideoUrls : [])
  ].map(local2MediaCdnMirrorUrl).filter(Boolean));
}

function finitePositive(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizedProbeResult(url, rawResult, elapsedMs) {
  const value = rawResult && typeof rawResult === 'object'
    ? rawResult
    : { playable: rawResult === true };
  return {
    url,
    playable: value.playable === true,
    fastStart: value.fastStart === true,
    probeLatencyMs: finitePositive(value.probeLatencyMs) || finitePositive(elapsedMs),
    probeBytesPerSecond: finitePositive(value.probeBytesPerSecond),
    streamabilityMargin: finitePositive(value.streamabilityMargin),
    details: value
  };
}

export function local2BestMediaProbe(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])]
    .filter(row => row?.playable === true && cleanUrl(row?.url))
    .sort((left, right) =>
      Number(right.fastStart === true) - Number(left.fastStart === true) ||
      (finitePositive(left.probeLatencyMs) || Number.MAX_SAFE_INTEGER) -
        (finitePositive(right.probeLatencyMs) || Number.MAX_SAFE_INTEGER) ||
      finitePositive(right.streamabilityMargin) - finitePositive(left.streamabilityMargin) ||
      finitePositive(right.probeBytesPerSecond) - finitePositive(left.probeBytesPerSecond)
    )[0] || null;
}

async function probeMediaEntry(entry, probe, timeoutMs, parentSignal) {
  const originalUrl = cleanUrl(entry?.videoUrl);
  const candidates = local2MediaPlaybackCandidates(entry);
  const generatedMirrors = local2GeneratedMediaMirrorUrls(entry);
  if (!originalUrl || !candidates.length || parentSignal?.aborted) {
    return {
      entry: {
        ...entry,
        alternateVideoUrls: candidates.filter(url => url !== originalUrl)
      },
      diagnostics: {
        candidateCount: candidates.length,
        mirrorCandidates: generatedMirrors.size,
        probes: 0,
        playableProbes: 0,
        fastStartProbes: 0,
        selectedMirror: false,
        selectedOriginal: false,
        failedOpen: Boolean(originalUrl)
      }
    };
  }

  const controllers = candidates.map(() => new AbortController());
  const abortAll = () => controllers.forEach(controller => {
    if (!controller.signal.aborted) controller.abort();
  });
  const onParentAbort = () => abortAll();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const rows = [];
  let chosenFastStart = null;
  let settleEarly;
  const early = new Promise(resolve => { settleEarly = resolve; });
  let settled = 0;
  const tasks = candidates.map(async (url, index) => {
    const startedAt = Date.now();
    let rawResult = null;
    try {
      rawResult = await probe(url, {
        signal: controllers[index].signal,
        timeoutMs
      });
    } catch (_) {}
    const row = normalizedProbeResult(url, rawResult, Date.now() - startedAt);
    rows.push(row);
    settled++;
    if (!chosenFastStart && row.playable && row.fastStart) {
      chosenFastStart = row;
      settleEarly();
    } else if (settled >= candidates.length) {
      settleEarly();
    }
  });

  await early;
  // A fast-start winner is sufficient for playback. Cancel a hanging
  // counterpart immediately so a bad primary CDN cannot delay publication.
  if (chosenFastStart) abortAll();
  await Promise.allSettled(tasks);
  parentSignal?.removeEventListener('abort', onParentAbort);

  const selected = chosenFastStart || local2BestMediaProbe(rows);
  const selectedUrl = cleanUrl(selected?.url) || originalUrl;
  const selectedMirror = Boolean(selected && generatedMirrors.has(selectedUrl));
  const output = {
    ...entry,
    ...(selected?.details || {}),
    videoUrl: selectedUrl,
    alternateVideoUrls: candidates.filter(url => url !== selectedUrl),
    playbackMirrorProbed: true,
    playbackMirrorSelected: selectedMirror,
    playbackMirrorFailedOpen: !selected
  };
  if (selected) {
    output.playbackProbeVerified = true;
    output.playbackFastStart = selected.fastStart === true;
    output.fastStart = selected.fastStart === true;
    output.videoUrl = selectedUrl;
    output.alternateVideoUrls = candidates.filter(url => url !== selectedUrl);
  }
  return {
    entry: output,
    diagnostics: {
      candidateCount: candidates.length,
      mirrorCandidates: generatedMirrors.size,
      probes: rows.length,
      playableProbes: rows.filter(row => row.playable).length,
      fastStartProbes: rows.filter(row => row.playable && row.fastStart).length,
      selectedMirror,
      selectedOriginal: Boolean(selected && !selectedMirror),
      failedOpen: !selected
    }
  };
}

/**
 * Playback-only transformation. The output always preserves input cardinality
 * and keeps every original URL as the primary or an alternate. Probe failure
 * therefore cannot reject, remove, or change the authoritative 15-media proof.
 */
export async function selectLocal2PlaybackMediaMirrors(entries = [], {
  probe,
  signal = null,
  concurrency = 8,
  timeoutMs = 3000
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('probe is required');
  const source = Array.isArray(entries) ? entries : [];
  const output = source.map(entry => ({
    ...entry,
    alternateVideoUrls: local2MediaPlaybackCandidates(entry)
      .filter(url => url !== cleanUrl(entry?.videoUrl))
  }));
  const diagnostics = {
    entries: source.length,
    mirrorCandidates: output.reduce(
      (total, _entry, index) => total + local2GeneratedMediaMirrorUrls(source[index]).size,
      0
    ),
    probes: 0,
    playableProbes: 0,
    fastStartProbes: 0,
    selectedMirrors: 0,
    selectedOriginals: 0,
    failedOpenEntries: 0,
    elapsedMs: 0
  };
  if (!source.length || signal?.aborted) return { media: output, diagnostics };

  const startedAt = Date.now();
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(12, Number(concurrency || 8), source.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!signal?.aborted) {
      const index = cursor++;
      if (index >= source.length) return;
      const result = await probeMediaEntry(source[index], probe, timeoutMs, signal);
      output[index] = result.entry;
      diagnostics.probes += result.diagnostics.probes;
      diagnostics.playableProbes += result.diagnostics.playableProbes;
      diagnostics.fastStartProbes += result.diagnostics.fastStartProbes;
      diagnostics.selectedMirrors += Number(result.diagnostics.selectedMirror);
      diagnostics.selectedOriginals += Number(result.diagnostics.selectedOriginal);
      diagnostics.failedOpenEntries += Number(result.diagnostics.failedOpen);
    }
  }));
  diagnostics.elapsedMs = Date.now() - startedAt;
  return { media: output, diagnostics };
}
