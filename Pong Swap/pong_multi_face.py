"""Conservative per-video source choice; independent of rendering quality.

These scores rank visual resemblance, not a person's real-world identity.
Calibration/accuracy requires separately labelled held-out footage. Unit tests
and augmentations are not evidence of 100% real-world matching accuracy.
"""
from dataclasses import dataclass, replace
from collections import OrderedDict
import hashlib
import math
import threading
import time
import numpy as np
from pong_match_feedback import MATCH_FEEDBACK
from pong_hair_policy import hair_allows
from pong_hair_profile import HAIR_WEIGHT, hair_match
from pong_swap_identity import (
    IdentitySelection, compatible_identity_rankings, rope_similarity,
    target_identity_continuity_threshold,
)

MAX_MULTI_FACES = 16
MINIMUM_WINNER_MARGIN = 2.0


def acquisition_probe_step(fps, prefetch, consensus_pending):
    # A 350ms speculative probe interval cannot ever complete a consensus
    # that correctly rejects gaps above 250ms. Finish an already-started
    # acquisition on consecutive source frames, then return to normal cadence.
    # Baseline 1.10: 0.35 s -> 0.1 s. With 1.5 s swipes a prepared video got
    # ~3 probes before it was shown, so most were still unlocked (0 swapped)
    # when they appeared. Probes stop once the video's face is locked.
    return max(1, int(round(max(1., fps)*.10))) if prefetch and not consensus_pending else 1


def multi_video_key(channel, epoch, source, face_ids, revision, manual=False):
    if not epoch or manual or len(set(face_ids)) < 2:
        return None
    value = repr((channel, epoch, source, tuple(sorted(set(face_ids))), revision))
    return hashlib.sha256(value.encode()).hexdigest()


class MultiVideoSources:
    """Bounded source-choice memory across seeks; never caches rendered pixels.

    Stores an approved source ID, NOT a target identity or old tracking state.
    Every new seek still has to detect/verify a compatible current target.
    Client epoch, source, selected set and quality revision isolate choices.
    """
    def __init__(self, maximum=128, ttl_seconds=1800, clock=time.monotonic):
        self.maximum, self.ttl, self.clock = maximum, ttl_seconds, clock
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def bind(self, key, face_id=None):
        if key is None:
            return face_id
        with self.lock:
            now = self.clock()
            while self.items and next(iter(self.items.values()))[1]+self.ttl <= now:
                self.items.popitem(last=False)
            old = self.items.pop(key, None)
            choice = old[0] if old else face_id
            if choice:
                self.items[key] = choice, now
                while len(self.items) > self.maximum:
                    self.items.popitem(last=False)
            return choice


@dataclass(frozen=True)
class MultiFaceDecision:
    selection: IdentitySelection | None
    reason: str
    margin: float | None = None
    scores: tuple = ()

    def public(self):
        return {"policy": "multi-face-face-plus-hair-v2", "reason": self.reason,
                "margin": self.margin,
                "hairPolicy": "original-segmented-hair-v3+colour-rank",
                "targetHairLab": getattr(self.selection.target.hair_color, "lab", None) if self.selection else None,
                "targetHair": self.selection.target.hair_color if self.selection else "unknown",
                "hairEvidenceScore": round(float(self.selection.target.hair_confidence),4) if self.selection else 0,
                "hairFallback": self.selection is not None and self.selection.target.hair_color == 'unknown',
                "rankings": [{"faceId": face, "score": round(score, 4)}
                             for face, score in self.scores]}


