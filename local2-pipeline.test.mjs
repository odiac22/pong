import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL2_ACCEPTED_SCHEMA,
  Local2CacheBundle,
  Local2ContinuousPipeline,
  createLocal2AcceptedDto,
  local2CleanResultIsExplicitlyHardSafe,
  local2DecisionIsHardSafe,
  local2ImageGradeSummary
} from './local2-pipeline.mjs';

function hardSafeDecision(overrides = {}) {
  return {
    verdict: 'accept',
    confidence: 0.99,
    reason: 'synthetic pass',
    model: 'local2-test',
    hardFilters: {
      photograph: true,
      femalePresentingAdult: true,
      malePresent: false,
      attachedAnatomy: false,
      feetDominant: false,
      bodyMismatch: false,
      over60: false,
      adultSafetyRisk: false,
      ambiguous: false,
      ...(overrides.hardFilters || {})
    },
    ...overrides
  };
}

function media(count = 15) {
  return Array.from({ length: count }, (_, index) => ({
    videoUrl: `https://media.invalid/${index}.mp4`,
    postUrl: `https://source.invalid/post/${index}`,
    postIndex: index,
    verified: true,
    fastStart: index < 10
  }));
}

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('synthetic pipeline timed out'));
      setTimeout(poll, 2);
    };
    poll();
  });
}

test('hard-safe decision is fail-closed for every Local2 hard filter', () => {
  assert.equal(local2DecisionIsHardSafe(hardSafeDecision()), true);
  for (const [field, unsafeValue] of [
    ['photograph', false],
    ['femalePresentingAdult', false],
    ['malePresent', true],
    ['attachedAnatomy', true],
    ['feetDominant', true],
    ['bodyMismatch', true],
    ['over60', true],
    ['adultSafetyRisk', true],
    ['ambiguous', true]
  ]) {
    assert.equal(local2DecisionIsHardSafe(hardSafeDecision({ hardFilters: { [field]: unsafeValue } })), false, field);
  }
});

test('clean model accept is hard-safe without requiring a Qwen-only flag', () => {
  const result = {
    decision: 'accept',
    requires_qwen_review: false,
    checks: {
      photograph: true,
      female_presenting_adult: true,
      male_present: false,
      male_only: false,
      attached_male_anatomy: false,
      feet_dominant: false,
      logo_or_placeholder: false,
      body_preference_conflict: false,
      appears_over_60: false,
      appears_over_50: false,
      underage_looking: false,
      age_ambiguous: false,
      anatomy_ambiguous: false,
      body_evidence_ambiguous: false
    }
  };
  assert.equal(local2CleanResultIsExplicitlyHardSafe(result), true);
  assert.equal(local2CleanResultIsExplicitlyHardSafe({
    ...result,
    checks: { ...result.checks, attached_male_anatomy: true }
  }), false);
});

test('clean image grades without legacy confidence or reason format safely for Qwen', () => {
  const summary = local2ImageGradeSummary([
    { image_index: 3, decision: 'unsure', checks: {}, scores: { attached_anatomy: 0.91 } }
  ], 0.64);
  assert.equal(summary, 'image 3: uncertain, confidence 0.64, numeric local evidence');
});

test('accepted DTO contains URLs only and requires 15 verified media entries', () => {
  const dto = createLocal2AcceptedDto({
    revision: 'local2-r1',
    profile: { artistUrl: 'https://coomerfans.com/u/onlyfans/123/example', artistName: 'example', sourcePage: 4 },
    decision: hardSafeDecision(),
    media: media(15),
    evidence: { examinedImages: 12, clearBodyViews: 4, decisionImageUrls: ['https://image.invalid/one.jpg'] }
  });
  assert.equal(dto.schema, LOCAL2_ACCEPTED_SCHEMA);
  assert.equal(dto.storage, 'memory-only');
  assert.equal(dto.media.length, 15);
  assert.equal(dto.media[4].postIndex, 4);
  assert.equal('html' in dto, false);
  assert.throws(() => createLocal2AcceptedDto({
    revision: 'local2-r1',
    profile: { artistUrl: 'https://coomerfans.com/u/onlyfans/123/example' },
    decision: hardSafeDecision(),
    media: media(14)
  }), /15 distinct verified/);
});

