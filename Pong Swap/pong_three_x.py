"""One approved source per recognized person, scoped to a video and selection.

No pixels or embeddings are persisted. Recognition uncertainty leaves the
original person visible; neither screen position nor detector ordering can
transfer an occupied slot. Rendering uses original-frame detection evidence.
"""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import threading
import time
import os

import numpy as np
import cv2

from pong_swap_identity import rope_similarity as _rope_similarity, target_identity_lock_threshold, approved_source_allows_target, approved_source_target_label
from pong_identity_math import current as _identity_math,frame_identity_math
from pong_face_restoration import apply_face_restoration

MAX_THREE_X_FACES = 256
MAX_THREE_X_RENDERED = 5

def identity_head_span(points):
    """Pose-tolerant scale for reservation, never evidence of identity.

    Inter-eye distance collapses in profile. The eye-to-mouth axis remains
    measurable, preventing an uncertain turn from consuming a new source.
    """
    p=np.asarray(points,np.float32)
    return max(1.,float(np.linalg.norm(p[1]-p[0])),
               .9*float(np.linalg.norm(p[:2].mean(0)-p[3:].mean(0))))

def rope_similarity(a,b):
    state=_identity_math()
    return state.cosine(a,b,False) if state is not None else _rope_similarity(a,b)


def rope_similarity_many(references, embedding):
    """Vectorised ``rope_similarity`` of one embedding against a list of references.

    Same scaling as the frame-scoped FrameMath non-strict cosine
    (100 * clip((cos - .05) / .65, 0, 1)); an invalid pair scores -inf like it does.
    One matrix product replaces hundreds of per-pair Python cosines per frame.
    """
    if references is None or len(references) == 0:
        return np.zeros(0, np.float64)
    target = np.asarray(embedding, np.float32).reshape(-1)
    norm = float(np.linalg.norm(target))
    matrix = np.asarray(references, np.float32).reshape(len(references), -1)
    if matrix.shape[1] != target.size or not np.isfinite(norm) or norm <= 1e-8:
        return np.full(len(references), -np.inf)
    norms = np.linalg.norm(matrix, axis=1)
    with np.errstate(divide='ignore', invalid='ignore'):
        cosines = (matrix @ target) / (norms * norm)
    cosines = np.clip(np.nan_to_num(cosines, nan=-1.0), -1.0, 1.0)
    scores = 100.0 * np.clip((cosines - .05) / .65, 0.0, 1.0)
    scores[~np.isfinite(norms) | (norms <= 1e-8)] = -np.inf
    return scores.astype(np.float64)


def hair_preference(face_id, color, confidence):
    """Soft ranking: verified agreement > unmeasured > verified mismatch.

    Admission helpers deliberately allow some unknowns; that is NOT evidence
    of matching hair and must not outscore a genuinely matching source.
    """
    from pong_hair_policy import hair_allows, strict_hair_rule
    from pong_hair_profile import hair_match
    from pong_appearance_policy import TAXONOMY
    from pong_face_roster import rule
    semantic = getattr(color, 'taxonomy', None) == TAXONOMY
    if (str(color) == 'unknown' or not np.isfinite(confidence)
            or (not semantic and confidence < .80)):
        return 1
    named = strict_hair_rule(face_id) or (rule(face_id) or {}).get('hair')
    if named:
        return 2 if hair_allows(face_id, color, confidence, include_skin=False) else 0
    agreement = hair_match(color, face_id)
    if agreement is None or not np.isfinite(agreement) or abs(agreement) < .15:
        return 1
    return 2 if agreement > 0 else 0


def valid_embedding(value):
    state=_identity_math()
    if state is not None:return state.valid(value)
    vector = np.asarray(value, dtype=np.float32).reshape(-1)
    return bool(0 < vector.size <= 1024 and np.isfinite(vector).all()
                and np.linalg.norm(vector) > 1e-8)


def raw_identity_cosine(a, b):
    state=_identity_math()
    if state is not None:return state.cosine(a,b,True)
    a,b=np.asarray(a,np.float32).reshape(-1),np.asarray(b,np.float32).reshape(-1)
    if a.shape!=b.shape or not valid_embedding(a) or not valid_embedding(b):return -1.
    return float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)))


class VideoAssignments:
    def __init__(self, face_ids):
        self.face_ids = tuple(face_ids)
        self.anchors = {}
        self.revision = 0
        self.lock = threading.RLock()

    def correct(self, corrections):
        """Detect moves a slot, or exchanges two already occupied slots."""
        with self.lock:
            for correction in sorted(corrections, key=lambda item: item['revision']):
                revision = correction['revision']
                if revision <= self.revision:
                    continue
                face_id = correction['faceId']
                target = np.asarray(correction['targetEmbedding'], dtype=np.float32).copy()
                if face_id not in self.face_ids or not valid_embedding(target):
                    raise ValueError('Invalid 3x correction')
                others = [(rope_similarity(anchor, target), key)
                          for key, anchor in self.anchors.items()]
                others.sort(reverse=True)
                if (others and others[0][1] != face_id
                        and others[0][0] >= target_identity_lock_threshold(100)
                        and (len(others) == 1 or others[0][0] - others[1][0] >= 5)):
                    other = others[0][1]
                    prior = self.anchors.pop(face_id, None)
                    self.anchors.pop(other)
                    if prior is not None:
                        self.anchors[other] = prior
                self.anchors[face_id] = target
                self.revision = revision

    def match(self, detections, strictness=45, acquire=None):
        """Return unique (source ID, detection index) pairs, never rebind loss."""
        with self.lock:
            rows = [(index, row) for index, row in enumerate(detections)
                    if row[2] is not None and valid_embedding(row[2])
                    and np.asarray(row[1]).shape == (5, 2)
                    and np.isfinite(row[1]).all()]
            threshold = target_identity_lock_threshold(strictness)
            scores = {key: sorted(
                [(rope_similarity(anchor, row[2]), index) for index, row in rows],
                reverse=True) for key, anchor in self.anchors.items()}
            pairs = []
            reserved = set()
            for ranked in scores.values():
                # Weak possible reappearances must not acquire a NEW slot.
                reserved.update(index for score, index in ranked if score >= 25)
            if scores and rows:
                from scipy.optimize import linear_sum_assignment
                keys = list(scores)
                indices = [index for index, _ in rows]
                # Solve all occupied slots together. Independent top-two gates
                # reject a person when their runner-up is clearly owned by a
                # different person, causing avoidable one-face dropouts.
                matrix = np.full((len(keys), len(rows) + len(keys)), -1e6)
                matrix[:, len(rows):] = threshold - 5
                for i, key in enumerate(keys):
                    for score, index in scores[key]:
                        if score >= threshold:
                            matrix[i, indices.index(index)] = score
                assigned_rows, assigned_columns = linear_sum_assignment(-matrix)
                best = float(matrix[assigned_rows, assigned_columns].sum())
                for i, j in zip(assigned_rows, assigned_columns):
                    if j >= len(rows) or matrix[i, j] < threshold:
                        continue
                    alternative = matrix.copy()
                    alternative[i, j] = -1e6
                    ar, ac = linear_sum_assignment(-alternative)
                    # An uncertain exchange remains blank; position never
                    # reassigns an occupied identity and anchors stay immutable.
                    if best - float(alternative[ar, ac].sum()) < 5 - 1e-6:
                        continue
                    pairs.append((keys[i], indices[j]))
            used = {index for _, index in pairs}
            # An absent assigned person keeps their source reserved, but must
            # not block unused sources from attaching to clearly new people.
            # Weak possible reappearances remain excluded by `reserved` above.
            available = [(index, row) for index, row in rows
                         if index not in used and index not in reserved]
            free = [key for key in self.face_ids if key not in self.anchors]
            # Prefer the largest people, assign selected order left-to-right.
            available.sort(key=lambda item: -float(item[1][0]))
            available = available[:len(free)]
            available.sort(key=lambda item: float(np.mean(item[1][1][:, 0])))
            choices = (acquire(free, available) if acquire is not None else
                       [(key, index) for key, (index, _) in zip(free, available)])
            by_index = dict(available)
            for key, index in choices:
                row = by_index.get(index)
                if key not in free or row is None or index in used:
                    continue
                if any(rope_similarity(anchor, row[2]) >= threshold for anchor in self.anchors.values()):
                    continue
                free.remove(key)
                used.add(index)
                self.anchors[key] = np.asarray(row[2], dtype=np.float32).copy()
                pairs.append((key, index))
            return tuple(pairs)