def choose_multi_face(candidates, targets, *, minimum_similarity=0.0,
                      minimum_presentation_confidence=0.0):
    """Feature-led best available winner, never input-order bias.

    Legacy acquisition is 90% colour/contrast. Multi face instead uses the
    existing feature-led 85/15 identity metric as a *resemblance ranking*.
    Report the runner-up margin, but do not abstain on near-ties: the user
    explicitly prefers the best available selected source over no swap.
    Invalid geometry, incompatible targets and source restrictions still fail
    closed; selection confidence is not rendering-quality evidence.
    """
    winners = []
    for target in targets:
        values = np.asarray(target.embedding).reshape(-1)
        if not values.size or not np.all(np.isfinite(values)) or np.linalg.norm(values) < 1e-8:
            continue
        valid = [c for c in candidates if hair_allows(c.face_id, target.hair_color, target.hair_confidence)
                 and np.asarray(c.embedding).size == values.size
                 and np.all(np.isfinite(c.embedding)) and np.linalg.norm(c.embedding) > 1e-8]
        ranked = compatible_identity_rankings(valid, target,
            minimum_similarity=0.0,
            minimum_presentation_confidence=minimum_presentation_confidence,
            similarity_mode="identity")
        # Feedback only reranks already-admitted sources. It cannot bypass
        # presentation restrictions, raw similarity floor, or selected faces.
        # Apply the raw gates to every candidate BEFORE bonuses. Otherwise a
        # boosted, ineligible winner vetoes the whole target and suppresses an
        # eligible runner-up. Colour-only matches likewise must not block a
        # valid feature match. Neither gate is relaxed by this ordering fix.
        # Baseline 1.6: no ArcFace>0 veto. Approved photos and video people are
        # different identities, so that veto rejected almost every stranger
        # (Baseline 1.0: no swap on 3 of 4 stock clips with Approved 3 + 8).
        # Owner rule: always use the best match among the selected faces.
        ranked = tuple(x for x in ranked if x.similarity >= minimum_similarity)
        if getattr(target.hair_color, "lab", None) is None:
            # Without hair evidence keep the feature-led preference: a source
            # with real ArcFace resemblance beats colour-only look-alikes, and
            # colour-only sources are used only when nothing else resembles.
            featured = tuple(x for x in ranked if rope_similarity(x.candidate.embedding, target.embedding) > 0)
            ranked = featured or ranked
        bonuses = MATCH_FEEDBACK.bonuses(target.embedding)
        # Baseline 1.6: hair colour is a big ranking factor (owner request).
        # Measured colour distance, scaled by evidence; 0 when unmeasured.
        def hair_term(face_id):
            match = hair_match(target.hair_color, face_id)
            return 0.0 if match is None else HAIR_WEIGHT * match
        ranked = tuple(replace(x, similarity=x.similarity+bonuses.get(x.candidate.face_id, 0.0)
                               +hair_term(x.candidate.face_id)) for x in ranked)
        # Collapse duplicate IDs before computing ambiguity. IDs are semantic
        # choices, not extra votes, and candidate ordering is not evidence.
        unique = {}
        for choice in ranked:
            if choice.candidate.face_id not in unique:
                unique[choice.candidate.face_id] = choice
        ranked = sorted(unique.values(), key=lambda x: (-x.similarity, x.candidate.face_id))
        if not ranked:
            continue
        first = ranked[0]
        scores = tuple((x.candidate.face_id, float(x.similarity)) for x in ranked)
        margin = float(first.similarity - ranked[1].similarity) if len(ranked) > 1 else None
        reason = "best-available-close-match" if margin is not None and margin < MINIMUM_WINNER_MARGIN else "candidate"
        winners.append(MultiFaceDecision(first, reason, margin, scores))
    if not winners:
        return MultiFaceDecision(None, "no-confident-match")
    return min(winners, key=lambda d: (-d.selection.similarity, -d.selection.target.area,
                                      d.selection.candidate.face_id,
                                      tuple(np.asarray(d.selection.target.keypoints).reshape(-1))))


class MultiFaceConsensus:
    """Two consistent observations separated by elapsed time, then immutable.

    40ms is source-time based (not a fixed frame count). Different people,
    missing evidence, backwards timestamps and >250ms gaps reset acquisition.
    No old video evidence or target embeddings are carried into a new session.
    """
    def __init__(self):
        self.pending = None
        self.first_seconds = self.last_seconds = None
        self.locked = None

    def observe(self, choice, seconds):
        if self.locked is not None:
            return self.locked
        if choice is None or not math.isfinite(seconds):
            self.pending = None
            self.first_seconds = self.last_seconds = None
            return None
        continuous = bool(self.pending is not None and
            self.pending.candidate.face_id == choice.candidate.face_id and
            0 < seconds - self.last_seconds <= .25 and
            rope_similarity(self.pending.target.embedding, choice.target.embedding) >= target_identity_continuity_threshold())
        if not continuous:
            self.pending = choice
            self.first_seconds = self.last_seconds = seconds
            return None
        self.pending, self.last_seconds = choice, seconds
        if seconds - self.first_seconds >= .04 - 1e-8:
            self.locked = choice
        return self.locked
