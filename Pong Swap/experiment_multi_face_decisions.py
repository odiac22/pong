"""Opt-in, count-only Multi Face acquisition diagnostics.

Install only in a disposable, already-qualified service before admitting a
session. This never changes a model, policy result, or frozen runtime source.
No face IDs, embeddings, image pixels, or client/session tokens are retained.
"""

from collections import Counter
from dataclasses import dataclass
import math
import threading

import numpy as np


def _valid_embedding(value, expected_size=None):
    try:
        vector = np.asarray(value).reshape(-1)
        return bool(vector.size and (expected_size is None or vector.size == expected_size)
                    and np.all(np.isfinite(vector)) and np.linalg.norm(vector) > 1e-8)
    except Exception:
        return False


def _pair_gate_counts(candidates, targets, minimum_similarity,
                      minimum_presentation_confidence, identity_module, hair_module):
    """Mirror admission gates for *diagnosis*, after the real decision ran.

    These are exclusive first-failing-pair counts, not a substitute decision.
    The original chooser is always authoritative, including feedback reranks.
    """
    counts = Counter(targets=len(targets), sourceChoices=len(candidates))
    for target in targets:
        embedding = np.asarray(target.embedding).reshape(-1)
        if not _valid_embedding(embedding):
            counts['invalidTargetEmbedding'] += 1
            continue
        for candidate in candidates:
            counts['candidatePairs'] += 1
            if not hair_module.hair_allows(candidate.face_id, target.hair_color,
                                           target.hair_confidence):
                counts['hairRejected'] += 1
                continue
            if not _valid_embedding(candidate.embedding, embedding.size):
                counts['invalidSourceEmbedding'] += 1
                continue
            if not identity_module.approved_source_allows_target(
                    candidate.face_id, target.presentation):
                counts['sourceAdmissionRejected'] += 1
                if not target.presentation.known:
                    counts['sourceAdmissionUnknownPresentation'] += 1
                elif target.presentation.confidence < .90:
                    counts['sourceAdmissionLowConfidence'] += 1
                else:
                    # The current policy only restricts the selected source
                    # at this point for a confidently male-presenting target.
                    counts['maleSourceRestricted'] += 1
                continue
            if not identity_module.presentations_are_compatible(
                    candidate.presentation, target.presentation,
                    minimum_confidence=minimum_presentation_confidence):
                counts['presentationRejected'] += 1
                if not candidate.presentation.known:
                    counts['sourcePresentationUnknown'] += 1
                elif candidate.presentation.label != target.presentation.label:
                    counts['presentationMismatch'] += 1
                else:
                    counts['presentationConfidenceBelowStrictness'] += 1
                continue
            ranked = identity_module.compatible_identity_rankings(
                (candidate,), target, minimum_similarity=0.0,
                minimum_presentation_confidence=minimum_presentation_confidence,
                similarity_mode='identity')
            if not ranked:
                counts['nonFiniteOrNegativeRanking'] += 1
                continue
            counts['rankedPairs'] += 1
            if ranked[0].similarity < minimum_similarity:
                counts['rawSimilarityFloorRejected'] += 1
                continue
            if identity_module.rope_similarity(candidate.embedding, target.embedding) <= 0:
                counts['nonPositiveArcfaceRejected'] += 1
                continue
            counts['eligiblePairs'] += 1
    return dict(counts)


@dataclass
class DiagnosticHandle:
    engine_module: object
    multi_module: object
    original_select: object
    original_choose: object
    original_observe: object
    counters: Counter
    lock: threading.Lock

    def snapshot(self):
        with self.lock:
            return dict(self.counters)

    def uninstall(self):
        engine_class = self.engine_module.PongSwapEngine
        if getattr(engine_class._select_compatible_identity_for_frame,
                   '_multi_face_diagnostic_owner', None) is self:
            engine_class._select_compatible_identity_for_frame = self.original_select
        if getattr(self.engine_module.choose_multi_face,
                   '_multi_face_diagnostic_owner', None) is self:
            self.engine_module.choose_multi_face = self.original_choose
        if getattr(self.multi_module.MultiFaceConsensus.observe,
                   '_multi_face_diagnostic_owner', None) is self:
            self.multi_module.MultiFaceConsensus.observe = self.original_observe


