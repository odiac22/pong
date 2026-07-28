import { createHash } from 'node:crypto';

export const LOCAL2_PIPELINE_SCHEMA = 'pong.local2.pipeline.v1';
export const LOCAL2_ACCEPTED_SCHEMA = 'pong.local2.accepted.v1';

const DEFAULT_CONCURRENCY = Object.freeze({
  profile: 16,
  triage: 2,
  verify: 12,
  classify: 2,
  finalize: 4
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function normalizedString(value, maximum = 4096) {
  return String(value || '').trim().slice(0, maximum);
}

function uniqueStrings(values, limit = 128) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => normalizedString(value))
    .filter(Boolean))].slice(0, limit);
}

function normalizedVerdict(value) {
  const verdict = normalizedString(value, 16).toLowerCase();
  return ['accept', 'reject', 'uncertain'].includes(verdict) ? verdict : 'uncertain';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function local2Fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function local2ArtistIdentity(candidate = {}) {
  const explicit = normalizedString(candidate.artistId || candidate.identity, 512).toLowerCase();
  if (explicit) return explicit;
  const rawUrl = normalizedString(candidate.artistUrl || candidate.url);
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split('/').filter(Boolean).map(value => value.toLowerCase());
    if (parts[0] === 'u' && parts.length >= 3) return `${parts[1]}:${parts[2]}`;
    return `${url.hostname.toLowerCase()}:${url.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch (_) {
    return rawUrl.toLowerCase();
  }
}

export function local2DecisionIsHardSafe(decision = {}) {
  const hard = decision.hardFilters || decision.hard_filters || {};
  return normalizedVerdict(decision.verdict || decision.decision) === 'accept' &&
    hard.photograph === true &&
    hard.femalePresentingAdult === true &&
    hard.malePresent === false &&
    hard.attachedAnatomy === false &&
    hard.feetDominant === false &&
    hard.bodyMismatch === false &&
    hard.over60 === false &&
    hard.adultSafetyRisk === false &&
    hard.ambiguous === false;
}

export function local2CleanResultIsExplicitlyHardSafe(result = {}) {
  const checks = result?.checks || {};
  const decision = normalizedVerdict(result?.decision || result?.verdict);
  return decision === 'accept' &&
    result?.requires_qwen_review !== true &&
    checks.photograph === true &&
    checks.female_presenting_adult === true &&
    checks.male_present === false &&
    checks.male_only === false &&
    checks.attached_male_anatomy === false &&
    checks.feet_dominant === false &&
    checks.logo_or_placeholder === false &&
    checks.body_preference_conflict === false &&
    checks.appears_over_60 === false &&
    checks.appears_over_50 === false &&
    checks.underage_looking === false &&
    checks.age_ambiguous === false &&
    checks.anatomy_ambiguous === false &&
    checks.body_evidence_ambiguous === false;
}

export function local2ImageGradeSummary(imageGrades = [], fallbackConfidence = 0.5) {
  const fallback = Number.isFinite(Number(fallbackConfidence))
    ? Math.max(0, Math.min(1, Number(fallbackConfidence)))
    : 0.5;
  return (Array.isArray(imageGrades) ? imageGrades : []).map((item, index) => {
    const rawConfidence = Number(item?.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : fallback;
    const imageIndex = Math.max(1, Number(item?.image_index || index + 1) || index + 1);
    const decision = normalizedVerdict(item?.decision || item?.verdict) || 'uncertain';
    const reason = normalizedString(item?.reason || item?.reason_code, 160) || 'numeric local evidence';
    return `image ${imageIndex}: ${decision}, confidence ${confidence.toFixed(2)}, ${reason}`;
  }).join('\n');
}

export function local2VerifiedMedia(media = []) {
  const byUrl = new Map();
  for (const raw of Array.isArray(media) ? media : []) {
    const videoUrl = normalizedString(raw?.videoUrl || raw?.url);
    if (!videoUrl || raw?.verified !== true) continue;
    if (!byUrl.has(videoUrl)) {
      byUrl.set(videoUrl, {
        videoUrl,
        postUrl: normalizedString(raw?.postUrl),
        postIndex: Math.max(0, Number(raw?.postIndex || 0) || 0),
        alternateVideoUrls: uniqueStrings(raw?.alternateVideoUrls || raw?.alternates, 8),
        verified: true,
        fastStart: raw?.fastStart === true
      });
    }
  }
  return [...byUrl.values()];
}

export function createLocal2AcceptedDto({ revision, profile, decision, media, evidence = {} }) {
  const artistId = local2ArtistIdentity(profile);
  const verifiedMedia = local2VerifiedMedia(media);
  if (!artistId) throw new Error('Local2 accepted DTO requires an artist identity');
  if (!normalizedString(revision, 256)) throw new Error('Local2 accepted DTO requires a revision');
  if (!local2DecisionIsHardSafe(decision)) throw new Error('Local2 decision is not explicitly hard-safe');
  if (verifiedMedia.length < 15) throw new Error('Local2 accepted DTO requires 15 distinct verified media URLs');

  const hard = decision.hardFilters || decision.hard_filters || {};
  const decisionImageUrls = uniqueStrings(
    evidence.decisionImageUrls || evidence.imageUrls || decision.decisionImageUrls,
    16
  );
  return {
    schema: LOCAL2_ACCEPTED_SCHEMA,
    storage: 'memory-only',
    revision: normalizedString(revision, 256),
    artist: {
      id: artistId,
      url: normalizedString(profile.artistUrl || profile.url),
      name: normalizedString(profile.artistName || profile.name, 256),
      sourcePage: Math.max(0, Number(profile.sourcePage || 0) || 0)
    },
    decision: {
      verdict: 'accept',
      confidence: Math.max(0, Math.min(1, Number(decision.confidence || 0))),
      reason: normalizedString(decision.reason, 240),
      hardFilters: {
        photograph: true,
        femalePresentingAdult: true,
        malePresent: false,
        attachedAnatomy: false,
        feetDominant: false,
        bodyMismatch: false,
        over60: false,
        adultSafetyRisk: false,
        ambiguous: false
      },
      evidence: {
        examinedImages: Math.max(0, Number(evidence.examinedImages || decision.examinedImages || 0) || 0),
        clearBodyViews: Math.max(0, Number(evidence.clearBodyViews || decision.clearBodyViews || 0) || 0),
        decisionImageUrls
      },
      model: normalizedString(decision.model, 256)
    },
    media: verifiedMedia
  };
}

class RamLru {
  constructor({ namespace, maximumItems, maximumBytes }) {
    this.namespace = normalizedString(namespace, 128);
    this.maximumItems = boundedInteger(maximumItems, 4096, 1, 100000);
    this.maximumBytes = boundedInteger(maximumBytes, 128 * 1024 * 1024, 1024, 2 ** 31 - 1);
    this.entries = new Map();
    this.bytes = 0;
  }

  get(key) {
    const namespaced = `${this.namespace}:${key}`;
    const entry = this.entries.get(namespaced);
    if (!entry) return undefined;
    this.entries.delete(namespaced);
    this.entries.set(namespaced, entry);
    return entry.value;
  }

  set(key, value, estimatedBytes = 0) {
    const namespaced = `${this.namespace}:${key}`;
    const bytes = Math.max(1, Number(estimatedBytes || Buffer.byteLength(stableJson(value))) || 1);
    const previous = this.entries.get(namespaced);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(namespaced);
    this.entries.set(namespaced, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maximumItems || this.bytes > this.maximumBytes) {
      const oldestKey = this.entries.keys().next().value;
      const removed = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.bytes -= Number(removed?.bytes || 0);
    }
    return value;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  stats() {
    return { storage: 'memory-only', items: this.entries.size, bytes: this.bytes };
  }
}

export class Local2CacheBundle {
  constructor({ modelRevision, learningRevision, featureItems = 8192, featureBytes = 192 * 1024 * 1024, decisionItems = 2048, decisionBytes = 32 * 1024 * 1024 } = {}) {
    this.modelRevision = normalizedString(modelRevision, 256) || 'unversioned-model';
    this.learningRevision = normalizedString(learningRevision, 256) || 'untrained';
    this.features = new RamLru({
      namespace: `local2:features:${this.modelRevision}`,
      maximumItems: featureItems,
      maximumBytes: featureBytes
    });
    this.decisions = new RamLru({
      namespace: `local2:decisions:${this.modelRevision}`,
      maximumItems: decisionItems,
      maximumBytes: decisionBytes
    });
  }

  featureKey({ imageFingerprint, cropPolicy, featureKind }) {
    return local2Fingerprint({
      schema: LOCAL2_PIPELINE_SCHEMA,
      modelRevision: this.modelRevision,
      imageFingerprint,
      cropPolicy,
      featureKind
    });
  }

  decisionKey({ artistId, evidenceFingerprint }) {
    return local2Fingerprint({
      schema: LOCAL2_PIPELINE_SCHEMA,
      modelRevision: this.modelRevision,
      learningRevision: this.learningRevision,
      artistId,
      evidenceFingerprint
    });
  }

  rotateLearningRevision(nextRevision) {
    const normalized = normalizedString(nextRevision, 256);
    if (!normalized || normalized === this.learningRevision) return false;
    this.learningRevision = normalized;
    this.decisions.clear();
    return true;
  }

  stats() {
    return {
      storage: 'memory-only',
      modelRevision: this.modelRevision,
      learningRevision: this.learningRevision,
      features: this.features.stats(),
      decisions: this.decisions.stats()
    };
  }
}

class PriorityStage {
  constructor({ name, concurrency, worker, onResult, onError }) {
    this.name = name;
    this.concurrency = boundedInteger(concurrency, 1, 1, 128);
    this.worker = worker;
    this.onResult = onResult;
    this.onError = onError;
    this.queue = [];
    this.active = 0;
    this.sequence = 0;
    this.closed = false;
    this.completed = 0;
    this.failed = 0;
  }

  push(value, priority = 0) {
    if (this.closed) return false;
    this.queue.push({ value, priority: Number(priority || 0), sequence: this.sequence++ });
    this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    queueMicrotask(() => this.pump());
    return true;
  }

  pump() {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(() => this.worker(job.value))
        .then(result => {
          this.completed++;
          return this.onResult(job.value, result);
        })
        .catch(error => {
          this.failed++;
          return this.onError(job.value, error);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  stop() {
    this.closed = true;
    this.queue.length = 0;
  }

  stats() {
    return {
      queued: this.queue.length,
      active: this.active,
      completed: this.completed,
      failed: this.failed,
      concurrency: this.concurrency
    };
  }
}

export class Local2ContinuousPipeline {
  constructor({
    revision,
    workers,
    targetAccepted = 48,
    readyMinimum = 12,
    deliveryBatch = 12,
    minimumVerifiedMedia = 15,
    triageHardRejectConfidence = 0.98,
    qualifiedRejectionAudit = false,
    concurrency = {},
    leaseTtlMs = 180000,
    now = () => Date.now()
  } = {}) {
    if (!workers || ['profile', 'triage', 'verify', 'classify'].some(name => typeof workers[name] !== 'function')) {
      throw new Error('Local2 pipeline requires profile, triage, verify, and classify workers');
    }
    this.revision = normalizedString(revision, 256) || 'local2-untrained';
    this.workers = workers;
    this.targetAccepted = boundedInteger(targetAccepted, 48, 15, 256);
    this.readyMinimum = boundedInteger(readyMinimum, 12, 1, this.targetAccepted);
    this.deliveryBatch = boundedInteger(deliveryBatch, 12, 1, 64);
    this.minimumVerifiedMedia = boundedInteger(minimumVerifiedMedia, 15, 15, 100);
    this.triageHardRejectConfidence = Math.max(0.5, Math.min(1, Number(triageHardRejectConfidence || 0.98)));
    this.qualifiedRejectionAudit = qualifiedRejectionAudit === true;
    this.leaseTtlMs = Math.max(1000, Number(leaseTtlMs || 180000));
    this.now = now;
    this.states = new Map();
    this.accepted = new Map();
    this.leases = new Map();
    this.rejected = new Map();
    this.stopped = false;
    this.statsCounters = {
      submitted: 0,
      duplicate: 0,
      staleResults: 0,
      triageHardRejects: 0,
      verifiedRejects: 0,
      modelRejects: 0,
      accepted: 0
    };

    const limits = { ...DEFAULT_CONCURRENCY, ...concurrency };
    const stage = (name, worker, onResult) => new PriorityStage({
      name,
      concurrency: limits[name],
      worker,
      onResult,
      onError: (value, error) => this.fail(value?.state || value, name, error)
    });
    this.stages = {
      profile: stage('profile', state => workers.profile(state.candidate, this.context(state)), (state, result) => this.profiled(state, result)),
      triage: stage('triage', state => workers.triage(state.profile, this.context(state)), (state, result) => this.triaged(state, result)),
      verify: stage('verify', state => workers.verify(state.profile, this.context(state)), (state, result) => this.verified(state, result)),
      classify: stage(
        'classify',
        job => workers.classify(job.state.profile, job.state.triage, this.context(job.state, job.revision)),
        (job, result) => this.classified(job, result)
      ),
      finalize: stage(
        'finalize',
        job => workers.finalize
          ? workers.finalize(job.state.profile, job.state.media, job.state.decision, this.context(job.state, job.revision))
          : job.state.media,
        (job, result) => this.finalized(job, result)
      )
    };
  }

  context(state, revision = state.revision) {
    return {
      schema: LOCAL2_PIPELINE_SCHEMA,
      revision,
      artistId: state.artistId,
      priority: state.priority,
      storage: 'memory-only',
      signal: state.abortController.signal
    };
  }

  submit(candidate, { priority = 0 } = {}) {
    if (this.stopped || this.accepted.size >= this.targetAccepted) return false;
    const artistId = local2ArtistIdentity(candidate);
    if (!artistId) return false;
    if (this.states.has(artistId) || this.accepted.has(artistId) || this.leases.has(artistId) || this.rejected.has(artistId)) {
      this.statsCounters.duplicate++;
      return false;
    }
    const state = {
      artistId,
      candidate: { ...candidate, artistId },
      revision: this.revision,
      priority: Number(priority || 0),
      stage: 'profile',
      abortController: new AbortController(),
      submittedAt: this.now()
    };
    this.states.set(artistId, state);
    this.statsCounters.submitted++;
    return this.stages.profile.push(state, state.priority);
  }

  profiled(state, profile) {
    if (!this.current(state)) return;
    state.profile = { ...profile, artistId: state.artistId };
    state.priority += Number(profile?.priorityBoost || 0);
    // The fifteen-real-video contract is the first substantial gate. No image
    // model work begins until the verifier proves the artist qualifies.
    state.stage = 'verify';
    this.stages.verify.push(state, state.priority);
  }

  triaged(state, triage = {}) {
    if (!this.current(state)) return;
    state.triage = triage;
    const rejected = normalizedVerdict(triage.verdict || triage.decision) === 'reject';
    const hardReject = rejected && (
      triage.terminalReject === true ||
      (triage.hardReject === true && Number(triage.confidence || 0) >= this.triageHardRejectConfidence)
    );
    if (hardReject) {
      this.statsCounters.triageHardRejects++;
      this.reject(state, 'triage', triage.reason || 'high-confidence hard reject');
      return;
    }
    state.triageDone = true;
    state.stage = 'classify';
    this.queueClassification(state, state.priority + Number(triage.priorityBoost || 0));
  }

  verified(state, result) {
    if (!this.current(state)) return;
    state.media = local2VerifiedMedia(Array.isArray(result) ? result : result?.media);
    state.verifyDone = true;
    if (state.media.length < this.minimumVerifiedMedia) {
      this.statsCounters.verifiedRejects++;
      this.reject(state, 'verify', `only ${state.media.length}/${this.minimumVerifiedMedia} verified media URLs`);
      return;
    }
    if (state.modelRejected) {
      this.reject(state, 'classify', state.modelRejectReason || 'Local2 hard-safe decision gate rejected');
      return;
    }
    if (!state.triageDone) {
      state.stage = 'triage';
      this.stages.triage.push(state, state.priority);
      return;
    }
    this.maybeFinalize(state);
  }

  queueClassification(state, priority = state.priority) {
    if (!this.current(state) || state.classifyQueuedRevision === this.revision) return false;
    state.classifyQueuedRevision = this.revision;
    return this.stages.classify.push({ state, revision: this.revision }, priority);
  }

  classified(job, decision = {}) {
    const { state, revision } = job;
    if (!this.current(state)) return;
    if (state.classifyQueuedRevision === revision) state.classifyQueuedRevision = '';
    if (revision !== this.revision) {
      this.statsCounters.staleResults++;
      this.queueClassification(state);
      return;
    }
    state.revision = revision;
    state.decision = decision;
    state.classifyDone = true;
    if (!local2DecisionIsHardSafe(decision)) {
      this.statsCounters.modelRejects++;
      state.modelRejected = true;
      state.modelRejectReason = decision.reason || 'Local2 hard-safe decision gate rejected';
      if (!this.qualifiedRejectionAudit || state.verifyDone) {
        this.reject(state, 'classify', state.modelRejectReason);
      } else {
        // Explicit diagnostic runs may finish the already-running verifier so
        // the RAM audit can list rejected artists proven to have 15+ videos.
        state.stage = 'verify-for-rejection-audit';
      }
      return;
    }
    this.maybeFinalize(state);
  }

  maybeFinalize(state) {
    if (!this.current(state) || !state.verifyDone || !state.classifyDone || state.finalizeQueued) return;
    state.finalizeQueued = true;
    state.stage = 'finalize';
    this.stages.finalize.push({ state, revision: this.revision }, state.priority);
  }

  finalized(job, result) {
    const { state, revision } = job;
    if (!this.current(state)) return;
    if (revision !== this.revision) {
      this.statsCounters.staleResults++;
      state.revision = this.revision;
      state.classifyDone = false;
      state.finalizeQueued = false;
      this.queueClassification(state);
      return;
    }
    const media = Array.isArray(result) ? result : result?.media || state.media;
    const dto = createLocal2AcceptedDto({
      revision: this.revision,
      profile: state.profile,
      decision: state.decision,
      media,
      evidence: state.decision?.evidence || {}
    });
    state.stage = 'accepted';
    state.dto = dto;
    this.accepted.set(state.artistId, dto);
    this.statsCounters.accepted++;
  }

  current(state) {
    return !this.stopped && this.states.get(state.artistId) === state && !state.rejected;
  }

  fail(state, stage, error) {
    if (!this.current(state)) return;
    this.reject(state, stage, error?.message || String(error || 'worker failed'));
  }

  reject(state, stage, reason) {
    state.rejected = true;
    state.rejectStage = stage;
    state.stage = 'rejected';
    state.reason = normalizedString(reason, 240);
    state.abortController?.abort(new Error(state.reason || `Local2 ${stage} rejected`));
    this.rejected.set(state.artistId, {
      artistId: state.artistId,
      artistUrl: normalizedString(state.profile?.artistUrl || state.candidate?.artistUrl, 2048),
      artistName: normalizedString(state.profile?.artistName || state.candidate?.artistName, 256),
      stage,
      reason: state.reason,
      verifiedMediaCount: Array.isArray(state.media) ? state.media.length : 0,
      preferenceProbability: Number.isFinite(Number(state.decision?.rawDecision?.preference_probability))
        ? Number(state.decision.rawDecision.preference_probability)
        : null,
      decisionImageUrls: uniqueStrings(
        state.decision?.evidence?.decisionImageUrls ||
        state.profile?.candidateImageUrls ||
        [],
        12
      ),
      revision: state.revision,
      at: this.now()
    });
    // Terminal rejects are audit summaries, not active pipeline work. Keeping
    // every rejected state here eventually deadlocks producer backpressure.
    this.states.delete(state.artistId);
    while (this.rejected.size > 4096) {
      this.rejected.delete(this.rejected.keys().next().value);
    }
  }

  rotateRevision(nextRevision) {
    const revision = normalizedString(nextRevision, 256);
    if (!revision || revision === this.revision) return false;
    this.revision = revision;
    this.accepted.clear();
    this.leases.clear();
    this.rejected.clear();
    for (const [artistId, state] of this.states) {
      // Rejected identities are no longer authoritative after learning changes.
      // Remove them so the discovery producer may submit a fresh evidence set;
      // their already-aborted workers cannot mutate a replacement state.
      if (state.rejected) {
        this.states.delete(artistId);
        continue;
      }
      state.revision = revision;
      if (!state.profile || !state.triage) continue;
      state.decision = null;
      state.classifyDone = false;
      state.finalizeQueued = false;
      state.dto = null;
      state.stage = 'classify';
      this.queueClassification(state);
    }
    return true;
  }

  releaseExpiredLeases() {
    const now = this.now();
    for (const [artistId, lease] of this.leases) {
      if (lease.expiresAt > now) continue;
      this.leases.delete(artistId);
      if (lease.dto.revision === this.revision && this.accepted.size < this.targetAccepted) {
        this.accepted.set(artistId, lease.dto);
      }
    }
  }

  lease(count = this.deliveryBatch) {
    this.releaseExpiredLeases();
    const items = [...this.accepted.entries()].slice(0, boundedInteger(count, this.deliveryBatch, 1, 64));
    const leasedAt = this.now();
    for (const [artistId, dto] of items) {
      this.accepted.delete(artistId);
      this.leases.set(artistId, { dto, leasedAt, expiresAt: leasedAt + this.leaseTtlMs });
    }
    return items.map(([, dto]) => dto);
  }

  acknowledge(artistIds = []) {
    let consumed = 0;
    for (const raw of artistIds) {
      const artistId = normalizedString(raw, 512).toLowerCase();
      if (!this.leases.delete(artistId)) continue;
      this.states.delete(artistId);
      consumed++;
    }
    return consumed;
  }

  isReady() {
    this.releaseExpiredLeases();
    return this.accepted.size >= this.readyMinimum;
  }

  stats() {
    this.releaseExpiredLeases();
    const rejectionStages = {};
    const rejectionReasons = {};
    for (const rejection of this.rejected.values()) {
      const stage = normalizedString(rejection.stage, 40) || 'unknown';
      const reason = normalizedString(rejection.reason, 160) || 'unknown';
      rejectionStages[stage] = (rejectionStages[stage] || 0) + 1;
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    }
    const topRejectionReasons = Object.entries(rejectionReasons)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([reason, count]) => ({ reason, count }));
    return {
      schema: LOCAL2_PIPELINE_SCHEMA,
      storage: 'memory-only',
      revision: this.revision,
      target: this.targetAccepted,
      readyMinimum: this.readyMinimum,
      ready: this.isReady(),
      accepted: this.accepted.size,
      leased: this.leases.size,
      states: this.states.size,
      rejected: this.rejected.size,
      rejectionStages,
      topRejectionReasons,
      counters: { ...this.statsCounters },
      stages: Object.fromEntries(Object.entries(this.stages).map(([name, stage]) => [name, stage.stats()]))
    };
  }

  rejectionAudit(minimumVerifiedMedia = 15) {
    const minimum = boundedInteger(minimumVerifiedMedia, 15, 0, 100);
    return [...this.rejected.values()]
      .filter(item => Number(item.verifiedMediaCount || 0) >= minimum)
      .map(item => ({ ...item, decisionImageUrls: [...(item.decisionImageUrls || [])] }));
  }

  setQualifiedRejectionAudit(enabled) {
    this.qualifiedRejectionAudit = enabled === true;
    return this.qualifiedRejectionAudit;
  }

  stop() {
    this.stopped = true;
    for (const state of this.states.values()) state.abortController?.abort(new Error('Local2 pipeline stopped'));
    Object.values(this.stages).forEach(stage => stage.stop());
  }
}