class PersonAssignments:
    """Person-owned tracks; each approved source has one owner for this video."""
    def __init__(self, face_ids):
        self.face_ids = tuple(face_ids)
        self.anchors = OrderedDict()
        self.sources = {}
        self.source_owners = {}
        self.positions = {}
        self.position_age = {}
        self.pose_references = {}
        self.confirmed_at = {}
        self.appearance = {}
        self.policy_references = {}
        self.match_sequence = 0
        self.continuity_holds = 0
        self.revision = 0
        self.sequence = 0
        self.lock = threading.RLock()

    def _new(self, source, embedding):
        if source in self.source_owners:
            raise ValueError('This approved face is already assigned to another person in this video')
        self.sequence += 1
        key = f'person-{self.sequence}'
        self.anchors[key] = np.asarray(embedding, dtype=np.float32).copy()
        self.sources[key] = source
        self.source_owners[source] = key
        return key

    def correct(self, corrections):
        with self.lock:
            for item in sorted(corrections, key=lambda x: x['revision']):
                if item['revision'] <= self.revision:
                    continue
                source, embedding = item['faceId'], item['targetEmbedding']
                if source not in self.face_ids or not valid_embedding(embedding):
                    raise ValueError('Invalid 3x correction')
                ranked = sorted(((rope_similarity(a, embedding), k) for k, a in self.anchors.items()), reverse=True)
                if ranked and ranked[0][0] >= target_identity_lock_threshold(100) and (len(ranked) == 1 or ranked[0][0]-ranked[1][0] >= 5):
                    key = ranked[0][1]
                    # An explicit Detect correction exchanges occupied sources;
                    # automatic matching still cannot steal or duplicate them.
                    previous = self.sources[key]
                    other = self.source_owners.get(source)
                    if other is not None and other != key:
                        self.sources[other] = previous
                        self.source_owners[previous] = other
                        self.appearance.pop(other, None)
                        self.policy_references.pop(other, None)
                    elif previous != source:
                        self.source_owners.pop(previous, None)
                    self.sources[key] = source
                    self.appearance.pop(key, None)
                    self.policy_references.pop(key, None)
                    self.source_owners[source] = key
                else:
                    # Detect is an explicit target correction, not automatic
                    # acquisition. A changed pose may not match the old anchor.
                    # Move its existing slot instead of creating a duplicate.
                    key = self.source_owners.get(source)
                    if key is None:
                        key = self._new(source, embedding)
                    else:
                        self.anchors[key] = np.asarray(embedding, dtype=np.float32).copy()
                        self.positions.pop(key, None)
                        self.position_age.pop(key, None)
                        self.confirmed_at.pop(key, None)
                        self.appearance.pop(key, None)
                        self.policy_references.pop(key, None)
                self.pose_references.clear()
                self.revision = item['revision']

    def match(self, detections, strictness=45, acquire=None, continuity=()):
        with self.lock:
            self.match_sequence += 1
            for key in list(self.position_age):
                self.position_age[key] += 1
                if self.position_age[key] > 8:
                    self.position_age.pop(key, None); self.positions.pop(key, None)
            rows = [(i, row) for i, row in enumerate(detections)
                    if row[2] is not None and valid_embedding(row[2])
                    and np.asarray(row[1]).shape == (5, 2) and np.isfinite(row[1]).all()]
            if not rows or not self.face_ids:
                return ()
            threshold = target_identity_lock_threshold(strictness)
            keys = list(self.anchors)
            pairs = []
            if keys:
                from scipy.optimize import linear_sum_assignment
                scores = np.array([[rope_similarity(self.anchors[k], row[2]) for _, row in rows] for k in keys])
                anchor_scores = scores.copy()
                for ki, key in enumerate(keys):
                    # Independently anchor-qualified views remain useful after
                    # an occlusion/cut; they are not limited to adjacent frames.
                    for j, (_, row) in enumerate(rows):
                        if scores[ki,j] < 25:continue
                        gallery_scores=sorted((rope_similarity(ref,row[2]) for ref in self.pose_references.get(key,())),reverse=True)
                        corroborated=(len(gallery_scores)>1 and gallery_scores[0]>=threshold and gallery_scores[1]>=threshold-5)
                        if gallery_scores and (gallery_scores[0]>=threshold+10 or corroborated):
                            scores[ki,j]=max(scores[ki,j],gallery_scores[0])
                    prior = self.positions.get(key)
                    if prior is None or self.match_sequence - self.confirmed_at.get(key, -99) > 2:
                        continue
                    span = max(1., float(np.linalg.norm(prior[1] - prior[0])))
                    for j, (_, row) in enumerate(rows):
                        current = np.asarray(row[1])
                        ratio = np.linalg.norm(current[1] - current[0]) / span
                        distance = np.median(np.linalg.norm(current-prior, axis=1))/span
                        if not .8 <= ratio <= 1.25 or distance > .35 or scores[ki,j] < 25:
                            continue
                        # References come ONLY from direct anchor-qualified
                        # frames. Never train on a gallery-assisted match.
                        for reference in self.pose_references.get(key, ()):
                            score = rope_similarity(reference, row[2])
                            if score >= threshold+5:
                                scores[ki,j] = max(scores[ki,j], score)

                matrix = np.full((len(keys), len(rows)+len(keys)), threshold-5.)
                matrix[:, :len(rows)] = np.where(scores >= threshold, scores, -1e6)
                rr, cc = linear_sum_assignment(-matrix)
                for i, j in zip(rr, cc):
                    if j >= len(rows) or scores[i, j] < threshold:
                        continue
                    # Preserve known identities only with a clear match; a new
                    # appearance still gets its own best-source track below.
                    others = np.delete(scores[:, j], i)
                    rivals = np.delete(scores[i], j)
                    if (others.size and scores[i,j]-others.max() < 5) or (rivals.size and scores[i,j]-rivals.max() < 5):
                        continue
                    pairs.append((keys[i], rows[j][0]))
                    if anchor_scores[i,j] >= threshold:
                        gallery = self.pose_references.setdefault(keys[i], [])
                        embedding = np.asarray(rows[j][1][2], np.float32)
                        if not gallery or max(raw_identity_cosine(ref, embedding) for ref in gallery) < .98:
                            gallery.append(embedding.copy())
                            del gallery[:-16]

            # A short forward/backward LK track supplies ORIGINAL-pixel
            # continuity. Never use geometry alone, train on these matches,
            # or allow an absent track to reacquire through this route.
            claimed = {i for _, i in pairs}
            owned = {k for k, _ in pairs}
            if callable(continuity):
                continuity=continuity() if len(owned)<len(keys) and len(claimed)<len(rows) else ()
            proposals = []
            for key in keys:
                if key in owned:
                    continue
                predictions = [r for r in continuity if np.array_equal(self.anchors[key], r[2])]
                if len(predictions) != 1:
                    continue
                predicted = np.asarray(predictions[0][1])
                span = (identity_head_span(predicted) if os.environ.get('PONG_INDEPENDENT_CONTINUITY','0')=='1'
                        else max(1., float(np.linalg.norm(predicted[1]-predicted[0]))))
                options = []
                for i, row in rows:
                    if i in claimed or rope_similarity(self.anchors[key], row[2]) < 25:
                        continue
                    points = np.asarray(row[1])
                    error = float(np.max(np.linalg.norm(points-predicted, axis=1)))/span
                    if error <= .15:
                        options.append((error, i))
                if len(options) == 1:
                    proposals.append((key, options[0][1]))
            for key, i in proposals:
                if sum(j == i for _, j in proposals) == 1:
                    pairs.append((key, i))
            used = {i for _, i in pairs}
            recognized = {key for key, _ in pairs}
            for key, index in pairs:
                self.positions[key] = np.asarray(detections[index][1]).copy()
                self.position_age[key] = 0
            missing = [(i, row) for i, row in rows if i not in used]
            new_people = []
            for i, row in missing:
                nearby = []
                points = np.asarray(row[1])
                span = (identity_head_span(points) if os.environ.get('PONG_PROFILE_RESERVATION','0')=='1'
                        else max(1., float(np.linalg.norm(points[1] - points[0]))))
                for key, previous in self.positions.items():
                    if key in recognized:
                        continue
                    old_span = (identity_head_span(previous) if os.environ.get('PONG_PROFILE_RESERVATION','0')=='1'
                                else max(1., float(np.linalg.norm(previous[1] - previous[0]))))
                    distance = float(np.median(np.linalg.norm(points - previous, axis=1))) / max(span, old_span)
                    if .5 <= span / old_span <= 2 and distance <= 1.25:
                        nearby.append((distance, key))
                if nearby:
                    # A face still occupying a lost person's track is not a
                    # new acquisition. Preserve its approved-source binding;
                    # render again only after identity becomes confident.
                    nearby.sort()
                    for _, key in nearby:
                        self.position_age[key] = 0
                    if len(nearby) == 1 or nearby[1][0] - nearby[0][0] >= .25:
                        self.positions[nearby[0][1]] = points.copy()
                    self.continuity_holds += 1
                else:
                    new_people.append((i, row))
            missing = new_people
            # An uncertain re-identification of an existing person must not
            # acquire a different approved source as if they were a new person.
            # Keep the old binding; wait for a confident track match instead.
            missing = [(i, row) for i, row in missing
                if not any(rope_similarity(anchor, row[2]) >= threshold - 5
                           for anchor in self.anchors.values())]
            # Reserve sources for their original people even while absent.
            # Only actually available render slots acquire new people.
            missing = sorted(missing, key=lambda item: -float(item[1][0]))[:max(0, MAX_THREE_X_RENDERED-len(pairs))]
            free = tuple(source for source in self.face_ids if source not in self.source_owners)
            choices = acquire(free, missing) if acquire and missing and free else []
            available = dict(missing)
            for source, i in choices:
                if source in free and source not in self.source_owners and i in available and i not in used:
                    key = self._new(source, available[i][2])
                    self.positions[key] = np.asarray(available[i][1]).copy()
                    self.position_age[key] = 0
                    pairs.append((key, i))
                    used.add(i)
            active = {k for k, _ in pairs}
            for k, _ in pairs:
                self.confirmed_at[k] = self.match_sequence
                self.anchors.move_to_end(k)
            # Bound history across long clips; never evict a currently visible track.
            for k in list(self.anchors):
                if len(self.anchors) <= 512:
                    break
                if k not in active:
                    self.anchors.pop(k); self.sources.pop(k, None)
                    self.appearance.pop(k, None)
                    self.policy_references.pop(k, None)
                    self.positions.pop(k, None); self.position_age.pop(k, None)
            return tuple(pairs)


def deepcopy_assignments(previous, face_ids):
    state = PersonAssignments(face_ids)
    for name in ('anchors', 'sources', 'source_owners', 'positions', 'position_age', 'confirmed_at', 'pose_references', 'appearance', 'policy_references'):
        setattr(state, name, deepcopy(getattr(previous, name)))
    for name in ('continuity_holds', 'revision', 'sequence', 'match_sequence'):
        setattr(state, name, getattr(previous, name))
    return state


class AssignmentRegistry:
    def __init__(self, maximum=256):
        self.maximum = maximum
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def get(self, channel, epoch, video_key, face_ids, *, cover_all=False, extend=False):
        key = hashlib.sha256(repr((channel, epoch, video_key, tuple(face_ids), cover_all)).encode()).digest()
        with self.lock:
            state = self.items.pop(key, None)
            if state is None and cover_all and extend:
                scope = (channel, epoch, video_key)
                for previous in reversed(self.items.values()):
                    if (getattr(previous, '_scope', None) == scope and
                            isinstance(previous, PersonAssignments) and set(previous.face_ids).issubset(face_ids)):
                        # Adding a Detect-only source must not reassign everyone.
                        with previous.lock:
                            state = deepcopy_assignments(previous, face_ids)
                        break
            state = state or (PersonAssignments(face_ids) if cover_all else VideoAssignments(face_ids))
            state._scope = (channel, epoch, video_key)
            self.items[key] = state
            while len(self.items) > self.maximum:
                self.items.popitem(last=False)
            return state


ASSIGNMENTS = AssignmentRegistry()


class AdaptiveRenderQuality:
    """Bounded quality adaptation; never skips people or changes cadence."""
    def __init__(self, responsive=False):
        self.responsive = responsive
        self.level = 0
        self.ema = None
        self.samples = 0
        self.over = 0
        self.headroom = 0
        self.reason = 'warming'

    def observe(self, seconds, fps, faces, buffer_seconds=None):
        if faces < 1 or not np.isfinite(seconds) or seconds <= 0:
            return
        budget = 1.0 / max(1.0, float(fps or 30))
        self.ema = seconds if self.ema is None else .2 * seconds + .8 * self.ema
        self.samples += 1
        if self.responsive:
            # Leave capacity for decode, encode and delivery. React within a
            # few frames, then require sustained spare capacity to recover.
            known_buffer = buffer_seconds is not None and np.isfinite(buffer_seconds)
            # Reserve several expensive frames plus delivery time. React before
            # the growing media reaches its live edge, not after it empties.
            pressure_floor = min(1.0, max(.80, self.ema * 6))
            buffer_low = known_buffer and buffer_seconds < pressure_floor
            buffer_safe = not known_buffer or buffer_seconds >= 1.25
            self.over = self.over + 1 if self.ema > budget * .85 or buffer_low else 0
            self.headroom = self.headroom + 1 if self.ema < budget * .60 and buffer_safe else 0
            severe = self.ema > budget * 1.5 or (buffer_low and buffer_seconds < .30)
            # Sustained compute debt needs a real cheaper stage even when the
            # player is buffering and cannot advance its reported clock.
            ceiling = 8 if buffer_low or self.ema > budget * 1.15 else max(4, self.level)
            self.reason = 'buffer-low' if buffer_low else ('compute-budget' if self.ema > budget * .85 else 'headroom')
            if self.over >= (2 if severe else 6) and self.level < ceiling:
                self.level = min(ceiling, self.level + (2 if severe else 1))
                self.samples = self.over = self.headroom = 0
            elif self.headroom >= 90 and self.level > 0:
                self.level -= 1
                self.samples = self.over = self.headroom = 0
            return
        self.over = self.over + 1 if self.ema > budget * .95 else 0
        # Recovery needs room for the more expensive level, not just parity.
        self.headroom = self.headroom + 1 if self.ema < budget * .40 else 0
        if self.over >= 12 and self.level < 3:
            self.level += 1
            self.ema = None
            self.samples = self.over = self.headroom = 0
        elif self.headroom >= 180 and self.level > 0:
            self.level -= 1
            self.ema = None
            self.samples = self.over = self.headroom = 0


RESTORER_LADDER_ORDER = ('GPEN1024', 'GPEN512', 'GPEN357')
# Measured fresh-restoration stage cost per face on the RTX 4070 (fresh CUDA graphs,
# artifacts/swap-fresh-20261031). Priors only: the ladder learns the real frame cost online.
RESTORER_FACE_COST_MS = {'GPEN1024': 36.0, 'GPEN512': 26.0, 'GPEN357': 3.1, 'GPEN257': 3.1, 'GPEN256': 3.1}


def ladder_rung_for(model):
    """Map a selected model onto the physical ladder rung, or None when it is not a GPEN rung."""
    if model in ('GPEN257', 'GPEN357', 'GPEN256'):
        return 'GPEN357'
    return model if model in RESTORER_LADDER_ORDER else None


