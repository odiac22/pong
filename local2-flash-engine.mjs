import { randomInt } from 'node:crypto';

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
    this.candidateConcurrency = integer(candidateConcurrency, 12, 1, 48);
    this.maximumPendingCandidates = integer(maximumPendingCandidates, 32, this.candidateConcurrency, 256);
    this.maximumPages = integer(maximumPages, 120, 1, 3500);
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
        leased: 0
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
      pages: run.stats.pages,
      discovered: run.stats.discovered,
      submitted: run.stats.submitted,
      completed: run.stats.completed,
      rejected: run.stats.rejected,
      failed: run.stats.failed,
      activeCandidates: run.active.size,
      rejectionReasons: Object.fromEntries(
        [...run.stats.rejectionReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)
      ),
      timings: { ...run.stats.timings },
      startedAt: run.startedAt,
      firstAcceptedAt: run.firstAcceptedAt || 0,
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
      seenArtists: new Set(),
      accepted: new Map(),
      leases: new Map(),
      active: new Set(),
      done: false,
      startedAt: this.now(),
      firstAcceptedAt: 0,
      stats: {
        pages: 0,
        discovered: 0,
        submitted: 0,
        completed: 0,
        rejected: 0,
        failed: 0,
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
    if (run.seed) {
      // Deterministic sequence for paired benchmarks.
      const value = (Math.imul((run.seed + index) >>> 0, 1664525) + 1013904223) >>> 0;
      return 1 + (value % 3500);
    }
    return randomInt(1, 3501);
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
      const candidates = await this.discoverPages(pages, {
        signal: run.controller.signal,
        revision: run.revision,
        generation: run.generation,
        variant: this.variant
      });
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
      // Likely-video density is the only scheduling hint. It changes completion
      // order, never the acceptance rules.
      unique.sort((a, b) =>
        Number(b.preferenceRank || 0) - Number(a.preferenceRank || 0) ||
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
    try {
      const result = await this.qualifyCandidate(candidate, {
        signal: run.controller.signal,
        revision: run.revision,
        generation: run.generation,
        variant: this.variant
      });
      if (this.run !== run || run.controller.signal.aborted) return;
      run.stats.completed++;
      if (!result?.accepted || !result?.dto) {
        run.stats.rejected++;
        const reason = text(result?.reason || 'rejected', 160);
        run.stats.rejectionReasons.set(reason, Number(run.stats.rejectionReasons.get(reason) || 0) + 1);
        if (run.diagnostics) {
          run.stats.recentOutcomes.push({
            artistUrl: text(candidate.artistUrl, 2048),
            accepted: false,
            reason,
            elapsedMs: this.now() - started,
            detail: result?.diagnostic || null
          });
          if (run.stats.recentOutcomes.length > 256) run.stats.recentOutcomes.shift();
        }
        return;
      }
      run.accepted.set(candidate.artistId, result.dto);
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
      run.stats.failed++;
      const reason = text(error?.message || error || 'failed', 160);
      run.stats.rejectionReasons.set(reason, Number(run.stats.rejectionReasons.get(reason) || 0) + 1);
      if (run.diagnostics) {
        run.stats.recentOutcomes.push({
          artistUrl: text(candidate.artistUrl, 2048),
          accepted: false,
          reason,
          elapsedMs: this.now() - started
        });
        if (run.stats.recentOutcomes.length > 256) run.stats.recentOutcomes.shift();
      }
    } finally {
      run.stats.timings.qualificationMs += this.now() - started;
    }
  }

  lease(count = 12) {
    const run = this.run;
    if (!run) return [];
    const output = [];
    const maximum = integer(count, 12, 1, 64);
    for (const [identity, dto] of run.accepted) {
      if (output.length >= maximum) break;
      run.accepted.delete(identity);
      run.leases.set(identity, dto);
      output.push(dto);
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