test('feature cache survives learning revision while decision cache is invalidated', () => {
  const cache = new Local2CacheBundle({ modelRevision: 'models-v1', learningRevision: 'learn-v1' });
  const featureKey = cache.featureKey({ imageFingerprint: 'image-a', cropPolicy: 'whole-body-v1', featureKind: 'embedding' });
  const decisionKey = cache.decisionKey({ artistId: 'onlyfans:123', evidenceFingerprint: 'evidence-a' });
  cache.features.set(featureKey, [1, 2, 3]);
  cache.decisions.set(decisionKey, { verdict: 'accept' });
  assert.equal(cache.rotateLearningRevision('learn-v2'), true);
  assert.deepEqual(cache.features.get(featureKey), [1, 2, 3]);
  assert.equal(cache.decisions.get(decisionKey), undefined);
});

test('continuous pipeline overlaps verification and classification without batch barriers', async () => {
  const events = [];
  const pipeline = new Local2ContinuousPipeline({
    revision: 'local2-r1',
    targetAccepted: 15,
    readyMinimum: 1,
    workers: {
      profile: async candidate => ({ ...candidate }),
      triage: async () => ({ verdict: 'uncertain', confidence: 0.5 }),
      verify: async profile => {
        events.push(`verify-start:${profile.artistId}`);
        await new Promise(resolve => setTimeout(resolve, 20));
        events.push(`verify-end:${profile.artistId}`);
        return media(15);
      },
      classify: async profile => {
        events.push(`classify-start:${profile.artistId}`);
        await new Promise(resolve => setTimeout(resolve, 5));
        events.push(`classify-end:${profile.artistId}`);
        return hardSafeDecision();
      }
    }
  });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/123/example' });
  await waitFor(() => pipeline.stats().accepted === 1);
  assert.ok(events.indexOf('classify-start:onlyfans:123') < events.indexOf('verify-end:onlyfans:123'));
  assert.equal(pipeline.isReady(), true);
  const leased = pipeline.lease(1);
  assert.equal(leased.length, 1);
  assert.equal(pipeline.acknowledge(['onlyfans:123']), 1);
  pipeline.stop();
});

test('profile completion admits media verification only after visual triage passes', async () => {
  const events = [];
  const pipeline = new Local2ContinuousPipeline({
    revision: 'local2-r1',
    targetAccepted: 15,
    readyMinimum: 1,
    workers: {
      profile: async candidate => ({ ...candidate }),
      triage: async () => {
        events.push('triage-start');
        await new Promise(resolve => setTimeout(resolve, 20));
        events.push('triage-end');
        return { verdict: 'uncertain', confidence: 0.5 };
      },
      verify: async () => {
        events.push('verify-start');
        await new Promise(resolve => setTimeout(resolve, 5));
        events.push('verify-end');
        return media(15);
      },
      classify: async () => hardSafeDecision()
    }
  });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/4/concurrent' });
  await waitFor(() => pipeline.stats().accepted === 1);
  assert.ok(events.indexOf('verify-start') > events.indexOf('triage-end'));
  pipeline.stop();
});

test('only high-confidence hard triage rejects; uncertainty reaches full classification', async () => {
  let classifyCalls = 0;
  const pipeline = new Local2ContinuousPipeline({
    revision: 'local2-r1',
    targetAccepted: 15,
    readyMinimum: 1,
    workers: {
      profile: async candidate => ({ ...candidate }),
      triage: async profile => profile.artistId.endsWith(':1')
        ? { verdict: 'reject', hardReject: true, confidence: 0.99, reason: 'synthetic hard reject' }
        : { verdict: 'reject', hardReject: true, confidence: 0.8, reason: 'uncertain' },
      verify: async () => media(15),
      classify: async () => {
        classifyCalls++;
        return hardSafeDecision();
      }
    }
  });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/1/reject' });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/2/continue' });
  await waitFor(() => pipeline.stats().accepted === 1 && pipeline.stats().rejected === 1);
  assert.equal(classifyCalls, 1);
  assert.equal(pipeline.stats().counters.triageHardRejects, 1);
  pipeline.stop();
});