class RestorerLadder:
    """Dynamic restorer quality for responsive 3X Adapt.

    One rung is active for every rendered person in a frame. The controller steps DOWN
    (1024 -> 512 -> 357) as soon as the measured frame cost, scaled by the visible face
    count, no longer fits the frame budget or the player's buffer runs low, and steps UP
    only after sustained headroom. It never disables restoration, never drops original
    frames or changes cadence, and is only constructed when Adapt is on; an explicit
    selection with Adapt off is honoured by never building a ladder.
    """
    DOWN_FRAMES = 3           # consecutive over-budget frames before an ordinary step down
    UP_FRAMES = 45            # consecutive headroom frames before a step up (~1.5 s at 30 fps)
    MIN_FRAMES_BETWEEN_UPS = 60
    MIN_FRAMES_BETWEEN_DOWNS = 8
    DOWN_UTILISATION = 0.85
    UP_UTILISATION = 0.70
    SEVERE_UTILISATION = 1.30
    PROBE_UTILISATION = 0.60  # sustained real cost this far under budget earns a trial step up
    PROBE_FRAMES = 60         # ~2 s at 30 fps
    MIN_FRAMES_BETWEEN_PROBES = 120
    PROBE_CONFIRM_FRAMES = 12  # raw frame cost also judges a probe during these frames
    WARMUP_FRAMES = 3

    def __init__(self, configured, *, ceiling='GPEN1024', floor='GPEN357', ready=None, start=None):
        order = list(RESTORER_LADDER_ORDER)
        top = ceiling if ceiling in order else 'GPEN1024'
        bottom = floor if floor in order else 'GPEN357'
        if order.index(top) > order.index(bottom):
            top, bottom = bottom, top
        self.rungs = tuple(order[order.index(top):order.index(bottom) + 1])
        self.configured = configured
        self.ready = ready or (lambda model: True)
        configured_rung = ladder_rung_for(configured)
        initial = start if start in self.rungs else (configured_rung if configured_rung in self.rungs else self.rungs[-1])
        self.index = self.rungs.index(initial)
        self.started_from_hint = start in self.rungs
        self.ema = None
        self.faces = 0
        self.fresh_ratio = 1.0
        self.over = 0
        self.headroom = 0
        self.probe = 0
        self.frames = 0
        self.last_change = -10_000
        self.switches = 0
        self.reason = 'warming'
        self.last_budget_ms = None
        self.last_prediction_ms = None

    @property
    def model(self):
        return self.rungs[self.index]

    @property
    def active(self):
        return len(self.rungs) > 1

    def _cost(self, model):
        return float(RESTORER_FACE_COST_MS.get(model, RESTORER_FACE_COST_MS['GPEN357']))

    def _predict(self, target_model, faces, ema=None):
        """Predicted frame cost if ``target_model`` restored ``faces`` people."""
        ema = self.ema if ema is None else ema
        if ema is None:
            return None
        current = self._cost(self.model) * self.faces * self.fresh_ratio
        proposed = self._cost(target_model) * faces * self.fresh_ratio
        return max(0.0, ema - current) + proposed

    def _next_ready(self, direction, steps=1):
        """Index of the nearest resident rung ``steps`` rungs away in ``direction`` (+1 cheaper, -1 finer)."""
        target = max(0, min(len(self.rungs) - 1, self.index + direction * steps))
        candidate = target
        # Prefer the requested rung, then anything resident between here and it.
        while candidate != self.index:
            if self.ready(self.rungs[candidate]):
                return candidate
            candidate -= direction
        # Nothing resident on the near side: when stepping up, the next resident rung
        # beyond the request is still a valid (single) step; when stepping down under
        # pressure, fall through to the cheapest resident rung.
        candidate = target + direction
        while 0 <= candidate < len(self.rungs):
            if self.ready(self.rungs[candidate]):
                return candidate
            candidate += direction
        return None

    def _move(self, index, reason):
        if index is None or index == self.index or not (0 <= index < len(self.rungs)):
            return False
        if not self.ready(self.rungs[index]):
            return False
        self.index = index
        self.switches += 1
        self.last_change = self.frames
        self.over = self.headroom = self.probe = 0
        self.reason = reason
        return True

    def observe(self, seconds, fps, faces, buffer_seconds=None, fresh_faces=None):
        """Feed one rendered frame; returns True when the active rung changed."""
        if not self.active or faces < 1 or not np.isfinite(seconds) or seconds <= 0:
            return False
        self.frames += 1
        ms = float(seconds) * 1000.0
        budget = 1000.0 / max(1.0, float(fps or 30))
        self.last_budget_ms = budget
        if self.frames <= self.WARMUP_FRAMES:
            # Cold first frames (lazy kernels, caches) are not steady-state evidence.
            # Pick the opening rung from the visible face count instead: one person
            # starts at the finest resident rung, a crowd at the cheapest; measured
            # frames correct either within a few frames.
            self.faces = faces
            if self.frames == 1 and not self.started_from_hint:
                opening = 0 if faces <= 1 else (len(self.rungs) // 2 if faces == 2 else len(self.rungs) - 1)
                target = self._next_ready(-1 if opening < self.index else +1, abs(opening - self.index)) if opening != self.index else None
                if target is not None and self._move(target, 'opening-face-count'):
                    self.switches = 0
                    self.last_change = -10_000
            return False
        if fresh_faces is not None:
            ratio = max(0.0, min(1.0, float(fresh_faces) / max(1, faces)))
            self.fresh_ratio = ratio if self.fresh_ratio is None else 0.1 * ratio + 0.9 * self.fresh_ratio
        known_buffer = buffer_seconds is not None and np.isfinite(buffer_seconds)
        buffer_low = known_buffer and buffer_seconds < 0.8
        buffer_safe = (not known_buffer) or buffer_seconds >= 1.25
        changed = False
        if faces > self.faces and self.ema is not None:
            # More people entered. Predict the new cost from the per-face prior before a
            # single slow frame is measured, and step down pre-emptively if it will not fit.
            predicted = self._predict(self.model, faces)
            self.last_prediction_ms = predicted
            if predicted > budget * self.SEVERE_UTILISATION and self.index < len(self.rungs) - 1:
                changed = self._move(self._next_ready(+1, 2), 'faces-entered-severe')
            elif predicted > budget * self.DOWN_UTILISATION and self.index < len(self.rungs) - 1:
                changed = self._move(self._next_ready(+1), 'faces-entered')
            # Re-anchor the EMA to the predicted cost of the rung now in use.
            self.ema = self._predict(self.model, faces, predicted) if changed else predicted
            self.faces = faces
            return changed
        if faces != self.faces:
            self.faces = faces
        self.ema = ms if self.ema is None else 0.2 * ms + 0.8 * self.ema
        # Right after a probe the raw frame cost counts too, so a wrong guess is
        # reversed within a few frames instead of waiting for the slow average.
        judged = max(self.ema, ms) if self.frames - self.last_change <= self.PROBE_CONFIRM_FRAMES and self.reason == 'probe' else self.ema
        over = judged > budget * self.DOWN_UTILISATION or buffer_low
        severe = judged > budget * self.SEVERE_UTILISATION or (buffer_low and buffer_seconds < 0.3)
        self.over = self.over + 1 if over else 0
        at_bottom = self.index >= len(self.rungs) - 1
        if at_bottom:
            self.reason = 'buffer-low' if buffer_low else ('compute-budget' if over else 'floor')
        elif over and (self.over >= (1 if severe else self.DOWN_FRAMES)) and (
                severe or self.frames - self.last_change >= self.MIN_FRAMES_BETWEEN_DOWNS):
            changed = self._move(self._next_ready(+1, 2 if severe else 1), 'buffer-low' if buffer_low else 'compute-budget')
            if changed:
                # Pull the estimate down to the expected cost of the cheaper rung so the
                # next frames judge the new rung, not the old one.
                self.ema = self._predict(self.model, faces)
            self.headroom = 0
        elif self.reason != 'probe' or self.frames - self.last_change > self.PROBE_CONFIRM_FRAMES:
            self.reason = 'buffer-low' if buffer_low else ('compute-budget' if over else 'headroom')
        if not changed and self.index > 0:
            up_index = self._next_ready(-1)
            predicted_up = self._predict(self.rungs[up_index], faces) if up_index is not None else None
            fits = predicted_up is not None and predicted_up <= budget * self.UP_UTILISATION and buffer_safe and not over
            self.headroom = self.headroom + 1 if fits else 0
            self.last_prediction_ms = predicted_up
            # The per-face prior may overestimate a rung (cadence reuse, faster kernels).
            # After a long quiet stretch well under budget, probe one rung up anyway and
            # let the measured frames confirm or reverse it; probes are rate limited.
            probe_ok = up_index is not None and self.ema <= budget * self.PROBE_UTILISATION and buffer_safe and not over
            self.probe = self.probe + 1 if probe_ok else 0
            since_change = self.frames - self.last_change
            if self.headroom >= self.UP_FRAMES and since_change >= self.MIN_FRAMES_BETWEEN_UPS:
                changed = self._move(up_index, 'headroom')
                if changed:
                    self.ema = predicted_up
            elif self.probe >= self.PROBE_FRAMES and since_change >= self.MIN_FRAMES_BETWEEN_PROBES:
                # Keep the measured estimate: the probe is judged by real frames.
                changed = self._move(up_index, 'probe')
        return changed

    def snapshot(self):
        return {'configured': self.configured, 'active': self.model, 'rungs': list(self.rungs),
                'reason': self.reason, 'emaMs': round(self.ema, 2) if self.ema is not None else None,
                'budgetMs': round(self.last_budget_ms, 2) if self.last_budget_ms else None,
                'predictedMs': round(self.last_prediction_ms, 2) if self.last_prediction_ms is not None else None,
                'faces': self.faces, 'freshRatio': round(float(self.fresh_ratio), 3),
                'switches': self.switches, 'framesSinceChange': self.frames - self.last_change if self.switches else self.frames}


class CrowdQuality:
    """Debounce visible-person count; a brief detection miss cannot flip quality."""
    def __init__(self):
        self.high = self.low = 0
        self.active = False

    def update(self, faces, level, enabled):
        self.high = self.high + 1 if faces >= 3 else 0
        self.low = self.low + 1 if faces < 3 else 0
        if not enabled or level == 0 or self.low >= 30:
            self.active = False
        elif self.high >= 8:
            self.active = True
        return self.active


class OriginalFrameTracker:
    """Short, guarded original-pixel tracks between full identity checks."""
    def __init__(self, allow_clipped=False):
        self.gray = None
        self.allow_clipped=allow_clipped
        self.rows = ()
        self.age = 0
        self.shape = None
        self.rejection_counts = {}

    @staticmethod
    def prepare(frame):
        height, width = frame.shape[:2]
        scale = min(1.0, 640.0 / max(height, width))
        small = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))))
        return cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), scale

    def remember(self, gray, scale, rows, shape):
        self.gray = gray
        self.scale = scale
        self.rows = tuple((area, np.asarray(points).copy(), np.asarray(embedding).copy())
                          for area, points, embedding in rows if valid_embedding(embedding))
        self.shape = shape
        self.age = 0

    def advance(self, gray, scale, shape, max_age=2):
        self.pending_identity_check=None
        def reject(reason):
            self.rejection_counts[reason]=self.rejection_counts.get(reason,0)+1
            return None
        if self.gray is None or self.shape != shape or self.age >= min(4, max(1, max_age)) or not self.rows or scale != self.scale:
            return reject('age-or-new-track')
        if float(np.abs(gray.astype(np.float32) - self.gray.astype(np.float32)).mean()) > 12:
            return reject('scene-change')
        points = np.concatenate([row[1] for row in self.rows]).astype(np.float32) * scale
        forward, good, _ = cv2.calcOpticalFlowPyrLK(self.gray, gray, points.reshape(-1, 1, 2), None,
            winSize=(21, 21), maxLevel=2)
        if forward is None or good is None or not good.all():
            return reject('forward-flow')
        backward, back_good, _ = cv2.calcOpticalFlowPyrLK(gray, self.gray, forward, None,
            winSize=(21, 21), maxLevel=2)
        if backward is None or back_good is None or not back_good.all():
            return reject('backward-flow')
        target = forward.reshape(-1, 2)
        if not np.isfinite(target).all() or np.max(np.linalg.norm(backward.reshape(-1, 2) - points, axis=1)) > .6:
            return reject('roundtrip-flow')
        rows, boxes, appearance_checks = [], [], []
        for i, (area, previous, embedding) in enumerate(self.rows):
            old = points[i*5:(i+1)*5]
            new = target[i*5:(i+1)*5]
            head_geometry=os.environ.get('PONG_TRACK_HEAD_GEOMETRY','0')=='1'
            span = identity_head_span(old) if head_geometry else max(1., float(np.linalg.norm(old[0] - old[1])))
            if span < 8 or np.max(np.linalg.norm(new - old, axis=1)) > span * .18:
                return reject('scale-or-motion')
            if head_geometry:
                from pong_attachment import weighted_similarity
                transform=weighted_similarity(old,new,[1.,1.,.8,0.,0.])[:2]
            else:transform, _ = cv2.estimateAffinePartial2D(old, new, method=cv2.LMEDS)
            if transform is None:
                return reject('rigid-fit')
            projected = cv2.transform(old.reshape(1, -1, 2), transform)[0]
            residual=np.linalg.norm(projected-new,axis=1)
            if np.max(residual[:3] if head_geometry else residual) > span * .025:
                return reject('nonrigid-expression')
            # Compare aligned ORIGINAL face appearance, never swapped pixels.
            lo = old.min(axis=0) - span * .45
            hi = old.max(axis=0) + span * .45
            x0, y0 = np.floor(lo).astype(int); x1, y1 = np.ceil(hi).astype(int)
            if x0 < 0 or y0 < 0 or x1 >= gray.shape[1] or y1 >= gray.shape[0]:
                if not self.allow_clipped:return reject('clipped')
                # A margin outside the image is not a lost face. Retain all
                # forward/backward/identity/appearance checks on real pixels.
                if np.any(old<0) or np.any(old[:,0]>=gray.shape[1]) or np.any(old[:,1]>=gray.shape[0]):return reject('clipped-points')
                original_area=max(1,(x1-x0)*(y1-y0))
                x0,y0=max(0,x0),max(0,y0);x1,y1=min(gray.shape[1],x1),min(gray.shape[0],y1)
                if (x1-x0)*(y1-y0)<original_area*.65 or min(x1-x0,y1-y0)<16:return reject('clipped-area')
            # Evaluate only the face ROI. This is the identical inverse-map
            # sample, without warping the full 640px frame for every person.
            local=transform.copy();local[:,2]+=local[:,:2]@np.array([x0,y0])
            warped = cv2.warpAffine(gray, local, (x1-x0,y1-y0),flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
            delta = np.abs(warped.astype(np.float32) - self.gray[y0:y1, x0:x1].astype(np.float32))
            if not delta.size or float(delta.mean()) > 5 or float(np.percentile(delta, 90)) > 14:
                if os.environ.get('PONG_TRACK_IDENTITY_RECHECK','0')!='1':return reject('original-appearance')
                appearance_checks.append(i)
            box = (new.min(axis=0) - span * .45, new.max(axis=0) + span * .45)
            for other_lo, other_hi in boxes:
                overlap = np.maximum(0, np.minimum(box[1], other_hi) - np.maximum(box[0], other_lo))
                if float(np.prod(overlap)) > .10 * min(float(np.prod(box[1]-box[0])), float(np.prod(other_hi-other_lo))):
                    return reject('track-overlap')
            boxes.append(box)
            rows.append((area, new / scale, embedding))
        if appearance_checks:
            self.pending_identity_check=(gray,tuple(rows),tuple(appearance_checks))
            return reject('original-appearance')
        self.gray, self.rows = gray, tuple(rows)
        self.age += 1
        return self.rows

    def advance_independent(self,gray,scale,shape,max_age=1):
        """Keep independently valid ORIGINAL tracks when another person fails.

        Only used for adjacent-frame identity continuity, not discovery. Every
        child runs the existing unrelaxed LK/appearance/age checks; uncertain
        overlaps are discarded and no child trains an identity anchor.
        """
        from copy import copy
        rows=[]
        for row in self.rows:
            child=copy(self);child.rows=(row,);child.rejection_counts={}
            current=child.advance(gray,scale,shape,max_age)
            if current is not None:rows.extend(current)
        boxes=[]
        for _,points,_ in rows:
            span=identity_head_span(points)
            boxes.append((points.min(0)-span*.45,points.max(0)+span*.45))
        unsafe=set()
        for i,(lo,hi) in enumerate(boxes):
            for j,(other_lo,other_hi) in enumerate(boxes[:i]):
                overlap=np.maximum(0,np.minimum(hi,other_hi)-np.maximum(lo,other_lo))
                if float(np.prod(overlap))>.10*min(float(np.prod(hi-lo)),float(np.prod(other_hi-other_lo))):unsafe.update((i,j))
        return tuple(row for i,row in enumerate(rows) if i not in unsafe)

    def confirm_pending(self,recognize):
        """Recheck changed original face identities without rerunning detection.

        Only fully valid adjacent-frame LK geometry reaches here. A current
        recognition must be very close to its own previous identity and have
        a clear margin over every other track. Discovery age is NOT reset.
        """
        pending=getattr(self,'pending_identity_check',None)
        self.pending_identity_check=None
        if pending is None:return None
        gray,proposed,indices=pending;rows=list(proposed)
        for i in indices:
            try:observed=recognize(rows[i][1])
            except Exception:return None
            score=raw_identity_cosine(self.rows[i][2],observed)
            rival=max((raw_identity_cosine(row[2],observed) for j,row in enumerate(self.rows) if j!=i),default=-1.)
            if score<.85 or score-rival<.05:return None
            rows[i]=(rows[i][0],rows[i][1],np.asarray(observed).copy())
        self.gray,self.rows=gray,tuple(rows);self.age+=1
        self.identity_rechecked=getattr(self,'identity_rechecked',0)+len(indices)
        return self.rows


class FaceCorrectionCache:
    """Transport signed swap corrections, never a frozen source/background."""
    def __init__(self):
        self.entries = {}
        self.shape = None
        self.revision = None
        self.age = 0

    def clear(self):
        self.entries = {}
        self.age = 0

    @staticmethod
    def overlaps(boxes):
        for i, a in enumerate(boxes):
            for b in boxes[:i]:
                if min(a[2],b[2]) > max(a[0],b[0]) and min(a[3],b[3]) > max(a[1],b[1]):
                    return True
        return False

    def remember(self, frame, output, rows, revision):
        self.clear()
        boxes = [box for _, _, box in rows]
        if not rows or self.overlaps(boxes):
            return
        self.shape, self.revision = frame.shape, revision
        for key, points, box in rows:
            x0,y0,x1,y1 = box
            if x0 < 0 or y0 < 0 or x1 > frame.shape[1] or y1 > frame.shape[0] or x1 <= x0 or y1 <= y0:
                self.clear();return
            delta = output[y0:y1,x0:x1].astype(np.float32) - frame[y0:y1,x0:x1].astype(np.float32)
            self.entries[key] = (np.asarray(points).copy(), box, delta, frame[y0:y1,x0:x1].copy())

    def render(self, frame, rows, revision, destination=None, max_age=2):
        if self.age >= min(10, max(1, max_age)) or frame.shape != self.shape or revision != self.revision or set(key for key,_ in rows) != set(self.entries) or not rows:
            return None
        prepared=[]
        for key, points in rows:
            old, box, delta, original = self.entries[key]
            matrix,_ = cv2.estimateAffinePartial2D(old.astype(np.float32), np.asarray(points,np.float32), method=cv2.LMEDS)
            if matrix is None or not np.isfinite(matrix).all(): return None
            projected=cv2.transform(old.reshape(1,-1,2),matrix)[0]
            span=max(1.,float(np.linalg.norm(old[0]-old[1])))
            if np.max(np.linalg.norm(projected-points,axis=1)) > span*.05: return None
            scale=float(np.linalg.norm(matrix[:,0]))
            if not .90 <= scale <= 1.10: return None
            x0,y0,x1,y1=box
            corners=np.array([[x0,y0],[x1,y0],[x0,y1],[x1,y1]],np.float32)
            moved=cv2.transform(corners.reshape(1,-1,2),matrix)[0]
            lo=np.floor(moved.min(axis=0)).astype(int);hi=np.ceil(moved.max(axis=0)).astype(int)
            left,top=max(0,lo[0]),max(0,lo[1]);right,bottom=min(frame.shape[1],hi[0]),min(frame.shape[0],hi[1])
            if right<=left or bottom<=top:return None
            local=matrix.copy();local[:,2]+=matrix[:,:2]@np.array([x0,y0])-np.array([left,top])
            warped_original=cv2.warpAffine(original,local,(right-left,bottom-top),flags=cv2.INTER_LINEAR)
            support=cv2.warpAffine(np.ones(original.shape[:2],np.float32),local,(right-left,bottom-top),flags=cv2.INTER_LINEAR) > .99
            difference=np.abs(warped_original.astype(np.float32)-frame[top:bottom,left:right].astype(np.float32)).mean(axis=2)
            if not support.any() or float(difference[support].mean()) > 8 or float(np.percentile(difference[support],90)) > 20:
                return None
            if True:  # Eyes/mouth changes matter even on the first reused frame.
                # Longer reuse must also prove that eyes and mouth remain
                # stable; averaging the whole head can hide local movement.
                radius = max(2, int(span * .18))
                for point in np.asarray(points)[[0, 1, 3, 4]]:
                    px, py = np.rint(point - [left, top]).astype(int)
                    xa, xb = max(0, px-radius), min(difference.shape[1], px+radius+1)
                    ya, yb = max(0, py-radius), min(difference.shape[0], py+radius+1)
                    patch = difference[ya:yb, xa:xb]
                    valid = support[ya:yb, xa:xb]
                    if not patch.size or not valid.any() or float(patch[valid].mean()) > 16:
                        return None
            prepared.append(((left,top,right,bottom),delta,local))
        if self.overlaps([box for box,_,_ in prepared]):return None
        result=frame.copy() if destination is None else destination
        for (left,top,right,bottom),delta,local in prepared:
            warped=cv2.warpAffine(delta,local,(right-left,bottom-top),flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT,borderValue=0)
            result[top:bottom,left:right]=np.clip(frame[top:bottom,left:right].astype(np.float32)+warped,0,255).astype(np.uint8)
        self.age += 1
        return result


def apply_quality_policy(config, saved, level, crowd_pressure=False):
    # Adapt changes scheduling, not the generated appearance. Model switching
    # and restoration bypass made pressure/recovery visible as face flicker.
    if saved['runtime'].get('tiktokRestorerProfile') == 'tiktok-3x-adapt':
        config['runtime']['threeXForce256'] = False
        config['runtime'].pop('crowdRestorerModel', None)
        config['runtime']['adaptRestorationBypassed'] = False
        config['parameters']['RestorerSwitch'] = bool(saved['parameters'].get('RestorerSwitch', False))
        config['parameters']['SwapperTypeTextSel'] = saved['parameters'].get('SwapperTypeTextSel', '128')
        return
    # Legacy profiles retain their prior policy.
    from pong_tiktok_restorer import TIKTOK_THREE_X_PROFILE, FIXED_GFPGAN12_THREE_X_PROFILE, ADAPT_THREE_X_PROFILE, ADAPT_RESTORER_STEP
    fixed = saved['runtime'].get('tiktokRestorerProfile') in (TIKTOK_THREE_X_PROFILE, FIXED_GFPGAN12_THREE_X_PROFILE, ADAPT_THREE_X_PROFILE)
    config['runtime']['threeXForce256'] = not fixed and level >= 1
    config['parameters']['RestorerSwitch'] = bool(saved['parameters'].get('RestorerSwitch', False)) and (fixed or level < 3)
    base = str(saved['parameters'].get('SwapperTypeTextSel', '128'))
    config['parameters']['SwapperTypeTextSel'] = '128' if not fixed and level >= 2 and base in ('256', '512') else base
    model = saved['parameters'].get('RestorerTypeTextSel')
    config['runtime'].pop('crowdRestorerModel', None)
    if (saved['runtime'].get('tiktokRestorerProfile') == ADAPT_THREE_X_PROFILE
            and crowd_pressure and level >= 1 and config['parameters']['RestorerSwitch']):
        fallback = ADAPT_RESTORER_STEP.get(model)
        if fallback:
            config['runtime']['crowdRestorerModel'] = fallback
    emergency = saved['runtime'].get('tiktokRestorerProfile') == ADAPT_THREE_X_PROFILE and level >= 8
    config['runtime']['adaptRestorationBypassed'] = emergency
    if emergency:
        config['parameters']['RestorerSwitch'] = False
        config['runtime'].pop('crowdRestorerModel', None)


class ThreeXRenderer:
    def __init__(self, engine, session, candidates, evidence_type):
        self.engine, self.session, self.evidence_type = engine, session, evidence_type
        self.candidates = {candidate.face_id: candidate for candidate in candidates}
        runtime = session.config['runtime']
        self.assignments = ASSIGNMENTS.get(session.channel, session.client_epoch or session.id,
            runtime.get('threeXVideoKey') or session.source_url, session.candidate_face_ids, cover_all=True, extend=bool(runtime.get('threeXCorrections')))
        self.assignments.correct(runtime.get('threeXCorrections', []))
        self.configs = {}
        self.presentation_cache = []
        self.hair_cache = []
        self.hair_measurements = 0
        self.render_seconds_ema = 0.0
        self.responsive_adapt = runtime.get('tiktokRestorerProfile') == 'tiktok-3x-adapt'
        self.quality = AdaptiveRenderQuality(responsive=self.responsive_adapt)
        self.crowd_quality = CrowdQuality()
        self.crowd_pressure = False
        self.active_person_keys = set()
        self.quality_hint_key = (len(self.candidates), round(float(getattr(session, 'fps', 30) or 30), 2),
                                 str(session.config['parameters'].get('SwapperTypeTextSel', '128')),
                                 runtime.get('tiktokRestorerProfile'),
                                 session.config['parameters'].get('RestorerTypeTextSel'))
        hints = getattr(engine, '_three_x_quality_hints', {})
        self.quality_adaptation_enabled = bool(runtime.get('adaptiveRestorer', False)
            or runtime.get('temporalForegroundReuseEnabled', False))
        self.explicit_cadence = runtime.get('frameReuseCadence')
        if self.explicit_cadence is not None:
            self.quality_adaptation_enabled = bool(runtime.get('adaptiveRestorer', False))
        self.quality.level = int(hints.get(self.quality_hint_key, 0)) if self.quality_adaptation_enabled else 0
        # Dynamic restorer quality (GPEN1024 -> GPEN512 -> GPEN357) for responsive Adapt only.
        # With Adapt off the explicitly selected model is honoured: no ladder is built.
        configured_restorer = session.config['parameters'].get('RestorerTypeTextSel')
        self.restorer_ladder = None
        if (self.responsive_adapt and self.quality_adaptation_enabled
                and bool(session.config['parameters'].get('RestorerSwitch', False))
                and ladder_rung_for(configured_restorer)
                and os.environ.get('PONG_RESTORER_LADDER', '1') == '1'):
            self.restorer_ladder = RestorerLadder(configured_restorer,
                ceiling=str(runtime.get('adaptRestorerCeiling', 'GPEN1024')),
                floor=str(runtime.get('adaptRestorerFloor', 'GPEN357')),
                ready=self._restorer_ready,
                start=hints.get(self.quality_hint_key + ('restorer-ladder',)))
            if not self.restorer_ladder.active:
                self.restorer_ladder = None
        self.frame_counts = {}
        self.rendered_frames = 0
        self.stage_timings = {}
        self.tracker = OriginalFrameTracker(allow_clipped=bool(runtime.get('attachmentStabilityEnabled',False)))
        self.continuity_tracker = OriginalFrameTracker(allow_clipped=bool(runtime.get('attachmentStabilityEnabled',False)))
        self.reuse_age = 2
        self.anchor_frames = 3
        self.staggered_refreshes = 0
        self.playback_buffer_seconds = None
        self.corrections = {}
        # Adapt-only (Adapt on, 1/3 and 1/4 off) has no reuse lever at all: every frame is
        # a fresh generation and the quality levels can only skip detection. Under measured
        # pressure that is already past the cheapest restorer rung, allow the same guarded
        # GPU patch transport the explicit cadences use (PONG_ADAPT_DYNAMIC_REUSE=0 restores
        # strictly fresh frames). All original frames are still output; nothing is dropped.
        self.adaptive_reuse = (self.responsive_adapt and self.quality_adaptation_enabled
            and self.explicit_cadence == 1 and os.environ.get('PONG_ADAPT_DYNAMIC_REUSE', '1') == '1')
        self.gpu_patch_enabled = (os.environ.get('PONG_GPU_FACE_PATCH', '1') == '1'
            and (self.responsive_adapt or self.explicit_cadence in (3, 4))
            and (self.explicit_cadence != 1 or self.adaptive_reuse)
            and callable(getattr(getattr(engine, '_vm', None), '_warp_grid_sample', None)))
        self.adaptive_reuse_frames = 0
        self.face_patches = {}
        self.batch_policy = None
        if os.environ.get('PONG_BATCH_PRESENTATION', '1') == '1':
            try:self.batch_policy = engine._presentation_classifier.graph_policy(5)
            except Exception as exc:self.batch_policy_error=str(exc)
        self.patch_rejections = {}
        self.gpu_patch_reused = 0
        if self.gpu_patch_enabled:
            from pong_face_patch import PatchCapture
            self.patch_capture = PatchCapture.for_vm(engine._vm)
        self.correction_reused_frames = 0
        self.tracked_frames = 0
        self.temporal = {}
        self.finish_contexts = {}
        self.last_slot_frame = {}
        self.last_revision = self.assignments.revision
        for key in self.candidates:
            config = deepcopy(session.config)
            apply_face_restoration(config, key)
            # Compose at source resolution; enhance only after all swaps so a
            # full-frame x2 enhancement cannot move later people's coordinates.
            config['runtime']['frameEnhancerEnabled'] = False
            config['parameters']['ThreeXStableCanonical'] = True
            config['runtime']['colorMatchCaptureOnMiss'] = True
            config['runtime']['tiktokRestorerState'] = {}
            self.configs[key] = config

    @frame_identity_math
    def render(self, frame):
        engine, session = self.engine, self.session
        if session.stop.is_set():
            return None, 0
        started = time.perf_counter()
        reused_faces_before = self.gpu_patch_reused
        gray, scale = self.tracker.prepare(frame)
        if self.last_revision != self.assignments.revision:
            self.tracker = OriginalFrameTracker(allow_clipped=bool(session.config['runtime'].get('attachmentStabilityEnabled',False)))
            self.continuity_tracker = OriginalFrameTracker(allow_clipped=bool(session.config['runtime'].get('attachmentStabilityEnabled',False)))
            self.temporal.clear()
            self.corrections.clear()
            self.face_patches.clear()
            self.finish_contexts.clear()
            self.last_revision = self.assignments.revision
        if os.environ.get('PONG_LAZY_CONTINUITY','0')=='1':
            independent=os.environ.get('PONG_INDEPENDENT_CONTINUITY','0')=='1'
            continuity=lambda:(self.continuity_tracker.advance_independent if independent else self.continuity_tracker.advance)(gray,scale,frame.shape,max_age=1) or ()
        else:
            continuity = self.continuity_tracker.advance(gray, scale, frame.shape, max_age=1) or ()
        independent_tracking = os.environ.get('PONG_INDEPENDENT_DETECTION_TRACKING','0')=='1'
        tracking_enabled = independent_tracking or self.explicit_cadence in (3, 4) or self.quality.level >= (1 if self.responsive_adapt else 2)
        track_age = min(4, max(2, self.quality.level)) if self.responsive_adapt else 2
        if (not self.responsive_adapt and self.explicit_cadence==4
                and os.environ.get('PONG_CADENCE_DISCOVERY','0')=='1'):
            # Align periodic discovery with the requested four-frame cadence.
            # Flow/appearance/scene and identity failures still redetect NOW.
            track_age=3
        if getattr(self, 'pending_rediscovery', False) and os.environ.get('PONG_PROMPT_REDISCOVERY', '1') == '1':
            track_age = 1
        detected = self.tracker.advance(gray, scale, frame.shape, max_age=track_age) if tracking_enabled else None
        tracked = detected is not None
        with engine._lock:
            with engine._torch.cuda.stream(engine._compute_stream):
                composite = engine._frame_tensor(frame) if detected is None else None
                if detected is None and getattr(self.tracker,'pending_identity_check',None) is not None:
                    detected=self.tracker.confirm_pending(lambda points:engine._models.run_recognize(composite,points,return_crop=False)[0])
                    tracked=detected is not None
                if detected is None:
                    detected = engine._detect(composite, recognize=True,
                        config=session.config, max_faces=MAX_THREE_X_FACES,
                        detector_score=engine._target_detection_score(), recover=True)
                    if os.environ.get('PONG_TILED_SMALL_FACE_RECOVERY','0')=='1':
                        from pong_tiled_detection import recover as recover_small_faces
                        detected=recover_small_faces(engine,composite,detected,session.config,engine._target_detection_score(),MAX_THREE_X_FACES)
                    detected = self._recover_known_people(composite, detected)
            if composite is not None or os.environ.get('PONG_DEFERRED_READBACK', '1') != '1':
                # A tracked frame queued no GPU work of its own; fencing here would only
                # wait for the previous frame's tail and remove the CPU/GPU overlap.
                engine._compute_stream.synchronize()
        if tracked:
            self.tracked_frames += 1
        else:
            self.tracker.remember(gray, scale, detected, frame.shape)
        detection_seconds = time.perf_counter() - started
        detected = self._eligible_people(frame, detected)
        stage_diagnostics = {} if self.rendered_frames % 60 == 30 else None
        # Keep correction and all composited faces atomic with respect to Detect.
        with self.assignments.lock:
            self.pending_appearance = {}
            pairs = self.assignments.match(detected,
                session.config['parameters'].get('DetectScoreSlider', 45),
                acquire=lambda sources, rows: self._assign_hair(frame, sources, rows, reuse_sources=True, unique_sources=True), continuity=continuity)
            for person_key, index in pairs:
                choice = self.pending_appearance.get(index)
                if choice and choice['faceId'] == self.assignments.sources[person_key]:
                    self.assignments.appearance[person_key] = choice
            identity_matched_count = len(pairs)
            pairs = self._strict_pairs(frame, pairs, detected)
            target_policy_rejected = identity_matched_count - len(pairs)
            limited_count = max(0, len(pairs) - MAX_THREE_X_RENDERED)
            pairs = self._cap_pairs(pairs, detected)
            self.continuity_tracker.remember(gray, scale,
                [(detected[i][0], detected[i][1], self.assignments.anchors[k]) for k, i in pairs], frame.shape)
            if not tracked and pairs:
                # An unassigned tiny/background face must not invalidate all
                # active tracks. Full discovery still runs at the bounded age.
                self.tracker.remember(gray, scale, [detected[index] for _, index in pairs], frame.shape)
                # A detected face that was rejected by eligibility/policy/identity on this
                # frame is dropped from the tracked rows above, so it would otherwise stay
                # invisible until the track age expires (2-4 frames). Re-detect on the very
                # next frame while such a face is pending, instead of extending the gap.
                self.pending_rediscovery = len(detected) > len(pairs) or self.eligibility_counts.get('detectedCount', 0) > len(detected)
            elif not tracked:
                self.pending_rediscovery = False
            from pong_tiktok_restorer import ADAPT_THREE_X_PROFILE
            self.crowd_pressure = self.crowd_quality.update(len(pairs), self.quality.level,
                self.quality_adaptation_enabled and session.config['runtime'].get('tiktokRestorerProfile') == ADAPT_THREE_X_PROFILE)
            if self.responsive_adapt:
                self.crowd_pressure = bool(pairs and self.quality_adaptation_enabled and self.quality.level >= 1)
            # Third buffer-pressure fallback: reuse only while all existing
            # motion/appearance guards pass. Never hold a whole output frame.
            emergency = self.responsive_adapt and self.quality.level >= 7
            self.reuse_age = (min(10 if emergency else 7,
                10 if emergency else max(2, self.quality.level + 1),
                max(2, int(session.fps * (.35 if emergency else .25))))
                if self.responsive_adapt else (3 if self.crowd_pressure else 2))
            if self.responsive_adapt:
                # At most three transported frames. Never stretch a face over
                # ten frames to mask overload; unsafe motion regenerates now.
                self.reuse_age = 3 if self.quality.level >= 3 else 2
            elif self.explicit_cadence is not None:
                self.reuse_age = self.explicit_cadence - 1
            self.anchor_frames = self.reuse_age + 1
            for key, _ in pairs:
                source = self.assignments.sources[key]
                if key not in self.configs or self.configs[key].get('_sourceFaceId') != source:
                    self.configs[key] = deepcopy(self.configs[source])
                    self.configs[key]['_sourceFaceId'] = source
                    self.temporal.pop(key, None); self.corrections.pop(key, None)
                    self.face_patches.pop(key, None)
                config = self.configs[key]
                old_policy = (config['runtime'].get('crowdRestorerModel'), config['runtime'].get('_crowdReuse', False), config['parameters'].get('RestorerSwitch'))
                apply_quality_policy(config, session.config, self.quality.level, self.crowd_pressure)
                if self.restorer_ladder is not None:
                    # One rung for everyone in the frame; select_restorer honours it per person.
                    chosen = self.restorer_ladder.model
                    if chosen != ladder_rung_for(config['parameters'].get('RestorerTypeTextSel')) or chosen != config['parameters'].get('RestorerTypeTextSel'):
                        config['runtime']['crowdRestorerModel'] = chosen
                    else:
                        config['runtime'].pop('crowdRestorerModel', None)
                config['runtime']['_crowdReuse'] = self.crowd_pressure
                new_policy = (config['runtime'].get('crowdRestorerModel'), self.crowd_pressure, config['parameters'].get('RestorerSwitch'))
                if old_policy != new_policy:
                    # Never carry lower-quality pixels into recovery or reuse a
                    # restorer history belonging to a different model.
                    self.temporal.pop(key, None); self.corrections.pop(key, None)
                    self.face_patches.pop(key, None)
            retained = set(self.assignments.anchors) | set(self.candidates)
            for store in (self.configs, self.temporal, self.last_slot_frame, self.corrections):
                for key in list(store):
                    if key not in retained:
                        store.pop(key, None)
            # A missing person, rejected current-frame policy or a cut must not
            # retain GPU pixels for a later reappearance. At most five patches.
            active_patch_keys = {key for key, _ in pairs}
            self.face_patches = {key: value for key, value in self.face_patches.items()
                                 if key in active_patch_keys}
            if self.gpu_patch_enabled:
                from pong_face_patch import FacePatch
                with engine._lock, engine._torch.cuda.stream(engine._compute_stream):
                    FacePatch.prepare_supports(list(self.face_patches.values()))
            if session.config['runtime'].get('attachmentStabilityEnabled',False) and pairs:
                from pong_attachment import refine_geometry,prepare_flow_predictions
                with engine._lock,engine._torch.cuda.stream(engine._compute_stream):
                    original_tensor=composite if composite is not None else engine._frame_tensor(frame)
                    composite=original_tensor
                    detected=list(detected)
                    prepared_dense=None
                    landmark=getattr(engine._vm,'_attachment_landmarker',None)
                    if os.environ.get('PONG_BATCH_LANDMARK_READBACK','0')=='1' and len(pairs)>1 and landmark is not None and landmark.available():
                        prepared_dense=landmark.points_many(engine._torch,original_tensor,[detected[index][1] for _,index in pairs])
                    if os.environ.get('PONG_BATCH_ATTACHMENT_FLOW','0')=='1':
                        states=[self.finish_contexts.setdefault((person,self.assignments.revision,self.assignments.sources[person]),{}) for person,_ in pairs]
                        prepare_flow_predictions(states,gray,scale,self.rendered_frames)
                    for rank,(person,index) in enumerate(pairs):
                        source_id=self.assignments.sources[person]
                        state=self.finish_contexts.setdefault((person,self.assignments.revision,source_id),{})
                        area,points,embedding=detected[index]
                        extra={'prepared_dense':prepared_dense[rank]} if prepared_dense is not None else {}
                        refined,_=refine_geometry(engine,original_tensor,points,state,self.rendered_frames,gray,scale,**extra)
                        detected[index]=(area,refined,embedding)
                        state['attachmentGeometryPrepared']=True
                    if os.environ.get('PONG_AUDIT_BATCH_PARSER'):
                        mask_rows=[]
                        for person,index in pairs:
                            config=self.configs[person]
                            if config['runtime'].get('maskFaceParserBackendPreference','trt')!='trt':break
                            params=dict(config['parameters'],PongStableAttachment=True,
                                PongApprovedFinish=bool(config['runtime'].get('approvedFaceFinishEnabled',False)))
                            state=self.finish_contexts[(person,self.assignments.revision,self.assignments.sources[person])]
                            mask_rows.append((detected[index][1],params,state))
                        if len(mask_rows)==len(pairs) and (len(mask_rows)==5 or os.environ.get('PONG_PARSER_PARTIAL_BATCH','0')=='1'):
                            engine._vm.prepare_attachment_masks(original_tensor,mask_rows)
            # Exact generation cannot consume a transported correction. Avoid
            # constructing its ROIs and copying float32 RGB differences anyway.
            exact_no_cache = (self.explicit_cadence==1 and os.environ.get('PONG_NO_UNUSED_CORRECTIONS','0')=='1'
                and not self.gpu_patch_enabled)
            # Adapt-only reuse engages only when the restorer ladder is already at its
            # floor (or absent) and the quality level reports sustained pressure.
            adaptive_reuse_active = bool(self.adaptive_reuse and self.quality.level >= 3
                and (self.restorer_ladder is None or self.restorer_ladder.index >= len(self.restorer_ladder.rungs) - 1))
            if adaptive_reuse_active:
                self.adaptive_reuse_frames += 1
            regions = [] if exact_no_cache else self._correction_regions(frame, pairs, detected)
            if not regions:
                self.corrections.clear()
            unsafe = set()
            for i, (key, _, box) in enumerate(regions):
                for other, _, other_box in regions[:i]:
                    if FaceCorrectionCache.overlaps([box, other_box]):
                        unsafe.update((key, other))
            original_for_patches = None
            if unsafe and self.gpu_patch_enabled and session.config['runtime'].get('attachmentStabilityEnabled',False):
                # Bounding crops overlap even when the visible faces do not.
                # Preserve one immutable ORIGINAL GPU frame for semantic evidence
                # so another person's pasted pixels cannot contaminate reuse.
                with engine._lock,engine._torch.cuda.stream(engine._compute_stream):
                    original_for_patches=original_tensor.clone()
            reused = set()
            output = None
            phases = {key: (rank * self.anchor_frames) // max(1, len(pairs))
                      for rank, key in enumerate(sorted(key for key, _ in pairs))}
            for key, points, _ in regions:
                cache = self.corrections.get(key)
                if self.gpu_patch_enabled or cache is None or key in unsafe or self.explicit_cadence == 1:
                    continue
                if (self.responsive_adapt and len(pairs) > 1 and self.quality.level >= 2
                        and cache.age >= max(1, self.reuse_age // 2)
                        and self.rendered_frames % self.anchor_frames == phases[key]):
                    # Refresh different people on different frames. Never delay
                    # a motion/appearance-triggered exact render to meet a phase.
                    self.staggered_refreshes += 1
                    continue
                candidate_output = cache.render(frame, [(key, points)], self.assignments.revision, destination=output,
                    max_age=self.reuse_age)
                if candidate_output is not None:
                    output = candidate_output
                    reused.add(key)
            if reused:
                self.correction_reused_frames += 1
            if len(reused) == len(pairs) and pairs:
                rendered_points = [detected[index][1] for _, index in pairs]
            else:
                render_frame = frame
                offset = np.array([0, 0], dtype=np.float32)
                render_box = None
                if (regions and (self.quality.level >= 2 or self.crowd_pressure)
                        and not session.config['runtime'].get('frameEnhancerEnabled')):
                    left = min(box[0] for _, _, box in regions)
                    top = min(box[1] for _, _, box in regions)
                    right = max(box[2] for _, _, box in regions)
                    bottom = max(box[3] for _, _, box in regions)
                    if right > left and bottom > top:
                        render_box = (left, top, right, bottom)
                        render_frame = frame[top:bottom, left:right]
                        offset = np.array([left, top], dtype=np.float32)
                if output is not None or composite is None:
                    upload = frame if output is None else output
                    if render_box is not None:
                        upload = upload[top:bottom, left:right]
                    with engine._lock, engine._torch.cuda.stream(engine._compute_stream):
                        composite = engine._frame_tensor(upload)
                elif render_box is not None:
                    composite = composite[:, top:bottom, left:right]
                fresh_original=None
                if len(pairs)>1 and os.environ.get('PONG_ORIGINAL_FRESH_INPUTS','0')=='1':
                    with engine._lock,engine._torch.cuda.stream(engine._compute_stream):
                        fresh_original=engine._frame_tensor(render_frame) if output is not None else composite.clone()
                if (self.explicit_cadence==1 and render_box is None and len(pairs)==5
                        and not reused and (os.environ.get('PONG_INDEPENDENT_SWAPPER_MANIFEST') or os.environ.get('PONG_FRESH_GPEN_BATCH'))
                        and session.config['runtime'].get('attachmentStabilityEnabled',False)):
                    rows=[]
                    for key,index in pairs:
                        candidate=self.candidates[self.assignments.sources[key]]
                        config=self.configs[key]
                        parameters=dict(config['parameters'],PongStableAttachment=True,
                            PongApprovedFinish=bool(config['runtime'].get('approvedFaceFinishEnabled',False)))
                        state=self.finish_contexts.setdefault((key,self.assignments.revision,candidate.face_id),{})
                        rows.append((detected[index][1],candidate.embedding,parameters,state,candidate.face_id))
                    with engine._lock,engine._torch.cuda.stream(engine._compute_stream):
                        engine._vm.prepare_independent_swaps(composite if fresh_original is None else fresh_original,rows,self.rendered_frames)
                rendered_points = []
                for key, index in pairs:
                    if key in reused:
                        rendered_points.append(detected[index][1])
                        continue
                    if session.stop.is_set():
                        return None, 0
                    if (self.gpu_patch_enabled and key in self.face_patches
                            and self.rendered_frames-getattr(self.face_patches[key],'anchor_frame',self.rendered_frames)>self.reuse_age):
                        self.face_patches.pop(key,None)
                    if (self.gpu_patch_enabled and key in self.face_patches and (key not in unsafe or original_for_patches is not None)
                            and (not self.adaptive_reuse or adaptive_reuse_active)):
                        with engine._lock, engine._torch.cuda.stream(engine._compute_stream):
                            dense=self.finish_contexts.get((key,self.assignments.revision,self.assignments.sources[key]),{}).get('attachmentDensePoints')
                            extra={'dense_points':dense} if session.config['runtime'].get('attachmentStabilityEnabled',False) else {}
                            if original_for_patches is not None:extra['original_tensor']=original_for_patches
                            accepted = self.face_patches[key].render(frame, detected[index][1], self.assignments.revision, self.reuse_age, composite, offset, **extra)
                        if not accepted:
                            reason = self.face_patches[key].last_reject_reason
                            self.patch_rejections[reason] = self.patch_rejections.get(reason, 0) + 1
                        if accepted:
                            self.gpu_patch_reused += 1
                            rendered_points.append(detected[index][1])
                            continue
                    candidate = self.candidates[self.assignments.sources[key]]
                    # Supply only this already verified ORIGINAL detection. No face
                    # recognizer ever sees a preceding person's replacement pixels.
                    area, points, embedding = detected[index]
                    evidence = self.evidence_type(detection_attempted=True,
                        detections=((area, points - offset, embedding),), recognition_complete=True)
                    evidence.frame_index=self.rendered_frames
                    evidence.target_policy_frame = render_frame
                    evidence.target_policy_points = (points - offset).copy()
                    evidence.target_policy_presentation = self.current_presentations.get(index)
                    config = self.configs[key]
                    context = None
                    if (self.explicit_cadence is None or self.responsive_adapt) and (self.quality.level >= 2 or self.crowd_pressure):
                        context = self.temporal.get(key)
                        signature = (self.anchor_frames, self.assignments.revision,
                            config['runtime'].get('crowdRestorerModel'), self.crowd_pressure)
                        if (context is None or context.get('threeXSignature') != signature
                                or self.last_slot_frame.get(key, -2) != self.rendered_frames - 1):
                            # Only reuse the existing restorer/mask results. Do not
                            # inherit unrelated experimental stabilizers: 3x did
                            # not previously enable those processing passes.
                            context = {'enabled': True, 'threeXSignature': signature,
                                'maxAnchorFrames': self.anchor_frames, 'maxInputMae': 8., 'maxInputPatchMae': 16.,
                                'maxMaskInputMae': 8., 'maxMaskPatchMae': 16.,
                                'maskLocalChangeGuardEnabled': True, 'maxMaskLocalPatchMae': 16.,
                                'dflXSegReuseEnabled': True, 'occluderDecoupledFromRestorer': True,
                                'parserDecoupledFromRestorer': True}
                            self.temporal[key] = context
                        context.update(frameIndex=self.rendered_frames,
                            mediaTimeSeconds=self.rendered_frames / max(1., float(getattr(session, 'fps', 30) or 30)),
                            forceExact=False, forceExactReasons=[])
                        self.last_slot_frame[key] = self.rendered_frames
                    if self.gpu_patch_enabled:
                        self.patch_capture.begin()
                    if session.config['runtime'].get('attachmentStabilityEnabled',False):
                        self.finish_contexts.setdefault((key,self.assignments.revision,candidate.face_id),{})['attachmentDenseOffset']=offset
                    try:
                        swapped, _ = engine.process_frame(render_frame, candidate.embedding, None,
                            source_face_id=candidate.face_id,
                            source_frame=candidate.source_frame, verify_identity=True,
                            config=self.configs[key], cancel_event=session.stop,
                            frame_evidence=evidence, frame_tensor=composite, synchronize_output=False, output_chw=True,
                            original_input_tensor=fresh_original,
                            diagnostics=stage_diagnostics, temporal_context=context,
                            finish_context=self.finish_contexts.setdefault((key,self.assignments.revision,candidate.face_id),{}))
                    finally:
                        packet = self.patch_capture.end() if self.gpu_patch_enabled else None
                        self.finish_contexts.get((key,self.assignments.revision,candidate.face_id),{}).pop('freshIndependentSwap',None)
                    if swapped is None:
                        return None, 0
                    if self.gpu_patch_enabled and getattr(evidence, 'swap_applied', False):
                        from pong_face_patch import FacePatch
                        capture_params = dict(engine._vm.parameters, _captureShape=render_frame.shape)
                        self.face_patches[key] = FacePatch(engine._vm, packet, frame, points, capture_params, self.assignments.revision, offset)
                        self.face_patches[key].anchor_frame=self.rendered_frames
                    elif self.gpu_patch_enabled:
                        self.face_patches.pop(key, None)
                    composite = swapped
                    if getattr(evidence, "swap_applied", False):
                        rendered_points.append(detected[index][1])
                deferred = self._deferred_readback_enabled() and getattr(session, 'deferred_readback', True)
                if deferred:
                    # Host composition of a cropped canvas happens in the writer thread.
                    output = self._enhance(composite, rendered_points, deferred=True, box=render_box,
                                           base_frame=(frame if output is None else output) if render_box is not None else None)
                else:
                    rendered_patch = self._enhance(composite, rendered_points)
                    if render_box is None:
                        output = rendered_patch
                    else:
                        left, top, right, bottom = render_box
                        output = frame.copy() if output is None else output
                        output[top:bottom, left:right] = rendered_patch
                if (len(rendered_points) == len(pairs) and not self.gpu_patch_enabled and not exact_no_cache
                        and isinstance(output, np.ndarray)):
                    for key, points, box in regions:
                        if key not in reused and key not in unsafe:
                            cache = FaceCorrectionCache()
                            cache.remember(frame, output, [(key, points, box)], self.assignments.revision)
                            self.corrections[key] = cache
                else:
                    self.corrections.clear()
            active_keys = {key for key, _ in pairs} - unsafe
            self.corrections = {key: cache for key, cache in self.corrections.items() if key in active_keys}
            elapsed = time.perf_counter() - started
            self.render_seconds_ema = (elapsed if not self.render_seconds_ema else
                .15 * elapsed + .85 * self.render_seconds_ema)
            self.rendered_frames += 1
            if stage_diagnostics is not None:
                self.stage_timings = {name: round(sum(values), 2)
                    for name, values in stage_diagnostics.items()
                    if name.endswith('Ms') and isinstance(values, list)}
                self.stage_timings['originalDetectionMs'] = round(detection_seconds * 1000, 2)
            rendered_level = self.quality.level
            rendered_model = self.restorer_ladder.model if self.restorer_ladder is not None else None
            if self.quality_adaptation_enabled:
                self.playback_buffer_seconds = self._playback_buffer()
                self.quality.observe(elapsed, getattr(session, 'fps', 30), len(pairs), self.playback_buffer_seconds)
                if self.restorer_ladder is not None:
                    reused_now = (self.gpu_patch_reused - reused_faces_before) + len(reused)
                    self.restorer_ladder.observe(elapsed, getattr(session, 'fps', 30), len(pairs),
                        self.playback_buffer_seconds, fresh_faces=max(0, len(rendered_points) - reused_now))
            if self.rendered_frames >= 48 and pairs:
                hints = getattr(engine, '_three_x_quality_hints', None)
                if hints is None:
                    hints = engine._three_x_quality_hints = OrderedDict()
                hints[self.quality_hint_key] = self.quality.level
                if self.restorer_ladder is not None:
                    hints[self.quality_hint_key + ('restorer-ladder',)] = self.restorer_ladder.model
                while len(hints) > 64:
                    hints.popitem(last=False)
            count_key = f'{self.eligibility_counts.get("detectedCount", 0)}/{len(detected)}/{len(pairs)}/{len(rendered_points)}'
            self.frame_counts[count_key] = self.frame_counts.get(count_key, 0) + 1
            session.multi_face_decision = {'policy': 'three-x-unique-sources-v3',
                'sourceReuseEnabled': False,
                'uniqueSourcesPerVideo': True,
                'reservedSourceCount': len(self.assignments.source_owners),
                'identityContinuityHolds': self.assignments.continuity_holds,
                'identityDetectorRecoveries': getattr(self, 'identity_detector_recoveries', 0),
                'qualifiedPolicyContinuity': getattr(self, 'qualified_policy_continuity', 0),
                'visibleSourceCount': len({self.assignments.sources[key] for key, _ in pairs}),
                'assignedCount': len(self.assignments.anchors), 'visibleCount': len(pairs), 'renderedCount': len(rendered_points),
                'selectedCount': len(self.candidates), 'revision': self.assignments.revision,
                'identityMatchedCount': identity_matched_count,
                'targetPolicyRejectedCount': target_policy_rejected,
                'maxRenderedFaces': MAX_THREE_X_RENDERED,
                'renderLimitExcludedCount': limited_count,
                'targetPolicyMs': round(self.target_policy_seconds * 1000, 2),
                'appearancePolicy': 'hair-first-nearest-skin-second-v3',
                'appearanceMatches': [dict(self.assignments.appearance.get(key, {}),
                    personKey=key, faceId=self.assignments.sources[key]) for key, _ in pairs],
                'hairMeasurements': self.hair_measurements,
                **getattr(self, 'eligibility_counts', {}),
                'renderMs': round(self.render_seconds_ema * 1000, 2),
                'loadAdaptive256': any(self.configs[key]['runtime'].get('crowdRestorerModel') == 'GPEN256'
                    or self.configs[key]['runtime'].get('threeXForce256', False) for key, _ in pairs),
                'gpenMode': ','.join(sorted({str(self.configs[key]['runtime'].get('crowdRestorerModel')
                    or self.configs[key]['runtime'].get('tiktokRestorerState', {}).get('model')
                    or self.configs[key]['parameters'].get('RestorerTypeTextSel'))
                    if self.configs[key]['parameters'].get('RestorerSwitch') else 'disabled' for key, _ in pairs})),
                'crowdQualityActive': self.crowd_pressure,
                'restorerLadder': self.restorer_ladder.snapshot() if self.restorer_ladder is not None else None,
                'renderedRestorer': rendered_model,
                'adaptiveController': ('cadence-first-stable-quality-v6+restorer-ladder-v1' if self.restorer_ladder is not None
                    else 'cadence-first-stable-quality-v6') if self.responsive_adapt else 'legacy',
                'adaptiveEmergencyActive': self.responsive_adapt and rendered_level >= 7,
                'adaptiveRestorationBypassed': False,
                'adaptiveReason': self.quality.reason,
                'playbackBufferSeconds': (round(self.playback_buffer_seconds, 3)
                    if self.playback_buffer_seconds is not None else None),
                'staggeredRefreshes': self.staggered_refreshes,
                'gpuPatchReusedFaces': self.gpu_patch_reused,
                'gpuPatchEnabled': bool(self.gpu_patch_enabled),
                'adaptiveReuseEligible': bool(self.adaptive_reuse),
                'adaptiveReuseActive': adaptive_reuse_active,
                'adaptiveReuseFrames': self.adaptive_reuse_frames,
                'gpuPatchRejections': dict(self.patch_rejections),
                'batchPolicyError': getattr(self,'batch_policy_error',None),
                'batchPolicyValidated': getattr(getattr(self,'batch_policy',None),'validated',0),
                'gpuPatchValidFaces': sum(p.valid for p in self.face_patches.values()),
                'attachmentMaskCacheHits':sum(c.get('attachmentVisibilityCacheHits',0) for c in self.finish_contexts.values()),
                'attachmentMaskCacheMisses':sum(c.get('attachmentVisibilityCacheMisses',0) for c in self.finish_contexts.values()),
                'adaptiveBudgetMs': round(850 / max(1., float(getattr(session, 'fps', 30))), 2),
                'restorerAnchorFrames': self.anchor_frames,
                'correctionReuseMaxFrames': self.reuse_age,
                'adaptiveQualityLevel': rendered_level,
                'frameCountStages': dict(self.frame_counts),
                'sampledStageMs': dict(self.stage_timings),
                'trackedFrames': self.tracked_frames,
                'trackingRejections':dict(self.tracker.rejection_counts),
                'trackingIdentityRechecks':getattr(self.tracker,'identity_rechecked',0),
                'correctionReusedFrames': self.correction_reused_frames,
                'colorEagerMisses': int(getattr(getattr(engine, '_vm', None), 'color_match_eager_misses', 0)),
                'temporalReuse': {str(i): {k: v for k, v in self.temporal.get(key, {}).items()
                    if k.endswith('Frames') and isinstance(v, (int, float))}
                    for i, key in enumerate(key for key, _ in pairs)},
                'swapperQuality': str(next(iter(self.configs.values()))['parameters'].get('SwapperTypeTextSel', '128'))}
            session.compatibility_status = 'locked' if pairs else 'waiting-for-people'
            return output, len(rendered_points)

    def _restorer_ready(self, model):
        """A ladder rung is selectable only while its GPEN plan is resident and warmed."""
        models = getattr(self.engine, '_models', None)
        runtime = getattr(models, '_gpen_runtime', None)
        if runtime is None:
            return True  # synthetic engines in tests have no native runtime
        from pong_restorer_profiles import physical_restorer
        try:
            edge = int(physical_restorer(model)[4:])
            state = getattr(runtime, '_states', {}).get(edge) or {}
            return bool(state.get('ready'))
        except Exception:
            return False

    def _playback_buffer(self):
        session = self.session
        if (not self.responsive_adapt or getattr(session, 'prefetch', True)
                or not getattr(session, 'playback_started_at', 0)
                or getattr(session, 'playback_paused', True)
                or not getattr(session, 'playback_position_updated_at', 0)
                or session.stop.is_set()
                or (getattr(session, 'scrub_suspended', None) is not None and session.scrub_suspended.is_set())):
            return None
        now = time.monotonic()
        if now - session.playback_position_updated_at > 2.5:
            return None  # A hidden/disconnected player must not request catch-up.
        value = self.engine._playback_headroom_seconds(session, now)
        return max(0., float(value)) if np.isfinite(value) else None

    def _cap_pairs(self, pairs, detected):
        # Keep already-visible people stable; fill free places with the largest
        # eligible faces. A sixth person's size change cannot steal a live slot.
        ranked = sorted(pairs, key=lambda pair: (
            pair[0] not in self.active_person_keys, -float(detected[pair[1]][0]), pair[0]))
        selected = {key for key, _ in ranked[:MAX_THREE_X_RENDERED]}
        self.active_person_keys = selected
        return [(key, index) for key, index in pairs if key in selected]

    def _correction_regions(self, frame, pairs, detected):
        if ((self.explicit_cadence not in (3, 4) and self.quality.level < 2 and not self.crowd_pressure) or self.session.config['runtime'].get('frameEnhancerEnabled')):
            return []
        vm = getattr(self.engine, '_vm', None)
        if vm is None:
            return []
        from pong_head_pose import pseudo_points
        rows=[]
        for key,index in pairs:
            points = detected[index][1]
            parameters=dict(self.configs[key]['parameters'])
            stable=bool(self.configs[key].get('runtime',{}).get('attachmentStabilityEnabled',False))
            parameters['PongStableAttachment']=stable
            pose_points = pseudo_points(points)[0] if os.environ.get("PONG_HEAD_POSE", "1") != "0" and not stable else points
            parameters['PongApprovedFinish']=bool(self.configs[key].get('runtime',{}).get('approvedFaceFinishEnabled',False))
            transform,size=vm.canonical_face_transform_matrix(pose_points,parameters)
            inverse=np.linalg.inv(transform)
            corners=np.array([[0,0],[size,0],[0,size],[size,size]],np.float32)
            mapped=cv2.transform(corners.reshape(1,-1,2),inverse[:2])[0]
            lo=np.floor(mapped.min(axis=0)).astype(int)-2
            hi=np.ceil(mapped.max(axis=0)).astype(int)+2
            box=(max(0,int(lo[0])),max(0,int(lo[1])),min(frame.shape[1],int(hi[0])),min(frame.shape[0],int(hi[1])))
            rows.append((key,points,box))
        return rows

    def _presentation_at(self, frame, points):
        if not isinstance(frame, np.ndarray):
            return self.engine._presentation_classifier.classify(frame, points)
        # Share only an observation of this exact ORIGINAL frame and geometry.
        # Never carry a prior frame's target eligibility into render/reuse.
        if getattr(self, '_policy_frame', None) is not frame:
            self._policy_frame = frame
            self._frame_presentations = {}
        cache = getattr(self, '_frame_presentations', {})
        self._frame_presentations = cache
        key = np.asarray(points, dtype=np.float32).tobytes()
        if key not in cache:
            classifier = self.engine._presentation_classifier
            cache[key] = getattr(classifier, 'classify_policy', classifier.classify)(frame, points)
        return cache[key]

    def _recover_known_people(self, tensor, rows):
        """Retry only ambiguous reacquisition with an independent detector."""
        if not rows or not self.assignments.anchors:return rows
        floor=target_identity_lock_threshold(self.session.config['parameters'].get('DetectScoreSlider',45))
        references=list(self.assignments.anchors.values())+[v for refs in self.assignments.pose_references.values() for v in refs]
        reference_matrix=np.stack([np.asarray(r,np.float32).reshape(-1) for r in references]) if references else None
        def score(row):
            if not valid_embedding(row[2]) or reference_matrix is None:return 0
            best=float(np.max(rope_similarity_many(reference_matrix,row[2])))
            return best if np.isfinite(best) else 0
        weak=[i for i,row in enumerate(rows) if score(row)<floor]
        if not weak:return rows
        config=deepcopy(self.session.config)
        config['parameters']['DetectTypeTextSel']='SCRDF' if config['parameters'].get('DetectTypeTextSel')=='Retinaface' else 'Retinaface'
        config['parameters']['DetectInputSizeTextSel']=640
        alternative=self.engine._detect(tensor,recognize=True,config=config,max_faces=MAX_THREE_X_FACES,
            detector_score=self.engine._target_detection_score())
        result=list(rows);used=set()
        for i in weak:
            span=max(1.,float(np.linalg.norm(rows[i][1][1]-rows[i][1][0])))
            matches=[(score(row),j,row) for j,row in enumerate(alternative) if j not in used
                and float(np.median(np.linalg.norm(np.asarray(row[1])-rows[i][1],axis=1)))/span < .65 and score(row)>=floor+5]
            if matches:
                _,j,result[i]=max(matches,key=lambda x:x[0]);used.add(j)
                self.identity_detector_recoveries=getattr(self,'identity_detector_recoveries',0)+1
        return result

    def _eligible_people(self, frame, detected):
        """Cache classification by recognized person, never screen position."""
        now = time.monotonic()
        self._policy_frame = frame
        self._frame_presentations = {}
        self.presentation_cache = [entry for entry in self.presentation_cache if now - entry[0] < 2.0]
        if os.environ.get('PONG_BATCH_ELIGIBILITY','0')=='1' and len(detected)>1:
            batch=getattr(self,'batch_policy',None)
            if batch is not None and (not self.presentation_cache or any(not entry[2] for entry in self.presentation_cache)):
                try:
                    for start in range(0,len(detected),5):
                        group=detected[start:start+5]
                        values=batch.classify(frame,[row[1] for row in group])
                        if values is not None:
                            self._frame_presentations.update((np.asarray(row[1],np.float32).tobytes(),value) for row,value in zip(group,values))
                except Exception as exc:self.batch_policy_error=str(exc)
        eligible = []
        self.eligibility_counts = {'detectedCount': len(detected), 'eligibleCount': 0, 'maleFilteredCount': 0, 'uncertainFilteredCount': 0, 'classificationErrorCount': 0}
        cache_matrix = None  # built lazily once per frame; invalidated when the cache grows
        for row in detected:
            if row[2] is None or not valid_embedding(row[2]):
                continue
            if cache_matrix is None and self.presentation_cache:
                cache_matrix = np.stack([np.asarray(entry[1], np.float32).reshape(-1) for entry in self.presentation_cache])
            cache_scores = rope_similarity_many(cache_matrix, row[2]) if cache_matrix is not None else np.zeros(0)
            ranked = sorted([(float(cache_scores[n]), n) for n in range(len(self.presentation_cache))], reverse=True)
            if (ranked and ranked[0][0] >= target_identity_lock_threshold(100)
                    and (len(ranked) == 1 or ranked[0][0] - ranked[1][0] >= 5)
                    and (os.environ.get('PONG_RETRY_UNCERTAIN_POLICY','0')!='1' or self.presentation_cache[ranked[0][1]][2])):
                admitted, reason = self.presentation_cache[ranked[0][1]][2:]
            else:
                try:
                    presentation = self._presentation_at(frame, row[1])
                    admitted = any(approved_source_allows_target(source_id, presentation)
                                   for source_id in getattr(self, 'candidates', {'': None}))
                    reason = 'eligibleCount' if admitted else ('maleFilteredCount' if presentation.label == 'male' else 'uncertainFilteredCount')
                except Exception:
                    admitted = False
                    reason = 'classificationErrorCount'
                self.presentation_cache.append((now, np.asarray(row[2]).copy(), admitted, reason))
                self.presentation_cache = self.presentation_cache[-MAX_THREE_X_FACES:]
                cache_matrix = None
            if not admitted and os.environ.get('PONG_ELIGIBILITY_CONTINUITY','0')=='1':
                # The later strict pair gate already permits this exact raw
                # identity proof. Do not filter that known person out before
                # they can reach it. This is not a geometry/presentation cache.
                references=getattr(self.assignments,'policy_references',{})
                scores=[]
                for key,views in references.items():
                    for vector,prior in views:
                        if any(approved_source_allows_target(source,prior) for source in self.candidates):
                            scores.append((raw_identity_cosine(vector,row[2]),key))
                if scores:
                    score,key=max(scores)
                    rival=max((v for v,k in scores if k!=key),default=-1.)
                    if score>=.85 and score-rival>=.05:
                        admitted=True;reason='eligibleCount'
                        self.eligibility_continuity=getattr(self,'eligibility_continuity',0)+1
            self.eligibility_counts[reason] += 1
            if admitted:
                eligible.append(row)
        return eligible

    def _measure_hair(self, frame, rows):
        now = time.monotonic()
        # Unknown or incompatible people may remain unassigned. Cache by
        # recognized original identity, never by screen position/detector index.
        self.hair_cache = [entry for entry in self.hair_cache if now - entry[0] < 2.0]
        measured = []
        for index, row in rows:
            matches = sorted([(rope_similarity(entry[1], row[2]), n)
                              for n, entry in enumerate(self.hair_cache)], reverse=True)
            if (matches and matches[0][0] >= target_identity_lock_threshold(100)
                    and (len(matches) == 1 or matches[0][0] - matches[1][0] >= 5)):
                color, confidence = self.hair_cache[matches[0][1]][2:]
            else:
                try:
                    color, confidence = self.engine._hair_for_multi_target(frame, row[1])
                except Exception:
                    color, confidence = 'unknown', 0.0
                self.hair_measurements += 1
                self.hair_cache.append((now, np.asarray(row[2]).copy(), color, confidence))
                self.hair_cache = self.hair_cache[-MAX_THREE_X_FACES:]
            measured.append((color, confidence))
        return measured

    def _strict_pairs(self, frame, pairs, detected):
        # Hair/skin rank the initial source choice; they must not erase a locked
        # person's swap as lighting changes. The hard target restriction applies
        # afresh before both rendering AND correction-cache reuse.
        started = time.perf_counter()
        allowed = []
        self.current_presentations = {}
        proven=set()
        if os.environ.get('PONG_PROVEN_POLICY_FIRST','0')=='1' and getattr(self,'rendered_frames',0)%30:
            # The existing fallback already authorizes this identity proof.
            # Evaluate it first to avoid an unused neural classification.
            # Keep periodic fresh observations and never grow the reference
            # gallery from a cached presentation.
            cache=getattr(self,'_frame_presentations',{})
            state=getattr(self,'assignments',None)
            references=getattr(state,'policy_references',{})
            for key,index in pairs:
                geometry=np.asarray(detected[index][1],np.float32).tobytes()
                if geometry in cache:continue
                source_id=getattr(state,'sources',{}).get(key,key);observed=detected[index][2]
                eligible=[(raw_identity_cosine(ref,observed),prior) for ref,prior in references.get(key,()) if approved_source_allows_target(source_id,prior)]
                rival=max((raw_identity_cosine(ref,observed) for other,refs in references.items() if other!=key for ref,_ in refs),default=-1)
                if eligible:
                    match,prior=max(eligible,key=lambda row:row[0])
                    if match>=.85 and match-rival>=.05:
                        cache[geometry]=prior;proven.add(key)
            self._frame_presentations=cache
            self.proven_policy_skips=getattr(self,'proven_policy_skips',0)+len(proven)
        batch = getattr(self, 'batch_policy', None)
        if batch is not None:
            cache = getattr(self, '_frame_presentations', {})
            missing = [(index, np.asarray(detected[index][1],np.float32).tobytes()) for _,index in pairs
                       if np.asarray(detected[index][1],np.float32).tobytes() not in cache]
            if len(missing)>1:
                try:
                    values=batch.classify(frame,[detected[index][1] for index,_ in missing])
                    if values is not None:
                        cache.update((geometry,value) for (_,geometry),value in zip(missing,values))
                        self._frame_presentations=cache
                except Exception as exc:
                    self.batch_policy_error=str(exc)
                    # Individual current-frame classification remains authoritative.
        for key, index in pairs:
            try:
                presentation = self._presentation_at(frame, detected[index][1])
                source_id = getattr(getattr(self, 'assignments', None), 'sources', {}).get(key, key)
                state=getattr(self,'assignments',None)
                references=getattr(state,'policy_references',{})
                # A current original embedding must match a qualified reference
                # at raw cosine .85. Display scores saturate and are unsuitable.
                # This handles expression-induced classifier flips without
                # relaxing eligibility for an unknown/new person.
                if not approved_source_allows_target(source_id,presentation):
                    observed=detected[index][2]
                    eligible=[(raw_identity_cosine(ref,observed),prior) for ref,prior in references.get(key,())
                              if approved_source_allows_target(source_id,prior)]
                    rival=max((raw_identity_cosine(ref,observed) for other,refs in references.items() if other!=key for ref,_ in refs),default=-1)
                    if eligible:
                        match,prior=max(eligible,key=lambda x:x[0])
                        if match>=.85 and match-rival>=.05:
                            presentation=prior
                            self.qualified_policy_continuity=getattr(self,'qualified_policy_continuity',0)+1
                elif key not in proven and state is not None and key in getattr(state,'anchors',{}) and raw_identity_cosine(state.anchors[key],detected[index][2])>=.65:
                    refs=references.setdefault(key,[])
                    if not refs or max(raw_identity_cosine(ref,detected[index][2]) for ref,_ in refs)<.98:
                        refs.append((np.asarray(detected[index][2]).copy(),presentation));del refs[:-16]
                if approved_source_allows_target(source_id, presentation):
                    allowed.append((key, index))
                    self.current_presentations[index] = presentation
            except Exception:
                pass
        self.target_policy_seconds = time.perf_counter() - started
        return allowed

    def _assign_hair(self, frame, free, rows, *, reuse_sources=False, unique_sources=False):
        """Rank selected sources for each new person; optionally allow reuse."""
        from pong_hair_policy import required_hair, hair_admits
        from pong_skin_policy import skin_rule
        if not free or not rows:
            return []
        # Eligibility admits males whenever Ari is selected, including after
        # Ari is reserved. Remaining female-only sources still need pair gates.
        male_exception = any(approved_source_target_label(key) == 'male'
                             for key in getattr(self, 'candidates', free))
        target_presentations = []
        if male_exception:
            # A male admitted for Ari cannot consume another source's slot,
            # nor can Ari claim a female slot before the final render gate.
            for _, row in rows:
                try:
                    target_presentations.append(self._presentation_at(frame, row[1]))
                except Exception:
                    target_presentations.append(None)
        if not male_exception and reuse_sources and len(free) == 1 and not required_hair(free[0]):
            chosen = [max(rows, key=lambda item: float(item[1][0]))] if unique_sources else rows
            return [(free[0], index) for index, _ in chosen]
        if not male_exception and not reuse_sources and not any(required_hair(key) or skin_rule(key) for key in free):
            return [(key, index) for key, (index, _) in zip(free, rows)]
        from scipy.optimize import linear_sum_assignment
        measured = self._measure_hair(frame, rows)
        from pong_appearance_rank import assignment_score, appearance_cost
        # Only approved hair pairs beat dummy slots. Global assignment maximizes
        # hair agreement before skin and resemblance while keeping sources unique.
        scores = np.full((len(free), len(rows) + len(free)), -1e6)
        scores[:, len(rows):] = 0
        for source, key in enumerate(free):
            for target, (color, confidence) in enumerate(measured):
                # Reservations never authorize a source outside its approved hair rule.
                if not hair_admits(key, color, confidence):
                    continue
                if male_exception and (target_presentations[target] is None or
                        not approved_source_allows_target(key, target_presentations[target])):
                    continue
                candidate = getattr(self, 'candidates', {}).get(key)
                resemblance = rope_similarity(candidate.embedding, rows[target][1][2]) if candidate is not None else 0
                scores[source, target] = assignment_score(key, color, resemblance)
                scores[source, target] -= .000001 * abs(source - target)
        def record(choices):
            by_index = {row[0]: measured[i] for i, row in enumerate(rows)}
            self.pending_appearance = {}
            for face_id, index in choices:
                color, confidence = by_index[index]
                evidence = getattr(color, 'evidence', {}) or {}
                hair_rank, skin_rank = appearance_cost(face_id, color)
                self.pending_appearance[index] = dict(faceId=face_id,
                    targetHair=str(color), targetSkinTone=getattr(color, 'skin_tone', 'unknown'),
                    hairRank=hair_rank, skinRank=skin_rank,
                    hairEvidence=evidence.get('hair_evidence'), skinEvidence=evidence.get('skin_evidence'),
                    method=evidence.get('method'), appearanceMs=evidence.get('acquisition_ipc_ms'),
                    evidenceOrigin='original-source-acquisition', evidenceFrame=getattr(self, 'rendered_frames', None))
            return choices
        if reuse_sources and not unique_sources:
            return record([(free[int(np.argmax(scores[:, target]))], rows[target][0]) for target in range(len(rows))
                    if float(scores[:, target].max()) > 0])
        source_rows, target_columns = linear_sum_assignment(-scores)
        return record([(free[source], rows[target][0]) for source, target in zip(source_rows, target_columns)
                if target < len(rows) and scores[source, target] > 0])

    def _enhance(self, tensor, points, deferred=False, box=None, base_frame=None):
        engine, config = self.engine, self.session.config
        runtime = config['runtime']
        with engine._lock:
            with engine._torch.cuda.stream(engine._compute_stream):
                scope = runtime.get('frameEnhancerScope', 'full') if runtime.get('frameEnhancerEnabled') else 'disabled'
                if scope in ('face', 'realtime'):
                    local = deepcopy(config)
                    local['runtime']['frameEnhancerDownscale'] = True
                    for kps in points:
                        tensor = engine._enhance_frame(tensor, kps, local)
                    if scope == 'face' and not runtime.get('frameEnhancerDownscale'):
                        tensor = engine._torch.nn.functional.interpolate(
                            tensor.float().unsqueeze(0), scale_factor=2,
                            mode='bilinear', align_corners=False)[0].clamp(0, 255)
                elif scope != 'disabled':
                    tensor = engine._enhance_frame(tensor, None, config)
                result = tensor.permute(1, 2, 0).to(engine._torch.uint8).contiguous()
                if deferred:
                    # Same pixels, no host fence here: the ordered writer awaits the
                    # recorded event and performs the encoder write off this thread.
                    from pong_deferred_readback import begin_readback
                    return begin_readback(engine._torch, engine._compute_stream, result, self.readback_ring,
                                          box=box, base_frame=base_frame)
            engine._compute_stream.synchronize()
            return result.cpu().numpy()

    def _deferred_readback_enabled(self):
        if os.environ.get('PONG_DEFERRED_READBACK', '1') != '1':
            return False
        ring = getattr(self, 'readback_ring', None)
        if ring is None:
            torch = getattr(self.engine, '_torch', None)
            if torch is None or not hasattr(torch, 'cuda') or not hasattr(torch, 'empty'):
                return False
            try:
                from pong_deferred_readback import PinnedRing
                self.readback_ring = ring = PinnedRing(torch, slots=int(os.environ.get('PONG_DEFERRED_READBACK_SLOTS', '3')))
            except Exception:
                self.readback_ring = None
                return False
        return ring is not None