def install(engine_module, multi_module, identity_module, hair_module, *, on_event=None):
    """Install count-only wrappers; caller must quiesce sessions before uninstall.

    `on_event` receives JSON-safe numeric/bool fields plus kind, reason and
    frame index. It must not log session IDs, embeddings, pixels, or source IDs.
    """
    engine_class = engine_module.PongSwapEngine
    original_select = engine_class._select_compatible_identity_for_frame
    original_choose = engine_module.choose_multi_face
    original_observe = multi_module.MultiFaceConsensus.observe
    if any(getattr(fn, '_multi_face_diagnostic_owner', None) is not None
           for fn in (original_select, original_choose, original_observe)):
        raise RuntimeError('Multi Face diagnostics already installed')
    handle = DiagnosticHandle(engine_module, multi_module, original_select,
                              original_choose, original_observe,
                              Counter(), threading.Lock())
    local = threading.local()

    def record(event):
        with handle.lock:
            handle.counters[event['kind']] += 1
            if event['kind'] == 'selection':
                handle.counters[f"reason:{event['reason']}"] += 1
                for key, value in event['gates'].items():
                    handle.counters[key] += value
            elif event['kind'] == 'consensus':
                handle.counters[f"consensus:{event['outcome']}"] += 1
        if on_event is not None:
            try:
                on_event(event)
            except Exception:
                # Diagnostics must never change an acquisition result.
                pass

    def choose_wrapper(candidates, targets, *, minimum_similarity=0.0,
                       minimum_presentation_confidence=0.0):
        result = original_choose(candidates, targets,
                                 minimum_similarity=minimum_similarity,
                                 minimum_presentation_confidence=minimum_presentation_confidence)
        try:
            gates = _pair_gate_counts(candidates, targets, minimum_similarity,
                                      minimum_presentation_confidence,
                                      identity_module, hair_module)
            local.choice = {'reason': result.reason, 'gates': gates,
                            'selected': result.selection is not None}
        except Exception:
            local.choice = {'reason': result.reason, 'gates': {},
                            'selected': result.selection is not None,
                            'diagnosticError': True}
        return result

    def select_wrapper(self, frame, candidates, config, frame_evidence, *args, **kwargs):
        local.choice = None
        result = original_select(self, frame, candidates, config, frame_evidence,
                                 *args, **kwargs)
        choice = local.choice
        try:
            detected = tuple(getattr(frame_evidence, 'detections', ()) or ())
            gates = dict(choice['gates']) if choice else {}
            gates['detectedRows'] = len(detected)
            gates['recognizedRows'] = sum(len(row) >= 3 and row[2] is not None
                                          for row in detected)
            if choice is None:
                gates['chooserNotReached'] = 1
            event = {'kind': 'selection',
                     'reason': choice['reason'] if choice else 'chooser-not-reached',
                     'selected': bool(result),
                     'frameIndex': int(getattr(frame_evidence, 'frame_index', -1)),
                     'gates': gates}
            record(event)
        except Exception:
            pass
        finally:
            local.choice = None
        return result

    def observe_wrapper(self, choice, seconds):
        result = original_observe(self, choice, seconds)
        try:
            outcome = ('locked' if result is not None else
                       'pending' if choice is not None and math.isfinite(seconds) else
                       'reset')
            record({'kind': 'consensus', 'outcome': outcome})
        except Exception:
            pass
        return result

    for fn in (choose_wrapper, select_wrapper, observe_wrapper):
        fn._multi_face_diagnostic_owner = handle
    engine_module.choose_multi_face = choose_wrapper
    engine_class._select_compatible_identity_for_frame = select_wrapper
    multi_module.MultiFaceConsensus.observe = observe_wrapper
    return handle
