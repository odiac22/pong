import { randomInt } from 'node:crypto';

const CANDIDATE_LEASE_TTL_MS = 15000;

const text = (value, maximum = 4096) => String(value || '').trim().slice(0, maximum);
const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
};

function artistIdentity(candidate = {}) {
  const explicit = text(candidate.artistId || candidate.identity, 512).toLowerCase();
  if (explicit) return explicit;
  try {
    const url = new URL(text(candidate.artistUrl || candidate.url));
    const parts = url.pathname.split('/').filter(Boolean).map(value => value.toLowerCase());
    if (parts[0] === 'u' && parts.length >= 3) return `${parts[1]}:${parts[2]}`;
    return `${url.hostname.toLowerCase()}:${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch (_) {
    return text(candidate.artistUrl || candidate.url, 2048).toLowerCase();
  }
}

function cleanPages(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter(value => Number.isInteger(value) && value >= 1 && value <= 3500))];
}

function transientRetryDelay(error, attempt = 0) {
  if (error?.name === 'AbortError') return 0;
  if (error?.pongTransient === true) {
    const explicit = Number(error?.retryAfterMs || 0);
    if (Number.isFinite(explicit) && explicit > 0) {
      return Math.min(180000, Math.max(50, explicit + 125));
    }
    return Math.min(30000, 1000 * (2 ** Math.min(5, attempt)));
  }
  const message = text(error?.message || error, 512);
  const match = message.match(/(?:backoff|retry)[^(\d]*\(?([\d,]+)\s*ms/i);
  const explicit = Number(error?.retryAfterMs || match?.[1]?.replace(/,/g, ''));
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(180000, Math.max(50, explicit + 125));
  if (/\b(?:HTTP\s*)?(?:429|502|503|504)\b|shared backoff|temporar|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return Math.min(30000, 1000 * (2 ** Math.min(5, attempt)));
  }
  return 0;
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('stopped')); return; }
    const timer = setTimeout(resolve, Math.max(0, Number(delayMs || 0)));
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('stopped'));
    }, { once: true });
  });
}

export class Local2FlashEngine {
  constructor({
    discoverPages,
    qualifyCandidate,
    getRevision = async () => 'local2-flash-unversioned',
    targetAccepted = 48,
    readyMinimum = 1,
    pageConcurrency = 4,
    candidateConcurrency = 12,
    maximumPendingCandidates = 32,
    maximumPages = 120,
    candidateTimeoutMs = 45000,
    maximumTransientRetries = 3,
    variant = 'local2-flash',
    now = () => Date.now()
  } = {}) {
    if (typeof discoverPages !== 'function' || typeof qualifyCandidate !== 'function') {
      throw new Error('Local2 Flash requires discoverPages and qualifyCandidate workers');
    }
    this.discoverPages = discoverPages;
    this.qualifyCandidate = qualifyCandidate;
    this.getRevision = getRevision;
    this.targetAccepted = integer(targetAccepted, 48, 1, 256);
    this.readyMinimum = integer(readyMinimum, 1, 1, this.targetAccepted);
    this.pageConcurrency = integer(pageConcurrency, 4, 1, 16);
    // This is a logical in-flight bound. Network, GPU, and proof work each use
    // their own much smaller semaphores, so a wider ranked cohort here does not
    // widen the source request concurrency or its rate limit.
    this.candidateConcurrency = integer(candidateConcurrency, 12, 1, 256);
    this.maximumPendingCandidates = integer(maximumPendingCandidates, 32, this.candidateConcurrency, 256);
    this.maximumPages = integer(maximumPages, 120, 1, 3500);
    this.candidateTimeoutMs = Number(candidateTimeoutMs) === 0
      ? 0
      : integer(candidateTimeoutMs, 45000, 5000, 180000);
    this.maximumTransientRetries = Number(maximumTransientRetries) === 0
      ? 0
      : integer(maximumTransientRetries, 3, 1, 1000000);
    this.variant = text(variant, 64) || 'local2-flash';
    this.now = now;
    this.generation = 0;
    this.run = null;
  }

  snapshot() {
    const run = this.run;
    if (!run) {
      return {
        ok: true,
        schema: 'pong.local2.flash.v1',
        storage: 'memory-only',
        active: false,
        ready: false,
        accepted: 0,
        leased: 0,
        pageConcurrency: this.pageConcurrency,
        candidateConcurrency: this.candidateConcurrency,
        maximumPendingCandidates: this.maximumPendingCandidates
      };
    }
    return {
      ok: true,
      schema: 'pong.local2.flash.v1',
      storage: 'memory-only',
      active: !run.controller.signal.aborted && !run.done,
      done: run.done,
      ready: run.accepted.size >= this.readyMinimum,
      revision: run.revision,
      accepted: run.accepted.size,
      leased: run.leases.size,
      target: this.targetAccepted,
      readyMinimum: this.readyMinimum,
      pageConcurrency: this.pageConcurrency,
      candidateConcurrency: this.candidateConcurrency,
      maximumPendingCandidates: this.maximumPendingCandidates,
      pages: run.stats.pages,
      productivePages: run.stats.productivePages,
      nearbyPagesQueued: run.hotPages.length,
      discovered: run.stats.discovered,
      submitted: run.stats.submitted,
      completed: run.stats.completed,
      acceptedTotal: run.stats.accepted,
      deliveredTotal: run.stats.delivered,
      deliveryGapsMs: run.stats.deliveredAt.slice(-12).map((value, index, values) => (
        index ? value - values[index - 1] : value - run.startedAt
      )),
      rejected: run.stats.rejected,
      policyRejected: run.stats.policyRejected,
      evidenceDisqualified: run.stats.evidenceDisqualified,
      failed: run.stats.failed,
      settled: run.stats.completed + run.stats.failed,
      transientRetries: run.stats.transientRetries,
      ...(run.diagnostics ? { transientReasons: [...run.stats.transientReasons] } : {}),
      activeCandidates: run.active.size,
      rejectionReasons: Object.fromEntries(
        [...run.stats.rejectionReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)
      ),
      timings: { ...run.stats.timings },
      startedAt: run.startedAt,
      firstAcceptedAt: run.firstAcceptedAt || 0,
      ...(run.error ? { error: run.error } : {}),
      ...(run.diagnostics ? { recentOutcomes: [...run.stats.recentOutcomes] } : {})
    };
  }

  async start({ pages = [], seed = 0, diagnostics = false } = {}) {
    await this.stop();
    const generation = ++this.generation;
    const controller = new AbortController();
    const revision = text(await this.getRevision(), 256) || 'local2-flash-unversioned';
    const forcedPages = cleanPages(pages);
    const run = {
      generation,
      controller,
      revision,
      forcedPages,
      seed: Number(seed || 0),
      diagnostics: Boolean(diagnostics),
      seenPages: new Set(),
      hotPages: [],
      hotPageSet: new Set(),
      seenArtists: new Set(),
      accepted: new Map(),
      leases: new Map(),
      leaseTimes: new Map(),
      active: new Set(),
      done: false,
      startedAt: this.now(),
      firstAcceptedAt: 0,
      stats: {
        pages: 0,
        discovered: 0,
        submitted: 0,
        completed: 0,
        accepted: 0,
        delivered: 0,
        deliveredAt: [],
        productivePages: 0,
        rejected: 0,
        policyRejected: 0,
        evidenceDisqualified: 0,
        failed: 0,
        transientRetries: 0,
        transientReasons: [],
        rejectionReasons: new Map(),
        recentOutcomes: [],
        timings: {
          discoveryMs: 0,
          qualificationMs: 0
        }
      }
    };
    this.run = run;
    run.producer = this.produce(run).catch(error => {
      if (!controller.signal.aborted) {
        run.error = text(error?.message || error, 240);
        run.stats.failed++;
      }
    }).finally(() => {
      if (this.run === run) run.done = true;
    });
    return this.snapshot();
  }

  nextPage(run, index) {
    if (index < run.forcedPages.length) return run.forcedPages[index];
    if (run.forcedPages.length) return 0;
    while (run.hotPages.length) {
      const page = run.hotPages.shift();
      run.hotPageSet.delete(page);
      if (!run.seenPages.has(page)) return page;
    }
    if (run.seed) {
      // Deterministic sequence for paired benchmarks.
      const value = (Math.imul((run.seed + index) >>> 0, 1664525) + 1013904223) >>> 0;
      return 1 + (value % 3500);
    }
    return randomInt(1, 3501);
  }

  promoteNearbyPages(run, rawPage) {
    if (run.forcedPages.length) return;
    const page = Number(rawPage || 0);
    if (!Number.isInteger(page) || page < 1 || page > 3500) return;
    const offsets = [-1, 1, -2, 2, -3, 3, -5, 5, -8, 8];
    let queued = 0;
    for (const offset of offsets) {
      const nearby = page + offset;
      if (
        nearby < 1 ||
        nearby > 3500 ||
        run.seenPages.has(nearby) ||
        run.hotPageSet.has(nearby)
      ) continue;
      run.hotPageSet.add(nearby);
      run.hotPages.push(nearby);
      queued++;
    }
    if (queued) run.stats.productivePages++;
  }

  async produce(run) {
    let pageCursor = 0;
    while (
      this.run === run &&
      !run.controller.signal.aborted &&
      run.accepted.size < this.targetAccepted &&
      run.stats.pages < this.maximumPages
    ) {
      while (run.active.size >= this.maximumPendingCandidates) {
        await Promise.race(run.active);
        if (run.controller.signal.aborted) return;
      }
      const pages = [];
      while (pages.length < this.pageConcurrency && run.stats.pages + pages.length < this.maximumPages) {
        const page = this.nextPage(run, pageCursor++);
        if (!page) break;
        if (run.seenPages.has(page)) continue;
        run.seenPages.add(page);
        pages.push(page);
      }
      if (!pages.length) break;
      const discoveryStarted = this.now();
      let candidates;
      let discoveryAttempt = 0;
      for (;;) {
        try {
          candidates = await this.discoverPages(pages, {
            signal: run.controller.signal,
            revision: run.revision,
            generation: run.generation,
            variant: this.variant
          });
          break;
        } catch (error) {
          const retryMs = transientRetryDelay(error, discoveryAttempt++);
          if (!retryMs || run.controller.signal.aborted) throw error;
          run.stats.transientRetries++;
          await waitForRetry(retryMs, run.controller.signal);
        }
      }
      run.stats.timings.discoveryMs += this.now() - discoveryStarted;
      run.stats.pages += pages.length;
      const unique = [];
      for (const candidate of candidates || []) {
        const identity = artistIdentity(candidate);
        if (!identity || run.seenArtists.has(identity)) continue;
        run.seenArtists.add(identity);
        unique.push({ ...candidate, artistId: identity });
      }
      run.stats.discovered += unique.length;
      // Local2.2 has a bounded structured source hint that identifies profiles
      // likely to satisfy its unchanged ten-video proof. Preserve that density-
      // first order here; the generic engine sort previously undid the discover
      // stage's ranking and sent media-sparse profiles ahead of known-dense ones.
      // Local2 retains preference-first ordering. These are scheduling hints
      // only and never accept or reject a candidate.
      unique.sort((a, b) => this.variant === 'local22-turbo'
        ? Number(Number(b.likelyVideoCount || 0) >= 10) -
            Number(Number(a.likelyVideoCount || 0) >= 10) ||
          Number(b.preferenceRank || 0) - Number(a.preferenceRank || 0) ||
          Number(b.likelyVideoCount || 0) - Number(a.likelyVideoCount || 0)
        : Number(b.preferenceRank || 0) - Number(a.preferenceRank || 0) ||
          Number(b.likelyVideoCount || 0) - Number(a.likelyVideoCount || 0)
      );
      for (const candidate of unique) {
        if (run.controller.signal.aborted || run.accepted.size >= this.targetAccepted) break;
        while (run.active.size >= this.candidateConcurrency) {
          await Promise.race(run.active);
          if (run.controller.signal.aborted) return;
        }
        run.stats.submitted++;
        let task;
        task = this.processCandidate(run, candidate).finally(() => run.active.delete(task));
        run.active.add(task);
      }
    }
    await Promise.allSettled([...run.active]);
  }

  async processCandidate(run, candidate) {
    const started = this.now();
    const candidateController = new AbortController();
    const abortFromRun = () => candidateController.abort(
      run.controller.signal.reason || new Error(`${this.variant} stopped`)
    );
    if (run.controller.signal.aborted) abortFromRun();
    else run.controller.signal.addEventListener('abort', abortFromRun, { once: true });
    const timeout = this.candidateTimeoutMs > 0
      ? setTimeout(() => candidateController.abort(
          new Error(`${this.variant} candidate exceeded ${this.candidateTimeoutMs}ms`)
        ), this.candidateTimeoutMs)
      : null;
    timeout?.unref?.();
    try {
      let result;
      let qualifyAttempt = 0;
      for (;;) {
        try {
          result = await this.qualifyCandidate(candidate, {
            signal: candidateController.signal,
            revision: run.revision,
            generation: run.generation,
            variant: this.variant
          });
          break;
        } catch (error) {
          const retryMs = transientRetryDelay(error, qualifyAttempt);
          if (!retryMs || candidateController.signal.aborted) throw error;
          // A permanently unhealthy dependency must not occupy every
          // candidate lane forever. Three delayed retries preserve
          // transient recovery; exhaustion is reported as an operational
          // failure, never as an artist rejection.
          if (this.maximumTransientRetries > 0 && qualifyAttempt >= this.maximumTransientRetries) throw error;
          qualifyAttempt++;
          run.stats.transientRetries++;
          if (run.diagnostics) {
            run.stats.transientReasons.push({
              artistUrl: text(candidate.artistUrl, 2048),
              reason: text(error?.message || error || 'transient failure', 200),
              retryMs
            });
            if (run.stats.transientReasons.length > 16) run.stats.transientReasons.shift();
          }
          await waitForRetry(retryMs, candidateController.signal);
        }
      }
      if (this.run !== run || run.controller.signal.aborted) return;
      run.stats.completed++;
      if (result?.mediaQualified === true) {
        this.promoteNearbyPages(run, candidate.sourcePage);
      }
      if (!result?.accepted || !result?.dto) {
        run.stats.rejected++;
        const category = result?.category === 'policy' ? 'policy' : 'evidence';
        if (category === 'policy') run.stats.policyRejected++;
        else run.stats.evidenceDisqualified++;
        const reason = text(result?.reason || 'rejected', 160);
        run.stats.rejectionReasons.set(reason, Number(run.stats.rejectionReasons.get(reason) || 0) + 1);
        if (run.diagnostics) {
          run.stats.recentOutcomes.push({
            artistUrl: text(candidate.artistUrl, 2048),
            accepted: false,
            category,
            reason,
            elapsedMs: this.now() - started,
            detail: result?.diagnostic || null
          });
          if (run.stats.recentOutcomes.length > 256) run.stats.recentOutcomes.shift();
        }
        return;
      }
      run.accepted.set(candidate.artistId, result.dto);
      run.stats.accepted++;
      if (!run.firstAcceptedAt) run.firstAcceptedAt = this.now();
      if (run.diagnostics) {
        run.stats.recentOutcomes.push({
          artistUrl: text(candidate.artistUrl, 2048),
          accepted: true,
          reason: text(result.dto?.decision?.reason || 'accepted', 160),
          elapsedMs: this.now() - started,
          detail: result?.diagnostic || null
        });
        if (run.stats.recentOutcomes.length > 256) run.stats.recentOutcomes.shift();
      }
    } catch (error) {
      if (run.controller.signal.aborted) return;
      const disqualificationCategory = error?.pongCategory === 'policy'
        ? 'policy'
        : error?.pongCategory === 'evidence'
          ? 'evidence'
          : '';
      if (disqualificationCategory) {
        run.stats.completed++;
        run.stats.rejected++;
        if (disqualificationCategory === 'policy') run.stats.policyRejected++;
        else run.stats.evidenceDisqualified++;
        const reason = text(error?.message || error || 'disqualified', 160);
        run.stats.rejectionReasons.set(reason, Number(run.stats.rejectionReasons.get(reason) || 0) + 1);
        if (run.diagnostics) {
          run.stats.recentOutcomes.push({
            artistUrl: text(candidate.artistUrl, 2048),
            accepted: false,
            category: disqualificationCategory,
            reason,
            elapsedMs: this.now() - started,
            detail: null
          });
          if (run.stats.recentOutcomes.length > 256) run.stats.recentOutcomes.shift();
        }
        return;
      }
      run.stats.failed++;
      const reason = text(error?.message || error || 'failed', 160);
      run.stats.rejectionReasons.set(reason, Number(run.stats.rejectionReasons.get(reason) || 0) + 1);
      if (run.diagnostics) {
        run.stats.recentOutcomes.push({
          artistUrl: text(candidate.artistUrl, 2048),
          accepted: false,
          category: 'operational',
          reason,
          elapsedMs: this.now() - started
        });
        if (run.stats.recentOutcomes.length > 256) run.stats.recentOutcomes.shift();
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      run.controller.signal.removeEventListener('abort', abortFromRun);
      // A candidate may launch bounded speculative helpers (for example source
      // ordering hints) that are intentionally not awaited after an early AI
      // rejection. Settle their shared signal with the candidate so they cannot
      // consume source capacity behind subsequent work.
      if (!candidateController.signal.aborted) {
        candidateController.abort(new Error(`${this.variant} candidate settled`));
      }
      run.stats.timings.qualificationMs += this.now() - started;
    }
  }

  lease(count = 12) {
    const run = this.run;
    if (!run) return [];
    const now = this.now();
    // Delivery stays retryable until the browser acknowledges publication.
    // Android can briefly suspend or recreate its WebView after receiving a
    // response; an unbounded lease previously stranded accepted artists.
    for (const [identity, dto] of run.leases) {
      const leasedAt = Number(run.leaseTimes.get(identity) || 0);
      if (leasedAt && now - leasedAt < CANDIDATE_LEASE_TTL_MS) continue;
      run.leases.delete(identity);
      run.leaseTimes.delete(identity);
      run.accepted.set(identity, dto);
    }
    const output = [];
    const maximum = integer(count, 12, 1, 64);
    for (const [identity, dto] of run.accepted) {
      if (output.length >= maximum) break;
      run.accepted.delete(identity);
      run.leases.set(identity, dto);
      run.leaseTimes.set(identity, now);
      output.push(dto);
    }
    if (output.length) {
      const deliveredAt = this.now();
      run.stats.delivered += output.length;
      for (let index = 0; index < output.length; index++) run.stats.deliveredAt.push(deliveredAt);
      if (run.stats.deliveredAt.length > 64) {
        run.stats.deliveredAt.splice(0, run.stats.deliveredAt.length - 64);
      }
    }
    return output;
  }

  acknowledge(values = []) {
    const run = this.run;
    if (!run) return 0;
    let consumed = 0;
    for (const value of values) {
      const identity = artistIdentity({ artistId: value, artistUrl: value });
      if (!identity || !run.leases.has(identity)) continue;
      run.leases.delete(identity);
      run.leaseTimes.delete(identity);
      consumed++;
    }
    return consumed;
  }

  async stop() {
    const run = this.run;
    if (!run) return this.snapshot();
    this.run = null;
    run.controller.abort(new Error('Local2 Flash stopped'));
    await Promise.race([
      Promise.resolve(run.producer).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    return this.snapshot();
  }
}