test('terminal taste prefilter reject skips classification regardless of confidence scale', async () => {
  let classifyCalls = 0;
  const pipeline = new Local2ContinuousPipeline({
    revision: 'local2-r1',
    targetAccepted: 15,
    readyMinimum: 1,
    workers: {
      profile: async candidate => ({ ...candidate }),
      triage: async () => ({
        verdict: 'reject',
        terminalReject: true,
        confidence: 0.51,
        reason: 'personal_preference_mismatch'
      }),
      verify: async () => media(15),
      classify: async () => {
        classifyCalls++;
        return hardSafeDecision();
      }
    }
  });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/7/taste-reject' });
  await waitFor(() => pipeline.stats().rejected === 1);
  assert.equal(classifyCalls, 0);
  assert.equal(pipeline.stats().counters.triageHardRejects, 1);
  pipeline.stop();
});

test('definitive visual reject aborts concurrent media verification', async () => {
  let verificationAborted = false;
  const pipeline = new Local2ContinuousPipeline({
    revision: 'local2-r1',
    targetAccepted: 15,
    readyMinimum: 1,
    workers: {
      profile: async candidate => ({ ...candidate }),
      triage: async () => ({ verdict: 'uncertain', confidence: 0.5 }),
      verify: async (_profile, context) => new Promise(resolve => {
        const timer = setTimeout(() => resolve(media(15)), 200);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          verificationAborted = true;
          resolve([]);
        }, { once: true });
      }),
      classify: async () => ({
        ...hardSafeDecision(),
        verdict: 'reject',
        reason: 'synthetic definitive visual reject',
        hardFilters: { ...hardSafeDecision().hardFilters, malePresent: true }
      })
    }
  });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/3/abort' });
  await waitFor(() => pipeline.stats().rejected === 1 && verificationAborted);
  assert.equal(pipeline.stats().accepted, 0);
  pipeline.stop();
});

test('terminal rejects do not consume active-state backpressure slots', async () => {
  const pipeline = new Local2ContinuousPipeline({
    revision: 'local2-r1',
    targetAccepted: 48,
    readyMinimum: 1,
    workers: {
      profile: async candidate => ({ ...candidate }),
      triage: async () => ({ verdict: 'reject', hardReject: true, confidence: 0.99, reason: 'synthetic reject' }),
      verify: async () => media(15),
      classify: async () => hardSafeDecision()
    }
  });
  for (let index = 0; index < 180; index++) {
    assert.equal(pipeline.submit({ artistUrl: `https://coomerfans.com/u/onlyfans/${1000 + index}/reject` }), true);
  }
  await waitFor(() => pipeline.stats().rejected === 180, 3000);
  assert.equal(pipeline.stats().states, 0);
  pipeline.stop();
});

test('learning revision invalidates rejects and reclassifies accepted evidence only inside Local2', async () => {
  let classifyCalls = 0;
  const pipeline = new Local2ContinuousPipeline({
    revision: 'local2-r1',
    targetAccepted: 15,
    readyMinimum: 1,
    workers: {
      profile: async candidate => ({ ...candidate }),
      triage: async () => ({ verdict: 'uncertain', confidence: 0.5 }),
      verify: async () => media(15),
      classify: async profile => {
        classifyCalls++;
        return profile.artistId.endsWith(':6') ? { verdict: 'reject', reason: 'old learned reject' } : hardSafeDecision();
      }
    }
  });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/5/accepted' });
  pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/6/rejected' });
  await waitFor(() => pipeline.stats().accepted === 1 && pipeline.stats().rejected === 1);
  assert.equal(pipeline.rotateRevision('local2-r2'), true);
  assert.equal(pipeline.stats().rejected, 0);
  assert.equal(pipeline.submit({ artistUrl: 'https://coomerfans.com/u/onlyfans/6/rejected' }), true);
  await waitFor(() => classifyCalls >= 4);
  assert.equal(pipeline.stats().revision, 'local2-r2');
  pipeline.stop();
});
