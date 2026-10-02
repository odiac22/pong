from __future__ import annotations

import concurrent.futures
import hashlib
import heapq
import json
import math
import os
import queue
import re
import statistics
import struct
import subprocess
import sys
import threading
import time
import uuid
import weakref
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Sequence
from urllib.parse import urlparse

import cv2
import numpy as np

from pong_swap_config import (
    CACHE_DIR,
    FACES_DIR,
    MODELS_DIR,
    ROPE_ROOT,
    default_config,
    load_config,
    normalize_production_model_choices,
    validate_restorer_backend_preference,
)
from pong_swap_mp4 import MovieDurationInitializer
from pong_face_restoration import apply_face_restoration
from pong_tiktok_restorer import session_config_for_profile, restorer_models, select_restorer
from pong_detection_learning import DetectionCalibration
from pong_match_feedback import MATCH_FEEDBACK
from pong_swap_lookahead import TrackingLookahead
from pong_swap_source_quality import highest_quality_video_stream
from pong_swap_source_pool import StandbySourcePool
from pong_swap_buffer_policy import render_ahead_ceiling_seconds
from pong_multi_face import (MAX_MULTI_FACES, MultiFaceConsensus, MultiVideoSources,
                            choose_multi_face, acquisition_probe_step, multi_video_key)
from pong_swap_identity import (
    CandidateIdentity,
    FacePresentation,
    FairFacePresentationClassifier,
    IdentitySelection,
    TargetIdentity,
    choose_compatible_identity,
    compatible_identity_rankings,
    face_switch_policy,
    identity_similarity_upper_bound,
    normalize_face_ids,
    presentation_confidence_for_strictness,
    rope_similarity,
    target_identity_continuity_threshold,
    target_identity_lock_threshold,
    approved_source_allows_target,
)


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
# The visible Face Match control is intentionally independent from detector
# confidence.  Keep the proven production detector threshold stable so moving
# a source-identity slider cannot rebuild embeddings or alter face discovery.
INTERNAL_FACE_DETECT_SCORE = 0.45


def _start_seek_preview(session, rgb: np.ndarray, transformed: bool) -> bool:
    """Encode one owned first-frame copy off the continuous-video producer.

    The WebP parameters and pixels are unchanged. Cancellation suppresses late
    publication; no GPU work, unbounded frame queue or producer join is added.
    """
    with session.condition:
        if session.stop.is_set() or session.first_rendered_frame_webp or session.first_rendered_frame_pending:
            return False
        owned_rgb = np.array(rgb, copy=True, order="C")
        session.first_rendered_frame_pending = True

    def encode():
        try:
            if session.stop.is_set():
                return
            ok, encoded = cv2.imencode(
                ".webp", cv2.cvtColor(owned_rgb, cv2.COLOR_RGB2BGR),
                [cv2.IMWRITE_WEBP_QUALITY, 100],
            )
            with session.condition:
                if ok and not session.stop.is_set() and not session.first_rendered_frame_webp:
                    session.first_rendered_frame_webp = encoded.tobytes()
                    session.first_rendered_frame_ready_at = time.time()
                    session.first_rendered_frame_transformed = bool(transformed)
        except Exception:
            # A preview failure cannot fail the authoritative video stream.
            pass
        finally:
            with session.condition:
                session.first_rendered_frame_pending = False
                session.condition.notify_all()
    try:
        threading.Thread(target=encode, name=f"PongSeekPreview-{session.channel}", daemon=True).start()
        return True
    except Exception:
        with session.condition:
            session.first_rendered_frame_pending = False
            session.condition.notify_all()
        return False


def normalize_swap_channel(value: str, client_epoch: str = "") -> str:
    """Return a bounded channel while preserving a per-device Pong scope.

    Older installed pages send only ``pong1``/``pong2``. Deriving a scope from
    their client epoch isolates them immediately, before those pages refresh
    onto the newer persistent WebView installation scope.
    """
    channel = str(value or "").strip().lower()
    if channel == "test":
        return channel
    if channel in {"pong1", "pong2"}:
        epoch = str(client_epoch or "").strip()
        if epoch:
            scope = hashlib.sha256(epoch.encode("utf-8")).hexdigest()[:20]
            return f"{channel}-{scope}"
        return channel
    if re.fullmatch(r"(?:pong1|pong2)-[a-z0-9]{12,32}", channel):
        return channel
    return "pong1"


class MaskMotionPreflight:
    """Shared deterministic motion classifier for mask-backend admission."""

    def __init__(self, *, frame_count: int = 5, flow_p90_threshold: float = 0.80):
        self.frame_count = max(2, int(frame_count))
        self.flow_p90_threshold = max(0.0, float(flow_p90_threshold))
        self._previous: np.ndarray | None = None
        self._flow_p90: list[float] = []
        self.seen = 0

    @property
    def complete(self) -> bool:
        return self.seen >= self.frame_count

    def add(self, frame: np.ndarray, *, rgb: bool) -> bool:
        if self.complete:
            return True
        resized = cv2.resize(
            np.asarray(frame),
            (160, 90),
            interpolation=cv2.INTER_AREA,
        )
        gray = cv2.cvtColor(
            resized,
            cv2.COLOR_RGB2GRAY if rgb else cv2.COLOR_BGR2GRAY,
        )
        if self._previous is not None:
            flow = cv2.calcOpticalFlowFarneback(
                self._previous,
                gray,
                None,
                0.5,
                2,
                15,
                2,
                5,
                1.1,
                0,
            )
            self._flow_p90.append(float(np.percentile(
                np.linalg.norm(flow, axis=2),
                90.0,
            )))
        self._previous = gray
        self.seen += 1
        return self.complete

    def result(self) -> dict[str, Any]:
        median_flow = (
            float(statistics.median(self._flow_p90))
            if self._flow_p90 else math.inf
        )
        return {
            "backend": (
                "cuda" if median_flow > self.flow_p90_threshold else "trt"
            ),
            "medianFlowP90": median_flow,
            "sampleCount": len(self._flow_p90),
            "frameCount": int(self.seen),
        }

class _FragmentedMp4Probe:
    """Incrementally recognize one complete top-level moof/mdat fragment.

    Seeing the four bytes ``mdat`` is not sufficient: FFmpeg writes the box
    header before its payload, and a paused speculative producer can otherwise
    be advertised as playable while the browser is still waiting for the rest
    of that box.  This parser follows declared ISO-BMFF box sizes, including
    extended sizes.  A size-zero box extends to EOF and therefore cannot make a
    live response ready until EOF is explicitly reported.
    """

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._offset = 0
        self._discarded = 0
        self._completed_moof = False
        self.first_complete_fragment_end: int | None = None
        self.last_complete_fragment_end: int | None = None
        self.complete_fragment_ends: list[int] = []
        self.complete_fragment_count = 0

    @property
    def media_fragment_ready(self) -> bool:
        return self.first_complete_fragment_end is not None

    def feed(self, chunk: bytes, *, eof: bool = False) -> bool:
        previous_count = self.complete_fragment_count
        if chunk:
            self._buffer.extend(chunk)
        while True:
            available = len(self._buffer) - self._offset
            if available < 8:
                break
            size32, box_type = struct.unpack_from(">I4s", self._buffer, self._offset)
            header_size = 8
            box_size = int(size32)
            if size32 == 1:
                if available < 16:
                    break
                box_size = int(struct.unpack_from(">Q", self._buffer, self._offset + 8)[0])
                header_size = 16
            elif size32 == 0:
                if not eof:
                    break
                box_size = available
            if box_size < header_size:
                raise ValueError(
                    f"invalid MP4 box size {box_size} for {box_type!r}"
                )
            if available < box_size:
                break
            self._offset += box_size
            absolute_end = self._discarded + self._offset
            if box_type == b"moof":
                self._completed_moof = True
            elif box_type == b"mdat" and self._completed_moof:
                self.complete_fragment_count += 1
                self.last_complete_fragment_end = absolute_end
                self.complete_fragment_ends.append(absolute_end)
                if self.first_complete_fragment_end is None:
                    self.first_complete_fragment_end = absolute_end
                self._completed_moof = False
            # Do not retain an entire long video merely to parse top-level box
            # boundaries. Preserve only the incomplete suffix.
            if self._offset >= 1024 * 1024:
                del self._buffer[: self._offset]
                self._discarded += self._offset
                self._offset = 0
        return self.complete_fragment_count > previous_count


class _FragmentedMp4TransportWriter:
    """Write a valid growing fMP4 with bounded top-level transport padding.

    Android's media data source can wait for a sizeable socket read before it
    exposes newly appended boxes to the demuxer. A very compressible CQ stream
    may therefore reach its buffered edge even though FFmpeg has already muxed
    several more seconds. ISO-BMFF ``free`` boxes inserted *between* complete
    moof/mdat fragments wake that reader without changing a video sample,
    timestamp, encoder setting, or decoded pixel.
    """

    def __init__(
        self,
        sink: Any,
        minimum_fragment_bytes: int = 0,
        padding_interval_fragments: int = 1,
        duration_seconds: float = 0,
    ) -> None:
        self.sink = sink
        self.minimum_fragment_bytes = max(
            0,
            min(64 * 1024, int(minimum_fragment_bytes or 0)),
        )
        self.probe = _FragmentedMp4Probe()
        self.source_bytes = 0
        self.bytes_written = 0
        self.padding_bytes = 0
        self._last_fragment_end = 0
        self._padding_interval_fragments = max(
            1,
            min(120, int(padding_interval_fragments or 1)),
        )
        self._group_fragments = 0
        self._group_source_bytes = 0
        self._duration_initializer = MovieDurationInitializer(duration_seconds)

    @staticmethod
    def _free_box(size: int) -> bytes:
        if size < 8:
            return b""
        return struct.pack(">I4s", size, b"free") + bytes(size - 8)

    def _padding_after(self, fragment_end: int, *, force: bool = False) -> bytes:
        fragment_bytes = max(0, int(fragment_end) - self._last_fragment_end)
        self._last_fragment_end = int(fragment_end)
        self._group_fragments += 1
        self._group_source_bytes += fragment_bytes
        if not force and self._group_fragments < self._padding_interval_fragments:
            return b""
        return self._flush_padding_group()

    def _flush_padding_group(self) -> bytes:
        requested = (
            self.minimum_fragment_bytes * self._group_fragments
            - self._group_source_bytes
        )
        self._group_fragments = 0
        self._group_source_bytes = 0
        return self._free_box(requested)

    def write(self, chunk: bytes) -> bool:
        chunk = self._duration_initializer.feed(chunk)
        if not chunk:
            return False
        previous_count = self.probe.complete_fragment_count
        chunk_start = self.source_bytes
        self.source_bytes += len(chunk)
        self.probe.feed(chunk)
        fragment_ends = self.probe.complete_fragment_ends[previous_count:]
        cursor = 0
        for fragment_end in fragment_ends:
            local_end = max(cursor, min(len(chunk), int(fragment_end) - chunk_start))
            if local_end > cursor:
                payload = chunk[cursor:local_end]
                self.sink.write(payload)
                self.bytes_written += len(payload)
            padding = self._padding_after(fragment_end)
            if padding:
                self.sink.write(padding)
                self.bytes_written += len(padding)
                self.padding_bytes += len(padding)
            cursor = local_end
        if cursor < len(chunk):
            payload = chunk[cursor:]
            self.sink.write(payload)
            self.bytes_written += len(payload)
        return self.probe.complete_fragment_count > previous_count

    def finish(self) -> bool:
        previous_count = self.probe.complete_fragment_count
        tail = self._duration_initializer.feed(b"", eof=True)
        if tail:
            self.write(tail)
        self.probe.feed(b"", eof=True)
        remaining_ends = self.probe.complete_fragment_ends[previous_count:]
        for index, fragment_end in enumerate(remaining_ends):
            padding = self._padding_after(
                fragment_end,
                force=(index == len(remaining_ends) - 1),
            )
            if padding:
                self.sink.write(padding)
                self.bytes_written += len(padding)
                self.padding_bytes += len(padding)
        if self._group_fragments:
            padding = self._flush_padding_group()
            if padding:
                self.sink.write(padding)
                self.bytes_written += len(padding)
                self.padding_bytes += len(padding)
        return self.probe.complete_fragment_count > previous_count


class ConfigUpdateConflict(RuntimeError):
    """Raised when a live pipeline prevents a destructive model reconfigure."""


class StaleActivationError(RuntimeError):
    """Raised when an obsolete browser operation tries to claim a channel."""


def _slug(value: str) -> str:
    clean = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return clean or "face"


def _natural_name_key(path: Path) -> tuple[tuple[int, int | str], ...]:
    """Sort Approved 2 before Approved 10 while remaining case-insensitive."""
    return tuple(
        (1, int(part)) if part.isdigit() else (0, part.lower())
        for part in re.split(r"(\d+)", path.name)
        if part
    )


def _bounded_square_roi(
    width: int,
    height: int,
    center_x: float,
    center_y: float,
    side: int,
    *,
    vertical_anchor: float = 0.5,
) -> tuple[int, int, int, int]:
    """Return an in-frame square ROI, shifting it instead of clipping it.

    A face close to the right or bottom edge used to produce a narrower crop:
    ``left``/``top`` were clamped first and ``right``/``bottom`` were then
    clipped independently.  The enhancer subsequently stretched that partial
    crop to its square model input, distorting edge faces.  Keep the requested
    side whenever the frame can contain it; only shrink when the frame itself
    is smaller than the requested square.
    """
    frame_width = max(1, int(width))
    frame_height = max(1, int(height))
    bounded_side = max(1, min(int(side), frame_width, frame_height))
    left = int(round(float(center_x) - bounded_side * 0.5))
    top = int(round(float(center_y) - bounded_side * float(vertical_anchor)))
    left = max(0, min(frame_width - bounded_side, left))
    top = max(0, min(frame_height - bounded_side, top))
    return left, top, left + bounded_side, top + bounded_side


_LK_TRACKING_OPTIONS = {
    "winSize": (21, 21),
    "maxLevel": 3,
    "criteria": (
        cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
        20,
        0.01,
    ),
}

_LK_TRACKING_ROI_SPANS = 3.75
_LK_TRACKING_ROI_MIN_SIDE = 192
_LK_TRACKING_ROI_ALIGNMENT = 16


def _landmark_span(points: np.ndarray) -> float:
    """Return a pose-independent scale for one five-landmark face."""
    values = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if len(values) < 2:
        return 0.0
    deltas = values[:, None, :] - values[None, :, :]
    return float(np.max(np.linalg.norm(deltas, axis=2)))


def _landmark_tracking_roi(
    prior_gray: np.ndarray,
    current_gray: np.ndarray,
    prior_kps: np.ndarray,
    frame_shape: tuple[int, ...],
) -> tuple[int, int, int, int] | None:
    """Return one conservative ROI shared by both LK directions.

    LK builds an image pyramid internally.  Running it over a full portrait
    frame twice is disproportionately expensive when only five face landmarks
    are tracked.  A square measuring roughly four landmark spans leaves ample
    context for the pyramid, while an additional motion margin keeps the next
    frame's face away from the crop edge.  Crops are never clamped: if the
    requested square would touch an image boundary, full-frame LK remains the
    safer fallback.
    """
    try:
        points = np.asarray(prior_kps, dtype=np.float32).reshape(-1, 2)
    except (TypeError, ValueError):
        return None
    if points.shape != (5, 2) or not np.isfinite(points).all():
        return None
    if prior_gray.ndim < 2 or current_gray.ndim < 2 or len(frame_shape) < 2:
        return None
    height, width = int(prior_gray.shape[0]), int(prior_gray.shape[1])
    if (
        height < 2
        or width < 2
        or current_gray.shape[:2] != (height, width)
        or (int(frame_shape[0]), int(frame_shape[1])) != (height, width)
    ):
        return None

    span = _landmark_span(points)
    if not math.isfinite(span) or span < 4.0:
        return None
    # Most of the 3.75-span square is already motion headroom because the five
    # landmarks occupy only the inner face.  Add a small, bounded margin for
    # fast inter-frame movement without turning medium faces into full frames.
    motion_margin = max(12.0, min(32.0, span * 0.15))
    requested_side = max(
        float(_LK_TRACKING_ROI_MIN_SIDE),
        span * _LK_TRACKING_ROI_SPANS + motion_margin * 2.0,
    )
    side = int(
        math.ceil(requested_side / float(_LK_TRACKING_ROI_ALIGNMENT))
        * _LK_TRACKING_ROI_ALIGNMENT
    )
    if side >= width or side >= height:
        return None

    center = (points.min(axis=0) + points.max(axis=0)) * 0.5
    left = int(math.floor(float(center[0]) - side * 0.5))
    top = int(math.floor(float(center[1]) - side * 0.5))
    right = left + side
    bottom = top + side
    if left <= 0 or top <= 0 or right >= width or bottom >= height:
        return None
    return left, top, right, bottom


def _tracked_landmarks_are_valid(
    prior: np.ndarray,
    candidate: np.ndarray,
    backtracked: np.ndarray,
    forward_status: np.ndarray,
    backward_status: np.ndarray,
    frame_shape: tuple[int, ...],
) -> bool:
    """Reject LK tracks that cannot describe the same on-screen face.

    Five points make LK very cheap, but a successful status bit alone is not a
    reliability signal.  A forward/backward check catches texture drift while
    the scale and pair-distance checks reject collapsed or sheared landmark
    constellations.  Bounds include a small tolerance for detector rounding at
    the frame edge; genuinely partial faces fall back to a fresh detector pass
    instead of carrying a stale track forward.
    """
    try:
        previous = np.asarray(prior, dtype=np.float32).reshape(-1, 2)
        current = np.asarray(candidate, dtype=np.float32).reshape(-1, 2)
        reverse = np.asarray(backtracked, dtype=np.float32).reshape(-1, 2)
    except (TypeError, ValueError):
        return False
    if previous.shape != (5, 2) or current.shape != previous.shape or reverse.shape != previous.shape:
        return False
    if not (
        np.isfinite(previous).all()
        and np.isfinite(current).all()
        and np.isfinite(reverse).all()
    ):
        return False
    if np.asarray(forward_status).size != 5 or np.asarray(backward_status).size != 5:
        return False
    status_mask = (
        np.asarray(forward_status).reshape(-1).astype(bool)
        & np.asarray(backward_status).reshape(-1).astype(bool)
    )
    # A hand, microphone or hair commonly hides one landmark while the other
    # four still define a stable similarity transform. Requiring all five made
    # such clips redetect every frame. Three consistent points are sufficient;
    # missing points are reconstructed from that transform by the caller.
    if int(np.count_nonzero(status_mask)) < 3:
        return False
    if len(frame_shape) < 2:
        return False
    height, width = int(frame_shape[0]), int(frame_shape[1])
    if height < 2 or width < 2:
        return False
    margin = max(2.0, max(height, width) * 0.02)
    if (
        np.any(current[:, 0] < -margin)
        or np.any(current[:, 0] > (width - 1) + margin)
        or np.any(current[:, 1] < -margin)
        or np.any(current[:, 1] > (height - 1) + margin)
    ):
        return False

    prior_span = _landmark_span(previous)
    current_span = _landmark_span(current)
    if prior_span < 4.0 or current_span < 4.0:
        return False
    scale = current_span / prior_span
    if not 0.65 <= scale <= 1.55:
        return False

    triangle = np.triu_indices(5, 1)
    prior_distances = np.linalg.norm(
        previous[:, None, :] - previous[None, :, :], axis=2
    )[triangle]
    current_distances = np.linalg.norm(
        current[:, None, :] - current[None, :, :], axis=2
    )[triangle]
    usable = prior_distances > max(1.0, prior_span * 0.04)
    if int(np.count_nonzero(usable)) < 6:
        return False
    ratios = current_distances[usable] / prior_distances[usable]
    median_scale = float(np.median(ratios))
    if median_scale <= 0.0 or np.max(np.abs(ratios / median_scale - 1.0)) > 0.35:
        return False

    frame_diagonal = float(np.hypot(width, height))
    displacement = np.linalg.norm(current - previous, axis=1)
    if float(np.median(displacement)) > max(6.0, prior_span * 0.50, frame_diagonal * 0.035):
        return False
    if float(np.max(displacement)) > max(10.0, prior_span * 0.75, frame_diagonal * 0.06):
        return False

    forward_backward_error = np.linalg.norm(reverse - previous, axis=1)
    error_limit = max(1.5, min(4.0, prior_span * 0.03))
    if float(np.max(forward_backward_error[status_mask])) > error_limit:
        return False
    return True


@dataclass(frozen=True)
class LandmarkTrackEvidence:
    """Evidence retained from one LK forward/backward track.

    Reconstructed landmarks are useful for a fresh model-rendered frame, but
    they must never authorize carrying a previously rendered face forward.
    Keeping the observation mask and fit residual makes that distinction
    explicit instead of losing it when this helper returns five coordinates.
    """

    points: np.ndarray
    observed_mask: np.ndarray
    reverse_errors: np.ndarray
    reconstructed: bool
    fit_residual: float
    locally_recovered_mask: np.ndarray | None = None


@dataclass(frozen=True)
class LandmarkTrackAdvance:
    points: np.ndarray
    current_gray: np.ndarray
    evidence: LandmarkTrackEvidence
    since_detect: int
    pose: "SimilarityPose | None" = None


@dataclass(frozen=True)
class SimilarityPose:
    """Global similarity pose used only for rendered landmark stabilization."""

    translation_x: float
    translation_y: float
    rotation: float
    log_scale: float
    media_time_seconds: float | None = None
    track_generation: int = 0


@dataclass
class FrameEvidence:
    """Session-local observations that may be consumed once by fallback work.

    A fresh instance is created for every decoded frame. Failed attempts are
    represented explicitly so a reuse rejection cannot repeat the same CPU or
    detector work before taking the exact path.
    """

    frame_index: int = -1
    media_time_seconds: float | None = None
    prior_track_revision: int = 0
    gray: np.ndarray | None = None
    lk_attempted: bool = False
    lk_flow_prepared: bool = False
    lk_flow_evidence: LandmarkTrackEvidence | None = None
    lk_advance: LandmarkTrackAdvance | None = None
    detection_attempted: bool = False
    detections: tuple[tuple[float, np.ndarray, np.ndarray | None], ...] = ()
    recognition_complete: bool = False
    selected_target_embedding: np.ndarray | None = None
    selected_target_similarity: float | None = None
    multi_face_decision: dict[str, Any] = field(default_factory=dict)
    best_target_similarity: float | None = None
    best_target_raw_similarity: float | None = None
    rejection_reasons: list[str] = field(default_factory=list)


_POSE_CANONICAL = np.asarray(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def _restorer_detector_recovery_is_safe(previous, current, similarity, elapsed_seconds):
    """A failed LK estimate is not a lost identity when a fresh detector proves it.

    This admits only small adjacent-frame motion with strong recognized identity.
    It never licenses full-face output reuse, unvalidated masks, or a missing detection.
    GPEN's independent canonical-image and local-correspondence gates still apply.
    """
    try:
        if not math.isfinite(float(similarity)) or float(similarity) < 75.0 or not (0.0 < float(elapsed_seconds) <= 0.10):
            return False
        before = np.asarray(previous, dtype=np.float32).reshape(5, 2)
        after = np.asarray(current, dtype=np.float32).reshape(5, 2)
        if not np.isfinite(before).all() or not np.isfinite(after).all():
            return False
        span = max(1.0, _landmark_span(before))
        ratio = _landmark_span(after) / span
        if not 0.90 <= ratio <= 1.10:
            return False
        if float(np.max(np.linalg.norm(after - before, axis=1))) / span > 0.12:
            return False
        transform, _ = cv2.estimateAffinePartial2D(before, after, method=cv2.LMEDS)
        if transform is None or not np.isfinite(transform).all():
            return False
        projected = cv2.transform(before.reshape(1, 5, 2), transform)[0]
        return float(np.max(np.linalg.norm(projected - after, axis=1))) / span <= 0.035
    except (TypeError, ValueError, OverflowError):
        return False


def _release_verified_identity_deadline(context, previous, current, similarity, elapsed_seconds):
    """A successful same-track identity check need not refresh pixel models.

    Keep every other invalidation reason, and leave each model's elapsed-age
    and current-image guards authoritative. Missing or ambiguous evidence fails
    closed through the existing exact path.
    """
    if not context or 'identity-deadline' not in context.get('forceExactReasons', ()):
        return False
    if not _restorer_detector_recovery_is_safe(previous, current, similarity, elapsed_seconds):
        return False
    reasons = [r for r in context['forceExactReasons'] if r != 'identity-deadline']
    context['forceExactReasons'] = reasons
    context['forceExact'] = bool(reasons)
    return True


def _fit_similarity_pose(
    points: np.ndarray,
    *,
    media_time_seconds: float | None = None,
    track_generation: int = 0,
) -> tuple[SimilarityPose, np.ndarray] | None:
    current = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    if current.shape != (5, 2) or not np.isfinite(current).all():
        return None
    matrix, _ = cv2.estimateAffinePartial2D(
        _POSE_CANONICAL,
        current,
        method=cv2.LMEDS,
    )
    if matrix is None or matrix.shape != (2, 3) or not np.isfinite(matrix).all():
        return None
    a = float(matrix[0, 0])
    sine = float(matrix[1, 0])
    tx = float(matrix[0, 2])
    scale = math.hypot(a, sine)
    if not math.isfinite(scale) or scale <= 1e-8:
        return None
    pose = SimilarityPose(
        translation_x=tx,
        translation_y=float(matrix[1, 2]),
        rotation=math.atan2(sine, a),
        log_scale=math.log(scale),
        media_time_seconds=media_time_seconds,
        track_generation=int(track_generation),
    )
    return pose, matrix.astype(np.float32, copy=False)


def _pose_matrix(pose: SimilarityPose) -> np.ndarray:
    scale = math.exp(float(pose.log_scale))
    cosine = math.cos(float(pose.rotation)) * scale
    sine = math.sin(float(pose.rotation)) * scale
    return np.asarray(
        [
            [cosine, -sine, float(pose.translation_x)],
            [sine, cosine, float(pose.translation_y)],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float32,
    )


def _propose_render_landmarks(
    tracking_state: dict[str, Any],
    candidate: np.ndarray,
    *,
    media_time_seconds: float | None = None,
) -> tuple[np.ndarray, SimilarityPose | None]:
    """Filter only global pose while retaining current non-rigid expression.

    Both detector and LK observations pass through this function. The raw
    points remain the next LK input; only the rendering transform is filtered.
    This removes detector/LK handoff jumps without independently dragging eye
    and mouth coordinates toward stale positions.
    """
    current = np.asarray(candidate, dtype=np.float32).reshape(-1, 2)
    generation = int(tracking_state.get("trackGeneration", 0))
    fitted = _fit_similarity_pose(
        current,
        media_time_seconds=media_time_seconds,
        track_generation=generation,
    )
    if fitted is None:
        return current, None
    raw_pose, raw_matrix = fitted
    previous_pose = tracking_state.get("renderPose")
    previous_render = tracking_state.get("kps")
    if (
        not isinstance(previous_pose, SimilarityPose)
        or int(previous_pose.track_generation) != generation
        or previous_render is None
    ):
        return current, raw_pose
    try:
        previous_points = np.asarray(previous_render, dtype=np.float32).reshape(-1, 2)
    except (TypeError, ValueError):
        return current, raw_pose
    if previous_points.shape != current.shape or not np.isfinite(previous_points).all():
        return current, raw_pose

    span = max(1.0, _landmark_span(current))
    normalized_motion = float(
        np.median(np.linalg.norm(current - previous_points, axis=1))
    ) / span
    current_weight = float(
        np.clip(0.75 + 0.25 * (normalized_motion / 0.08), 0.75, 1.0)
    )
    if (
        media_time_seconds is not None
        and previous_pose.media_time_seconds is not None
    ):
        delta_seconds = float(media_time_seconds) - float(previous_pose.media_time_seconds)
        if not math.isfinite(delta_seconds) or delta_seconds <= 0.0 or delta_seconds > 0.25:
            return current, raw_pose
        # Preserve the historical 0.75 minimum at 30 fps while making the
        # amount of retained history independent of the source frame rate.
        retained = (1.0 - current_weight) ** max(0.25, delta_seconds * 30.0)
        current_weight = 1.0 - retained

    angle_delta = math.atan2(
        math.sin(raw_pose.rotation - previous_pose.rotation),
        math.cos(raw_pose.rotation - previous_pose.rotation),
    )
    filtered_pose = SimilarityPose(
        translation_x=(
            previous_pose.translation_x * (1.0 - current_weight)
            + raw_pose.translation_x * current_weight
        ),
        translation_y=(
            previous_pose.translation_y * (1.0 - current_weight)
            + raw_pose.translation_y * current_weight
        ),
        rotation=previous_pose.rotation + angle_delta * current_weight,
        log_scale=(
            previous_pose.log_scale * (1.0 - current_weight)
            + raw_pose.log_scale * current_weight
        ),
        media_time_seconds=media_time_seconds,
        track_generation=generation,
    )
    raw_h = np.eye(3, dtype=np.float32)
    raw_h[:2] = raw_matrix
    try:
        raw_inverse = np.linalg.inv(raw_h)
    except np.linalg.LinAlgError:
        return current, raw_pose
    canonicalized = cv2.perspectiveTransform(
        current.reshape(1, -1, 2),
        raw_inverse,
    )[0]
    rendered = cv2.perspectiveTransform(
        canonicalized.reshape(1, -1, 2),
        _pose_matrix(filtered_pose),
    )[0]
    if not np.isfinite(rendered).all():
        return current, raw_pose
    return rendered.astype(np.float32, copy=False), filtered_pose


def _track_landmarks_lk(
    prior_gray: np.ndarray,
    current_gray: np.ndarray,
    prior_kps: np.ndarray,
    frame_shape: tuple[int, ...],
    *,
    return_evidence: bool = False,
) -> np.ndarray | LandmarkTrackEvidence | None:
    """Track five landmarks with a forward/backward LK consistency check."""
    global_points = np.asarray(prior_kps, dtype=np.float32).reshape(-1, 2)
    roi = _landmark_tracking_roi(
        prior_gray,
        current_gray,
        global_points,
        frame_shape,
    )
    offset = np.zeros((1, 2), dtype=np.float32)
    prior_input = prior_gray
    current_input = current_gray
    if roi is not None:
        left, top, right, bottom = roi
        offset[0] = (float(left), float(top))
        # Both directions must see exactly the same coordinate system.  Using
        # independently centered crops would make the reverse error meaningless.
        prior_input = prior_gray[top:bottom, left:right]
        current_input = current_gray[top:bottom, left:right]
    # Track four nearby texture samples for every semantic landmark.  When the
    # exact coordinate has weak LK texture, three consistent local samples can
    # directly observe its motion without reconstructing it from the other
    # side of the face or paying for a GPU detector pass.
    auxiliary_offsets = np.asarray(
        [[-4.0, 0.0], [4.0, 0.0], [0.0, -4.0], [0.0, 4.0]],
        dtype=np.float32,
    )
    auxiliary_points = (
        global_points[:, None, :] + auxiliary_offsets[None, :, :]
    ).reshape(-1, 2)
    all_global_points = np.concatenate([global_points, auxiliary_points], axis=0)
    points = (all_global_points - offset).reshape(-1, 1, 2)
    tracked, forward_status, _forward_error = cv2.calcOpticalFlowPyrLK(
        prior_input,
        current_input,
        points,
        None,
        **_LK_TRACKING_OPTIONS,
    )
    if tracked is None or forward_status is None:
        return None
    backtracked, backward_status, _backward_error = cv2.calcOpticalFlowPyrLK(
        current_input,
        prior_input,
        tracked,
        None,
        **_LK_TRACKING_OPTIONS,
    )
    if backtracked is None or backward_status is None:
        return None
    candidate_all = tracked.reshape(-1, 2) + offset
    reverse_all = backtracked.reshape(-1, 2) + offset
    status_all = (
        np.asarray(forward_status).reshape(-1).astype(bool)
        & np.asarray(backward_status).reshape(-1).astype(bool)
    )
    # Contract tests and older OpenCV shims may return only the original five
    # points. The strict path remains correct; it simply cannot use the local
    # recovery enhancement for that call.
    candidate = candidate_all[:5].copy()
    reverse = reverse_all[:5].copy()
    # Preserve direct semantic-landmark observations separately from local
    # motion inference. The latter is useful for a freshly rendered model frame
    # but must not masquerade as five directly observed points when authorizing
    # reuse of an older composite.
    directly_observed_mask = status_all[:5].copy()
    status_mask = directly_observed_mask.copy()
    locally_recovered = np.zeros(5, dtype=bool)
    if len(candidate_all) >= 25 and len(status_all) >= 25:
        span = max(4.0, _landmark_span(global_points))
        local_error_limit = max(1.5, min(4.0, span * 0.03))
        for landmark_index in range(5):
            if status_mask[landmark_index]:
                continue
            start = 5 + landmark_index * 4
            stop = start + 4
            local_status = status_all[start:stop]
            local_reverse_error = np.linalg.norm(
                reverse_all[start:stop] - auxiliary_points[landmark_index * 4:(landmark_index + 1) * 4],
                axis=1,
            )
            local_valid = local_status & np.isfinite(local_reverse_error)
            local_valid &= local_reverse_error <= local_error_limit
            if int(np.count_nonzero(local_valid)) < 3:
                continue
            prior_local = auxiliary_points[landmark_index * 4:(landmark_index + 1) * 4]
            displacements = candidate_all[start:stop][local_valid] - prior_local[local_valid]
            median_displacement = np.median(displacements, axis=0)
            if not np.isfinite(median_displacement).all():
                continue
            displacement_residuals = np.linalg.norm(
                displacements - median_displacement,
                axis=1,
            )
            consensus_limit = max(0.75, min(2.5, span * 0.02))
            if (
                not np.isfinite(displacement_residuals).all()
                or float(np.max(displacement_residuals)) > consensus_limit
            ):
                continue
            candidate[landmark_index] = global_points[landmark_index] + median_displacement
            # Retain the support samples' real reverse error instead of
            # manufacturing a perfect zero-error semantic observation.
            reverse_offsets = (
                reverse_all[start:stop][local_valid] - prior_local[local_valid]
            )
            reverse[landmark_index] = (
                global_points[landmark_index]
                + np.median(reverse_offsets, axis=0)
            )
            status_mask[landmark_index] = True
            locally_recovered[landmark_index] = True
    observed_count = int(np.count_nonzero(status_mask))
    reconstructed = 3 <= observed_count < 5
    fit_transform = None
    fit_residual = math.inf
    if observed_count >= 3:
        fit_transform, _ = cv2.estimateAffinePartial2D(
            global_points[status_mask],
            candidate[status_mask],
            method=cv2.LMEDS,
        )
        if (
            fit_transform is not None
            and fit_transform.shape == (2, 3)
            and np.isfinite(fit_transform).all()
        ):
            projected = cv2.transform(
                global_points[status_mask].reshape(1, -1, 2),
                fit_transform,
            )[0]
            fit_residual = float(
                np.max(np.linalg.norm(projected - candidate[status_mask], axis=1))
            )
    if reconstructed:
        transform = fit_transform
        if transform is None or not np.isfinite(fit_residual):
            return None
        missing = ~status_mask
        candidate[missing] = cv2.transform(
            global_points[missing].reshape(1, -1, 2),
            transform,
        )[0]
        # Reconstructed points did not participate in forward/backward LK;
        # represent them as neutral in that check while all constellation,
        # scale, bounds and motion checks still apply to the reconstruction.
        reverse[missing] = global_points[missing]
    if not _tracked_landmarks_are_valid(
        global_points,
        candidate,
        reverse,
        status_mask.astype(np.uint8).reshape(-1, 1),
        status_mask.astype(np.uint8).reshape(-1, 1),
        frame_shape,
    ):
        return None
    reverse_errors = np.linalg.norm(reverse - global_points, axis=1).astype(
        np.float32,
        copy=False,
    )
    evidence = LandmarkTrackEvidence(
        points=candidate,
        observed_mask=directly_observed_mask.copy(),
        reverse_errors=reverse_errors,
        reconstructed=reconstructed,
        fit_residual=float(fit_residual),
        locally_recovered_mask=locally_recovered,
    )
    return evidence if return_evidence else candidate


def _smooth_tracked_landmarks(
    previous_render: np.ndarray | None,
    candidate: np.ndarray,
    delta_seconds: float = 1.0 / 30.0,
) -> np.ndarray:
    """Remove small LK jitter without lagging intentional face motion.

    At most 25% of the previous rendered position is retained.  The filter
    fades out completely once median landmark motion reaches eight percent of
    the face span, so quick head movement is never deliberately delayed.
    Raw LK points are stored separately and remain the input to the next track.
    """
    current = np.asarray(candidate, dtype=np.float32).reshape(-1, 2)
    if previous_render is None:
        return current
    previous = np.asarray(previous_render, dtype=np.float32).reshape(-1, 2)
    if previous.shape != current.shape or not np.isfinite(previous).all():
        return current
    span = max(1.0, _landmark_span(current))
    normalized_motion = float(np.median(np.linalg.norm(current - previous, axis=1))) / span
    if not math.isfinite(delta_seconds) or delta_seconds <= 0 or delta_seconds > .25:
        return current
    # Normalize both the motion threshold and decay, not just the latter.
    reference_motion = normalized_motion / (delta_seconds * 30.0)
    reference_weight = float(np.clip(0.75 + 0.25 * (reference_motion / 0.08), 0.75, 1.0))
    current_weight = 1.0 - (1.0 - reference_weight) ** (delta_seconds * 30.0)
    return (previous * (1.0 - current_weight) + current * current_weight).astype(
        np.float32,
        copy=False,
    )


def _transport_render_correction_with_lk(
    previous_raw: np.ndarray,
    previous_render: np.ndarray,
    current_raw: np.ndarray,
    *,
    max_correction_ratio: float = 0.04,
) -> np.ndarray | None:
    """Move the prior render correction with current image-attached motion."""
    try:
        raw_before = np.asarray(previous_raw, dtype=np.float32).reshape(-1, 2)
        render_before = np.asarray(previous_render, dtype=np.float32).reshape(-1, 2)
        raw_now = np.asarray(current_raw, dtype=np.float32).reshape(-1, 2)
    except (TypeError, ValueError):
        return None
    if (
        raw_before.shape != (5, 2)
        or render_before.shape != (5, 2)
        or raw_now.shape != (5, 2)
        or not np.isfinite(raw_before).all()
        or not np.isfinite(render_before).all()
        or not np.isfinite(raw_now).all()
    ):
        return None
    transform, _ = cv2.estimateAffinePartial2D(
        raw_before,
        raw_now,
        method=cv2.LMEDS,
    )
    if transform is None or transform.shape != (2, 3) or not np.isfinite(transform).all():
        return None
    linear = transform[:, :2].astype(np.float32, copy=False)
    determinant = float(np.linalg.det(linear))
    if not math.isfinite(determinant) or determinant <= 0.0:
        return None
    correction = (render_before - raw_before) @ linear.T
    span = max(1.0, _landmark_span(raw_now))
    if float(np.max(np.linalg.norm(correction, axis=1))) > (
        span * max(0.0, float(max_correction_ratio))
    ):
        return None
    predicted = raw_now + correction
    return (
        predicted.astype(np.float32, copy=False)
        if np.isfinite(predicted).all()
        else None
    )


def _fuse_detector_with_lk_prediction(
    detected: np.ndarray,
    predicted: np.ndarray,
    *,
    minimum_detector_gain: float = 0.5,
    low_innovation_ratio: float = 0.005,
    high_innovation_ratio: float = 0.02,
    max_detector_offset_ratio: float = 0.01,
    diagnostics: dict[str, Any] | None = None,
) -> np.ndarray:
    """Fuse same-timestamp detector and motion-compensated render estimates."""
    detector_points = np.asarray(detected, dtype=np.float32).reshape(-1, 2)
    predicted_points = np.asarray(predicted, dtype=np.float32).reshape(-1, 2)
    if (
        detector_points.shape != (5, 2)
        or predicted_points.shape != (5, 2)
        or not np.isfinite(detector_points).all()
        or not np.isfinite(predicted_points).all()
    ):
        if diagnostics is not None:
            diagnostics["detectorLkFusionReason"] = "invalid-input"
        return detector_points
    interocular = max(
        1.0,
        float(np.linalg.norm(detector_points[1] - detector_points[0])),
    )
    innovation = detector_points - predicted_points
    innovation_norms = np.linalg.norm(innovation, axis=1)
    residual_ratio = float(
        math.sqrt(float(np.mean(np.square(innovation_norms)))) / interocular
    )
    max_ratio = float(np.max(innovation_norms) / interocular)
    if diagnostics is not None:
        diagnostics["detectorLkFusionResidualRatio"] = residual_ratio
    if not math.isfinite(residual_ratio) or not math.isfinite(max_ratio):
        if diagnostics is not None:
            diagnostics["detectorLkFusionReason"] = "nonfinite"
        return detector_points
    low = max(0.0, float(low_innovation_ratio))
    high = max(low + 1e-6, float(high_innovation_ratio))
    floor_gain = float(np.clip(minimum_detector_gain, 0.0, 1.0))
    if residual_ratio <= low:
        detector_gain = floor_gain
    elif residual_ratio >= high:
        detector_gain = 1.0
    else:
        detector_gain = floor_gain + (1.0 - floor_gain) * (
            (residual_ratio - low) / (high - low)
        )
    allowed_offset = max(0.0, float(max_detector_offset_ratio)) * interocular
    max_innovation = float(np.max(innovation_norms))
    if max_innovation > 1e-6:
        detector_gain = max(
            detector_gain,
            1.0 - (allowed_offset / max_innovation),
        )
    detector_gain = float(np.clip(detector_gain, 0.0, 1.0))
    fused = predicted_points + innovation * detector_gain
    if not np.isfinite(fused).all():
        if diagnostics is not None:
            diagnostics["detectorLkFusionReason"] = "nonfinite"
        return detector_points
    if diagnostics is not None:
        diagnostics["detectorLkFusionReason"] = "accepted"
        diagnostics["detectorLkFusionGain"] = detector_gain
    return fused.astype(np.float32, copy=False)


def _reconcile_detector_pose_with_lk_shape(
    detected: np.ndarray,
    predicted: np.ndarray,
    *,
    detector_detail_weight: float = 0.20,
    max_local_residual_ratio: float = 0.05,
    diagnostics: dict[str, Any] | None = None,
) -> np.ndarray:
    """Preserve LK feature shape while accepting detector global pose.

    A scheduled detector observation is an excellent absolute anchor, but a
    direct switch from LK coordinates to detector coordinates can change eye,
    nose, and mouth geometry on one frame.  Fit only the detector's global
    similarity pose to the same-frame LK prediction, then blend the remaining
    local detector residual.  Large or invalid disagreement always returns the
    untouched detector result, so cuts, target changes, and tracking failures
    cannot inherit stale geometry.
    """
    detector_points = np.asarray(detected, dtype=np.float32).reshape(-1, 2)
    predicted_points = np.asarray(predicted, dtype=np.float32).reshape(-1, 2)
    if (
        detector_points.shape != (5, 2)
        or predicted_points.shape != (5, 2)
        or not np.isfinite(detector_points).all()
        or not np.isfinite(predicted_points).all()
    ):
        if diagnostics is not None:
            diagnostics["detectorShapeContinuityReason"] = "invalid-input"
        return detector_points
    pose_transform, _ = cv2.estimateAffinePartial2D(
        predicted_points,
        detector_points,
        method=cv2.LMEDS,
    )
    if (
        pose_transform is None
        or pose_transform.shape != (2, 3)
        or not np.isfinite(pose_transform).all()
    ):
        if diagnostics is not None:
            diagnostics["detectorShapeContinuityReason"] = "invalid-pose"
        return detector_points
    aligned_prediction = cv2.transform(
        predicted_points.reshape(1, -1, 2),
        pose_transform,
    )[0]
    local_residual = detector_points - aligned_prediction
    interocular = max(
        1.0,
        float(np.linalg.norm(detector_points[1] - detector_points[0])),
    )
    local_norms = np.linalg.norm(local_residual, axis=1)
    maximum_ratio = float(np.max(local_norms) / interocular)
    rms_ratio = float(
        math.sqrt(float(np.mean(np.square(local_norms)))) / interocular
    )
    if diagnostics is not None:
        diagnostics["detectorShapeContinuityMaxResidualRatio"] = maximum_ratio
        diagnostics["detectorShapeContinuityRmsResidualRatio"] = rms_ratio
    maximum_allowed = max(0.0, float(max_local_residual_ratio))
    if (
        not math.isfinite(maximum_ratio)
        or not math.isfinite(rms_ratio)
        or maximum_ratio > maximum_allowed
    ):
        if diagnostics is not None:
            diagnostics["detectorShapeContinuityReason"] = "local-disagreement"
        return detector_points

    # Favor LK continuity for small detector-local innovations, then smoothly
    # return authority to the detector as the innovation approaches the safety
    # limit.  The global detector pose has already been applied above.
    minimum_weight = float(np.clip(detector_detail_weight, 0.0, 1.0))
    transition_start = maximum_allowed * 0.20
    if maximum_allowed <= 1e-8 or maximum_ratio >= maximum_allowed:
        effective_weight = 1.0
    elif maximum_ratio <= transition_start:
        effective_weight = minimum_weight
    else:
        effective_weight = minimum_weight + (1.0 - minimum_weight) * (
            (maximum_ratio - transition_start)
            / max(1e-8, maximum_allowed - transition_start)
        )
    reconciled = aligned_prediction + local_residual * effective_weight
    if not np.isfinite(reconciled).all():
        if diagnostics is not None:
            diagnostics["detectorShapeContinuityReason"] = "nonfinite-output"
        return detector_points
    if diagnostics is not None:
        diagnostics["detectorShapeContinuityReason"] = "accepted"
        diagnostics["detectorShapeContinuityWeight"] = effective_weight
    return reconciled.astype(np.float32, copy=False)


def _advance_prefetch_tracking(
    frame: np.ndarray,
    tracking_state: dict[str, Any],
    detect_interval: int,
    *,
    require_all_observed: bool = False,
    commit: bool = True,
    return_advance: bool = False,
    frame_evidence: FrameEvidence | None = None,
    media_time_seconds: float | None = None,
) -> np.ndarray | LandmarkTrackAdvance | None:
    """Advance the existing strict LK track without running a model.

    This is used only by the opt-in speculative prefetch lane. A missing,
    stale, or geometrically unsafe track returns ``None`` so the caller falls
    back to the ordinary detect/swap/enhance path for that frame. State is
    mutated only after a track passes the same forward/backward validation used
    by :meth:`process_frame`.
    """
    if not isinstance(frame, np.ndarray) or frame.ndim != 3:
        return None
    prior_kps = tracking_state.get("rawKps", tracking_state.get("kps"))
    prior_gray = tracking_state.get("gray")
    previous_render_kps = tracking_state.get("kps")
    since_detect = int(tracking_state.get("sinceDetect", max(1, detect_interval)))
    if (
        prior_kps is None
        or prior_gray is None
        or since_detect >= max(1, int(detect_interval))
    ):
        return None
    track_revision = int(tracking_state.get("trackRevision", 0))
    reusable_evidence = bool(
        frame_evidence is not None
        and int(frame_evidence.prior_track_revision) == track_revision
    )
    current_gray = (
        frame_evidence.gray
        if reusable_evidence and isinstance(frame_evidence.gray, np.ndarray)
        else cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    )
    if frame_evidence is not None and frame_evidence.gray is None:
        frame_evidence.gray = current_gray
    advance = (
        frame_evidence.lk_advance
        if reusable_evidence and frame_evidence.lk_attempted
        else None
    )
    if reusable_evidence and frame_evidence.lk_attempted and advance is None:
        return None
    if advance is None:
        if frame_evidence is not None and frame_evidence.lk_flow_prepared:
            evidence = frame_evidence.lk_flow_evidence
        else:
            evidence = _track_landmarks_lk(
                prior_gray,
                current_gray,
                np.asarray(prior_kps, dtype=np.float32),
                frame.shape,
                return_evidence=True,
            )
        if frame_evidence is not None:
            frame_evidence.lk_attempted = True
        if not isinstance(evidence, LandmarkTrackEvidence):
            return None
        # Preserve the established rendering contract: LK observations receive
        # the small motion-adaptive jitter filter, while the raw observation is
        # retained as the next LK input.  A continuously filtered global pose
        # was trialled here, but it added lag on the fast head-motion corpus
        # without improving attachment.
        rendered = None
        if bool(tracking_state.get("disableLkSmoothing", False)):
            rendered = np.asarray(evidence.points, dtype=np.float32)
        elif bool(tracking_state.get("sharedLandmarkEstimator", False)):
            rendered = _transport_render_correction_with_lk(
                prior_kps,
                previous_render_kps,
                evidence.points,
            )
        if rendered is None:
            rendered = _smooth_tracked_landmarks(
                previous_render_kps,
                evidence.points,
                delta_seconds=float(tracking_state.get("frameDeltaSeconds", 1.0 / 30.0)),
            )
        advance = LandmarkTrackAdvance(
            points=rendered,
            current_gray=current_gray,
            evidence=evidence,
            since_detect=since_detect + 1,
            pose=None,
        )
        if frame_evidence is not None:
            frame_evidence.lk_advance = advance
    evidence = advance.evidence
    if require_all_observed and (
        evidence.reconstructed
        or int(np.count_nonzero(evidence.observed_mask)) != 5
        or not np.isfinite(evidence.fit_residual)
    ):
        return None
    if commit:
        _commit_tracking_advance(tracking_state, advance)
    return advance if return_advance else advance.points


def _commit_tracking_advance(
    tracking_state: dict[str, Any],
    advance: LandmarkTrackAdvance,
) -> None:
    """Commit LK state only after its proposed rendered output is accepted."""
    tracking_state["rawKps"] = np.asarray(
        advance.evidence.points,
        dtype=np.float32,
    )
    tracking_state["kps"] = np.asarray(advance.points, dtype=np.float32)
    tracking_state["gray"] = advance.current_gray
    tracking_state["sinceDetect"] = int(advance.since_detect)
    if advance.pose is not None:
        tracking_state["renderPose"] = advance.pose
    tracking_state["trackRevision"] = int(
        tracking_state.get("trackRevision", 0)
    ) + 1


def _full_frame_reuse_appearance_is_safe(
    current_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    *,
    max_face_mae: float = 14.0,
    max_face_p90: float = 32.0,
    max_patch_mae: float = 46.0,
    diagnostics: dict[str, Any] | None = None,
) -> bool:
    """Reject residual reuse when the tracked face changed locally.

    LK geometry alone cannot see a blink, mouth change, hair, hand, or thin
    occluder.  Compare the current face region with the prior source warped
    into the new pose and require both global and small-patch agreement.  Any
    non-finite metric fails closed.  This check does not alter rendered pixels;
    it only decides whether the unchanged full-inference path must run.
    """
    try:
        current = np.asarray(current_rgb)
        previous = np.asarray(previous_rgb)
        prior_points = np.asarray(previous_kps, dtype=np.float32).reshape(5, 2)
        current_points = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
    except (TypeError, ValueError):
        if diagnostics is not None:
            diagnostics["reason"] = "invalid-input"
        return False
    if (
        current.shape != previous.shape
        or current.ndim != 3
        or current.shape[2] != 3
        or (current.dtype.kind in "fc" and not np.isfinite(current).all())
        or (previous.dtype.kind in "fc" and not np.isfinite(previous).all())
        or not np.isfinite(prior_points).all()
        or not np.isfinite(current_points).all()
    ):
        if diagnostics is not None:
            diagnostics["reason"] = "invalid-input"
        return False
    transform, _ = cv2.estimateAffinePartial2D(
        prior_points,
        current_points,
        method=cv2.LMEDS,
    )
    if transform is None or transform.shape != (2, 3) or not np.isfinite(transform).all():
        if diagnostics is not None:
            diagnostics["reason"] = "transform"
        return False

    height, width = current.shape[:2]
    prior_span = max(4.0, _landmark_span(prior_points))
    current_span = max(4.0, _landmark_span(current_points))

    def bounds(points: np.ndarray, span: float, padding: float) -> tuple[int, int, int, int]:
        left = max(0, int(math.floor(float(np.min(points[:, 0])) - span * padding)))
        top = max(0, int(math.floor(float(np.min(points[:, 1])) - span * padding)))
        right = min(width, int(math.ceil(float(np.max(points[:, 0])) + span * padding)))
        bottom = min(height, int(math.ceil(float(np.max(points[:, 1])) + span * padding)))
        return left, top, right, bottom

    source_left, source_top, source_right, source_bottom = bounds(
        prior_points,
        prior_span,
        0.55,
    )
    target_left, target_top, target_right, target_bottom = bounds(
        current_points,
        current_span,
        0.55,
    )
    if (
        source_right - source_left < 8
        or source_bottom - source_top < 8
        or target_right - target_left < 8
        or target_bottom - target_top < 8
    ):
        if diagnostics is not None:
            diagnostics["reason"] = "roi"
        return False

    local_transform = np.asarray(transform, dtype=np.float64).copy()
    local_transform[:, 2] += local_transform[:, :2] @ np.asarray(
        [source_left, source_top],
        dtype=np.float64,
    )
    local_transform[:, 2] -= np.asarray([target_left, target_top], dtype=np.float64)
    original_target_width = target_right - target_left
    original_target_height = target_bottom - target_top
    normalized_scale = min(
        1.0,
        192.0 / max(1.0, float(max(original_target_width, original_target_height))),
    )
    target_size = (
        max(8, int(round(original_target_width * normalized_scale))),
        max(8, int(round(original_target_height * normalized_scale))),
    )
    scaled_transform = local_transform.copy()
    scaled_transform[0, :] *= target_size[0] / float(original_target_width)
    scaled_transform[1, :] *= target_size[1] / float(original_target_height)
    warped_prior = cv2.warpAffine(
        previous[source_top:source_bottom, source_left:source_right],
        scaled_transform,
        target_size,
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    warped_validity = cv2.warpAffine(
        np.full(
            (source_bottom - source_top, source_right - source_left),
            255,
            dtype=np.uint8,
        ),
        scaled_transform,
        target_size,
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    current_roi = current[target_top:target_bottom, target_left:target_right]
    if current_roi.shape[1] != target_size[0] or current_roi.shape[0] != target_size[1]:
        current_roi = cv2.resize(
            current_roi,
            target_size,
            interpolation=cv2.INTER_LINEAR,
        )
    if warped_prior.shape != current_roi.shape:
        if diagnostics is not None:
            diagnostics["reason"] = "shape"
        return False

    local_points = np.rint(
        (
            current_points
            - np.asarray([target_left, target_top], dtype=np.float32)
        )
        * np.asarray(
            [
                target_size[0] / float(original_target_width),
                target_size[1] / float(original_target_height),
            ],
            dtype=np.float32,
        )
    ).astype(np.int32)
    mask = np.zeros(current_roi.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(local_points), 255)
    core_mask = mask.copy()
    dilation = max(3, int(round(current_span * normalized_scale * 0.16)))
    if dilation % 2 == 0:
        dilation += 1
    mask = cv2.dilate(mask, np.ones((dilation, dilation), dtype=np.uint8))
    # Geometric sample validity—not pixel color—is the authority. The old
    # all-channels->0 test discarded black hair, dark skin regions and shadows,
    # allowing changes in exactly those regions to evade the appearance gate.
    sample_valid = warped_validity > 0
    valid = mask.astype(bool) & sample_valid
    core_valid = core_mask.astype(bool) & sample_valid
    if int(np.count_nonzero(valid)) < 64:
        if diagnostics is not None:
            diagnostics["reason"] = "visibility"
        return False
    pixel_mae = np.mean(
        np.abs(current_roi.astype(np.float32) - warped_prior.astype(np.float32)),
        axis=2,
    )
    values = pixel_mae[valid]
    face_mae = float(np.mean(values))
    percentile_index = max(0, min(len(values) - 1, int(math.ceil(len(values) * 0.90)) - 1))
    face_p90 = float(np.partition(values, percentile_index)[percentile_index])
    if diagnostics is not None:
        diagnostics["faceMae"] = face_mae
        diagnostics["faceP90"] = face_p90
    if not np.isfinite(face_mae) or not np.isfinite(face_p90):
        if diagnostics is not None:
            diagnostics["reason"] = "nonfinite"
        return False
    if face_mae > float(max_face_mae) or face_p90 > float(max_face_p90):
        if diagnostics is not None:
            diagnostics["reason"] = "face-change"
        return False

    # A small occluder can disappear inside a whole-face mean.  Eight-by-eight
    # patch means make that local change visible without reacting to one noisy
    # pixel or adding another neural model to the critical path.
    patch = 8
    valid_float = core_valid.astype(np.float32)
    patch_sum = cv2.boxFilter(
        pixel_mae * valid_float,
        ddepth=cv2.CV_32F,
        ksize=(patch, patch),
        normalize=False,
        borderType=cv2.BORDER_CONSTANT,
    )
    patch_count = cv2.boxFilter(
        valid_float,
        ddepth=cv2.CV_32F,
        ksize=(patch, patch),
        normalize=False,
        borderType=cv2.BORDER_CONSTANT,
    )
    sufficiently_visible = patch_count >= float((patch * patch) // 3)
    if np.any(sufficiently_visible):
        patch_means = patch_sum[sufficiently_visible] / np.maximum(
            patch_count[sufficiently_visible],
            1.0,
        )
        patch_max = float(np.max(patch_means))
    else:
        patch_max = math.inf
    if diagnostics is not None:
        diagnostics["patchMae"] = patch_max
    accepted = bool(np.isfinite(patch_max) and patch_max <= float(max_patch_mae))
    if diagnostics is not None:
        diagnostics["reason"] = "accepted" if accepted else "local-change"
    return accepted


def _compose_canonical_motion_transform(
    source_to_canonical: np.ndarray,
    target_to_canonical: np.ndarray,
) -> np.ndarray | None:
    """Compose source-frame -> target-frame motion through one canonical space."""
    try:
        source_matrix = np.asarray(source_to_canonical, dtype=np.float64).reshape(3, 3)
        target_matrix = np.asarray(target_to_canonical, dtype=np.float64).reshape(3, 3)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(source_matrix).all() or not np.isfinite(target_matrix).all():
        return None
    try:
        motion = np.linalg.solve(target_matrix, source_matrix)
    except np.linalg.LinAlgError:
        return None
    if not np.isfinite(motion).all() or abs(float(motion[2, 2])) < 1e-12:
        return None
    motion /= float(motion[2, 2])
    if not np.allclose(motion[2], np.asarray([0.0, 0.0, 1.0]), atol=1e-7):
        return None
    return np.asarray(motion[:2, :], dtype=np.float64)


def _warp_affine_continuous_linear(
    source: np.ndarray,
    forward_transform: np.ndarray,
    output_size: tuple[int, int],
) -> np.ndarray:
    """Four-tap bilinear affine warp without OpenCV's phase-table rounding.

    ``forward_transform`` has the same source-to-destination contract used by
    ``cv2.warpAffine`` without ``WARP_INVERSE_MAP``.  Border samples are zero.
    The source/output dtype remains signed int16 so the caller's saturating add
    keeps exactly the existing residual-compositing contract.
    """
    values = np.asarray(source)
    if values.ndim != 3 or values.dtype != np.int16:
        raise TypeError("continuous residual warp requires HxWxC int16 input")
    output_width, output_height = map(int, output_size)
    if output_width <= 0 or output_height <= 0:
        raise ValueError("continuous residual warp requires positive dimensions")
    inverse = cv2.invertAffineTransform(
        np.asarray(forward_transform, dtype=np.float64).reshape(2, 3)
    )
    yy, xx = np.indices((output_height, output_width), dtype=np.float32)
    source_x = (
        np.float32(inverse[0, 0]) * xx
        + np.float32(inverse[0, 1]) * yy
        + np.float32(inverse[0, 2])
    )
    source_y = (
        np.float32(inverse[1, 0]) * xx
        + np.float32(inverse[1, 1]) * yy
        + np.float32(inverse[1, 2])
    )
    x0 = np.floor(source_x).astype(np.int32)
    y0 = np.floor(source_y).astype(np.int32)
    x1 = x0 + 1
    y1 = y0 + 1
    wx = source_x - x0
    wy = source_y - y0
    source_height, source_width = values.shape[:2]

    def sample(x_index: np.ndarray, y_index: np.ndarray) -> np.ndarray:
        valid = (
            (x_index >= 0)
            & (x_index < source_width)
            & (y_index >= 0)
            & (y_index < source_height)
        )
        clipped_x = np.clip(x_index, 0, source_width - 1)
        clipped_y = np.clip(y_index, 0, source_height - 1)
        result = values[clipped_y, clipped_x].astype(np.float32, copy=False)
        return result * valid[..., None]

    top_left = sample(x0, y0)
    top_right = sample(x1, y0)
    bottom_left = sample(x0, y1)
    bottom_right = sample(x1, y1)
    wx = wx[..., None]
    wy = wy[..., None]
    output = (
        top_left * (1.0 - wx) * (1.0 - wy)
        + top_right * wx * (1.0 - wy)
        + bottom_left * (1.0 - wx) * wy
        + bottom_right * wx * wy
    )
    return np.rint(output).clip(-32768, 32767).astype(np.int16)


def build_temporal_restorer_context(
    runtime: dict[str, Any],
    *,
    enabled: bool,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the temporal-restorer contract shared by live and benchmark paths."""
    context: dict[str, Any] = {
        "enabled": bool(enabled),
        "correctionStabilizationEnabled": bool(runtime.get("temporalRestorerCorrectionStabilizationEnabled", False)),
        "correctionLocalGuardEnabled": bool(runtime.get("temporalRestorerCorrectionLocalGuardEnabled", False)),
        "localRefreshEnabled": bool(runtime.get("temporalRestorerLocalRefreshEnabled", False)),
        "maxInputMae": float(runtime.get("temporalRestorerMaxInputMae", 18.0)),
        "maxInputPatchMae": float(runtime.get("temporalRestorerMaxInputPatchMae", 34.0)),
        "exactBlendEnabled": bool(runtime.get("temporalRestorerExactBlendEnabled", False)),
        "exactBlendCurrentWeight": float(runtime.get("temporalRestorerExactBlendCurrentWeight", 0.75)),
        "pixelCenterReturnMap": bool(runtime.get("restorerPixelCenterReturnMap", False)),
        "boundedCubicReturnSampler": bool(runtime.get("restorerBoundedCubicReturnSampler", False)),
        "boundedCubicWeight": float(runtime.get("restorerBoundedCubicWeight", 1.0)),
        "monotoneHermiteReturnSampler": bool(runtime.get("restorerMonotoneHermiteReturnSampler", False)),
        "bilinearInputAlignment": bool(runtime.get("restorerBilinearInputAlignment", False)),
        "fusedInputAlignment": bool(runtime.get("restorerFusedInputAlignment", False)),
        "residualReturn": bool(runtime.get("restorerResidualReturn", False)),
        "residualReturnWeight": float(
            runtime.get("restorerResidualReturnWeight", 1.0)
        ),
        "residualReturnMinimumFaceSize": int(
            runtime.get("restorerResidualReturnMinimumFaceSize", 0)
        ),
        "residualParserUsesLegacyAppearance": bool(
            runtime.get("restorerResidualParserUsesLegacyAppearance", False)
        ),
        "lowFrequencyAnchorStabilization": bool(
            runtime.get("restorerLowFrequencyAnchorStabilization", False)
        ),
        "lowFrequencyAnchorStrength": float(
            runtime.get("restorerLowFrequencyAnchorStrength", 0.15)
        ),
        "lowFrequencyAnchorKernel": int(
            runtime.get("restorerLowFrequencyAnchorKernel", 15)
        ),
        "lowFrequencyAnchorMaxCorrection": float(
            runtime.get("restorerLowFrequencyAnchorMaxCorrection", 3.0)
        ),
        "exactPastebackRoundToNearest": bool(runtime.get("exactPastebackRoundToNearest", False)),
        "exactPastebackFloat64Composite": bool(
            runtime.get("exactPastebackFloat64Composite", False)
        ),
        "returnGeometryCache": bool(runtime.get("restorerReturnGeometryCache", False)),
        "outputFractionalLevels": int(runtime.get("restorerOutputFractionalLevels", 0)),
        "faceParserEvidenceQuantizationStep": float(
            runtime.get("faceParserEvidenceQuantizationStep", 0.0)
        ),
        "referenceParserMaskDiagnostic": bool(
            runtime.get("referenceParserMaskDiagnostic", False)
        ),
        "hybridReferenceReasons": tuple(
            str(value)
            for value in (runtime.get("restorerHybridReferenceReasons") or [])
        ),
        "hybridReferenceCadenceByReason": dict(
            runtime.get("restorerHybridReferenceCadenceByReason") or {}
        ),
        "hybridReferencePhaseByReason": dict(
            runtime.get("restorerHybridReferencePhaseByReason") or {}
        ),
        "hybridReferenceMinimumInputMaeByReason": dict(
            runtime.get("restorerHybridReferenceMinimumInputMaeByReason") or {}
        ),
        "hybridReferenceBlendWeight": float(
            runtime.get("restorerHybridReferenceBlendWeight", 1.0)
        ),
        "hybridReferenceBlendWeightByReason": dict(
            runtime.get("restorerHybridReferenceBlendWeightByReason") or {}
        ),
        "hybridLowerCenterMinX": float(
            runtime.get("restorerHybridLowerCenterMinX", 0.45)
        ),
        "hybridLowerCenterMaxX": float(
            runtime.get("restorerHybridLowerCenterMaxX", 0.70)
        ),
        "hybridLowerCenterMinY": float(
            runtime.get("restorerHybridLowerCenterMinY", 0.70)
        ),
        "spatialExactBlendEnabled": bool(
            runtime.get("temporalRestorerSpatialBlendEnabled", False)
        ),
        "spatialExactBlendTriggerReasons": tuple(
            str(value)
            for value in runtime.get(
                "temporalRestorerSpatialBlendTriggerReasons", []
            )
        ),
        "spatialExactBlendRequiresHybridReference": bool(
            runtime.get(
                "temporalRestorerSpatialBlendRequiresHybridReference", False
            )
        ),
        "spatialExactBlendTriggerMaxGapFrames": int(
            runtime.get(
                "temporalRestorerSpatialBlendTriggerMaxGapFrames", 0
            )
        ),
        "spatialExactBlendTriggerMinimumEvents": int(
            runtime.get(
                "temporalRestorerSpatialBlendTriggerMinimumEvents", 2
            )
        ),
        "spatialExactBlendTriggerMinimumPatchToMeanRatio": float(
            runtime.get(
                "temporalRestorerSpatialBlendTriggerMinimumPatchToMeanRatio", 0.0
            )
        ),
        "spatialExactBlendBurstHoldFrames": int(
            runtime.get(
                "temporalRestorerSpatialBlendBurstHoldFrames", 0
            )
        ),
        "spatialExactBlendCurrentWeight": float(
            runtime.get("temporalRestorerSpatialBlendCurrentWeight", 0.75)
        ),
        "spatialExactBlendChangeLow": float(
            runtime.get("temporalRestorerSpatialBlendChangeLow", 1.0)
        ),
        "spatialExactBlendChangeHigh": float(
            runtime.get("temporalRestorerSpatialBlendChangeHigh", 8.0)
        ),
        "spatialExactBlendEdgeGuardFraction": float(
            runtime.get(
                "temporalRestorerSpatialBlendEdgeGuardFraction", 0.0
            )
        ),
        "maxMaskInputMae": float(runtime.get("temporalMaskMaxInputMae", 16.0)),
        "maskAnchorHz": float(runtime.get("temporalMaskAnchorHz", 0.0)),
        "maxMaskPatchMae": float(runtime.get("temporalMaskMaxInputPatchMae", 30.0)),
        "maskLocalChangeGuardEnabled": bool(runtime.get("temporalMaskLocalChangeGuardEnabled", False)),
        "maxMaskLocalPatchMae": float(runtime.get("temporalMaskMaxLocalPatchMae", 30.0)),
        "dflXSegReuseEnabled": bool(
            runtime.get("temporalDflXSegReuseEnabled", False)
        ),
        "occluderDecoupledFromRestorer": bool(
            runtime.get("temporalOccluderDecoupledFromRestorer", False)
        ),
        "identityResidualStabilizationEnabled": bool(
            runtime.get("temporalIdentityResidualStabilizationEnabled", False)
        ),
        "identityResidualHighMotionOnly": bool(
            runtime.get("temporalIdentityResidualHighMotionOnly", False)
        ),
        "identityResidualCurrentWeight": float(
            runtime.get("temporalIdentityResidualCurrentWeight", 0.70)
        ),
        "identityResidualHalfLifeSeconds": float(
            runtime.get("temporalIdentityResidualHalfLifeSeconds", 0.020)
        ),
        "identityResidualChangeLow": float(
            runtime.get("temporalIdentityResidualChangeLow", 2.0)
        ),
        "identityResidualChangeHigh": float(
            runtime.get("temporalIdentityResidualChangeHigh", 14.0)
        ),
        "identityResidualMaxInputMae": float(
            runtime.get("temporalIdentityResidualMaxInputMae", 20.0)
        ),
        "identityResidualMaxInputPatchMae": float(
            runtime.get("temporalIdentityResidualMaxInputPatchMae", 48.0)
        ),
        "registeredResidualReuse": bool(runtime.get("temporalRegisteredResidualReuse", False)),
        "registeredRegionConfidence": bool(runtime.get("temporalRegisteredRegionConfidence", False)),
        "registeredMinCoreSupport": float(runtime.get("temporalRegisteredMinCoreSupport", 0.75)),
        "registeredMinImportantSupport": float(runtime.get("temporalRegisteredMinImportantSupport", 0.98)),
        "registeredMinPartSupport": float(runtime.get("temporalRegisteredMinPartSupport", 0.97)),
        "registeredRequireCenters": bool(runtime.get("temporalRegisteredRequireCenters", True)),
        "registeredMaxInvalidImportantRatio": float(
            runtime.get("temporalRegisteredMaxInvalidImportantRatio", 0.01)
        ),
        "registeredFlowSize": int(runtime.get("temporalRegisteredFlowSize", 128)),
        "registeredBicubicResidual": bool(runtime.get("temporalRegisteredBicubicResidual", False)),
        "currentMasks": bool(runtime.get("temporalCurrentFrameMasks", False)),
        "currentOccluder": bool(
            runtime.get(
                "temporalCurrentOccluder",
                runtime.get("temporalCurrentFrameMasks", False),
            )
        ),
        "currentFaceParser": bool(
            runtime.get(
                "temporalCurrentFaceParser",
                runtime.get("temporalCurrentFrameMasks", False),
            )
        ),
        "parserUsesPreRestorerBase": bool(
            runtime.get("temporalParserUsesPreRestorerBase", False)
        ),
        "parserDecoupledFromRestorer": bool(
            runtime.get("temporalParserDecoupledFromRestorer", False)
        ),
        "faceParserSkipFrames": int(runtime.get("temporalFaceParserSkipFrames", 0)),
        "maskExactParserBlendEnabled": bool(
            runtime.get("maskExactParserBlendEnabled", False)
        ),
        "maskExactParserBlendCurrentWeight": float(
            runtime.get("maskExactParserBlendCurrentWeight", 0.80)
        ),
        "maskExactParserBlendHalfLifeSeconds": float(
            runtime.get("maskExactParserBlendHalfLifeSeconds", 0.020)
        ),
        "maskTrtDetailGainCompensation": float(
            runtime.get("maskTrtDetailGainCompensation", 0.0)
        ),
        "maskOccluderRuntimeBackend": str(
            runtime.get("maskOccluderBackendPreference", "inherit")
        ).lower(),
        "maskFaceParserRuntimeBackend": str(
            runtime.get("maskFaceParserBackendPreference", "inherit")
        ).lower(),
    }
    if extras:
        context.update(extras)
    return context


def _adaptive_mask_state(
    runtime: dict[str, Any],
    tracking_state: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Return generation-scoped adaptive-mask state without changing presets."""
    if (
        not bool(runtime.get("maskAdaptiveBackendEnabled", False))
        or tracking_state is None
    ):
        return None
    generation = int(tracking_state.get("trackGeneration", 0))
    state = tracking_state.get("maskAdaptiveBackend")
    if not isinstance(state, dict) or int(state.get("generation", -1)) != generation:
        state = {
            "generation": generation,
            "backend": "cuda",
            "locked": False,
            "samples": [],
        }
        tracking_state["maskAdaptiveBackend"] = state
    return state


def _record_adaptive_mask_motion(
    runtime: dict[str, Any],
    tracking_state: dict[str, Any] | None,
    warp_diagnostics: dict[str, Any] | None,
) -> str | None:
    """Observe an existing tracker residual and make one immutable decision.

    No extra detector, optical-flow pass, model inference, or frame pixels are
    introduced.  Once enough finite residuals exist, the median selects one
    mask backend for the remainder of the active tracking generation.
    """
    state = _adaptive_mask_state(runtime, tracking_state)
    if state is None or bool(state.get("locked", False)):
        return None if state is None else str(state.get("backend", "cuda"))
    residual = (warp_diagnostics or {}).get("landmarkResidualRatio")
    if not isinstance(residual, (int, float)) or not math.isfinite(float(residual)):
        return str(state.get("backend", "cuda"))
    samples = state.setdefault("samples", [])
    samples.append(float(residual))
    del samples[: max(0, len(samples) - 12)]
    minimum_samples = max(
        1,
        int(runtime.get("maskAdaptiveMinimumSamples", 3)),
    )
    if len(samples) >= minimum_samples:
        threshold = max(
            0.0,
            float(runtime.get("maskAdaptiveResidualThreshold", 0.008)),
        )
        state["medianResidual"] = float(statistics.median(samples))
        state["backend"] = (
            "trt" if state["medianResidual"] <= threshold else "cuda"
        )
        state["locked"] = True
    return str(state.get("backend", "cuda"))


def _selected_adaptive_mask_backend(
    runtime: dict[str, Any],
    tracking_state: dict[str, Any] | None,
) -> str | None:
    state = _adaptive_mask_state(runtime, tracking_state)
    if state is None:
        return None
    backend = str(state.get("backend", "cuda")).lower()
    return backend if backend in ("cuda", "trt") else "cuda"


@dataclass(frozen=True)
class ResidualWarpPlan:
    """Immutable geometry and source ownership for one exact residual render.

    Planning is deliberately separated from materialization so the caller can
    validate and commit tracking state before scheduling the CPU-only OpenCV
    work.  The referenced arrays must remain alive and unmodified until
    :func:`_render_prior_swap_residual` returns.  The synchronous compatibility
    wrapper below preserves the original call contract.
    """

    current: np.ndarray
    previous: np.ndarray
    swapped: np.ndarray
    source_points: np.ndarray
    target_points: np.ndarray
    local_transform: np.ndarray
    source_roi: tuple[int, int, int, int]
    target_roi: tuple[int, int, int, int]
    interpolation: int
    continuous_linear: bool
    feature_patch_lock_strength: float
    feature_patch_max_mae: float
    feature_patch_max_p90: float


def _discard_residual_future_for_promotion(
    future: concurrent.futures.Future | None,
) -> None:
    """Cancel or join one speculative residual before exact promotion."""
    if future is None:
        return
    if not future.cancel():
        # If OpenCV already owns the job, wait for its immutable reads to
        # finish. The result is deliberately ignored; only a fresh exact frame
        # may cross the speculative-to-visible boundary.
        future.result()


def _plan_prior_swap_residual(
    current_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    *,
    max_landmark_residual_ratio: float = 0.12,
    interpolation: int = cv2.INTER_LINEAR,
    continuous_linear: bool = False,
    feature_patch_lock_strength: float = 0.0,
    feature_patch_max_mae: float = 16.0,
    feature_patch_max_p90: float = 34.0,
    source_to_canonical: np.ndarray | None = None,
    target_to_canonical: np.ndarray | None = None,
    canonical_blend_weight: float = 1.0,
    pose_aware_affine: bool = False,
    pose_aware_affine_max_anisotropy: float = 1.12,
    pose_aware_affine_min_improvement: float = 0.12,
    pose_aware_affine_min_residual_ratio: float = 0.008,
    diagnostics: dict[str, Any] | None = None,
) -> ResidualWarpPlan | None:
    """Validate and plan movement of a prior residual onto the current frame.

    Whole-frame duplication makes a nominal 24 fps preview visibly play at
    12 fps. Instead, preserve every pixel of the *current* source frame and
    carry only the prior swap/enhancement delta into the newly tracked pose.
    The operation is limited to a face-sized ROI and uses a validated similarity
    transform, so its CPU cost is tiny compared with a detector + swap model.

    Returning ``None`` is deliberately conservative: any unexpected geometry,
    dimensions, or transform causes full inference for the frame.  This stage
    performs no pixel materialization and is therefore safe to complete before
    a later CPU renderer is admitted.
    """
    current = np.asarray(current_rgb)
    previous = np.asarray(previous_rgb)
    swapped = np.asarray(previous_swapped_rgb)
    if (
        current.ndim != 3
        or current.shape[-1] != 3
        or current.shape != previous.shape
        or current.shape != swapped.shape
        or current.dtype != np.uint8
        or previous.dtype != np.uint8
        or swapped.dtype != np.uint8
    ):
        return None
    try:
        source_points = np.asarray(previous_kps, dtype=np.float32).reshape(-1, 2)
        target_points = np.asarray(current_kps, dtype=np.float32).reshape(-1, 2)
    except (TypeError, ValueError):
        return None
    if (
        source_points.shape != (5, 2)
        or target_points.shape != (5, 2)
        or not np.isfinite(source_points).all()
        or not np.isfinite(target_points).all()
    ):
        return None

    canonical_transform = None
    if source_to_canonical is not None and target_to_canonical is not None:
        canonical_transform = _compose_canonical_motion_transform(
            source_to_canonical,
            target_to_canonical,
        )
    landmark_transform, _inliers = cv2.estimateAffinePartial2D(
        source_points,
        target_points,
        method=cv2.LMEDS,
    )
    blend_weight = float(np.clip(canonical_blend_weight, 0.0, 1.0))
    if canonical_transform is not None and landmark_transform is not None:
        if blend_weight >= 1.0:
            transform = canonical_transform
            transport_mode = "canonical-composition"
        elif blend_weight <= 0.0:
            transform = landmark_transform
            transport_mode = "landmark-lmeds"
        else:
            mixed = (
                landmark_transform.astype(np.float64) * (1.0 - blend_weight)
                + canonical_transform.astype(np.float64) * blend_weight
            )
            # Both inputs are similarity transforms. Project the interpolated
            # 2x2 block back onto that family so interpolation cannot introduce
            # shear or anisotropic scale.
            a = 0.5 * (float(mixed[0, 0]) + float(mixed[1, 1]))
            b = 0.5 * (float(mixed[1, 0]) - float(mixed[0, 1]))
            transform = np.asarray(
                [[a, -b, mixed[0, 2]], [b, a, mixed[1, 2]]],
                dtype=np.float64,
            )
            transport_mode = "canonical-landmark-blend"
    elif canonical_transform is not None:
        transform = canonical_transform
        transport_mode = "canonical-composition"
    else:
        transform = landmark_transform
        transport_mode = "landmark-lmeds"

    # A similarity transform is stable and deliberately conservative, but it
    # cannot follow the mild horizontal foreshortening produced by a real head
    # turn. Evaluate a six-parameter fit over all five observed landmarks and
    # adopt it only when it is demonstrably better than the similarity fit and
    # remains close to a similarity transform. This prevents expression-only
    # mouth or eye movement from becoming an affine face distortion while
    # correcting the side-to-side drift that is visible between exact anchors.
    if (
        bool(pose_aware_affine)
        and canonical_transform is None
        and landmark_transform is not None
    ):
        source_design = np.concatenate(
            [source_points.astype(np.float64), np.ones((5, 1), dtype=np.float64)],
            axis=1,
        )
        try:
            solved_x, *_ = np.linalg.lstsq(
                source_design,
                target_points[:, 0].astype(np.float64),
                rcond=None,
            )
            solved_y, *_ = np.linalg.lstsq(
                source_design,
                target_points[:, 1].astype(np.float64),
                rcond=None,
            )
            affine_candidate = np.asarray(
                [solved_x, solved_y],
                dtype=np.float64,
            )
        except (TypeError, ValueError, np.linalg.LinAlgError):
            affine_candidate = None
        if (
            affine_candidate is not None
            and affine_candidate.shape == (2, 3)
            and np.isfinite(affine_candidate).all()
        ):
            similarity_projection = cv2.transform(
                source_points.reshape(1, -1, 2),
                landmark_transform,
            )[0]
            affine_projection = cv2.transform(
                source_points.reshape(1, -1, 2),
                affine_candidate,
            )[0]
            similarity_errors = np.linalg.norm(
                similarity_projection - target_points,
                axis=1,
            )
            affine_errors = np.linalg.norm(
                affine_projection - target_points,
                axis=1,
            )
            similarity_max = float(np.max(similarity_errors))
            affine_max = float(np.max(affine_errors))
            similarity_rms = float(
                math.sqrt(float(np.mean(np.square(similarity_errors))))
            )
            affine_rms = float(
                math.sqrt(float(np.mean(np.square(affine_errors))))
            )
            singular_values = np.linalg.svd(
                affine_candidate[:, :2],
                compute_uv=False,
            )
            smallest_scale = float(np.min(singular_values))
            largest_scale = float(np.max(singular_values))
            anisotropy = largest_scale / max(1e-8, smallest_scale)
            determinant = float(np.linalg.det(affine_candidate[:, :2]))
            residual_ratio = similarity_max / max(
                1.0,
                _landmark_span(target_points),
            )
            minimum_gain = float(
                np.clip(pose_aware_affine_min_improvement, 0.0, 0.75)
            )
            maximum_anisotropy = max(
                1.0,
                float(pose_aware_affine_max_anisotropy),
            )
            affine_safe = bool(
                determinant > 0.0
                and 0.72 <= smallest_scale <= 1.40
                and 0.72 <= largest_scale <= 1.40
                and anisotropy <= maximum_anisotropy
                and residual_ratio
                >= max(0.0, float(pose_aware_affine_min_residual_ratio))
                and affine_max <= similarity_max * (1.0 - minimum_gain)
                and affine_rms <= similarity_rms * (1.0 - minimum_gain)
            )
            if diagnostics is not None:
                diagnostics["poseAwareAffineCandidate"] = True
                diagnostics["poseAwareAffineAnisotropy"] = anisotropy
                diagnostics["poseAwareAffineSimilarityMax"] = similarity_max
                diagnostics["poseAwareAffineMax"] = affine_max
                diagnostics["poseAwareAffineSimilarityRms"] = similarity_rms
                diagnostics["poseAwareAffineRms"] = affine_rms
                diagnostics["poseAwareAffineAccepted"] = affine_safe
            if affine_safe:
                transform = affine_candidate
                transport_mode = "pose-aware-affine"
    if diagnostics is not None:
        diagnostics["transportMode"] = transport_mode
        diagnostics["canonicalBlendWeight"] = blend_weight
    if transform is None or transform.shape != (2, 3) or not np.isfinite(transform).all():
        return None
    linear = transform[:, :2]
    determinant = float(np.linalg.det(linear))
    if determinant <= 0.0:
        return None
    scale = math.sqrt(determinant)
    if not 0.72 <= scale <= 1.40:
        return None
    projected = cv2.transform(source_points.reshape(1, -1, 2), transform)[0]
    reprojection_error = np.linalg.norm(projected - target_points, axis=1)
    target_span = _landmark_span(target_points)
    max_reprojection_error = float(np.max(reprojection_error))
    normalized_reprojection_error = max_reprojection_error / max(1.0, target_span)
    if diagnostics is not None:
        diagnostics["landmarkResidualRatio"] = normalized_reprojection_error
        diagnostics["landmarkResidualPixels"] = max_reprojection_error
    if max_reprojection_error > max(
        2.5,
        target_span * float(max_landmark_residual_ratio),
    ):
        if diagnostics is not None:
            diagnostics["reason"] = "nonrigid-landmark-motion"
        return None

    height, width = current.shape[:2]
    source_span = _landmark_span(source_points)
    side = max(48, int(round(max(source_span, target_span) * 4.0)))
    source_center = (source_points.min(axis=0) + source_points.max(axis=0)) * 0.5
    target_center = (target_points.min(axis=0) + target_points.max(axis=0)) * 0.5
    source_roi = _bounded_square_roi(
        width,
        height,
        float(source_center[0]),
        float(source_center[1]),
        side,
        vertical_anchor=0.55,
    )
    target_roi = _bounded_square_roi(
        width,
        height,
        float(target_center[0]),
        float(target_center[1]),
        side,
        vertical_anchor=0.55,
    )
    source_left, source_top, source_right, source_bottom = source_roi
    target_left, target_top, target_right, target_bottom = target_roi
    if source_right <= source_left or source_bottom <= source_top:
        return None
    if target_right <= target_left or target_bottom <= target_top:
        return None

    # Convert the global affine transform into source-crop -> target-crop
    # coordinates, then warp only the face-sized residual.
    local_transform = transform.copy()
    local_transform[:, 2] += linear @ np.asarray(
        [source_left, source_top], dtype=np.float64
    )
    local_transform[:, 2] -= np.asarray([target_left, target_top], dtype=np.float64)
    return ResidualWarpPlan(
        current=current,
        previous=previous,
        swapped=swapped,
        source_points=source_points,
        target_points=target_points,
        local_transform=local_transform,
        source_roi=(source_left, source_top, source_right, source_bottom),
        target_roi=(target_left, target_top, target_right, target_bottom),
        interpolation=int(interpolation),
        continuous_linear=bool(continuous_linear),
        feature_patch_lock_strength=float(feature_patch_lock_strength),
        feature_patch_max_mae=float(feature_patch_max_mae),
        feature_patch_max_p90=float(feature_patch_max_p90),
    )


def _render_prior_swap_residual(
    plan: ResidualWarpPlan,
    *,
    diagnostics: dict[str, Any] | None = None,
) -> np.ndarray:
    """Materialize a validated residual plan without changing its decisions."""
    current = plan.current
    previous = plan.previous
    swapped = plan.swapped
    source_points = plan.source_points
    target_points = plan.target_points
    local_transform = plan.local_transform
    source_left, source_top, source_right, source_bottom = plan.source_roi
    target_left, target_top, target_right, target_bottom = plan.target_roi
    target_width = target_right - target_left
    target_height = target_bottom - target_top
    interpolation = int(plan.interpolation)
    residual = cv2.subtract(
        swapped[source_top:source_bottom, source_left:source_right],
        previous[source_top:source_bottom, source_left:source_right],
        dtype=cv2.CV_16S,
    )
    if plan.continuous_linear and interpolation == cv2.INTER_LINEAR:
        warped_residual = _warp_affine_continuous_linear(
            residual,
            local_transform,
            (target_width, target_height),
        )
        if diagnostics is not None:
            diagnostics["residualSampler"] = "continuous-four-tap-linear"
    else:
        warped_residual = cv2.warpAffine(
            residual,
            local_transform,
            (target_width, target_height),
            flags=interpolation,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
    output = np.ascontiguousarray(current, dtype=np.uint8).copy()
    current_region = output[target_top:target_bottom, target_left:target_right]
    # OpenCV's typed saturating add avoids three full ROI float conversions;
    # it is bit-identical for the integer residual and roughly 3x faster on a
    # 720p portrait face ROI than NumPy float/clip/uint8 round-tripping.
    cv2.add(
        current_region,
        warped_residual,
        dst=current_region,
        dtype=cv2.CV_8U,
    )
    patch_strength = float(np.clip(plan.feature_patch_lock_strength, 0.0, 1.0))
    if patch_strength > 0.0:
        # Residual addition intentionally preserves current expression, but
        # tiny alignment differences can cancel or double exact eye/lip detail.
        # Inside unchanged feature islands, softly converge toward the warped
        # exact rendered patch. Each island is independently photometrically
        # gated; a blink, mouth change, or incoming foreground object keeps the
        # ordinary current-source-plus-residual result.
        source_region = previous[
            source_top:source_bottom,
            source_left:source_right,
        ]
        swapped_region = swapped[
            source_top:source_bottom,
            source_left:source_right,
        ]
        warped_source = cv2.warpAffine(
            source_region,
            local_transform,
            (target_width, target_height),
            flags=interpolation,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        warped_swapped = cv2.warpAffine(
            swapped_region,
            local_transform,
            (target_width, target_height),
            flags=interpolation,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        valid = cv2.warpAffine(
            np.full(source_region.shape[:2], 255, dtype=np.uint8),
            local_transform,
            (target_width, target_height),
            flags=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        local_points = target_points - np.asarray(
            [target_left, target_top], dtype=np.float32
        )
        eye_span = max(4.0, float(np.linalg.norm(local_points[1] - local_points[0])))
        mouth_span = max(3.0, float(np.linalg.norm(local_points[4] - local_points[3])))
        feature_specs = (
            (local_points[0], 0.20 * eye_span, 0.13 * eye_span),
            (local_points[1], 0.20 * eye_span, 0.13 * eye_span),
            (
                (local_points[3] + local_points[4]) * 0.5,
                0.68 * mouth_span,
                0.20 * eye_span,
            ),
        )
        accepted_mask = np.zeros((target_height, target_width), dtype=np.uint8)
        current_source_region = current[
            target_top:target_bottom,
            target_left:target_right,
        ]
        accepted_count = 0
        for center, radius_x, radius_y in feature_specs:
            island = np.zeros_like(accepted_mask)
            cv2.ellipse(
                island,
                (int(round(float(center[0]))), int(round(float(center[1])))),
                (
                    max(2, int(round(float(radius_x)))),
                    max(2, int(round(float(radius_y)))),
                ),
                0.0,
                0.0,
                360.0,
                255,
                thickness=-1,
                lineType=cv2.LINE_AA,
            )
            island = cv2.bitwise_and(island, valid)
            pixels = island >= 128
            if int(np.count_nonzero(pixels)) < 12:
                continue
            difference = np.mean(
                np.abs(
                    current_source_region[pixels].astype(np.float32)
                    - warped_source[pixels].astype(np.float32)
                ),
                axis=1,
            )
            feature_mae = float(np.mean(difference))
            feature_p90 = float(np.percentile(difference, 90.0))
            if (
                math.isfinite(feature_mae)
                and math.isfinite(feature_p90)
                and feature_mae <= float(plan.feature_patch_max_mae)
                and feature_p90 <= float(plan.feature_patch_max_p90)
            ):
                accepted_mask = cv2.max(accepted_mask, island)
                accepted_count += 1
        if accepted_count:
            blur_sigma = max(0.8, eye_span * 0.018)
            accepted_mask = cv2.GaussianBlur(
                accepted_mask,
                (0, 0),
                sigmaX=blur_sigma,
                sigmaY=blur_sigma,
            )
            alpha = (
                accepted_mask.astype(np.float32)
                * (patch_strength / 255.0)
            )[..., None]
            blended = (
                current_region.astype(np.float32) * (1.0 - alpha)
                + warped_swapped.astype(np.float32) * alpha
            )
            current_region[:] = np.clip(blended, 0.0, 255.0).astype(np.uint8)
        if diagnostics is not None:
            diagnostics["featurePatchAcceptedCount"] = int(accepted_count)
    return output


def _time_normalized_current_weight(
    fallback_current_weight: float,
    delta_seconds: float | None,
    half_life_seconds: float,
) -> float:
    """Convert one wall-clock smoothing half-life into a per-frame weight.

    A fixed per-frame blend behaves very differently at 24, 30, and 60 fps.
    This conversion gives each source the same response in seconds while
    retaining the configured legacy weight whenever reliable timing is absent.
    """
    fallback = float(np.clip(fallback_current_weight, 0.0, 1.0))
    try:
        delta = float(delta_seconds) if delta_seconds is not None else math.nan
        half_life = float(half_life_seconds)
    except (TypeError, ValueError, OverflowError):
        return fallback
    if (
        not math.isfinite(delta)
        or not math.isfinite(half_life)
        or delta <= 0.0
        or half_life <= 0.0
    ):
        return fallback
    history_weight = math.exp(-math.log(2.0) * delta / half_life)
    return float(np.clip(1.0 - history_weight, 0.0, 1.0))


def _quality_preserving_output_cadence(source_fps: float, maximum_fps: float = 0.0):
    """Bound workload with uniform source-frame selection, never blended faces.

    Only frame cadence changes. Spatial resolution, model, restoration strength,
    encoder settings and elapsed playback time are unchanged. Zero disables it.
    A whole-number stride avoids alternating intervals (e.g. 50 -> 25, not 30).
    """
    source = float(source_fps)
    if not math.isfinite(source) or source <= 0:
        raise ValueError('source FPS must be finite and positive')
    try:
        limit = float(maximum_fps)
    except (TypeError, ValueError, OverflowError):
        limit = 0.0
    stride = (max(1, int(math.ceil(source / limit - 1e-4)))
              if math.isfinite(limit) and limit > 0 else 1)
    return source / stride, stride


def _apply_source_fps_runtime_cadence(
    runtime: dict[str, Any],
    fps: float,
) -> dict[str, int]:
    """Resolve time-based update rates into source-specific frame intervals.

    The legacy frame-count settings remain the fallback. Positive Hz values
    opt a session into stable wall-clock behavior across different source FPS.
    """
    source_fps = max(1.0, float(fps))
    resolved: dict[str, int] = {}

    def interval_from_hz(hz_key: str, frame_key: str, minimum: int = 1) -> None:
        try:
            hz = float(runtime.get(hz_key, 0.0) or 0.0)
        except (TypeError, ValueError, OverflowError):
            hz = 0.0
        if math.isfinite(hz) and hz > 0.0:
            interval = max(minimum, int(round(source_fps / hz)))
            runtime[frame_key] = interval
            resolved[frame_key] = interval

    interval_from_hz("targetDetectHz", "targetDetectIntervalFrames")
    interval_from_hz("identityCheckHz", "identityCheckIntervalFrames")

    try:
        parser_hz = float(runtime.get("temporalFaceParserHz", 0.0) or 0.0)
    except (TypeError, ValueError, OverflowError):
        parser_hz = 0.0
    if math.isfinite(parser_hz) and parser_hz > 0.0:
        parser_interval = max(1, int(round(source_fps / parser_hz)))
        parser_skip = max(0, parser_interval - 1)
        runtime["temporalFaceParserSkipFrames"] = parser_skip
        resolved["temporalFaceParserSkipFrames"] = parser_skip
    return resolved


def _render_prior_swap_residual_with_confidence(
    plan: ResidualWarpPlan,
    *,
    local_change_low: float = 3.0,
    local_change_high: float = 18.0,
    diagnostics: dict[str, Any] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Render a transported face ROI plus a region-independent safety field.

    The field is derived from correspondence between the current source and
    the transported prior source. It therefore works for any moving feature,
    occluder, pose change, or mask boundary instead of naming facial regions.
    Uniform exposure drift is removed before measuring local disagreement.
    """
    current = plan.current
    previous = plan.previous
    source_left, source_top, source_right, source_bottom = plan.source_roi
    target_left, target_top, target_right, target_bottom = plan.target_roi
    target_width = target_right - target_left
    target_height = target_bottom - target_top
    source_region = previous[source_top:source_bottom, source_left:source_right]
    residual = cv2.subtract(
        plan.swapped[source_top:source_bottom, source_left:source_right],
        source_region,
        dtype=cv2.CV_16S,
    )
    if plan.continuous_linear and int(plan.interpolation) == cv2.INTER_LINEAR:
        warped_residual = _warp_affine_continuous_linear(
            residual,
            plan.local_transform,
            (target_width, target_height),
        )
    else:
        warped_residual = cv2.warpAffine(
            residual,
            plan.local_transform,
            (target_width, target_height),
            flags=int(plan.interpolation),
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
    predicted = np.ascontiguousarray(
        current[target_top:target_bottom, target_left:target_right]
    ).copy()
    cv2.add(predicted, warped_residual, dst=predicted, dtype=cv2.CV_8U)
    confidence_scale = min(
        1.0,
        128.0 / max(1.0, float(max(target_width, target_height))),
    )
    confidence_size = (
        max(8, int(round(target_width * confidence_scale))),
        max(8, int(round(target_height * confidence_scale))),
    )
    confidence_transform = np.asarray(plan.local_transform, dtype=np.float64).copy()
    confidence_transform[0, :] *= confidence_size[0] / float(target_width)
    confidence_transform[1, :] *= confidence_size[1] / float(target_height)
    warped_source = cv2.warpAffine(
        source_region,
        confidence_transform,
        confidence_size,
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    valid = cv2.warpAffine(
        np.full(source_region.shape[:2], 255, dtype=np.uint8),
        confidence_transform,
        confidence_size,
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    current_region = current[target_top:target_bottom, target_left:target_right]
    if current_region.shape[:2] != (confidence_size[1], confidence_size[0]):
        current_region = cv2.resize(
            current_region,
            confidence_size,
            interpolation=cv2.INTER_AREA,
        )
    valid_pixels = valid >= 254
    confidence = np.zeros((confidence_size[1], confidence_size[0]), dtype=np.float32)
    if int(np.count_nonzero(valid_pixels)) >= 32:
        source_delta = (
            current_region.astype(np.float32) - warped_source.astype(np.float32)
        )
        exposure = np.median(source_delta[valid_pixels], axis=0)
        exposure = np.clip(exposure, -8.0, 8.0)
        local_error = np.mean(np.abs(source_delta - exposure), axis=2)
        # Spatial averaging rejects compression speckle without hiding thin
        # real changes such as hair, fingers, eyelids, or a moving mask edge.
        local_error = cv2.GaussianBlur(local_error, (3, 3), 0)
        low = max(0.0, float(local_change_low))
        high = max(low + 1e-6, float(local_change_high))
        changed = np.clip((local_error - low) / (high - low), 0.0, 1.0)
        changed = changed * changed * (3.0 - 2.0 * changed)
        confidence = (1.0 - changed) * valid_pixels.astype(np.float32)
        confidence = cv2.erode(confidence, np.ones((3, 3), dtype=np.uint8))
        confidence = cv2.GaussianBlur(confidence, (5, 5), 0)
        confidence *= valid_pixels.astype(np.float32)
        if diagnostics is not None:
            diagnostics["localConfidenceMean"] = float(np.mean(confidence[valid_pixels]))
            diagnostics["localConfidenceP10"] = float(
                np.percentile(confidence[valid_pixels], 10.0)
            )
            diagnostics["localAppearanceP95"] = float(
                np.percentile(local_error[valid_pixels], 95.0)
            )
    if confidence.shape != (target_height, target_width):
        confidence = cv2.resize(
            confidence,
            (target_width, target_height),
            interpolation=cv2.INTER_LINEAR,
        )
    return predicted, confidence


def _warp_prior_swap_residual(
    current_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    *,
    max_landmark_residual_ratio: float = 0.12,
    interpolation: int = cv2.INTER_LINEAR,
    continuous_linear: bool = False,
    feature_patch_lock_strength: float = 0.0,
    feature_patch_max_mae: float = 16.0,
    feature_patch_max_p90: float = 34.0,
    source_to_canonical: np.ndarray | None = None,
    target_to_canonical: np.ndarray | None = None,
    canonical_blend_weight: float = 1.0,
    pose_aware_affine: bool = False,
    pose_aware_affine_max_anisotropy: float = 1.12,
    pose_aware_affine_min_improvement: float = 0.12,
    pose_aware_affine_min_residual_ratio: float = 0.008,
    diagnostics: dict[str, Any] | None = None,
) -> np.ndarray | None:
    """Synchronous compatibility wrapper for plan + exact materialization."""
    plan = _plan_prior_swap_residual(
        current_rgb,
        previous_rgb,
        previous_swapped_rgb,
        previous_kps,
        current_kps,
        max_landmark_residual_ratio=max_landmark_residual_ratio,
        interpolation=interpolation,
        continuous_linear=continuous_linear,
        feature_patch_lock_strength=feature_patch_lock_strength,
        feature_patch_max_mae=feature_patch_max_mae,
        feature_patch_max_p90=feature_patch_max_p90,
        source_to_canonical=source_to_canonical,
        target_to_canonical=target_to_canonical,
        canonical_blend_weight=canonical_blend_weight,
        pose_aware_affine=pose_aware_affine,
        pose_aware_affine_max_anisotropy=pose_aware_affine_max_anisotropy,
        pose_aware_affine_min_improvement=pose_aware_affine_min_improvement,
        pose_aware_affine_min_residual_ratio=pose_aware_affine_min_residual_ratio,
        diagnostics=diagnostics,
    )
    if plan is None:
        return None
    return _render_prior_swap_residual(plan, diagnostics=diagnostics)


def _stabilize_exact_output_with_prior(
    current_rgb: np.ndarray,
    exact_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    *,
    current_weight: float = 0.85,
    max_face_mae: float = 14.0,
    max_face_p90: float = 32.0,
    max_patch_mae: float = 46.0,
    max_landmark_residual_ratio: float = 0.12,
    dense_flow: bool = False,
    delta_seconds: float | None = None,
    half_life_seconds: float = 0.020,
    local_change_low: float = 3.0,
    local_change_high: float = 18.0,
    motion_low_per_second: float = 0.20,
    motion_high_per_second: float = 1.50,
    pose_aware_affine: bool = True,
    diagnostics: dict[str, Any] | None = None,
) -> np.ndarray:
    """Stabilize any safe face region with time-normalized local confidence."""
    exact = np.ascontiguousarray(exact_rgb)
    # The per-pixel confidence field below supersedes the former all-or-nothing
    # appearance preflight. A cut or changed identity produces near-zero local
    # confidence and therefore the exact current frame, while an isolated
    # expression or occluder no longer disables stabilization everywhere else.
    try:
        source_points = np.asarray(previous_kps, dtype=np.float32).reshape(5, 2)
        target_points = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
        span = max(1.0, _landmark_span(target_points))
        displacement_ratio = float(
            np.mean(np.linalg.norm(target_points - source_points, axis=1)) / span
        )
    except (TypeError, ValueError):
        displacement_ratio = math.inf
    try:
        delta = float(delta_seconds) if delta_seconds is not None else math.nan
    except (TypeError, ValueError, OverflowError):
        delta = math.nan
    if math.isfinite(displacement_ratio) and math.isfinite(delta) and delta > 0.0:
        motion_per_second = displacement_ratio / delta
        motion_low = max(0.0, float(motion_low_per_second))
        motion_high = max(motion_low + 1e-6, float(motion_high_per_second))
        if motion_per_second >= motion_high:
            if diagnostics is not None:
                diagnostics["exactStabilizationReason"] = "high-motion-current"
                diagnostics["exactStabilizationMotionPerSecond"] = motion_per_second
            return exact
        motion_fraction = float(np.clip(
            (motion_per_second - motion_low) / (motion_high - motion_low),
            0.0,
            1.0,
        ))
        motion_fraction = motion_fraction * motion_fraction * (
            3.0 - 2.0 * motion_fraction
        )
        motion_confidence = 1.0 - motion_fraction
    else:
        motion_per_second = math.nan
        motion_confidence = 1.0
    warp_diagnostics: dict[str, Any] = {}
    confidence: np.ndarray | None = None
    blend_roi: tuple[int, int, int, int] | None = None
    region_local_result = False
    if dense_flow:
        confidence_holder: list[np.ndarray] = []
        predicted = _warp_prior_swap_residual_dense_flow(
            current_rgb,
            previous_rgb,
            previous_swapped_rgb,
            previous_kps,
            current_kps,
            flow_size=128,
            confidence_out=confidence_holder,
            diagnostics=warp_diagnostics,
        )
        if confidence_holder:
            confidence = confidence_holder[0]
    else:
        plan = _plan_prior_swap_residual(
            current_rgb,
            previous_rgb,
            previous_swapped_rgb,
            previous_kps,
            current_kps,
            max_landmark_residual_ratio=max_landmark_residual_ratio,
            pose_aware_affine=pose_aware_affine,
            diagnostics=warp_diagnostics,
        )
        if plan is None:
            predicted = None
        else:
            blend_roi = plan.target_roi
            predicted, confidence = _render_prior_swap_residual_with_confidence(
                plan,
                local_change_low=local_change_low,
                local_change_high=local_change_high,
                diagnostics=warp_diagnostics,
            )
            region_local_result = True
    if predicted is None or confidence is None:
        if diagnostics is not None:
            diagnostics["exactStabilizationReason"] = str(
                warp_diagnostics.get("reason") or "warp"
            )
        return exact

    weight = _time_normalized_current_weight(
        current_weight,
        delta_seconds,
        half_life_seconds,
    )
    history_weight = (1.0 - weight) * motion_confidence
    if blend_roi is None:
        try:
            points = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
            span = max(4.0, _landmark_span(points))
            height, width = exact.shape[:2]
            blend_roi = (
                max(0, int(math.floor(float(np.min(points[:, 0])) - span * 0.65))),
                max(0, int(math.floor(float(np.min(points[:, 1])) - span * 0.65))),
                min(width, int(math.ceil(float(np.max(points[:, 0])) + span * 0.65))),
                min(height, int(math.ceil(float(np.max(points[:, 1])) + span * 0.65))),
            )
        except (TypeError, ValueError):
            blend_roi = (0, 0, exact.shape[1], exact.shape[0])
    left, top, right, bottom = blend_roi
    blended = exact.copy()
    if right > left and bottom > top:
        confidence_region = (
            confidence if region_local_result
            else confidence[top:bottom, left:right]
        )
        history_alpha = np.clip(
            confidence_region * history_weight,
            0.0,
            1.0,
        ).astype(np.float32, copy=False)
        blended[top:bottom, left:right] = cv2.blendLinear(
            exact[top:bottom, left:right],
            (
                predicted if region_local_result
                else predicted[top:bottom, left:right]
            ),
            1.0 - history_alpha,
            history_alpha,
        )
    if diagnostics is not None:
        diagnostics["exactStabilizationReason"] = "accepted"
        diagnostics["exactStabilizationCurrentWeight"] = weight
        diagnostics["exactStabilizationHistoryWeight"] = history_weight
        diagnostics["exactStabilizationMotionPerSecond"] = motion_per_second
        diagnostics.update(warp_diagnostics)
    return np.ascontiguousarray(blended)


def _stabilize_exact_mouth_with_prior(
    current_rgb: np.ndarray,
    exact_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    *,
    current_weight: float = 0.80,
    max_mae: float = 10.0,
    max_p90: float = 24.0,
    diagnostics: dict[str, Any] | None = None,
) -> np.ndarray:
    """Stabilize GPEN mouth detail without freezing the source expression.

    A five-point similarity maps the previous generated *residual* into the
    current frame. Only a compact feathered mouth island can contribute, and
    only while the current source mouth still agrees with the motion-warped
    previous source. Teeth, speech, food, hands, cuts, and large expressions
    therefore keep the untouched current render.
    """
    current = np.asarray(current_rgb)
    exact = np.ascontiguousarray(exact_rgb)
    previous = np.asarray(previous_rgb)
    swapped = np.asarray(previous_swapped_rgb)
    if (
        current.ndim != 3
        or current.shape[-1] != 3
        or current.shape != exact.shape
        or current.shape != previous.shape
        or current.shape != swapped.shape
        or current.dtype != np.uint8
        or exact.dtype != np.uint8
        or previous.dtype != np.uint8
        or swapped.dtype != np.uint8
    ):
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "shape"
        return exact
    try:
        source_points = np.asarray(previous_kps, dtype=np.float32).reshape(5, 2)
        target_points = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
    except (TypeError, ValueError):
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "landmarks"
        return exact
    if not np.isfinite(source_points).all() or not np.isfinite(target_points).all():
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "landmarks"
        return exact
    transform, _ = cv2.estimateAffinePartial2D(
        source_points,
        target_points,
        method=cv2.LMEDS,
    )
    if transform is None or transform.shape != (2, 3) or not np.isfinite(transform).all():
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "transform"
        return exact
    linear = transform[:, :2]
    determinant = float(np.linalg.det(linear))
    if not math.isfinite(determinant) or determinant <= 0.0:
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "transform"
        return exact
    scale = math.sqrt(determinant)
    if not 0.78 <= scale <= 1.28:
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "scale"
        return exact

    height, width = current.shape[:2]
    source_span = max(8.0, _landmark_span(source_points))
    target_span = max(8.0, _landmark_span(target_points))
    source_center = np.mean(source_points[3:5], axis=0)
    target_center = np.mean(target_points[3:5], axis=0)
    # Include the lips and the immediately adjacent restored skin, but not the
    # nose or jaw where a stale residual is more visible during head rotation.
    source_rx = max(5, int(round(source_span * 0.34)))
    source_ry = max(4, int(round(source_span * 0.19)))
    target_rx = max(5, int(round(target_span * 0.34)))
    target_ry = max(4, int(round(target_span * 0.19)))
    source_left = max(0, int(math.floor(float(source_center[0]) - source_rx - 4)))
    source_top = max(0, int(math.floor(float(source_center[1]) - source_ry - 4)))
    source_right = min(width, int(math.ceil(float(source_center[0]) + source_rx + 5)))
    source_bottom = min(height, int(math.ceil(float(source_center[1]) + source_ry + 5)))
    target_left = max(0, int(math.floor(float(target_center[0]) - target_rx - 5)))
    target_top = max(0, int(math.floor(float(target_center[1]) - target_ry - 5)))
    target_right = min(width, int(math.ceil(float(target_center[0]) + target_rx + 6)))
    target_bottom = min(height, int(math.ceil(float(target_center[1]) + target_ry + 6)))
    if min(
        source_right - source_left,
        source_bottom - source_top,
        target_right - target_left,
        target_bottom - target_top,
    ) <= 6:
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "roi"
        return exact

    local = np.asarray(transform, dtype=np.float64).copy()
    local[:, 2] += linear @ np.asarray([source_left, source_top], dtype=np.float64)
    local[:, 2] -= np.asarray([target_left, target_top], dtype=np.float64)
    target_width = target_right - target_left
    target_height = target_bottom - target_top
    previous_patch = previous[source_top:source_bottom, source_left:source_right]
    previous_residual = cv2.subtract(
        swapped[source_top:source_bottom, source_left:source_right],
        previous_patch,
        dtype=cv2.CV_16S,
    )
    warped_source = cv2.warpAffine(
        previous_patch,
        local,
        (target_width, target_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    warped_residual = cv2.warpAffine(
        previous_residual,
        local,
        (target_width, target_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    valid = cv2.warpAffine(
        np.full(previous_patch.shape[:2], 255, dtype=np.uint8),
        local,
        (target_width, target_height),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    center_local = (
        int(round(float(target_center[0]) - target_left)),
        int(round(float(target_center[1]) - target_top)),
    )
    core = np.zeros((target_height, target_width), dtype=np.uint8)
    cv2.ellipse(
        core,
        center_local,
        (target_rx, target_ry),
        0.0,
        0.0,
        360.0,
        255,
        thickness=-1,
        lineType=cv2.LINE_AA,
    )
    core = cv2.bitwise_and(core, valid)
    pixels = core >= 192
    if int(np.count_nonzero(pixels)) < 24:
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "coverage"
        return exact
    current_patch = current[target_top:target_bottom, target_left:target_right]
    source_delta = current_patch[pixels].astype(np.float32) - warped_source[pixels].astype(np.float32)
    # Remove a uniform exposure shift before judging expression/occlusion
    # change. Lighting should not disable stability, local structure should.
    # Compensate only a small illumination drift. Treating an arbitrary
    # uniform mouth-region change as exposure would misclassify a newly
    # introduced object or a large open-mouth transition as safe history.
    exposure = np.clip(np.median(source_delta, axis=0), -8.0, 8.0)
    source_error = np.mean(np.abs(source_delta - exposure), axis=1)
    mouth_mae = float(np.mean(source_error))
    mouth_p90 = float(np.percentile(source_error, 90.0))
    if diagnostics is not None:
        diagnostics["exactMouthMae"] = mouth_mae
        diagnostics["exactMouthP90"] = mouth_p90
    if (
        not math.isfinite(mouth_mae)
        or not math.isfinite(mouth_p90)
        or mouth_mae > float(max_mae)
        or mouth_p90 > float(max_p90)
    ):
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "appearance"
        return exact

    predicted = cv2.add(
        current_patch,
        warped_residual,
        dtype=cv2.CV_8U,
    )
    weight = float(np.clip(current_weight, 0.65, 1.0))
    # Fade history continuously as the current source diverges rather than
    # producing a hard threshold transition near the safety boundary.
    change_fraction = max(
        mouth_mae / max(1e-6, float(max_mae)),
        mouth_p90 / max(1e-6, float(max_p90)),
    )
    history_weight = (1.0 - weight) * float(
        np.clip(1.0 - change_fraction, 0.0, 1.0)
    )
    if history_weight <= 1e-4:
        if diagnostics is not None:
            diagnostics["exactMouthReason"] = "current-authority"
        return exact
    feather = cv2.GaussianBlur(
        core,
        (0, 0),
        sigmaX=max(0.8, min(target_rx, target_ry) * 0.16),
    )
    alpha = (feather.astype(np.float32) * (history_weight / 255.0))[..., None]
    result = exact.copy()
    exact_patch = result[target_top:target_bottom, target_left:target_right]
    exact_patch[:] = np.clip(
        exact_patch.astype(np.float32) * (1.0 - alpha)
        + predicted.astype(np.float32) * alpha,
        0.0,
        255.0,
    ).astype(np.uint8)
    if diagnostics is not None:
        diagnostics["exactMouthReason"] = "accepted"
        diagnostics["exactMouthHistoryWeight"] = history_weight
    return np.ascontiguousarray(result)


def _warp_prior_swap_residual_dense_flow(
    current_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    *,
    flow_size: int = 192,
    confidence_out: list[np.ndarray] | None = None,
    diagnostics: dict[str, Any] | None = None,
) -> np.ndarray | None:
    """Transport the prior exact residual with local, occlusion-aware flow.

    Five landmarks provide only the coarse pose transform.  A bidirectional
    dense field then follows local eye, mouth, cheek and jaw motion inside the
    face ROI.  Pixels without a consistent current->anchor correspondence—or
    whose warped source appearance disagrees with the current frame—receive no
    old residual, preserving newly introduced foreground objects.

    This is an experimental opt-in path.  Failure is conservative and returns
    ``None`` so the caller performs the unchanged exact render.
    """
    started = time.perf_counter()
    current = np.asarray(current_rgb)
    previous = np.asarray(previous_rgb)
    swapped = np.asarray(previous_swapped_rgb)
    if (
        current.ndim != 3
        or current.shape[-1] != 3
        or current.shape != previous.shape
        or current.shape != swapped.shape
        or current.dtype != np.uint8
        or previous.dtype != np.uint8
        or swapped.dtype != np.uint8
    ):
        return None
    try:
        source_points = np.asarray(previous_kps, dtype=np.float32).reshape(-1, 2)
        target_points = np.asarray(current_kps, dtype=np.float32).reshape(-1, 2)
    except (TypeError, ValueError):
        return None
    if (
        source_points.shape != (5, 2)
        or target_points.shape != (5, 2)
        or not np.isfinite(source_points).all()
        or not np.isfinite(target_points).all()
    ):
        return None

    transform, _inliers = cv2.estimateAffinePartial2D(
        source_points,
        target_points,
        method=cv2.LMEDS,
    )
    if transform is None or transform.shape != (2, 3) or not np.isfinite(transform).all():
        return None
    linear = transform[:, :2]
    determinant = float(np.linalg.det(linear))
    if determinant <= 0.0:
        return None
    scale = math.sqrt(determinant)
    if not 0.72 <= scale <= 1.40:
        return None

    height, width = current.shape[:2]
    source_span = _landmark_span(source_points)
    target_span = _landmark_span(target_points)
    side = max(48, int(round(max(source_span, target_span) * 4.0)))
    source_center = (source_points.min(axis=0) + source_points.max(axis=0)) * 0.5
    target_center = (target_points.min(axis=0) + target_points.max(axis=0)) * 0.5
    source_left, source_top, source_right, source_bottom = _bounded_square_roi(
        width,
        height,
        float(source_center[0]),
        float(source_center[1]),
        side,
        vertical_anchor=0.55,
    )
    target_left, target_top, target_right, target_bottom = _bounded_square_roi(
        width,
        height,
        float(target_center[0]),
        float(target_center[1]),
        side,
        vertical_anchor=0.55,
    )
    if source_right <= source_left or source_bottom <= source_top:
        return None
    if target_right <= target_left or target_bottom <= target_top:
        return None

    local_transform = transform.copy()
    local_transform[:, 2] += linear @ np.asarray(
        [source_left, source_top], dtype=np.float64
    )
    local_transform[:, 2] -= np.asarray([target_left, target_top], dtype=np.float64)
    target_width = target_right - target_left
    target_height = target_bottom - target_top
    source_region = previous[source_top:source_bottom, source_left:source_right]
    residual = cv2.subtract(
        swapped[source_top:source_bottom, source_left:source_right],
        source_region,
        dtype=cv2.CV_16S,
    )
    affine_source = cv2.warpAffine(
        source_region,
        local_transform,
        (target_width, target_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    affine_residual = cv2.warpAffine(
        residual,
        local_transform,
        (target_width, target_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    current_region = current[target_top:target_bottom, target_left:target_right]

    maximum_flow_edge = max(64, min(256, int(flow_size)))
    resize_scale = min(
        1.0,
        maximum_flow_edge / float(max(target_width, target_height)),
    )
    flow_width = max(48, int(round(target_width * resize_scale)))
    flow_height = max(48, int(round(target_height * resize_scale)))
    current_gray = cv2.cvtColor(current_region, cv2.COLOR_RGB2GRAY)
    anchor_gray = cv2.cvtColor(affine_source, cv2.COLOR_RGB2GRAY)
    if (flow_width, flow_height) != (target_width, target_height):
        current_small = cv2.resize(
            current_gray,
            (flow_width, flow_height),
            interpolation=cv2.INTER_AREA,
        )
        anchor_small = cv2.resize(
            anchor_gray,
            (flow_width, flow_height),
            interpolation=cv2.INTER_AREA,
        )
    else:
        current_small = current_gray
        anchor_small = anchor_gray

    flow_started = time.perf_counter()
    forward_solver = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)
    reverse_solver = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_FAST)
    current_to_anchor = forward_solver.calc(current_small, anchor_small, None)
    anchor_to_current = reverse_solver.calc(anchor_small, current_small, None)
    if diagnostics is not None:
        diagnostics["denseFlowMs"] = (time.perf_counter() - flow_started) * 1000.0
    if (
        current_to_anchor is None
        or anchor_to_current is None
        or not np.isfinite(current_to_anchor).all()
        or not np.isfinite(anchor_to_current).all()
    ):
        if diagnostics is not None:
            diagnostics["reason"] = "dense-flow-invalid"
        return None

    yy, xx = np.mgrid[0:flow_height, 0:flow_width].astype(np.float32)
    map_x = xx + current_to_anchor[..., 0]
    map_y = yy + current_to_anchor[..., 1]
    sampled_reverse = cv2.remap(
        anchor_to_current,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    sampled_anchor = cv2.remap(
        anchor_small,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    fb_error = np.linalg.norm(current_to_anchor + sampled_reverse, axis=2)
    magnitude = np.linalg.norm(current_to_anchor, axis=2)
    photometric_error = cv2.absdiff(current_small, sampled_anchor).astype(np.float32)
    grid_scale = max(flow_width / max(target_width, 1), flow_height / max(target_height, 1))
    supported = (
        (map_x >= 1.0)
        & (map_x <= flow_width - 2.0)
        & (map_y >= 1.0)
        & (map_y <= flow_height - 2.0)
        & (fb_error <= max(0.75, 1.5 * grid_scale))
        & (magnitude <= max(4.0, 22.0 * grid_scale))
        & (photometric_error <= 24.0)
    )

    # Require reliable correspondence around each semantic feature.  This is
    # stronger than a single whole-face ratio and prevents a fast path from
    # accepting a frame whose only failure is an eye or mouth.
    feature_support: list[float] = []
    important_radius = max(3, int(round(0.10 * target_span * grid_scale)))
    for point in target_points:
        px = int(round((float(point[0]) - target_left) * flow_width / target_width))
        py = int(round((float(point[1]) - target_top) * flow_height / target_height))
        mask = np.zeros((flow_height, flow_width), dtype=np.uint8)
        cv2.circle(mask, (px, py), important_radius, 1, -1)
        region = mask.astype(bool)
        feature_support.append(float(np.mean(supported[region])) if np.any(region) else 0.0)
    support_ratio = float(np.mean(supported))
    minimum_feature_support = min(feature_support) if feature_support else 0.0
    if diagnostics is not None:
        diagnostics["denseSupportRatio"] = support_ratio
        diagnostics["denseFeatureSupport"] = feature_support
        diagnostics["densePhotometricP95"] = float(np.percentile(photometric_error, 95.0))
        diagnostics["denseFbP95"] = float(np.percentile(fb_error, 95.0))
    if support_ratio < 0.78 or minimum_feature_support < 0.84:
        if diagnostics is not None:
            diagnostics["reason"] = "dense-confidence"
        return None

    flow_full = cv2.resize(
        current_to_anchor,
        (target_width, target_height),
        interpolation=cv2.INTER_LINEAR,
    )
    flow_full[..., 0] *= target_width / float(flow_width)
    flow_full[..., 1] *= target_height / float(flow_height)
    full_y, full_x = np.mgrid[0:target_height, 0:target_width].astype(np.float32)
    warped_residual = cv2.remap(
        affine_residual,
        full_x + flow_full[..., 0],
        full_y + flow_full[..., 1],
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    support_full = cv2.resize(
        supported.astype(np.float32),
        (target_width, target_height),
        interpolation=cv2.INTER_NEAREST,
    )
    # Contract uncertain correspondence before feathering.  The alpha remains
    # exactly zero on unsupported pixels, so stale identity detail cannot cover
    # a newly visible hand, hair strand, or foreground object.
    support_full = cv2.erode(support_full, np.ones((3, 3), dtype=np.uint8))
    alpha = cv2.GaussianBlur(support_full, (5, 5), 0)
    alpha *= support_full
    masked_residual = np.rint(
        warped_residual.astype(np.float32) * alpha[..., None]
    ).astype(np.int16)
    output = np.ascontiguousarray(current, dtype=np.uint8).copy()
    output_region = output[target_top:target_bottom, target_left:target_right]
    cv2.add(output_region, masked_residual, dst=output_region, dtype=cv2.CV_8U)
    if confidence_out is not None:
        full_confidence = np.zeros(current.shape[:2], dtype=np.float32)
        full_confidence[
            target_top:target_bottom,
            target_left:target_right,
        ] = np.clip(alpha, 0.0, 1.0)
        confidence_out.append(full_confidence)
    if diagnostics is not None:
        diagnostics["reason"] = "dense-accepted"
        diagnostics["denseTotalMs"] = (time.perf_counter() - started) * 1000.0
    return output


def _initialize_sparse_residual_mesh(
    frame_rgb: np.ndarray,
    face_kps: np.ndarray,
    *,
    maximum_features: int = 56,
    semantic_landmarks: np.ndarray | None = None,
    semantic_indices_to_keep: np.ndarray | None = None,
) -> dict[str, Any] | None:
    """Create an exact-frame sparse surface track for residual transport.

    When a visual 68-point refresh is available, retain the internal semantic
    contours (brows, nose, eyes, and lips) and supplement them with texture
    points.  The jaw silhouette is intentionally excluded: it is not a stable
    material surface under yaw or foreground hair.  The legacy texture-only
    behavior remains unchanged when ``semantic_landmarks`` is omitted.
    """
    frame = np.asarray(frame_rgb)
    try:
        points = np.asarray(face_kps, dtype=np.float32).reshape(5, 2)
    except (TypeError, ValueError):
        return None
    if frame.ndim != 3 or frame.shape[-1] != 3 or not np.isfinite(points).all():
        return None
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    height, width = gray.shape
    span = max(8.0, _landmark_span(points))
    center = (points.min(axis=0) + points.max(axis=0)) * 0.5
    mask = np.zeros_like(gray, dtype=np.uint8)
    cv2.ellipse(
        mask,
        (int(round(float(center[0]))), int(round(float(center[1] + span * 0.10)))),
        (int(round(span * 1.55)), int(round(span * 1.90))),
        0,
        0,
        360,
        255,
        -1,
    )
    features = np.empty((0, 2), dtype=np.float32)
    if int(maximum_features) > 0:
        detected_features = cv2.goodFeaturesToTrack(
            gray,
            maxCorners=max(16, int(maximum_features)),
            qualityLevel=0.012,
            minDistance=max(3.0, span * 0.045),
            mask=mask,
            blockSize=5,
            useHarrisDetector=False,
        )
        if detected_features is not None:
            features = detected_features.reshape(-1, 2).astype(
                np.float32,
                copy=False,
            )
            inside = (
                (features[:, 0] >= 1.0)
                & (features[:, 0] <= width - 2.0)
                & (features[:, 1] >= 1.0)
                & (features[:, 1] <= height - 2.0)
            )
            features = features[inside]
    semantic_points = np.empty((0, 2), dtype=np.float32)
    semantic_indices = np.empty((0,), dtype=np.int16)
    if semantic_landmarks is not None:
        try:
            all_semantic = np.asarray(semantic_landmarks, dtype=np.float32).reshape(68, 2)
        except (TypeError, ValueError):
            all_semantic = np.empty((0, 2), dtype=np.float32)
        if len(all_semantic) == 68 and np.isfinite(all_semantic).all():
            # 17:68 excludes the unstable jaw outline while retaining every
            # internal contour used to keep eyes and lips attached.
            semantic_indices = (
                np.asarray(semantic_indices_to_keep, dtype=np.int16).reshape(-1)
                if semantic_indices_to_keep is not None
                else np.arange(17, 68, dtype=np.int16)
            )
            semantic_indices = semantic_indices[
                (semantic_indices >= 0) & (semantic_indices < 68)
            ]
            semantic_points = all_semantic[semantic_indices]
            semantic_inside = (
                (semantic_points[:, 0] >= 1.0)
                & (semantic_points[:, 0] <= width - 2.0)
                & (semantic_points[:, 1] >= 1.0)
                & (semantic_points[:, 1] <= height - 2.0)
            )
            semantic_points = semantic_points[semantic_inside]
            semantic_indices = semantic_indices[semantic_inside]
            minimum_semantic_points = (
                8 if semantic_indices_to_keep is not None else 42
            )
            if len(semantic_points) < minimum_semantic_points:
                semantic_points = np.empty((0, 2), dtype=np.float32)
                semantic_indices = np.empty((0,), dtype=np.int16)
    if len(semantic_points):
        # Avoid nearly coincident controls, which make a Delaunay cell
        # ill-conditioned and add no independent motion evidence.
        nearest = np.min(
            np.linalg.norm(features[:, None, :] - semantic_points[None, :, :], axis=2),
            axis=1,
        )
        features = features[nearest >= max(2.0, span * 0.025)]
        controls = np.concatenate([semantic_points, features], axis=0)
        point_kinds = np.concatenate(
            [
                np.ones(len(semantic_points), dtype=np.uint8),
                np.zeros(len(features), dtype=np.uint8),
            ]
        )
        point_semantic_indices = np.concatenate(
            [
                semantic_indices,
                np.full(len(features), -1, dtype=np.int16),
            ]
        )
    else:
        controls = features
        point_kinds = np.zeros(len(features), dtype=np.uint8)
        point_semantic_indices = np.full(len(features), -1, dtype=np.int16)
    if len(controls) < 12:
        return None
    return {
        "anchorPoints": controls.copy(),
        "currentPoints": controls.copy(),
        "gray": gray,
        "anchorKps": points.copy(),
        "currentKps": points.copy(),
        "pointKinds": point_kinds,
        "semanticIndices": point_semantic_indices,
        "semantic": bool(len(semantic_points)),
    }


def _track_sparse_residual_mesh_controls(
    current_rgb: np.ndarray,
    current_kps: np.ndarray,
    mesh_state: dict[str, Any] | None,
    *,
    require_semantic_groups: bool = True,
    minimum_control_count: int = 12,
    diagnostics: dict[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, np.ndarray | None]:
    """Advance immutable-anchor mesh controls by one source frame.

    The returned state's ``anchorPoints`` never move; only its current
    observations advance.  Invalid observations are removed, and internal
    eye/mouth/nose groups must retain independent support before a reused
    appearance is permitted.
    """
    if not isinstance(mesh_state, dict):
        if diagnostics is not None:
            diagnostics["reason"] = "sparse-missing-state"
        return None, None
    current = np.asarray(current_rgb)
    try:
        anchor_features = np.asarray(mesh_state.get("anchorPoints"), dtype=np.float32).reshape(-1, 2)
        prior_features = np.asarray(mesh_state.get("currentPoints"), dtype=np.float32).reshape(-1, 2)
        prior_gray = np.asarray(mesh_state.get("gray"), dtype=np.uint8)
        anchor_kps = np.asarray(mesh_state.get("anchorKps"), dtype=np.float32).reshape(5, 2)
        target_kps = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
        point_kinds = np.asarray(
            mesh_state.get("pointKinds", np.zeros(len(anchor_features))),
            dtype=np.uint8,
        ).reshape(-1)
        semantic_indices = np.asarray(
            mesh_state.get("semanticIndices", np.full(len(anchor_features), -1)),
            dtype=np.int16,
        ).reshape(-1)
    except (TypeError, ValueError):
        return None, None
    if (
        current.ndim != 3
        or current.shape[-1] != 3
        or len(anchor_features) != len(prior_features)
        or len(anchor_features) < 12
        or len(point_kinds) != len(anchor_features)
        or len(semantic_indices) != len(anchor_features)
    ):
        return None, None
    current_gray = cv2.cvtColor(current, cv2.COLOR_RGB2GRAY)
    if prior_gray.shape != current_gray.shape:
        return None, None
    height, width = current_gray.shape
    prior_input = prior_gray
    current_input = current_gray
    point_offset = np.zeros((1, 2), dtype=np.float32)
    try:
        prior_kps_for_roi = np.asarray(
            mesh_state.get("currentKps", anchor_kps),
            dtype=np.float32,
        ).reshape(5, 2)
    except (TypeError, ValueError):
        prior_kps_for_roi = anchor_kps
    tracking_roi = _landmark_tracking_roi(
        prior_gray,
        current_gray,
        prior_kps_for_roi,
        current.shape,
    )
    lk_options = _LK_TRACKING_OPTIONS
    if not require_semantic_groups and len(prior_features) <= 20:
        # Optional feature islands track only a compact internal-face support
        # set. Building the conservative four-level whole-face pyramid used by
        # the authoritative five-point tracker is duplicated work here. Keep
        # the same bidirectional validation over a smaller, aligned eye-band
        # crop and two-level pyramid.
        feature_min = np.min(prior_features, axis=0)
        feature_max = np.max(prior_features, axis=0)
        margin = max(20.0, _landmark_span(prior_kps_for_roi) * 0.20)
        roi_left = int(math.floor(float(feature_min[0] - margin)))
        roi_top = int(math.floor(float(feature_min[1] - margin)))
        roi_right = int(math.ceil(float(feature_max[0] + margin)))
        roi_bottom = int(math.ceil(float(feature_max[1] + margin)))
        roi_left = max(0, (roi_left // 8) * 8)
        roi_top = max(0, (roi_top // 8) * 8)
        roi_right = min(width, ((roi_right + 7) // 8) * 8)
        roi_bottom = min(height, ((roi_bottom + 7) // 8) * 8)
        if roi_right - roi_left >= 48 and roi_bottom - roi_top >= 48:
            tracking_roi = (roi_left, roi_top, roi_right, roi_bottom)
            lk_options = {
                "winSize": (15, 15),
                "maxLevel": 2,
                "criteria": (
                    cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                    15,
                    0.01,
                ),
            }
    if tracking_roi is not None:
        roi_left, roi_top, roi_right, roi_bottom = tracking_roi
        point_offset[0] = (float(roi_left), float(roi_top))
        prior_input = prior_gray[roi_top:roi_bottom, roi_left:roi_right]
        current_input = current_gray[roi_top:roi_bottom, roi_left:roi_right]
    tracking_points = (prior_features - point_offset).reshape(-1, 1, 2)
    tracked, forward_status, _ = cv2.calcOpticalFlowPyrLK(
        prior_input,
        current_input,
        tracking_points,
        None,
        **lk_options,
    )
    if tracked is None or forward_status is None:
        return None, None
    backtracked, backward_status, _ = cv2.calcOpticalFlowPyrLK(
        current_input,
        prior_input,
        tracked,
        None,
        **lk_options,
    )
    if backtracked is None or backward_status is None:
        return None, None
    tracked = tracked.reshape(-1, 2) + point_offset
    backtracked = backtracked.reshape(-1, 2) + point_offset
    valid = (
        np.asarray(forward_status).reshape(-1).astype(bool)
        & np.asarray(backward_status).reshape(-1).astype(bool)
        & np.isfinite(tracked).all(axis=1)
        & np.isfinite(backtracked).all(axis=1)
    )
    span = max(8.0, _landmark_span(target_kps))
    reverse_error = np.linalg.norm(backtracked - prior_features, axis=1)
    displacement = np.linalg.norm(tracked - prior_features, axis=1)
    valid &= reverse_error <= max(1.25, min(3.0, span * 0.025))
    valid &= displacement <= max(12.0, span * 0.55)
    valid &= (
        (tracked[:, 0] >= 1.0)
        & (tracked[:, 0] <= width - 2.0)
        & (tracked[:, 1] >= 1.0)
        & (tracked[:, 1] <= height - 2.0)
    )
    if int(np.count_nonzero(valid)) < max(
        int(minimum_control_count),
        int(math.ceil(len(valid) * 0.55)),
    ):
        if diagnostics is not None:
            diagnostics["reason"] = "sparse-tracking"
        return None, None

    semantic_support: dict[str, float] = {}
    if bool(mesh_state.get("semantic")):
        # Groups intentionally use the canonical 68-point index ranges.
        # Brows are useful support but are not mandatory because hair can cover
        # them. Eyes, nose, and lips must remain independently observed.
        for name, lower, upper, minimum_ratio in (
            ("leftEye", 36, 42, 0.66),
            ("rightEye", 42, 48, 0.66),
            ("nose", 27, 36, 0.55),
            ("mouth", 48, 68, 0.60),
        ):
            group = (semantic_indices >= lower) & (semantic_indices < upper)
            if not np.any(group):
                if not require_semantic_groups:
                    semantic_support[name] = 0.0
                    continue
                if diagnostics is not None:
                    diagnostics["reason"] = f"sparse-semantic-{name}-missing"
                return None, None
            ratio = float(np.mean(valid[group]))
            semantic_support[name] = ratio
            if require_semantic_groups and ratio < minimum_ratio:
                if diagnostics is not None:
                    diagnostics["reason"] = f"sparse-semantic-{name}-support"
                    diagnostics["sparseSemanticSupport"] = semantic_support
                return None, None

    transform, _ = cv2.estimateAffinePartial2D(
        anchor_kps,
        target_kps,
        method=cv2.LMEDS,
    )
    if transform is None or transform.shape != (2, 3) or not np.isfinite(transform).all():
        return None, None
    linear = transform[:, :2]
    determinant = float(np.linalg.det(linear))
    if determinant <= 0.0 or not 0.72 <= math.sqrt(determinant) <= 1.40:
        return None, None

    # Bound local deformation around the robust global head transform.  This
    # passes observed eye/lip motion but prevents a single low-texture point
    # from pulling the mesh—and the swapped feature—across the face.
    projected = cv2.transform(anchor_features.reshape(1, -1, 2), transform)[0]
    local_delta = tracked - projected
    local_norm = np.linalg.norm(local_delta, axis=1)
    local_limit = max(4.0, span * 0.18)
    too_large = local_norm > local_limit
    if np.any(too_large):
        local_delta[too_large] *= (
            local_limit / np.maximum(local_norm[too_large], 1e-6)
        )[:, None]
        tracked = projected + local_delta

    next_state = {
        "anchorPoints": anchor_features[valid].copy(),
        "currentPoints": tracked[valid].copy(),
        "gray": current_gray,
        "anchorKps": anchor_kps.copy(),
        "currentKps": target_kps.copy(),
        "pointKinds": point_kinds[valid].copy(),
        "semanticIndices": semantic_indices[valid].copy(),
        "semantic": bool(mesh_state.get("semantic")),
    }
    if diagnostics is not None:
        diagnostics["sparseSemanticSupport"] = semantic_support
        diagnostics["sparseControlCount"] = int(np.count_nonzero(valid))
    return next_state, transform


def _rebase_sparse_residual_mesh(
    frame_rgb: np.ndarray,
    current_kps: np.ndarray,
    mesh_state: dict[str, Any] | None,
    *,
    semantic_landmarks: np.ndarray | None = None,
    maximum_features: int = 40,
    semantic_indices_to_keep: np.ndarray | None = None,
) -> dict[str, Any] | None:
    """Commit new exact appearance while retaining current tracked geometry."""
    if semantic_landmarks is not None or not isinstance(mesh_state, dict):
        return _initialize_sparse_residual_mesh(
            frame_rgb,
            current_kps,
            maximum_features=maximum_features,
            semantic_landmarks=semantic_landmarks,
            semantic_indices_to_keep=semantic_indices_to_keep,
        )
    advanced, _ = _track_sparse_residual_mesh_controls(
        frame_rgb,
        current_kps,
        mesh_state,
    )
    if advanced is None:
        return _initialize_sparse_residual_mesh(
            frame_rgb,
            current_kps,
            maximum_features=maximum_features,
            semantic_indices_to_keep=semantic_indices_to_keep,
        )
    current_points = np.asarray(advanced["currentPoints"], dtype=np.float32)
    points = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
    advanced["anchorPoints"] = current_points.copy()
    advanced["currentPoints"] = current_points.copy()
    advanced["anchorKps"] = points.copy()
    advanced["currentKps"] = points.copy()
    return advanced


def _warp_prior_swap_with_semantic_features(
    current_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    mesh_state: dict[str, Any] | None,
    *,
    max_landmark_residual_ratio: float = 0.12,
    interpolation: int = cv2.INTER_LINEAR,
    feature_strength: float = 0.65,
    feature_max_mae: float = 16.0,
    feature_max_p90: float = 34.0,
    feature_groups: tuple[str, ...] = (
        "leftEye",
        "rightEye",
        "nose",
        "mouth",
    ),
    diagnostics: dict[str, Any] | None = None,
) -> tuple[np.ndarray | None, dict[str, Any] | None]:
    """Add optional rigid feature islands to the established global warp.

    The global residual path remains authoritative. Semantic observations are
    only used to sample exact rendered appearance inside independently gated
    eye, nose, and mouth islands. Missing or unsafe optional geometry never
    converts an otherwise valid global reuse into an exact render.
    """
    started = time.perf_counter()
    global_diagnostics: dict[str, Any] = {}
    output = _warp_prior_swap_residual(
        current_rgb,
        previous_rgb,
        previous_swapped_rgb,
        previous_kps,
        current_kps,
        max_landmark_residual_ratio=max_landmark_residual_ratio,
        interpolation=interpolation,
        diagnostics=global_diagnostics,
    )
    if diagnostics is not None:
        diagnostics.update(global_diagnostics)
    if output is None:
        return None, None
    if not isinstance(mesh_state, dict) or not bool(mesh_state.get("semantic")):
        if diagnostics is not None:
            diagnostics["semanticFeatureReason"] = "optional-state-unavailable"
            diagnostics["semanticFeatureTotalMs"] = (
                time.perf_counter() - started
            ) * 1000.0
        return output, None

    tracking_started = time.perf_counter()
    track_diagnostics: dict[str, Any] = {}
    next_state, _ = _track_sparse_residual_mesh_controls(
        current_rgb,
        current_kps,
        mesh_state,
        require_semantic_groups=False,
        minimum_control_count=8,
        diagnostics=track_diagnostics,
    )
    if diagnostics is not None:
        diagnostics["semanticFeatureTrackingMs"] = (
            time.perf_counter() - tracking_started
        ) * 1000.0
    if next_state is None:
        if diagnostics is not None:
            diagnostics["semanticFeatureReason"] = str(
                track_diagnostics.get("reason") or "optional-tracking-unavailable"
            )
            diagnostics["semanticFeatureTotalMs"] = (
                time.perf_counter() - started
            ) * 1000.0
        return output, None

    anchor_points = np.asarray(next_state["anchorPoints"], dtype=np.float32)
    target_points = np.asarray(next_state["currentPoints"], dtype=np.float32)
    semantic_indices = np.asarray(
        next_state.get("semanticIndices"),
        dtype=np.int16,
    ).reshape(-1)
    current = np.asarray(current_rgb)
    previous = np.asarray(previous_rgb)
    swapped = np.asarray(previous_swapped_rgb)
    height, width = current.shape[:2]
    face_span = max(8.0, _landmark_span(np.asarray(current_kps, dtype=np.float32)))
    strength = float(np.clip(feature_strength, 0.0, 1.0))
    accepted_names: list[str] = []
    rejected_reasons: dict[str, str] = {}

    # An optional feature island must not cover a newly introduced object just
    # because that object is outside the small eye/lip core being sampled.  A
    # compact, exposure-compensated whole-face check disables every optional
    # island while leaving the already-qualified global reuse result intact.
    try:
        prior_five = np.asarray(previous_kps, dtype=np.float32).reshape(5, 2)
        current_five = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
        face_transform, _ = cv2.estimateAffinePartial2D(
            prior_five,
            current_five,
            method=cv2.LMEDS,
        )
    except (TypeError, ValueError):
        face_transform = None
    if face_transform is not None and face_transform.shape == (2, 3):
        check_edge = 96
        prior_span = max(8.0, _landmark_span(prior_five))
        check_side = max(48, int(round(max(prior_span, face_span) * 2.5)))
        prior_center = (prior_five.min(axis=0) + prior_five.max(axis=0)) * 0.5
        current_center = (current_five.min(axis=0) + current_five.max(axis=0)) * 0.5
        source_roi = _bounded_square_roi(
            width,
            height,
            float(prior_center[0]),
            float(prior_center[1]),
            check_side,
            vertical_anchor=0.55,
        )
        target_roi = _bounded_square_roi(
            width,
            height,
            float(current_center[0]),
            float(current_center[1]),
            check_side,
            vertical_anchor=0.55,
        )
        sl, st, sr, sb = source_roi
        tl, tt, tr, tb = target_roi
        face_linear = face_transform[:, :2]
        local_face_transform = np.asarray(face_transform, dtype=np.float64).copy()
        local_face_transform[:, 2] += face_linear @ np.asarray(
            [sl, st],
            dtype=np.float64,
        )
        local_face_transform[:, 2] -= np.asarray([tl, tt], dtype=np.float64)
        warped_prior = cv2.warpAffine(
            previous[st:sb, sl:sr],
            local_face_transform,
            (tr - tl, tb - tt),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        warped_small = cv2.resize(
            warped_prior,
            (check_edge, check_edge),
            interpolation=cv2.INTER_AREA,
        )
        current_small = cv2.resize(
            current[tt:tb, tl:tr],
            (check_edge, check_edge),
            interpolation=cv2.INTER_AREA,
        )
        photo_delta = current_small.astype(np.float32) - warped_small.astype(np.float32)
        exposure = np.median(photo_delta.reshape(-1, 3), axis=0)
        photo_error = np.mean(
            np.abs(photo_delta - exposure.reshape(1, 1, 3)),
            axis=2,
        )
        face_mae = float(np.mean(photo_error))
        face_p90 = float(np.percentile(photo_error, 90.0))
        if diagnostics is not None:
            diagnostics["semanticFeatureFaceMae"] = face_mae
            diagnostics["semanticFeatureFaceP90"] = face_p90
        if face_mae > 8.0 or face_p90 > 22.0:
            if diagnostics is not None:
                diagnostics["semanticFeatureReason"] = "optional-face-change"
                diagnostics["semanticFeatureTotalMs"] = (
                    time.perf_counter() - started
                ) * 1000.0
            return output, next_state

    # Per-group patch geometry is intentionally compact and non-overlapping.
    # The jaw and broad cheek surface remain on the established global path.
    enabled_groups = {str(value) for value in feature_groups}
    if enabled_groups == {"leftEye", "rightEye"}:
        # A single rigid eye band is both cheaper and more stable than two
        # independently estimated eye transforms: their relative spacing can
        # no longer oscillate as LK support changes from frame to frame.
        group_specs = (("eyes", 36, 48, 8, 0.42, 0.115),)
        enabled_groups = {"eyes"}
    else:
        group_specs = (
            ("leftEye", 36, 42, 4, 0.18, 0.105),
            ("rightEye", 42, 48, 4, 0.18, 0.105),
            ("nose", 27, 36, 5, 0.13, 0.18),
            ("mouth", 48, 68, 8, 0.25, 0.125),
        )
    for name, lower, upper, minimum_points, radius_x_ratio, radius_y_ratio in group_specs:
        if name not in enabled_groups:
            continue
        group = (semantic_indices >= lower) & (semantic_indices < upper)
        source_group = anchor_points[group]
        target_group = target_points[group]
        if len(source_group) < minimum_points:
            rejected_reasons[name] = "support"
            continue
        local_transform, inliers = cv2.estimateAffinePartial2D(
            source_group,
            target_group,
            method=cv2.LMEDS,
        )
        if (
            local_transform is None
            or local_transform.shape != (2, 3)
            or not np.isfinite(local_transform).all()
        ):
            rejected_reasons[name] = "fit"
            continue
        projected = cv2.transform(source_group.reshape(1, -1, 2), local_transform)[0]
        fit_error = np.linalg.norm(projected - target_group, axis=1)
        if float(np.percentile(fit_error, 90.0)) > max(1.25, face_span * 0.025):
            rejected_reasons[name] = "fit-residual"
            continue
        linear = local_transform[:, :2]
        determinant = float(np.linalg.det(linear))
        if determinant <= 0.0 or not 0.80 <= math.sqrt(determinant) <= 1.25:
            rejected_reasons[name] = "scale"
            continue

        source_center = np.mean(source_group, axis=0)
        target_center = np.mean(target_group, axis=0)
        radius_x = max(4, int(round(face_span * radius_x_ratio)))
        radius_y = max(3, int(round(face_span * radius_y_ratio)))
        source_left = max(0, int(math.floor(float(source_center[0]) - radius_x - 3)))
        source_top = max(0, int(math.floor(float(source_center[1]) - radius_y - 3)))
        source_right = min(width, int(math.ceil(float(source_center[0]) + radius_x + 4)))
        source_bottom = min(height, int(math.ceil(float(source_center[1]) + radius_y + 4)))
        target_left = max(0, int(math.floor(float(target_center[0]) - radius_x - 4)))
        target_top = max(0, int(math.floor(float(target_center[1]) - radius_y - 4)))
        target_right = min(width, int(math.ceil(float(target_center[0]) + radius_x + 5)))
        target_bottom = min(height, int(math.ceil(float(target_center[1]) + radius_y + 5)))
        if min(
            source_right - source_left,
            source_bottom - source_top,
            target_right - target_left,
            target_bottom - target_top,
        ) <= 5:
            rejected_reasons[name] = "roi"
            continue

        local = np.asarray(local_transform, dtype=np.float64).copy()
        local[:, 2] += linear @ np.asarray(
            [source_left, source_top],
            dtype=np.float64,
        )
        local[:, 2] -= np.asarray([target_left, target_top], dtype=np.float64)
        target_width = target_right - target_left
        target_height = target_bottom - target_top
        source_patch = previous[source_top:source_bottom, source_left:source_right]
        swapped_patch = swapped[source_top:source_bottom, source_left:source_right]
        warped_source = cv2.warpAffine(
            source_patch,
            local,
            (target_width, target_height),
            flags=int(interpolation),
            borderMode=cv2.BORDER_REFLECT_101,
        )
        warped_swapped = cv2.warpAffine(
            swapped_patch,
            local,
            (target_width, target_height),
            flags=int(interpolation),
            borderMode=cv2.BORDER_REFLECT_101,
        )
        valid = cv2.warpAffine(
            np.full(source_patch.shape[:2], 255, dtype=np.uint8),
            local,
            (target_width, target_height),
            flags=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        center_local = (
            int(round(float(target_center[0]) - target_left)),
            int(round(float(target_center[1]) - target_top)),
        )
        core = np.zeros((target_height, target_width), dtype=np.uint8)
        cv2.ellipse(
            core,
            center_local,
            (radius_x, radius_y),
            0.0,
            0.0,
            360.0,
            255,
            thickness=-1,
            lineType=cv2.LINE_AA,
        )
        core = cv2.bitwise_and(core, valid)
        pixels = core >= 192
        if int(np.count_nonzero(pixels)) < 16:
            rejected_reasons[name] = "coverage"
            continue
        current_patch = current[target_top:target_bottom, target_left:target_right]
        difference = np.mean(
            np.abs(
                current_patch[pixels].astype(np.float32)
                - warped_source[pixels].astype(np.float32)
            ),
            axis=1,
        )
        patch_mae = float(np.mean(difference))
        patch_p90 = float(np.percentile(difference, 90.0))
        if (
            not math.isfinite(patch_mae)
            or not math.isfinite(patch_p90)
            or patch_mae > float(feature_max_mae)
            or patch_p90 > float(feature_max_p90)
        ):
            rejected_reasons[name] = "appearance"
            continue
        sigma = max(0.7, min(radius_x, radius_y) * 0.12)
        alpha = cv2.GaussianBlur(core, (0, 0), sigmaX=sigma, sigmaY=sigma)
        alpha_float = (alpha.astype(np.float32) * (strength / 255.0))[..., None]
        output_patch = output[target_top:target_bottom, target_left:target_right]
        output_patch[:] = np.clip(
            output_patch.astype(np.float32) * (1.0 - alpha_float)
            + warped_swapped.astype(np.float32) * alpha_float,
            0.0,
            255.0,
        ).astype(np.uint8)
        accepted_names.append(name)

    if diagnostics is not None:
        diagnostics["semanticFeatureReason"] = "optional-applied"
        diagnostics["semanticFeatureAcceptedCount"] = len(accepted_names)
        diagnostics["semanticFeatureAcceptedNames"] = accepted_names
        diagnostics["semanticFeatureRejectedReasons"] = rejected_reasons
        diagnostics["semanticFeatureTotalMs"] = (
            time.perf_counter() - started
        ) * 1000.0
    return output, next_state


def _warp_prior_swap_residual_semantic_field(
    current_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    current_kps: np.ndarray,
    mesh_state: dict[str, Any],
    *,
    mesh_size: int = 96,
    diagnostics: dict[str, Any] | None = None,
) -> tuple[np.ndarray | None, dict[str, Any] | None]:
    """Transport one immutable exact residual with a constrained smooth field.

    Unlike the older per-frame Delaunay path, this composes global head motion
    and local semantic corrections into one inverse map.  Only the residual is
    sampled at full resolution; source reconstruction and visibility confidence
    are evaluated on a small grid.  This keeps internal facial controls attached
    without paying for repeated full-resolution source warps.
    """
    started = time.perf_counter()
    current = np.asarray(current_rgb)
    previous = np.asarray(previous_rgb)
    swapped = np.asarray(previous_swapped_rgb)
    try:
        target_points = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
    except (TypeError, ValueError):
        return None, None
    if (
        current.ndim != 3
        or current.shape != previous.shape
        or current.shape != swapped.shape
        or current.dtype != np.uint8
        or previous.dtype != np.uint8
        or swapped.dtype != np.uint8
    ):
        return None, None
    tracking_started = time.perf_counter()
    next_state, transform = _track_sparse_residual_mesh_controls(
        current,
        target_points,
        mesh_state,
        diagnostics=diagnostics,
    )
    if next_state is None or transform is None:
        return None, None
    if diagnostics is not None:
        diagnostics["semanticTrackingMs"] = (time.perf_counter() - tracking_started) * 1000.0
    anchor_controls = np.asarray(next_state["anchorPoints"], dtype=np.float32)
    target_controls = np.asarray(next_state["currentPoints"], dtype=np.float32)
    point_kinds = np.asarray(next_state.get("pointKinds"), dtype=np.uint8).reshape(-1)
    source_points = np.asarray(next_state["anchorKps"], dtype=np.float32).reshape(5, 2)
    span = max(8.0, _landmark_span(target_points))
    source_span = max(8.0, _landmark_span(source_points))
    height, width = current.shape[:2]
    side = max(48, int(round(max(source_span, span) * 3.6)))
    source_center = (source_points.min(axis=0) + source_points.max(axis=0)) * 0.5
    target_center = (target_points.min(axis=0) + target_points.max(axis=0)) * 0.5
    source_left, source_top, source_right, source_bottom = _bounded_square_roi(
        width,
        height,
        float(source_center[0]),
        float(source_center[1]),
        side,
        vertical_anchor=0.55,
    )
    target_left, target_top, target_right, target_bottom = _bounded_square_roi(
        width,
        height,
        float(target_center[0]),
        float(target_center[1]),
        side,
        vertical_anchor=0.55,
    )
    target_width = target_right - target_left
    target_height = target_bottom - target_top
    if min(source_right - source_left, source_bottom - source_top, target_width, target_height) <= 8:
        return None, None
    inverse = cv2.invertAffineTransform(np.asarray(transform, dtype=np.float32))
    if inverse.shape != (2, 3) or not np.isfinite(inverse).all():
        return None, None

    field_started = time.perf_counter()
    mesh_edge = max(48, min(128, int(mesh_size)))
    grid_y, grid_x = np.mgrid[0:mesh_edge, 0:mesh_edge].astype(np.float32)
    target_x = target_left + grid_x * ((target_width - 1.0) / max(1.0, mesh_edge - 1.0))
    target_y = target_top + grid_y * ((target_height - 1.0) / max(1.0, mesh_edge - 1.0))
    base_anchor_x = inverse[0, 0] * target_x + inverse[0, 1] * target_y + inverse[0, 2]
    base_anchor_y = inverse[1, 0] * target_x + inverse[1, 1] * target_y + inverse[1, 2]

    base_controls = cv2.transform(target_controls.reshape(1, -1, 2), inverse)[0]
    corrections = anchor_controls - base_controls
    correction_norm = np.linalg.norm(corrections, axis=1)
    correction_limit = max(3.0, min(source_span, span) * 0.16)
    oversized = correction_norm > correction_limit
    if np.any(oversized):
        corrections[oversized] *= (
            correction_limit / np.maximum(correction_norm[oversized], 1e-6)
        )[:, None]

    numerator_x = np.zeros((mesh_edge, mesh_edge), dtype=np.float32)
    numerator_y = np.zeros_like(numerator_x)
    weights = np.zeros_like(numerator_x)
    scale_x = (mesh_edge - 1.0) / max(1.0, target_width - 1.0)
    scale_y = (mesh_edge - 1.0) / max(1.0, target_height - 1.0)

    def splat(px: float, py: float, dx: float, dy: float, weight: float) -> None:
        gx = (px - target_left) * scale_x
        gy = (py - target_top) * scale_y
        if gx < -1.0 or gy < -1.0 or gx > mesh_edge or gy > mesh_edge:
            return
        x0 = int(math.floor(gx))
        y0 = int(math.floor(gy))
        for yy in (y0, y0 + 1):
            if yy < 0 or yy >= mesh_edge:
                continue
            wy = 1.0 - abs(gy - yy)
            if wy <= 0.0:
                continue
            for xx in (x0, x0 + 1):
                if xx < 0 or xx >= mesh_edge:
                    continue
                wx = 1.0 - abs(gx - xx)
                amount = float(weight) * wx * wy
                if amount <= 0.0:
                    continue
                numerator_x[yy, xx] += float(dx) * amount
                numerator_y[yy, xx] += float(dy) * amount
                weights[yy, xx] += amount

    for point, correction, kind in zip(target_controls, corrections, point_kinds):
        splat(
            float(point[0]),
            float(point[1]),
            float(correction[0]),
            float(correction[1]),
            3.0 if int(kind) == 1 else 1.0,
        )
    # Clamp the deformation to the global similarity transform at the ROI
    # boundary.  These are geometry priors, not fabricated facial observations.
    for px, py in (
        (target_left, target_top),
        ((target_left + target_right - 1.0) * 0.5, target_top),
        (target_right - 1.0, target_top),
        (target_left, (target_top + target_bottom - 1.0) * 0.5),
        (target_right - 1.0, (target_top + target_bottom - 1.0) * 0.5),
        (target_left, target_bottom - 1.0),
        ((target_left + target_right - 1.0) * 0.5, target_bottom - 1.0),
        (target_right - 1.0, target_bottom - 1.0),
    ):
        splat(float(px), float(py), 0.0, 0.0, 5.0)
    sigma = max(2.5, mesh_edge * 0.055)
    blurred_weights = cv2.GaussianBlur(weights, (0, 0), sigmaX=sigma, sigmaY=sigma)
    blurred_x = cv2.GaussianBlur(numerator_x, (0, 0), sigmaX=sigma, sigmaY=sigma)
    blurred_y = cv2.GaussianBlur(numerator_y, (0, 0), sigmaX=sigma, sigmaY=sigma)
    denominator = np.maximum(blurred_weights, 1e-5)
    correction_x = blurred_x / denominator
    correction_y = blurred_y / denominator
    # Fade naturally to the global transform where no reliable local control
    # contributes, rather than extrapolating one feature across the whole face.
    confidence = np.clip(blurred_weights / 0.035, 0.0, 1.0)
    correction_x *= confidence
    correction_y *= confidence
    map_x_small = base_anchor_x + correction_x - float(source_left)
    map_y_small = base_anchor_y + correction_y - float(source_top)
    if diagnostics is not None:
        diagnostics["semanticFieldMs"] = (time.perf_counter() - field_started) * 1000.0

    source_region = previous[source_top:source_bottom, source_left:source_right]
    residual = cv2.subtract(
        swapped[source_top:source_bottom, source_left:source_right],
        source_region,
        dtype=cv2.CV_16S,
    )
    # Visibility is evaluated cheaply at mesh resolution.  Remove a global
    # exposure shift before thresholding so lighting changes are not confused
    # with a hand/hair entering the foreground.
    visibility_started = time.perf_counter()
    sampled_source_small = cv2.remap(
        source_region,
        map_x_small,
        map_y_small,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    current_region = current[target_top:target_bottom, target_left:target_right]
    current_small = cv2.resize(
        current_region,
        (mesh_edge, mesh_edge),
        interpolation=cv2.INTER_AREA,
    )
    difference = current_small.astype(np.float32) - sampled_source_small.astype(np.float32)
    exposure = np.median(difference.reshape(-1, 3), axis=0)
    photo = np.mean(np.abs(difference - exposure.reshape(1, 1, 3)), axis=2)
    support = photo <= 30.0
    feature_support: list[float] = []
    radius = max(2, int(round(0.10 * span * max(scale_x, scale_y))))
    for point in target_points:
        px = int(round((float(point[0]) - target_left) * scale_x))
        py = int(round((float(point[1]) - target_top) * scale_y))
        part = np.zeros((mesh_edge, mesh_edge), dtype=np.uint8)
        cv2.circle(part, (px, py), radius, 1, -1)
        region = part.astype(bool)
        feature_support.append(float(np.mean(support[region])) if np.any(region) else 0.0)
    support_ratio = float(np.mean(support))
    if min(feature_support, default=0.0) < 0.52 or support_ratio < 0.58:
        if diagnostics is not None:
            diagnostics["reason"] = "semantic-confidence"
            diagnostics["semanticFeatureSupport"] = feature_support
            diagnostics["semanticSupportRatio"] = support_ratio
        return None, None
    alpha_small = cv2.erode(support.astype(np.float32), np.ones((3, 3), dtype=np.uint8))
    alpha_small = cv2.GaussianBlur(alpha_small, (5, 5), 0)
    alpha_small *= support.astype(np.float32)
    if diagnostics is not None:
        diagnostics["semanticVisibilityMs"] = (time.perf_counter() - visibility_started) * 1000.0

    remap_started = time.perf_counter()
    map_x = cv2.resize(map_x_small, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    map_y = cv2.resize(map_y_small, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    alpha = cv2.resize(alpha_small, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    warped_residual = cv2.remap(
        residual,
        map_x,
        map_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    # Fixed-point OpenCV multiplication is materially faster than promoting
    # three full ROI channels to float in NumPy, while preserving sub-percent
    # feather weights and signed residuals.
    alpha_fixed = np.rint(np.clip(alpha, 0.0, 1.0) * 32767.0).astype(np.int16)
    alpha_fixed_3 = cv2.merge((alpha_fixed, alpha_fixed, alpha_fixed))
    masked_residual = cv2.multiply(
        warped_residual,
        alpha_fixed_3,
        scale=1.0 / 32767.0,
        dtype=cv2.CV_16S,
    )
    output = np.ascontiguousarray(current, dtype=np.uint8).copy()
    output_region = output[target_top:target_bottom, target_left:target_right]
    cv2.add(output_region, masked_residual, dst=output_region, dtype=cv2.CV_8U)
    if diagnostics is not None:
        diagnostics["reason"] = "semantic-accepted"
        diagnostics["semanticSupportRatio"] = support_ratio
        diagnostics["semanticFeatureSupport"] = feature_support
        diagnostics["semanticRemapMs"] = (time.perf_counter() - remap_started) * 1000.0
        diagnostics["semanticTotalMs"] = (time.perf_counter() - started) * 1000.0
    return output, next_state


def _warp_prior_swap_residual_sparse_mesh(
    current_rgb: np.ndarray,
    previous_rgb: np.ndarray,
    previous_swapped_rgb: np.ndarray,
    previous_kps: np.ndarray,
    current_kps: np.ndarray,
    mesh_state: dict[str, Any] | None,
    *,
    mesh_size: int = 128,
    diagnostics: dict[str, Any] | None = None,
) -> tuple[np.ndarray | None, dict[str, Any] | None]:
    """Transport an exact residual through a tracked sparse facial surface.

    Shi-Tomasi points are initialized only on an exact frame and tracked
    sequentially with forward/backward LK.  Their displacement refines the
    coarse five-landmark similarity transform through a piecewise-linear map.
    The current source remains the base image, and photometrically unsupported
    pixels receive no old residual, protecting foreground occlusions.
    """
    started = time.perf_counter()
    if isinstance(mesh_state, dict) and bool(mesh_state.get("semantic")):
        return _warp_prior_swap_residual_semantic_field(
            current_rgb,
            previous_rgb,
            previous_swapped_rgb,
            current_kps,
            mesh_state,
            mesh_size=mesh_size,
            diagnostics=diagnostics,
        )
    current = np.asarray(current_rgb)
    previous = np.asarray(previous_rgb)
    swapped = np.asarray(previous_swapped_rgb)
    try:
        target_points = np.asarray(current_kps, dtype=np.float32).reshape(5, 2)
    except (TypeError, ValueError):
        return None, None
    if (
        current.ndim != 3
        or current.shape != previous.shape
        or current.shape != swapped.shape
        or current.dtype != np.uint8
        or previous.dtype != np.uint8
        or swapped.dtype != np.uint8
    ):
        return None, None
    next_state, transform = _track_sparse_residual_mesh_controls(
        current,
        target_points,
        mesh_state,
        diagnostics=diagnostics,
    )
    if next_state is None or transform is None:
        return None, None
    anchor_features = np.asarray(next_state["anchorPoints"], dtype=np.float32)
    tracked_features = np.asarray(next_state["currentPoints"], dtype=np.float32)
    source_points = np.asarray(next_state["anchorKps"], dtype=np.float32).reshape(5, 2)
    span = max(8.0, _landmark_span(target_points))
    height, width = current.shape[:2]
    linear = transform[:, :2]

    source_span = _landmark_span(source_points)
    side = max(48, int(round(max(source_span, span) * 4.0)))
    source_center = (source_points.min(axis=0) + source_points.max(axis=0)) * 0.5
    target_center = (target_points.min(axis=0) + target_points.max(axis=0)) * 0.5
    source_left, source_top, source_right, source_bottom = _bounded_square_roi(
        width, height, float(source_center[0]), float(source_center[1]), side, vertical_anchor=0.55,
    )
    target_left, target_top, target_right, target_bottom = _bounded_square_roi(
        width, height, float(target_center[0]), float(target_center[1]), side, vertical_anchor=0.55,
    )
    target_width = target_right - target_left
    target_height = target_bottom - target_top
    if min(source_right - source_left, source_bottom - source_top, target_width, target_height) <= 8:
        return None, None
    local_transform = transform.copy()
    local_transform[:, 2] += linear @ np.asarray([source_left, source_top], dtype=np.float64)
    local_transform[:, 2] -= np.asarray([target_left, target_top], dtype=np.float64)
    source_region = previous[source_top:source_bottom, source_left:source_right]
    residual = cv2.subtract(
        swapped[source_top:source_bottom, source_left:source_right],
        source_region,
        dtype=cv2.CV_16S,
    )
    affine_source = cv2.warpAffine(
        source_region,
        local_transform,
        (target_width, target_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )
    affine_residual = cv2.warpAffine(
        residual,
        local_transform,
        (target_width, target_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )

    projected_anchor = cv2.transform(anchor_features.reshape(1, -1, 2), transform)[0]
    projected_kps = cv2.transform(source_points.reshape(1, -1, 2), transform)[0]
    source_controls = np.concatenate([projected_anchor, projected_kps], axis=0)
    target_controls = np.concatenate([tracked_features, target_points], axis=0)
    source_controls -= np.asarray([target_left, target_top], dtype=np.float32)
    target_controls -= np.asarray([target_left, target_top], dtype=np.float32)
    control_valid = (
        (source_controls[:, 0] >= -4.0)
        & (source_controls[:, 0] <= target_width + 3.0)
        & (source_controls[:, 1] >= -4.0)
        & (source_controls[:, 1] <= target_height + 3.0)
        & (target_controls[:, 0] >= -4.0)
        & (target_controls[:, 0] <= target_width + 3.0)
        & (target_controls[:, 1] >= -4.0)
        & (target_controls[:, 1] <= target_height + 3.0)
    )
    source_controls = source_controls[control_valid]
    target_controls = target_controls[control_valid]
    boundary = np.asarray(
        [
            [0.0, 0.0], [target_width * 0.5, 0.0], [target_width - 1.0, 0.0],
            [0.0, target_height * 0.5], [target_width - 1.0, target_height * 0.5],
            [0.0, target_height - 1.0], [target_width * 0.5, target_height - 1.0],
            [target_width - 1.0, target_height - 1.0],
        ],
        dtype=np.float32,
    )
    source_controls = np.concatenate([source_controls, boundary], axis=0)
    target_controls = np.concatenate([target_controls, boundary], axis=0)
    if len(source_controls) < 16:
        return None, None

    # Delaunay interpolation is evaluated on a small regular grid, then the
    # current->anchor map is enlarged once for the face ROI.
    from scipy.spatial import Delaunay

    mesh_edge = max(64, min(160, int(mesh_size)))
    scale_x = mesh_edge / float(target_width)
    scale_y = mesh_edge / float(target_height)
    destination_small = target_controls * np.asarray([scale_x, scale_y], dtype=np.float32)
    source_small = source_controls * np.asarray([scale_x, scale_y], dtype=np.float32)
    try:
        triangulation = Delaunay(destination_small)
    except Exception:
        return None, None
    grid_y, grid_x = np.mgrid[0:mesh_edge, 0:mesh_edge].astype(np.float32)
    query = np.stack([grid_x.ravel(), grid_y.ravel()], axis=1)
    simplex = triangulation.find_simplex(query)
    supported = simplex >= 0
    if float(np.mean(supported)) < 0.96:
        return None, None
    simplex_safe = np.maximum(simplex, 0)
    affine = triangulation.transform[simplex_safe, :2]
    delta = query - triangulation.transform[simplex_safe, 2]
    bary_first = np.einsum("nij,nj->ni", affine, delta)
    bary = np.column_stack([bary_first, 1.0 - bary_first.sum(axis=1)])
    vertices = triangulation.simplices[simplex_safe]
    mapped = np.sum(source_small[vertices] * bary[..., None], axis=1)
    map_x_small = mapped[:, 0].reshape(mesh_edge, mesh_edge).astype(np.float32)
    map_y_small = mapped[:, 1].reshape(mesh_edge, mesh_edge).astype(np.float32)
    map_x = cv2.resize(map_x_small, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    map_y = cv2.resize(map_y_small, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    map_x *= target_width / float(mesh_edge)
    map_y *= target_height / float(mesh_edge)
    warped_source = cv2.remap(
        affine_source, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101,
    )
    warped_residual = cv2.remap(
        affine_residual, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0,
    )
    current_region = current[target_top:target_bottom, target_left:target_right]
    photo = np.mean(
        np.abs(current_region.astype(np.int16) - warped_source.astype(np.int16)),
        axis=2,
    ).astype(np.float32)
    support = photo <= 22.0
    feature_support: list[float] = []
    radius = max(4, int(round(span * 0.11)))
    for point in target_points:
        px = int(round(float(point[0]) - target_left))
        py = int(round(float(point[1]) - target_top))
        part = np.zeros((target_height, target_width), dtype=np.uint8)
        cv2.circle(part, (px, py), radius, 1, -1)
        region = part.astype(bool)
        feature_support.append(float(np.mean(support[region])) if np.any(region) else 0.0)
    if min(feature_support, default=0.0) < 0.78 or float(np.mean(support)) < 0.72:
        if diagnostics is not None:
            diagnostics["reason"] = "sparse-confidence"
            diagnostics["sparseFeatureSupport"] = feature_support
            diagnostics["sparseSupportRatio"] = float(np.mean(support))
        return None, None
    support_float = cv2.erode(support.astype(np.float32), np.ones((3, 3), dtype=np.uint8))
    alpha = cv2.GaussianBlur(support_float, (5, 5), 0)
    alpha *= support_float
    masked_residual = np.rint(
        warped_residual.astype(np.float32) * alpha[..., None]
    ).astype(np.int16)
    output = np.ascontiguousarray(current, dtype=np.uint8).copy()
    output_region = output[target_top:target_bottom, target_left:target_right]
    cv2.add(output_region, masked_residual, dst=output_region, dtype=cv2.CV_8U)
    if diagnostics is not None:
        diagnostics["reason"] = "sparse-accepted"
        diagnostics["sparsePointCount"] = int(len(anchor_features))
        diagnostics["sparseSupportRatio"] = float(np.mean(support))
        diagnostics["sparseFeatureSupport"] = feature_support
        diagnostics["sparseTotalMs"] = (time.perf_counter() - started) * 1000.0
    return output, next_state


@dataclass(frozen=True)
class ApprovedFace:
    id: str
    name: str
    files: tuple[Path, ...]

    @property
    def thumbnail(self) -> Path:
        return self.files[0]


@dataclass
class SwapSession:
    id: str
    channel: str
    source_url: str
    face_id: str
    start_seconds: float
    # Equivalent transport URLs for the same media. The primary Pong cache
    # route remains first; an optional canonical CDN URL is raced only through
    # source negotiation, and the first decodable route becomes authoritative.
    source_candidates: tuple[str, ...] = ()
    candidate_face_ids: tuple[str, ...] = ()
    selected_face_id: str = ""
    selected_face_similarity: float = 0.0
    multi_face_decision: dict[str, Any] = field(default_factory=dict)
    selected_target_presentation: str = ""
    automatic_target_lock_frame: int = -1
    automatic_target_lock_seconds: float = -1.0
    automatic_acquisition_backfilled_frames: list[int] = field(default_factory=list)
    manual_target_x: float | None = None
    manual_target_y: float | None = None
    manual_target_embedding: np.ndarray | None = field(default=None, repr=False)
    manual_target_presentation: FacePresentation | None = field(default=None, repr=False)
    compatibility_status: str = "pending"
    compatibility_checks: int = 0
    compatibility_rejections: int = 0
    target_identity_checks: int = 0
    target_identity_rejections: int = 0
    target_identity_min_similarity: float = 0.0
    target_identity_max_similarity: float = 0.0
    target_identity_rejection_samples: list[dict[str, Any]] = field(default_factory=list)
    client_epoch: str = ""
    activation_sequence: int = 0
    # Full duration of the original source, not the progressively growing
    # duration reported by the fragmented MP4 reader.  The WebView needs this
    # value to keep its scrubber stable while a one-second prepared stream is
    # promoted into continuous playback.
    source_duration: float = 0.0
    source_fps: float = 0.0
    source_frame_stride: int = 1
    cadence_skipped_frames: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    models_ready_at: float = 0.0
    embedding_ready_at: float = 0.0
    source_opened_at: float = 0.0
    source_decoder_reused: bool = False
    encoder_started_at: float = 0.0
    first_source_frame_at: float = 0.0
    first_transformed_frame_at: float = 0.0
    # A seek can present this high-quality, exact-timeline transformed frame while Android
    # is still probing/decoding the growing fMP4. It is populated only for seek
    # sessions and never substitutes for the continuous encoded stream.
    first_rendered_frame_webp: bytes = field(default=b"", repr=False)
    first_rendered_frame_pending: bool = False
    first_rendered_frame_ready_at: float = 0.0
    first_rendered_frame_transformed: bool = False
    first_byte_at: float = 0.0
    playable_at: float = 0.0
    cancel_requested_at: float = 0.0
    resources_released_at: float = 0.0
    media_fragment_ready: bool = False
    frames: int = 0
    inference_frames: int = 0
    transformed_frames: int = 0
    transformed_frame_ranges: list[list[int]] = field(default_factory=list)
    temporal_reuse_frames: int = 0
    temporal_redetect_recoveries: int = 0
    semantic_landmark_refreshes: int = 0
    semantic_landmark_failures: int = 0
    semantic_landmark_seconds: float = 0.0
    semantic_landmark_last_score: float = 0.0
    semantic_landmark_provider: str = ""
    frame_work_seconds: float = 0.0
    exact_work_seconds: float = 0.0
    reuse_work_seconds: float = 0.0
    redetect_seconds: float = 0.0
    appearance_guard_seconds: float = 0.0
    residual_warp_seconds: float = 0.0
    encoder_write_seconds: float = 0.0
    pacing_wait_seconds: float = 0.0
    foreground_pacing_wait_seconds: float = 0.0
    render_ahead_ceiling_seconds: float = 3.0
    temporal_reuse_rejections: dict[str, int] = field(default_factory=dict)
    temporal_appearance_samples: list[dict[str, Any]] = field(default_factory=list, repr=False)
    diagnostics_enabled: bool = False
    frame_diagnostics: dict[str, list[float]] = field(default_factory=dict, repr=False)
    state: str = "created"
    error: str = ""
    error_code: str = ""
    stop: threading.Event = field(default_factory=threading.Event)
    scrub_suspended: threading.Event = field(default_factory=threading.Event, repr=False)
    condition: threading.Condition = field(default_factory=threading.Condition, repr=False)
    lifecycle_lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    producer: threading.Thread | None = field(default=None, repr=False)
    source_opener: threading.Thread | None = field(default=None, repr=False)
    container: Any | None = field(default=None, repr=False)
    process: subprocess.Popen | None = field(default=None, repr=False)
    decoder: threading.Thread | None = field(default=None, repr=False)
    feeder: threading.Thread | None = field(default=None, repr=False)
    spool_path: Path | None = field(default=None, repr=False)
    bytes_written: int = 0
    transport_padding_bytes: int = 0
    subscribers: int = 0
    stream_requests: int = 0
    request_ranges: list[str] = field(default_factory=list)
    complete: bool = False
    delete_requested: bool = False
    # Native decoder/encoder teardown can take multiple seconds on Windows.
    # Guard it separately from logical cancellation so a replacement stream can
    # become active immediately without launching duplicate interrupter threads.
    interrupt_requested: bool = False
    cleanup_started: bool = False
    width: int = 0
    height: int = 0
    fps: float = 0.0
    prefetch: bool = False
    prebuffer_seconds: float = 0.0
    # How often FFmpeg closes a keyframe-delimited media fragment. This is not
    # the same as the prepared lead target above: a 0.5 s first fragment can
    # become playable while production continues toward a 2 s safety buffer.
    fragment_seconds: float = 1.0
    fragment_frame_target: int = 0
    complete_fragments: int = 0
    navigation_class: str = "prefetch"
    playback_started_at: float = 0.0
    playback_position_seconds: float = 0.0
    playback_position_updated_at: float = 0.0
    playback_paused: bool = False
    activation_requested: bool = False
    # Admission to speculative work is owned by the session so promotion and
    # cancellation can release it independently of mutable role flags.
    prefetch_gate_owned: bool = False
    # A session must remain internally consistent even while the operator edits
    # the PC preset. In particular, output dimensions and FFmpeg input size may
    # never change after the encoder has started.
    config: dict[str, Any] = field(default_factory=dict, repr=False)
    config_revision: int = 0

    def prepared_frame_target(self) -> int:
        """Return the number of output frames needed for a safe preload.

        ``prebuffer_seconds`` is normally clamped to the scheduler's minimum
        headroom. A seek near EOF cannot manufacture that much media, though,
        and container duration/PTS rounding can still differ by one frame. A
        completed stream with a valid fragment is therefore also considered
        prepared once it contains at least one frame (see :meth:`is_prepared`).
        """
        if self.fps <= 0:
            return 1
        return max(1, round(self.fps * self.prebuffer_seconds))

    def muxed_media_seconds(self) -> float:
        """Return conservative playable time represented by complete fragments."""
        if self.fps <= 0 or self.complete_fragments <= 0:
            return 0.0
        fragment_frames = max(1, int(self.fragment_frame_target or 1))
        muxed_frames = min(
            max(0, int(self.frames)),
            self.complete_fragments * fragment_frames,
        )
        return float(muxed_frames) / float(self.fps)

    def browser_startup_bytes(self) -> int:
        """Return the minimum initial body needed by Android's MP4 probe.

        Service-created sessions always carry a complete configuration
        snapshot. A zero fallback preserves compatibility for old/in-process
        session objects which predate this transport-only readiness contract.
        """
        runtime = self.config.get("runtime", {}) if isinstance(self.config, dict) else {}
        try:
            value = int(runtime.get("browserStartupBytes", 0) or 0)
        except (TypeError, ValueError, OverflowError):
            value = 0
        return max(0, min(2 * 1024 * 1024, value))

    def browser_startup_ready(self) -> bool:
        """Return whether the first HTTP body is safe to expose to WebView."""
        if not self.media_fragment_ready:
            return False
        runtime = self.config.get("runtime", {}) if isinstance(self.config, dict) else {}
        try:
            minimum_media_seconds = max(
                0.0,
                min(5.0, float(runtime.get("browserStartupMediaSeconds", 0.0) or 0.0)),
            )
        except (TypeError, ValueError, OverflowError):
            minimum_media_seconds = 0.0
        if (
            not self.complete
            and minimum_media_seconds > 0.0
            and self.muxed_media_seconds() + (1.0 / max(1.0, self.fps))
            < minimum_media_seconds
        ):
            return False
        minimum = self.browser_startup_bytes()
        # A finalized short clip cannot grow to the configured byte budget;
        # its complete container is nevertheless a valid finite MP4.
        return bool(self.complete or minimum <= 0 or self.bytes_written >= minimum)

    def is_prepared(self) -> bool:
        if not self.browser_startup_ready() or self.fps <= 0:
            return False
        # Source duration metadata is occasionally a fraction of a frame more
        # optimistic than the decoder. EOF is authoritative: a finalized
        # fragment containing real video is the maximum attainable preload.
        if self.complete and self.frames > 0:
            return True
        if self.frames < self.prepared_frame_target():
            return False
        if self.prebuffer_seconds <= 0:
            return True
        # Count time represented by complete keyframe-delimited fragments. Raw
        # frames and encoded byte size are not playback clocks, especially when
        # the configured quality policy is variable bitrate.
        fed_seconds = float(self.frames) / float(self.fps)
        muxed_seconds = self.muxed_media_seconds()
        playable_seconds = min(fed_seconds, muxed_seconds)
        frame_tolerance = 1.0 / float(self.fps)
        return playable_seconds + frame_tolerance >= self.prebuffer_seconds

    def stream_startup_ready(self, media_source: bool = False) -> bool:
        # MediaSource receives an explicit codec and complete MP4 fragments;
        # unlike Android's URL demuxer it does not need a 48 KiB sniff window.
        if media_source:
            return bool(self.media_fragment_ready and self.complete_fragments > 0)
        return self.browser_startup_ready()

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "channel": self.channel,
            "faceId": self.face_id,
            "faceIds": list(self.candidate_face_ids or (self.face_id,)),
            "selectedFaceId": self.selected_face_id,
            "selectedFaceSimilarity": self.selected_face_similarity,
            "multiFace": self.multi_face_decision,
            "selectedTargetPresentation": self.selected_target_presentation,
            "automaticTargetLockFrame": self.automatic_target_lock_frame,
            "automaticTargetLockSeconds": self.automatic_target_lock_seconds,
            "automaticAcquisitionBackfilledFrames": list(
                self.automatic_acquisition_backfilled_frames
            ),
            "manualTarget": (
                {
                    "x": self.manual_target_x,
                    "y": self.manual_target_y,
                    "identityLocked": self.manual_target_embedding is not None,
                }
                if self.manual_target_x is not None and self.manual_target_y is not None
                else None
            ),
            "compatibilityStatus": self.compatibility_status,
            "compatibilityChecks": self.compatibility_checks,
            "compatibilityRejections": self.compatibility_rejections,
            "targetIdentityChecks": self.target_identity_checks,
            "targetIdentityRejections": self.target_identity_rejections,
            "targetIdentityMinSimilarity": self.target_identity_min_similarity,
            "targetIdentityMaxSimilarity": self.target_identity_max_similarity,
            "targetIdentityRejectionSamples": list(
                self.target_identity_rejection_samples
            ),
            "clientEpoch": self.client_epoch,
            "activationSequence": self.activation_sequence,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "modelsReadyAt": self.models_ready_at,
            "restorationProfile": self.config.get("runtime", {}).get("tiktokRestorerProfile", "default"),
            "adaptiveRestoration": dict(self.config.get("runtime", {}).get("tiktokRestorerState", {})),
            "embeddingReadyAt": self.embedding_ready_at,
            "sourceOpenedAt": self.source_opened_at,
            "sourceDecoderReused": self.source_decoder_reused,
            "encoderStartedAt": self.encoder_started_at,
            "firstSourceFrameAt": self.first_source_frame_at,
            "firstTransformedFrameAt": self.first_transformed_frame_at,
            "firstRenderedFrameReady": bool(self.first_rendered_frame_webp),
            "firstRenderedFrameReadyAt": self.first_rendered_frame_ready_at,
            "firstRenderedFrameTransformed": self.first_rendered_frame_transformed,
            "firstRenderedFrameBytes": len(self.first_rendered_frame_webp),
            "firstByteAt": self.first_byte_at,
            "playableAt": self.playable_at,
            "cancelRequestedAt": self.cancel_requested_at,
            "resourcesReleasedAt": self.resources_released_at,
            "mediaFragmentReady": self.media_fragment_ready,
            "browserStartupBytes": self.browser_startup_bytes(),
            "browserStartupReady": self.browser_startup_ready(),
            "frames": self.frames,
            "inferenceFrames": self.inference_frames,
            "transformedFrames": self.transformed_frames,
            "transformedFrameRanges": [list(pair) for pair in self.transformed_frame_ranges],
            "temporalReuseFrames": self.temporal_reuse_frames,
            "temporalRedetectRecoveries": self.temporal_redetect_recoveries,
            "semanticLandmarks": {
                "refreshes": self.semantic_landmark_refreshes,
                "failures": self.semantic_landmark_failures,
                "seconds": self.semantic_landmark_seconds,
                "lastScore": self.semantic_landmark_last_score,
                "provider": self.semantic_landmark_provider,
            },
            "timingTotals": {
                "frameWorkSeconds": self.frame_work_seconds,
                "exactWorkSeconds": self.exact_work_seconds,
                "reuseWorkSeconds": self.reuse_work_seconds,
                "redetectSeconds": self.redetect_seconds,
                "appearanceGuardSeconds": self.appearance_guard_seconds,
                "residualWarpSeconds": self.residual_warp_seconds,
                "encoderWriteSeconds": self.encoder_write_seconds,
                "pacingWaitSeconds": self.pacing_wait_seconds,
                "foregroundPacingWaitSeconds": self.foreground_pacing_wait_seconds,
                "renderAheadCeilingSeconds": self.render_ahead_ceiling_seconds,
            },
            "temporalReuseRejections": dict(self.temporal_reuse_rejections),
            "temporalAppearanceSamples": list(self.temporal_appearance_samples),
            "diagnostics": (
                {key: list(values) for key, values in list(self.frame_diagnostics.items())
                 if not key.startswith("_")}
                if self.diagnostics_enabled
                else {}
            ),
            "bytesWritten": self.bytes_written,
            "transportPaddingBytes": self.transport_padding_bytes,
            "subscribers": self.subscribers,
            "streamRequests": self.stream_requests,
            "requestRanges": list(self.request_ranges),
            "complete": self.complete,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "sourceFps": self.source_fps or self.fps,
            "sourceFrameStride": self.source_frame_stride,
            "cadenceSkippedFrames": self.cadence_skipped_frames,
            "cadencePolicy": "uniform-full-quality" if self.source_frame_stride > 1 else "source-rate",
            "duration": self.source_duration,
            "prefetch": self.prefetch,
            "prebufferSeconds": self.prebuffer_seconds,
            "preparedFrameTarget": self.prepared_frame_target(),
            "fragmentSeconds": self.fragment_seconds,
            "fragmentFrameTarget": self.fragment_frame_target,
            "completeFragments": self.complete_fragments,
            "muxedMediaSeconds": self.muxed_media_seconds(),
            "navigationClass": self.navigation_class,
            "activationRequested": self.activation_requested,
            "scrubSuspended": self.scrub_suspended.is_set(),
            "playbackStartedAt": self.playback_started_at,
            "playbackPositionSeconds": self.playback_position_seconds,
            "playbackPositionUpdatedAt": self.playback_position_updated_at,
            "playbackPaused": self.playback_paused,
            "configRevision": self.config_revision,
            "prepared": self.is_prepared(),
            "state": self.state,
            "error": self.error,
            "errorCode": self.error_code,
            "terminal": self.complete or self.state in {"error", "stopped", "finished", "deferred"},
        }


@dataclass
class FramePreview:
    """Ephemeral, memory-only source frame used by Pong's settings editor."""

    id: str
    source_url: str
    face_id: str
    start_seconds: float
    frame: np.ndarray = field(repr=False)
    geometry_only: bool = False
    detected_faces: list[dict[str, Any]] | None = field(default=None, repr=False)
    detection_profile: str = ""
    detection_token: str = ""
    recovered_indices: set[int] = field(default_factory=set, repr=False)
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)
    anchor: np.ndarray | None = field(default=None, repr=False)
    tracking_state: dict[str, Any] = field(default_factory=dict, repr=False)
    tracking_profile: str = ""
    manual_target_x: float | None = None
    manual_target_y: float | None = None
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    def public(self) -> dict[str, Any]:
        height, width = self.frame.shape[:2]
        return {
            "id": self.id,
            "faceId": self.face_id,
            "startSeconds": self.start_seconds,
            "width": int(width),
            "height": int(height),
            "createdAt": self.created_at,
            "geometryOnly": self.geometry_only,
        }


class PongSwapEngine:
    # These values configure shared model/session objects or change the enhancer
    # profile. They can be changed only when no created/running session (and no
    # background embedding primer) still depends on the current model graph.
    _MODEL_LIFECYCLE_CONFIG_PATHS = (
        ("runtime", "identityClassifierBackend"),
        ("runtime", "backend"),
        ("runtime", "orderedGpuSubmission"),
        ("runtime", "restorerBackendPreference"),
        ("runtime", "restorerNativeTrtTf32"),
        ("runtime", "restorerNativeTrtQualifiedPlan"),
        ("runtime", "restorerNativeTrtQualifiedPlan1024"),
        ("runtime", "restorerNativeTrtSplitPlan"),
        ("runtime", "restorerNativeStaticResidualPath"),
        ("runtime", "restorerCudaDirectIo"),
        ("runtime", "restorerCudaGraph"),
        ("runtime", "maskCudaGraph"),
        ("runtime", "maskBackendPreference"),
        ("runtime", "maskAdaptiveBackendEnabled"),
        ("runtime", "frameEnhancerEnabled"),
        ("runtime", "frameEnhancerType"),
        ("runtime", "frameEnhancerScope"),
        ("runtime", "frameEnhancerTileSize"),
        ("runtime", "frameEnhancerDownscale"),
        ("parameters", "ModelSessionsTextSel"),
        # Detector/profile settings also determine approved-face alignment and
        # therefore the persistent source-embedding cache key.
        ("parameters", "DetectTypeTextSel"),
        ("parameters", "DetectInputSizeTextSel"),
        # Swapper/restorer choices are hot visual selections. Models owns one
        # independent cached session per choice, so switching between them must
        # not tear down RetinaFace, ArcFace, the current GPEN graph, and every
        # other already-warm session. Full teardown here caused live dropdown
        # changes to time out while rebuilding an otherwise unchanged graph.
        # Merge mode changes the persisted source embedding and the shared
        # distinctiveness mean used by Rope's latent cache.
        ("parameters", "MergeTextSel"),
    )

    def __init__(self) -> None:
        # Configuration/session registration is control-plane work and must not
        # queue behind every GPU frame.  `_lock` deliberately remains the
        # model/inference lock; `_config_lock` protects only the authoritative
        # preset and its revision.
        self._config_lock = threading.RLock()
        self._lock = threading.RLock()
        self._sessions_lock = threading.RLock()
        self._models = None
        self._vm = None
        self._enhancer_session = None
        self._enhancer_batch_max = 6
        self._torch = None
        # Shared ORT/TensorRT sessions are bound to one long-lived CUDA stream.
        # Keeping the stream object alive for the same lifetime as the sessions
        # is required: ORT stores only the native cudaStream_t pointer.
        self._compute_stream = None
        # A sparse 68-point semantic refresh keeps rapid yaw/head motion tied
        # to real facial features between expensive exact swap/restorer frames.
        # It is a long-lived part of the selected graph, bound to the same CUDA
        # stream as Rope, and is never constructed by a feeder thread.
        self._semantic_landmark_estimator = None
        self._warming_models = None
        self._warming_stream = None
        # Successful first-run probes belong to a published model generation,
        # not to an individual SwapSession producer thread. Replaying detector,
        # recognizer, swapper and restorer probes from every short-lived feeder
        # thread grows native CUDA/ORT execution state by hundreds of MiB per
        # video on Windows. This signature lets all sessions reuse the exact
        # already-warmed graph until a selected model/backend/shape changes.
        self._pipeline_warm_signature: tuple[Any, ...] | None = None
        # All live detector/swap/restorer calls execute on one stable OS thread.
        # ORT CUDA/TensorRT providers retain native execution workspaces in
        # thread-associated state even when the InferenceSession itself is
        # shared. Creating a fresh feeder thread for every video measured as an
        # additional ~600 MiB of VRAM per session and eventually reduced a
        # realtime stream to 0.19x. Decoders and encoders remain per-session;
        # only serialized GPU work is scheduled here.
        self._gpu_worker_lock = threading.Lock()
        self._gpu_worker_queue: queue.PriorityQueue[Any] = queue.PriorityQueue()
        self._gpu_promoted_events: weakref.WeakSet = weakref.WeakSet()
        self._gpu_worker_thread: threading.Thread | None = None
        self._gpu_worker_ident = 0
        self._gpu_work_sequence = 0
        self._gpu_worker_inflight = 0
        self._gpu_worker_active_label = ""
        self._gpu_worker_active_since = 0.0
        self._gpu_worker_last_completed_at = 0.0
        self._gpu_worker_cancelled_before_start = 0
        self._gpu_worker_closing = False
        self._config = load_config()
        self._detection_calibration = DetectionCalibration(
            Path(__file__).resolve().parent / "presets" / "detection-learning.json"
        )
        self._config_revision = 1
        self._multi_video_sources = MultiVideoSources()
        self._instance_id = uuid.uuid4().hex
        self._model_residency: dict[str, Any] = {}
        self._last_gpu_oom: dict[str, Any] = {}
        self._faces: dict[str, ApprovedFace] = {}
        self._embedding_cache: dict[tuple[str, str], np.ndarray] = {}
        self._source_frame_cache: dict[tuple[str, str], Any] = {}
        self._presentation_cache: dict[tuple[str, str], FacePresentation] = {}
        self._presentation_key_locks_guard = threading.Lock()
        self._presentation_key_locks: dict[tuple[str, str], threading.Lock] = {}
        self._presentation_classifier = FairFacePresentationClassifier(
            Path(__file__).resolve().parent
            / "vendor"
            / "facefusion-benchmark"
            / ".assets"
            / "models"
            / "fairface.onnx",
            backend=str(self._config["runtime"].get("identityClassifierBackend", "cpu")),
        )
        self._embedding_cache_dir = CACHE_DIR / "embeddings-v2"
        self._embedding_cache_dir.mkdir(parents=True, exist_ok=True)
        self._embedding_prime_lock = threading.Lock()
        self._embedding_prime_started = False
        self._embedding_prime_thread: threading.Thread | None = None
        self._embedding_prime_cancel = threading.Event()
        self._embedding_prime_error = ""
        # Opening the face picker primes every approved identity in the
        # background.  Those source-image passes use the same global model lock
        # as a real playback session, so an unlucky foreground request could sit
        # behind the entire face list.  Keep a tiny, independent priority gate:
        # the primer finishes at most its current identity, then yields until
        # session registration / selected-identity work has completed.
        self._embedding_priority_condition = threading.Condition()
        self._foreground_embedding_work = 0
        self._embedding_key_locks_guard = threading.Lock()
        self._embedding_key_locks: dict[tuple[str, str], threading.Lock] = {}
        self._sessions: dict[str, SwapSession] = {}
        self._active_by_channel: dict[str, str] = {}
        self._activation_by_client_channel: dict[tuple[str, str], int] = {}
        self._frame_previews: dict[str, FramePreview] = {}
        self._frame_previews_lock = threading.RLock()
        self._frame_preview_render_leases = 0
        # Speculative sessions prepare in order instead of all fighting for the
        # same ONNX/CUDA lock. Foreground playback never takes this gate.
        self._prefetch_gate = threading.Lock()
        # Network/source negotiation is independent of GPU inference. Allow the
        # two predicted next videos to open together while retaining the single
        # speculative GPU gate above. This is deliberately session-bounded:
        # each session may race two equivalent routes, and late losers close as
        # soon as their open attempt returns.
        self._prefetch_source_open_gate = threading.BoundedSemaphore(2)
        self._standby_sources = StandbySourcePool()
        self._last_used = 0.0
        self._warm_error = ""
        self.scan_faces()
        self._orphan_spools_removed = 0

    @property
    def config(self) -> dict[str, Any]:
        # Do not expose the authoritative nested dict. A caller mutating the
        # object returned by /settings used to bypass normalization, persistence
        # and the model-lifecycle checks in update_config().
        with self._config_lock:
            return deepcopy(self._config)

    def _gpu_worker_loop(self) -> None:
        self._gpu_worker_ident = threading.get_ident()
        try:
            while True:
                (
                    _priority,
                    _sequence,
                    callback,
                    args,
                    kwargs,
                    completed,
                    result,
                    queue_cancel_event,
                    cancelled_value,
                    work_label,
                ) = self._gpu_worker_queue.get()
                stop_worker = callback is None
                try:
                    if stop_worker:
                        result["value"] = True
                    elif queue_cancel_event is not None and queue_cancel_event.is_set():
                        self._gpu_worker_cancelled_before_start += 1
                        result["value"] = cancelled_value
                    else:
                        self._gpu_worker_inflight = 1
                        self._gpu_worker_active_label = str(work_label or getattr(callback, "__name__", "gpu-work"))
                        self._gpu_worker_active_since = time.time()
                        result["value"] = callback(*args, **kwargs)
                except BaseException as exc:
                    result["error"] = exc
                finally:
                    self._gpu_worker_inflight = 0
                    self._gpu_worker_active_label = ""
                    self._gpu_worker_active_since = 0.0
                    self._gpu_worker_last_completed_at = time.time()
                    completed.set()
                    self._gpu_worker_queue.task_done()
                    # queue.get() otherwise retains the last frame/context while
                    # the worker is idle. The waiting caller owns result now.
                    callback = None
                    args = None
                    kwargs = None
                    completed = None
                    result = None
                    queue_cancel_event = None
                    cancelled_value = None
                    work_label = ""
                if stop_worker:
                    break
        finally:
            with self._gpu_worker_lock:
                if self._gpu_worker_thread is threading.current_thread():
                    self._gpu_worker_thread = None
                self._gpu_worker_ident = 0
                self._gpu_worker_closing = False

    def _ensure_gpu_worker(self) -> threading.Thread:
        with self._gpu_worker_lock:
            if getattr(self, "_gpu_worker_closing", False):
                raise RuntimeError("Pong Swap GPU worker is shutting down")
            worker = self._gpu_worker_thread
            if worker is None or not worker.is_alive():
                worker = threading.Thread(
                    target=self._gpu_worker_loop,
                    name="PongSwapGPU",
                    daemon=True,
                )
                self._gpu_worker_thread = worker
                worker.start()
            return worker

    def _promote_queued_session_work(self, session: SwapSession) -> int:
        """Promote an activated prefetch's already-queued work, exactly once.

        Queue priorities were snapshots of session.prefetch. Changing that flag
        on a swipe did not move its waiting warm/frame job out of the background
        lane. Keep FIFO order among foreground jobs and never interrupt the
        in-flight frame or modify another session's work.
        """
        if not hasattr(self, "_gpu_worker_lock"):
            return 0
        with self._gpu_worker_lock:
            promoted = getattr(self, "_gpu_promoted_events", None)
            if promoted is None:
                promoted = self._gpu_promoted_events = weakref.WeakSet()
            promoted.add(session.stop)
            changed = 0
            with self._gpu_worker_queue.mutex:
                jobs = self._gpu_worker_queue.queue
                for index, job in enumerate(jobs):
                    if job[0] > 0 and job[2] is not None and job[7] is session.stop:
                        jobs[index] = (0, *job[1:])
                        changed += 1
                if changed:
                    heapq.heapify(jobs)
            return changed

    def _run_gpu_work(
        self,
        callback,
        *args,
        priority: int = 0,
        queue_cancel_event: threading.Event | None = None,
        cancelled_value: Any = None,
        work_label: str = "",
        **kwargs,
    ):
        """Run one GPU operation on Pong's persistent execution thread.

        Calls originating from the worker execute inline, which makes nested
        helpers safe. The priority queue gives visible foreground and seek work
        precedence over speculative preparation without changing rendered
        pixels or model settings.
        """
        if threading.get_ident() == self._gpu_worker_ident:
            return callback(*args, **kwargs)
        completed = threading.Event()
        result: dict[str, Any] = {}
        # Admission and publication must be one atomic operation with respect
        # to shutdown.  Previously shutdown could set ``_gpu_worker_closing``
        # and enqueue its sentinel after _ensure_gpu_worker() returned but
        # before this request reached the queue.  The sentinel then stopped the
        # owner first and this caller waited forever on ``completed``.
        with self._gpu_worker_lock:
            if self._gpu_worker_closing:
                raise RuntimeError("Pong Swap GPU worker is shutting down")
            worker = self._gpu_worker_thread
            if worker is None or not worker.is_alive():
                worker = threading.Thread(
                    target=self._gpu_worker_loop,
                    name="PongSwapGPU",
                    daemon=True,
                )
                self._gpu_worker_thread = worker
                worker.start()
            self._gpu_work_sequence += 1
            sequence = self._gpu_work_sequence
            # Covers promotion racing a submission whose caller computed the
            # old priority before taking this admission/publication lock.
            if queue_cancel_event in getattr(self, "_gpu_promoted_events", ()):
                priority = min(0, int(priority))
            self._gpu_worker_queue.put(
                (
                    int(priority),
                    sequence,
                    callback,
                    args,
                    kwargs,
                    completed,
                    result,
                    queue_cancel_event,
                    cancelled_value,
                    str(work_label or getattr(callback, "__name__", "gpu-work")),
                )
            )
        completed.wait()
        error = result.get("error")
        if error is not None:
            raise error
        return result.get("value")

    def shutdown_gpu_worker(self, *, timeout: float = 10.0) -> bool:
        """Drain and stop the owner thread for disposable benchmark engines."""
        if threading.get_ident() == self._gpu_worker_ident:
            return False
        with self._gpu_worker_lock:
            worker = self._gpu_worker_thread
            if worker is None or not worker.is_alive():
                self._gpu_worker_thread = None
                self._gpu_worker_ident = 0
                self._gpu_worker_closing = False
                return True
            if self._gpu_worker_closing:
                closing = True
            else:
                self._gpu_worker_closing = True
                self._gpu_work_sequence += 1
                sequence = self._gpu_work_sequence
                closing = False
        if not closing:
            completed = threading.Event()
            result: dict[str, Any] = {}
            self._gpu_worker_queue.put((
                2**31 - 1,
                sequence,
                None,
                (),
                {},
                completed,
                result,
                None,
                None,
                "shutdown",
            ))
            completed.wait(timeout=max(0.0, float(timeout)))
        worker.join(timeout=max(0.0, float(timeout)))
        return not worker.is_alive()

    def _normalized_config(self, config: dict[str, Any]) -> dict[str, Any]:
        # Preserve the user's current authoritative baseline when a stale
        # client omits a value or sends JSON null. Factory defaults are not a
        # safe substitute for a deliberately tuned active preset.
        normalized = deepcopy(self._config)
        # Browser state can outlive a server/config revision.  Treat explicit
        # JSON null values from that stale state as "use the authoritative
        # default" instead of allowing None to reach numeric and nested-map
        # consumers in the render path.
        for section in ("runtime", "parameters"):
            supplied = config.get(section)
            if not isinstance(supplied, dict):
                continue
            normalized[section].update(
                {
                    name: deepcopy(value)
                    for name, value in supplied.items()
                    if value is not None
                }
            )
        normalize_production_model_choices(normalized)
        validate_restorer_backend_preference(normalized["runtime"]["restorerBackendPreference"])
        return normalized

    @classmethod
    def _model_lifecycle_changed(
        cls,
        before: dict[str, Any],
        after: dict[str, Any],
    ) -> bool:
        return any(
            before.get(section, {}).get(name) != after.get(section, {}).get(name)
            for section, name in cls._MODEL_LIFECYCLE_CONFIG_PATHS
        )

    def _model_configuration_in_use(self) -> bool:
        primer = getattr(self, "_embedding_prime_thread", None)
        # Cancellation is a request, not proof that the thread released its
        # model/session references.  Treat the primer as an owner until its
        # finally block actually exits.
        primer_busy = self._thread_is_alive(primer)
        preview_lock = getattr(self, "_frame_previews_lock", None)
        if preview_lock is None:
            preview_rendering = int(getattr(self, "_frame_preview_render_leases", 0) or 0) > 0
        else:
            with preview_lock:
                preview_rendering = int(getattr(self, "_frame_preview_render_leases", 0) or 0) > 0
        return (
            self._active_session_count() > 0
            or primer_busy
            or preview_rendering
        )

    def _cancel_embedding_prime(self, *, timeout: float = 5.0) -> bool:
        """Cancel speculative face priming before a requested graph change.

        The primer deliberately registers before its 30-second idle delay so a
        graph change cannot race an unregistered worker. That registration must
        not make a user-selected swapper/restorer wait for the whole delay.
        """
        cancel = getattr(self, "_embedding_prime_cancel", None)
        if cancel is None:
            cancel = threading.Event()
            self._embedding_prime_cancel = cancel
        cancel.set()
        with self._embedding_priority_condition:
            self._embedding_priority_condition.notify_all()
        with self._embedding_prime_lock:
            primer = self._embedding_prime_thread
        if self._thread_is_alive(primer) and primer is not threading.current_thread():
            # The primer can be waiting for a cancellable low-priority GPU job.
            # Joining it from the GPU owner would prevent that job from being
            # dequeued and cancelled until the timeout expires.
            if threading.get_ident() == getattr(self, "_gpu_worker_ident", 0):
                return True
            primer.join(timeout=max(0.0, float(timeout)))
        return not self._thread_is_alive(primer)

    def _config_snapshot(self) -> tuple[dict[str, Any], int]:
        with self._config_lock:
            return deepcopy(self._config), self._config_revision

    def update_config(
        self,
        config: dict[str, Any],
        *,
        persist: bool = True,
        backup: bool = False,
    ) -> dict[str, Any]:
        from pong_swap_config import save_config

        if (
            hasattr(self, "_gpu_worker_queue")
            and threading.get_ident() != getattr(self, "_gpu_worker_ident", 0)
        ):
            try:
                candidate = self._normalized_config(config)
                if self._model_lifecycle_changed(self._config, candidate):
                    self._embedding_prime_cancel.set()
                    with self._embedding_priority_condition:
                        self._embedding_priority_condition.notify_all()
            except Exception:
                # Authoritative normalization/validation still runs on owner.
                pass
            return self._run_gpu_work(
                self.update_config,
                deepcopy(config),
                priority=-5,
                work_label="update-config",
                persist=persist,
                backup=backup,
            )

        # Lock order is config -> primer retirement -> model. Updates are rare
        # and may legitimately wait for one in-flight primer identity; ordinary
        # POST /sessions takes only the config lock and never waits for ordinary
        # frame inference.
        with self._config_lock:
            candidate = self._normalized_config(config)
            # A persisted submission may intentionally commit the currently
            # previewed values.  In that case the live candidate is unchanged,
            # but the on-disk baseline can still be older and must be updated.
            # Preview events remain write-free.
            if candidate == self._config:
                if persist:
                    applied = (
                        save_config(candidate, backup=True) if backup
                        else save_config(candidate)
                    )
                    self._config = deepcopy(applied)
                return deepcopy(self._config)
            lifecycle_changed = self._model_lifecycle_changed(self._config, candidate)
            if lifecycle_changed and self._active_session_count() > 0:
                raise ConfigUpdateConflict(
                    "Stop active/preloaded swap sessions before changing the model backend, "
                    "enhancer/detector profile, model-session mode, or embedding merge mode"
                )
            if lifecycle_changed and not self._cancel_embedding_prime():
                raise ConfigUpdateConflict(
                    "Background face preparation is finishing one identity; retry the model change"
                )
            with self._lock:
                # A test hook and a final defensive recheck cover any owner
                # registered before this updater acquired the configuration lock.
                if lifecycle_changed and self._model_configuration_in_use():
                    raise ConfigUpdateConflict(
                        "Stop active/preloaded swap sessions before changing the model backend, "
                        "enhancer/detector profile, model-session mode, or embedding merge mode"
                    )

                if lifecycle_changed:
                    # Retire successfully before publishing/persisting a backend
                    # change. A failed fence must leave the old config in force.
                    self.unload()
                    if self._models is not None or getattr(self, "_warming_models", None) is not None:
                        raise ConfigUpdateConflict("Model retirement failed; configuration was not changed")

                applied = (
                    save_config(candidate, backup=True) if backup
                    else save_config(candidate)
                ) if persist else candidate
                self._config = deepcopy(applied)
                self._config_revision += 1
                if lifecycle_changed:
                    self._warm_error = ""
                elif self._models is not None and self._active_session_count() == 0:
                    runtime = self._config["runtime"]
                    self._model_residency = self._models.reconcile_production_residency(
                        self._config["parameters"],
                        retained_restorers=self._session_restorers(self._config),
                        minimum_free_mib=runtime.get("prefetchMinFreeMiB", 1536),
                        preview_lru_limit=runtime.get("previewModelLruLimit", 0),
                    )
                return deepcopy(self._config)

    def stop_all_sessions(self) -> int:
        """Stop every registered swap producer before a live model-profile edit."""
        with self._sessions_lock:
            sessions = list(self._sessions.values())
        for session in sessions:
            self._request_session_stop(session, delete=True)
            if session.producer is None:
                with session.condition:
                    session.complete = True
                    session.condition.notify_all()
                self._schedule_spool_cleanup(session, delay=0.0)
        return len(sessions)

    def scan_faces(self) -> list[ApprovedFace]:
        groups: list[tuple[str, list[Path]]] = []
        FACES_DIR.mkdir(parents=True, exist_ok=True)
        for folder in sorted((p for p in FACES_DIR.iterdir() if p.is_dir()), key=_natural_name_key):
            files = sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
            if files:
                groups.append((folder.name, files))
        for image in sorted((p for p in FACES_DIR.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS), key=lambda p: p.name.lower()):
            groups.append((image.stem, [image]))
        found: dict[str, ApprovedFace] = {}
        for name, files in groups:
            # Identity follows image contents, not only the filename. Replacing
            # an approved image in place must invalidate its persisted ArcFace
            # embedding instead of silently reusing the old person.
            hasher = hashlib.sha256()
            for path in files:
                hasher.update(str(path.relative_to(FACES_DIR)).lower().encode("utf-8"))
                try:
                    with path.open("rb") as source:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            hasher.update(chunk)
                except OSError:
                    continue
            digest = hasher.hexdigest()[:12]
            face_id = f"{_slug(name)}-{digest}"
            found[face_id] = ApprovedFace(face_id, name, tuple(files))
        self._faces = found
        return list(found.values())

    def faces_public(self) -> list[dict[str, Any]]:
        self.scan_faces()
        result = [
            {
                "id": face.id,
                "name": face.name,
                "imageCount": len(face.files),
                "thumbnailUrl": f"/pong-swap/faces/{face.id}/thumbnail",
                "sourceImageUrl": f"/pong-swap/faces/{face.id}/source",
            }
            for face in self._faces.values()
        ]
        # Do not let speculative work for every approved identity race the face
        # the user actually taps.  The face picker and album setup can take more
        # than eight seconds on Android, so an eight-second timer regularly began
        # the full TensorRT warm-up just before the first live POST /sessions.
        # That inverted the priority and added several seconds to the only cold
        # transition the user directly waits for.  Keep a longer grace window;
        # the selected session warms the same graph immediately, while the idle
        # primer still fills every other per-face cache afterward.
        # Per-face disk embeddings still make a later selection inexpensive.
        self.prime_embeddings_async(delay_seconds=30.0)
        return result

    def face(self, face_id: str) -> ApprovedFace:
        # Face ids are content-addressed and /faces refreshes the inventory
        # before the picker exposes an id.  Re-hashing every approved image for
        # every thumbnail and again for POST /sessions turned a single picker
        # selection into hundreds of megabytes of redundant disk I/O.  Use the
        # current immutable-id inventory first; only rescan when a caller asks
        # for an id that was not present in the latest inventory (for example,
        # an image added on disk after service start).
        face = self._faces.get(face_id)
        if face is None:
            self.scan_faces()
            face = self._faces.get(face_id)
        if face is None:
            raise KeyError("approved face was not found")
        return face

    def delete_face(self, face_id: str) -> dict[str, Any]:
        """Permanently remove one explicitly selected approved identity.

        A face id is content-addressed and must resolve through the current
        inventory. Only the exact approved image files belonging to that id are
        unlinked; empty identity folders are then pruned without ever removing
        the approved-faces root or a folder containing unrelated files.
        """
        face = self.face(face_id)
        with self._sessions_lock:
            sessions = [
                session
                for session in self._sessions.values()
                if face.id in (session.candidate_face_ids or (session.face_id,))
            ]
        for session in sessions:
            self._request_session_stop(session, delete=True)

        root = FACES_DIR.resolve()
        deleted_files = 0
        parent_candidates: set[Path] = set()
        for path in face.files:
            resolved = path.resolve()
            if not resolved.is_relative_to(root) or resolved == root:
                raise ValueError("approved face path escaped the approved-faces directory")
            parent_candidates.add(resolved.parent)
            try:
                resolved.unlink()
                deleted_files += 1
            except FileNotFoundError:
                pass

        # Deepest first, stopping at the root and preserving any directory
        # containing a non-image note or an unrelated approved identity.
        for parent in sorted(parent_candidates, key=lambda value: len(value.parts), reverse=True):
            current = parent
            while current != root and current.is_relative_to(root):
                try:
                    current.rmdir()
                except (OSError, FileNotFoundError):
                    break
                current = current.parent

        with self._lock:
            self._faces.pop(face.id, None)
            for key in [key for key in self._embedding_cache if key[0] == face.id]:
                self._embedding_cache.pop(key, None)
            for key in [key for key in self._source_frame_cache if key[0] == face.id]:
                self._source_frame_cache.pop(key, None)
            for key in [key for key in self._presentation_cache if key[0] == face.id]:
                self._presentation_cache.pop(key, None)
        with self._embedding_key_locks_guard:
            for key in [key for key in self._embedding_key_locks if key[0] == face.id]:
                self._embedding_key_locks.pop(key, None)
        with self._presentation_key_locks_guard:
            for key in [key for key in self._presentation_key_locks if key[0] == face.id]:
                self._presentation_key_locks.pop(key, None)
        for cache_path in self._embedding_cache_dir.glob(f"{_slug(face.name)}-*.npy"):
            try:
                cache_path.unlink()
            except OSError:
                pass
        self.scan_faces()
        return {
            "id": face.id,
            "name": face.name,
            "deletedFiles": deleted_files,
        }

    def _session_restorers(self, config):
        required = set(restorer_models(config))
        # A swipe retires its producer before the next card is registered.
        # Do not unload 512 in that brief gap and repay graph warm-up per card.
        if time.monotonic() < getattr(self, "_tiktok_restorers_keep_until", 0.0):
            required.update(("GPEN512", "GPEN1024"))
        with self._sessions_lock:
            for session in self._sessions.values():
                if not session.stop.is_set() and not session.complete:
                    required.update(restorer_models(session.config))
        return tuple(sorted(value for value in required if value))

    @staticmethod
    def _warm_selected_restorer(models, torch, stream, config, *, allow_create=True):
        with torch.cuda.stream(stream):
            for restorer in restorer_models(config):
                models.warm_restorer(
                    restorer, allow_create=allow_create,
                )

    @staticmethod
    def _pipeline_signature(config: dict[str, Any]) -> tuple[Any, ...]:
        parameters = config.get("parameters", {})
        runtime = config.get("runtime", {})
        return (
            str(runtime.get("backend", "cuda")),
            bool(runtime.get("orderedGpuSubmission", True)),
            str(runtime.get("restorerBackendPreference", "legacy")),
            bool(runtime.get("restorerNativeTrtTf32", False)),
            str(runtime.get("restorerNativeTrtSplitPlan", "")),
            str(runtime.get("restorerNativeStaticResidualPath", "")),
            bool(runtime.get("restorerCudaDirectIo", False)),
            bool(runtime.get("restorerCudaGraph", False)),
            bool(runtime.get("maskCudaGraph", False)),
            str(runtime.get("maskBackendPreference", "cuda")),
            bool(runtime.get("maskAdaptiveBackendEnabled", False)),
            str(runtime.get("maskOccluderBackendPreference", "inherit")),
            str(runtime.get("maskFaceParserBackendPreference", "inherit")),
            bool(
                runtime.get("temporalSemanticMeshEnabled", False)
                or runtime.get("temporalSemanticFeaturePatchesEnabled", False)
            ),
            str(parameters.get("ModelSessionsTextSel", "Shared")),
            str(parameters.get("DetectTypeTextSel", "SCRDF")),
            str(parameters.get("DetectInputSizeTextSel", "640")),
            str(parameters.get("SwapperTypeTextSel", "128")),
            bool(parameters.get("RestorerSwitch", False)),
            str(parameters.get("RestorerTypeTextSel", "")),
            str(runtime.get("tiktokRestorerProfile", "default")),
        )

    def warm(
        self,
        config: dict[str, Any] | None = None,
        *,
        allow_create_selected: bool = False,
    ) -> dict[str, Any]:
        if (
            hasattr(self, "_gpu_worker_queue")
            and threading.get_ident() != getattr(self, "_gpu_worker_ident", 0)
        ):
            return self._run_gpu_work(
                self.warm,
                priority=0,
                work_label="warm",
                config=config,
                allow_create_selected=allow_create_selected,
            )
        with self._lock:
            if getattr(self, "_warming_models", None) is not None:
                raise RuntimeError("Unload the failed warm-up before retrying")
            # Writers also hold _lock before publishing _config. Never acquire
            # _config_lock here: updates take config -> model in that order.
            effective_config = deepcopy(self._config if config is None else config)
            if self._model_lifecycle_changed(self._config, effective_config):
                raise ConfigUpdateConflict("Warm-up configuration does not match the model lifecycle")
            self._presentation_classifier.set_backend(
                str(effective_config["runtime"].get("identityClassifierBackend", "cpu"))
            )
            if self._models is not None and self._vm is not None:
                # Cached approved-face metadata does not initialize the target
                # classifier. Include it even in the already-warm fast path.
                try:
                    self._presentation_classifier.warm()
                except Exception as exc:
                    self._warm_error = f"{type(exc).__name__}: {exc}"
                    raise
                # An explicit warm/menu-prime request is activity. Without this,
                # the idle thread could unload an already-warm engine moments
                # after /warm returned ready because the old timestamp survived.
                self._last_used = time.time()
                requested_signature = self._pipeline_signature(effective_config)
                if effective_config.get("runtime", {}).get("tiktokRestorerProfile"):
                    self._tiktok_restorers_keep_until = time.monotonic() + 60.0
                # The immutable ORT sessions are bound to the engine's one
                # persistent compute stream. Once this exact graph has executed
                # successfully, session admission is a readiness check—not a
                # reason to rerun all first-use probes on the caller's OS thread.
                if self._pipeline_warm_signature == requested_signature:
                    # A completed session can be followed by idle memory
                    # cleanup. A matching configuration is not proof that all
                    # of its restoration graphs are still resident. Admission
                    # may restore them; frame calls remain creation-free.
                    self._warm_selected_restorer(
                        self._models, self._torch, self._compute_stream,
                        effective_config, allow_create=allow_create_selected,
                    )
                    self._warm_error = ""
                    return self.health()
                try:
                    if self._active_session_count() == 0:
                        runtime = effective_config["runtime"]
                        self._model_residency = self._models.reconcile_production_residency(
                            effective_config["parameters"],
                            retained_restorers=self._session_restorers(effective_config),
                            minimum_free_mib=runtime.get("prefetchMinFreeMiB", 1536),
                            preview_lru_limit=runtime.get("previewModelLruLimit", 0),
                        )
                    with self._torch.cuda.stream(self._compute_stream):
                        self._models.preload_pipeline_sessions(
                            effective_config["parameters"].get("SwapperTypeTextSel", "128"),
                            effective_config["parameters"].get("DetectTypeTextSel", "SCRDF"),
                            effective_config["parameters"].get("DetectInputSizeTextSel", "640"),
                        )
                        self._warm_selected_restorer(
                            self._models, self._torch, self._compute_stream, effective_config,
                            allow_create=(
                                allow_create_selected or self._active_session_count() == 0
                            ),
                        )
                        if bool(
                            effective_config["runtime"].get(
                                "maskAdaptiveBackendEnabled", False
                            )
                        ) or any(
                            str(effective_config["runtime"].get(key, "inherit")).lower()
                            in {"cuda", "trt"}
                            for key in (
                                "maskOccluderBackendPreference",
                                "maskFaceParserBackendPreference",
                            )
                        ):
                            self._models.warm_mask_backends(
                                effective_config["parameters"], adaptive=True
                            )
                        if (
                            self._semantic_landmark_estimator is None
                            and (
                                effective_config["runtime"].get(
                                    "temporalSemanticMeshEnabled", False
                                )
                                or effective_config["runtime"].get(
                                    "temporalSemanticFeaturePatchesEnabled", False
                                )
                            )
                        ):
                            from semantic_landmarks import SemanticLandmarkEstimator

                            self._semantic_landmark_estimator = SemanticLandmarkEstimator(
                                stream_id=int(self._compute_stream.cuda_stream),
                                use_cuda=True,
                            )
                    self._compute_stream.synchronize()
                    self._pipeline_warm_signature = requested_signature
                except Exception as exc:
                    self._warm_error = f"{type(exc).__name__}: {exc}"
                    raise
                self._warm_error = ""
                return self.health()
            started = time.perf_counter()
            rope_path = str(ROPE_ROOT)
            if rope_path not in sys.path:
                sys.path.insert(0, rope_path)
            try:
                import torch
                from rope.Models import Models
                from rope.VideoManager import VideoManager
                from rope.qt.parameters import seed_control_dict

                # Import Torch/Rope first so their Windows CUDA DLL setup is
                # complete before ORT creates the classifier's CUDA session.
                self._presentation_classifier.warm()
                models = Models()
                models._ordered_gpu_submission = bool(
                    effective_config["runtime"].get("orderedGpuSubmission", True)
                )
                models.set_models_folder(str(MODELS_DIR))
                models._gpen_trt_fp16 = bool(
                    effective_config["runtime"].get("restorerTrtFp16", True)
                )
                models._gpen_native_trt_tf32 = bool(
                    effective_config["runtime"].get(
                        "restorerNativeTrtTf32", False
                    )
                )
                models._gpen_native_trt_qualified_plan = str(
                    effective_config["runtime"].get(
                        "restorerNativeTrtQualifiedPlan", ""
                    )
                    or ""
                )
                models._gpen_native_trt_split_plan = str(
                    effective_config["runtime"].get(
                        "restorerNativeTrtSplitPlan", ""
                    )
                    or ""
                )
                models._gpen_native_trt_qualified_plan_1024 = str(
                    effective_config["runtime"].get("restorerNativeTrtQualifiedPlan1024", "") or ""
                )
                models._gpen_native_static_residual_path = str(
                    effective_config["runtime"].get(
                        "restorerNativeStaticResidualPath", ""
                    )
                    or ""
                )
                models._gpen_cuda_direct_io = bool(
                    effective_config["runtime"].get(
                        "restorerCudaDirectIo",
                        False,
                    )
                )
                models._gpen_cuda_graph = bool(
                    effective_config["runtime"].get(
                        "restorerCudaGraph",
                        False,
                    )
                )
                models._gpen_hybrid_reference_enabled = bool(
                    effective_config["runtime"].get(
                        "restorerHybridReferenceReasons", []
                    )
                    or effective_config["runtime"].get(
                        "referenceParserMaskDiagnostic", False
                    )
                )
                models._mask_cuda_graph = bool(
                    effective_config["runtime"].get("maskCudaGraph", False)
                )
                models._mask_backend_preference = str(
                    effective_config["runtime"].get(
                        "maskBackendPreference", "cuda"
                    )
                )
                backend = str(effective_config["runtime"].get("backend", "cuda")).lower()
                backend_pref = "trt" if backend == "trt" else "onnx"
                for attr in (
                    "swapper_model",
                    "swapper_256_model",
                    "swapper_512_model",
                    "recognition_model",
                    "retinaface_model",
                ):
                    models.set_backend_preference(attr, backend_pref, unload=False)
                # AlphaFace's live 256 model is already fast through CUDA EP.
                # Avoid a first-selection TensorRT engine build in the settings
                # request; it can otherwise outlive the HTTP gateway timeout.
                models.set_backend_preference("alphaface_model", "onnx", unload=False)
                restorer_backend = validate_restorer_backend_preference(
                    effective_config["runtime"].get("restorerBackendPreference", "legacy"),
                )
                for attr in ("GPEN_256_model", "GPEN_512_model"):
                    models.set_backend_preference(
                        attr, {
                            "legacy": None,
                            "cuda": "onnx",
                            "trt": "trt",
                            "native-trt": "native-trt",
                        }[restorer_backend],
                        unload=False,
                    )
                session_mode = effective_config["parameters"].get(
                    "ModelSessionsTextSel", "Shared"
                )
                # Never compile 1024 implicitly in a live settings request.
                # Only a separately qualified, hash-checked artifact enables TRT.
                models.set_backend_preference(
                    "GPEN_1024_model",
                    "native-trt" if models._gpen_native_trt_qualified_plan_1024 else "onnx",
                    unload=False,
                )
                models.set_model_session_mode(session_mode)
                # Use one persistent engine stream for every stage of the
                # serialized live pipeline.  Shared ORT/TRT sessions are bound
                # to this exact native stream before they are created, which
                # lets torch preprocessing and ORT inference order naturally
                # without a host-side syncvec drain between each stage.
                compute_stream = torch.cuda.Stream(device=0)
                # Failed warm-up retains private ownership until unload can
                # fence successfully; these are not published as ready models.
                self._warming_models = models
                self._warming_stream = compute_stream
                if models._model_session_mode == "Shared":
                    models.set_shared_compute_stream(compute_stream)
                vm = VideoManager(models)
                # Pong calls swap_core directly and does not use Rope's GUI
                # scrubber or 1 kHz pacing loop. Stop those workers immediately
                # so they cannot contend with or outlive the headless service.
                shutdown_workers = getattr(vm, "shutdown_background_workers", None)
                if callable(shutdown_workers):
                    shutdown_workers()
                vm.parameters = dict(effective_config["parameters"])
                vm.control = seed_control_dict()
                vm.control["SwapFacesButton"] = True
                vm.control["MaskViewButton"] = False
                semantic_landmark_estimator = None
                # Rope's model objects are lazy.  Load and execute one
                # throwaway swap now so a phone button press never pays the
                # ONNX session and CUDA kernel setup cost.
                with torch.cuda.stream(compute_stream):
                    models.preload_pipeline_sessions(
                        effective_config["parameters"].get("SwapperTypeTextSel", "128"),
                        effective_config["parameters"].get("DetectTypeTextSel", "SCRDF"),
                        effective_config["parameters"].get("DetectInputSizeTextSel", "640"),
                    )
                    self._warm_selected_restorer(models, torch, compute_stream, effective_config)
                    if bool(
                        effective_config["runtime"].get(
                            "maskAdaptiveBackendEnabled", False
                        )
                    ) or any(
                        str(effective_config["runtime"].get(key, "inherit")).lower()
                        in {"cuda", "trt"}
                        for key in (
                            "maskOccluderBackendPreference",
                            "maskFaceParserBackendPreference",
                        )
                    ):
                        models.warm_mask_backends(
                            effective_config["parameters"], adaptive=True
                        )
                    if (
                        effective_config["runtime"].get(
                            "temporalSemanticMeshEnabled", False
                        )
                        or effective_config["runtime"].get(
                            "temporalSemanticFeaturePatchesEnabled", False
                        )
                    ):
                        from semantic_landmarks import SemanticLandmarkEstimator

                        semantic_landmark_estimator = SemanticLandmarkEstimator(
                            stream_id=int(compute_stream.cuda_stream),
                            use_cuda=True,
                        )
                # Warm-up is the one lifecycle boundary where a full stream
                # wait is required before publishing the model objects.
                compute_stream.synchronize()
                self._torch = torch
                self._compute_stream = compute_stream
                self._models = models
                self._vm = vm
                self._semantic_landmark_estimator = semantic_landmark_estimator
                self._model_residency = models.reconcile_production_residency(
                    effective_config["parameters"],
                    retained_restorers=self._session_restorers(effective_config),
                    minimum_free_mib=effective_config["runtime"].get("prefetchMinFreeMiB", 1536),
                    preview_lru_limit=effective_config["runtime"].get("previewModelLruLimit", 0),
                )
                self._warming_models = None
                self._warming_stream = None
                self._pipeline_warm_signature = self._pipeline_signature(effective_config)
                if (
                    self._config["runtime"].get("frameEnhancerEnabled")
                    and str(self._config["runtime"].get("frameEnhancerScope", "full"))
                    != "realtime"
                ):
                    self._warm_frame_enhancer()
                self._warm_error = ""
                self._last_used = time.time()
            except Exception as exc:
                self._warm_error = f"{type(exc).__name__}: {exc}"
                raise
            result = self.health()
            result["warmupMs"] = round((time.perf_counter() - started) * 1000, 1)
            return result

    def unload(self) -> None:
        if getattr(self, "_standby_sources", None) is not None:
            self._standby_sources.clear()
        if (
            hasattr(self, "_gpu_worker_queue")
            and threading.get_ident() != getattr(self, "_gpu_worker_ident", 0)
        ):
            return self._run_gpu_work(
                self.unload,
                priority=20,
                work_label="unload",
            )
        with self._lock:
            # Model teardown is unsafe while a producer is inside process_frame
            # or merely queued to enter it. Keep the API idempotent, but leave a
            # busy engine warm; the idle-unload loop will retry later.
            with self._sessions_lock:
                if self._model_configuration_in_use():
                    return
                pending = getattr(self, "_warming_models", None)
                if pending is not None:
                    try:
                        self._warming_stream.synchronize()
                        pending.delete_models()
                    except Exception as exc:
                        self._warm_error = f"Warm-up teardown failed: {type(exc).__name__}: {exc}"
                        return
                    self._warming_models = None
                    self._warming_stream = None
                if self._models is not None:
                    try:
                        if self._compute_stream is not None:
                            self._compute_stream.synchronize()
                        self._models.delete_models()
                    except Exception as exc:
                        # A failed GPEN retirement fence must retain sessions,
                        # buffers and their stream instead of dropping ownership.
                        self._warm_error = f"Model teardown failed: {type(exc).__name__}: {exc}"
                        return
                if self._vm is not None:
                    shutdown_workers = getattr(self._vm, "shutdown_background_workers", None)
                    if callable(shutdown_workers):
                        try:
                            shutdown_workers()
                        except Exception:
                            pass
                self._models = None
                self._vm = None
                classifier = getattr(self, "_presentation_classifier", None)
                if classifier is not None:
                    classifier.unload()
                self._enhancer_session = None
                self._semantic_landmark_estimator = None
                self._pipeline_warm_signature = None
                self._model_residency = {}
                # Release the stream only after every ORT session that stores
                # its native pointer has been deleted.
                self._compute_stream = None
                self._embedding_cache.clear()
                self._source_frame_cache.clear()
                with self._embedding_prime_lock:
                    self._embedding_prime_started = False
                    self._embedding_prime_thread = None
                    # Never clear/reuse an Event captured by an older primer.
                    # A cancelled worker can still be unwinding after a bounded
                    # join; clearing that same object would let it continue on
                    # a graph that unload just retired.
                    self._embedding_prime_cancel = type(self._embedding_prime_cancel)()
                    self._embedding_prime_error = ""
                if self._torch is not None:
                    try:
                        self._torch.cuda.empty_cache()
                    except Exception:
                        pass

    @staticmethod
    def _cleanup_orphan_spools(spool_dir: Path | None = None) -> int:
        """Remove session artifacts that cannot belong to this process.

        Session identifiers are 32 lowercase hexadecimal characters. Restricting
        cleanup to that exact filename shape avoids deleting unrelated media in
        the cache directory. An open spool owned by another process is skipped on
        platforms that reject unlinking open files.
        """
        target = spool_dir or (CACHE_DIR / "sessions")
        target.mkdir(parents=True, exist_ok=True)
        removed = 0
        for path in target.glob("*.mp4"):
            if not re.fullmatch(r"[0-9a-f]{32}\.mp4", path.name):
                continue
            try:
                path.unlink()
                removed += 1
            except (FileNotFoundError, PermissionError, OSError):
                pass
        return removed

    def cleanup_orphan_spools(self) -> int:
        removed = self._cleanup_orphan_spools()
        self._orphan_spools_removed += removed
        return removed

    @staticmethod
    def _thread_is_alive(thread: threading.Thread | None) -> bool:
        return bool(thread is not None and thread.is_alive())

    @staticmethod
    def _process_is_alive(process: subprocess.Popen | None) -> bool:
        if process is None:
            return False
        try:
            return process.poll() is None
        except Exception:
            return False

    def _session_has_live_resources(self, session: SwapSession) -> bool:
        producer = session.producer
        with session.lifecycle_lock:
            source_opener = session.source_opener
            decoder = session.decoder
            feeder = session.feeder
            process = session.process
            container = session.container
        return bool(
            self._thread_is_alive(producer)
            or self._thread_is_alive(source_opener)
            or self._thread_is_alive(decoder)
            or self._thread_is_alive(feeder)
            or self._process_is_alive(process)
            # A registered PyAV container means an open/decode operation may
            # still be in flight, even if its worker thread is between calls.
            or (container is not None and not session.complete)
        )

    def _active_session_count(self, *, exclude_session_id: str = "") -> int:
        with self._sessions_lock:
            sessions = list(self._sessions.values())
        return sum(
            1
            for session in sessions
            if session.id != exclude_session_id
            and (
                session.state in {"created", "starting", "streaming", "stopping"}
                or self._session_has_live_resources(session)
            )
        )

    @staticmethod
    def _close_pipe(pipe: Any | None) -> None:
        if pipe is None:
            return
        try:
            pipe.close()
        except Exception:
            pass

    def _interrupt_session_resources(self, session: SwapSession) -> None:
        """Actively break network decode, pipe I/O and encoder waits.

        The decoder thread exclusively owns and closes its PyAV container.
        External retirement terminates FFmpeg and signals decode cancellation;
        it must not race ``container.close()`` against a native decode call.
        """
        # Serialize stop, producer-finally and cleanup retries. Calling close or
        # wait concurrently on the same native handle is not reliably safe.
        with session.lifecycle_lock:
            process = session.process
            decoder = session.decoder
            feeder = session.feeder

            if process is not None:
                if self._process_is_alive(process):
                    try:
                        process.terminate()
                    except Exception:
                        pass
                    try:
                        process.wait(timeout=0.75)
                    except subprocess.TimeoutExpired:
                        try:
                            process.kill()
                        except Exception:
                            pass
                        try:
                            process.wait(timeout=0.75)
                        except Exception:
                            pass
                    except Exception:
                        pass
                # Terminating first prevents BufferedWriter.close() from blocking
                # while trying to flush into a full encoder pipe.
                self._close_pipe(getattr(process, "stdin", None))
                self._close_pipe(getattr(process, "stdout", None))
                self._close_pipe(getattr(process, "stderr", None))

        if (
            decoder is not None
            and decoder is not threading.current_thread()
            and decoder.is_alive()
        ):
            decoder.join(timeout=0.75)
        if (
            feeder is not None
            and feeder is not threading.current_thread()
            and feeder.is_alive()
        ):
            feeder.join(timeout=0.75)

    def _release_prefetch_admission(self, session: SwapSession) -> bool:
        """Release speculative admission exactly once, regardless of role changes."""
        with session.condition:
            if not session.prefetch_gate_owned:
                return False
            session.prefetch_gate_owned = False
            self._prefetch_gate.release()
            session.condition.notify_all()
            return True

    def _acquire_prefetch_admission(self, session: SwapSession) -> bool:
        """Bound speculative GPU/model setup after bounded source negotiation."""
        while not session.stop.is_set():
            with session.condition:
                if (
                    not session.prefetch
                    or session.activation_requested
                    or session.playback_started_at
                ):
                    return False
            min_free_mib = max(
                256,
                int(session.config.get("runtime", {}).get("prefetchMinFreeMiB", 1536)),
            )
            try:
                if self._torch is not None:
                    free_mib = int(self._torch.cuda.mem_get_info()[0] // (1024 * 1024))
                    if free_mib < min_free_mib:
                        with session.condition:
                            session.error_code = "GPU_HEADROOM"
                            session.error = (
                                f"Prefetch deferred: GPU has {free_mib} MiB free; "
                                f"{min_free_mib} MiB is reserved for foreground playback"
                            )
                            session.state = "deferred"
                            session.condition.notify_all()
                        return False
            except Exception:
                # A telemetry failure must not block an otherwise safe session.
                pass
            if not self._prefetch_gate.acquire(timeout=0.20):
                continue
            with session.condition:
                if (
                    not session.prefetch
                    or session.activation_requested
                    or session.playback_started_at
                    or session.stop.is_set()
                ):
                    self._prefetch_gate.release()
                    return False
                session.prefetch_gate_owned = True
                session.condition.notify_all()
                return True
        return False

    @staticmethod
    def _gpu_oom_error(exc: BaseException) -> bool:
        message = f"{type(exc).__name__}: {exc}".lower()
        return any(token in message for token in (
            "outofmemoryerror",
            "out of memory",
            "cuda_error_out_of_memory",
            "cuda failure 2",
            "cudnn_status_alloc_failed",
            "failed to allocate memory",
        ))

    def _record_gpu_oom(self, session: SwapSession, exc: BaseException) -> None:
        if threading.get_ident() != getattr(self, "_gpu_worker_ident", 0):
            return self._run_gpu_work(
                self._record_gpu_oom,
                session,
                exc,
                priority=-1,
                work_label="record-gpu-oom",
            )
        self._last_gpu_oom = {
            "at": time.time(),
            "sessionId": session.id,
            "channel": session.channel,
            "message": f"{type(exc).__name__}: {exc}",
        }
        models = self._models
        if models is not None:
            try:
                models._release_unused_cuda_arenas()
            except Exception:
                pass

    def _recover_foreground_gpu_memory(self, session: SwapSession) -> int:
        """Retire optional GPU work and release allocators for one foreground retry.

        A speculative producer admitted while memory was healthy can retain ORT
        scratch allocations after the foreground card becomes visible. Do not
        lower render quality or unload the selected production graph: cancel only
        unadopted speculative sessions, then release allocator caches before the
        visible frame is attempted once more.
        """
        if threading.get_ident() != getattr(self, "_gpu_worker_ident", 0):
            return self._run_gpu_work(
                self._recover_foreground_gpu_memory,
                session,
                priority=-1,
                work_label="recover-gpu-memory",
            )
        with self._sessions_lock:
            speculative = [
                candidate
                for candidate in self._sessions.values()
                if (
                    candidate.id != session.id
                    and candidate.prefetch
                    and not candidate.activation_requested
                    and not candidate.stop.is_set()
                )
            ]
        for candidate in speculative:
            self._request_session_stop_async(candidate, delete=True)
        self._release_prefetch_admission(session)
        models = self._models
        if models is not None:
            try:
                models._release_unused_cuda_arenas()
            except Exception:
                pass
        try:
            if self._torch is not None:
                self._torch.cuda.empty_cache()
        except Exception:
            pass
        return len(speculative)

    def _reconcile_idle_model_residency(self, exclude_session_id: str = "") -> None:
        """Release only unused model/allocator state on the GPU owner thread."""
        if (
            self._active_session_count(exclude_session_id=exclude_session_id) != 0
            or self._models is None
        ):
            return
        with self._lock:
            current_config = self._config
            runtime = current_config["runtime"]
            self._model_residency = self._models.reconcile_production_residency(
                current_config["parameters"],
                retained_restorers=self._session_restorers(current_config),
                minimum_free_mib=runtime.get("prefetchMinFreeMiB", 1536),
                preview_lru_limit=runtime.get("previewModelLruLimit", 0),
            )
            self._models._release_unused_cuda_arenas()

    def _signal_session_stop(self, session: SwapSession, *, delete: bool) -> bool:
        """Logically retire a session and return whether native teardown is new."""
        with session.condition:
            if delete:
                session.delete_requested = True
            session.stop.set()
            if not session.cancel_requested_at:
                session.cancel_requested_at = time.time()
            if not session.complete:
                session.state = "stopping"
            should_interrupt = not session.interrupt_requested
            session.interrupt_requested = True
            session.condition.notify_all()
        self._release_prefetch_admission(session)
        return should_interrupt

    def _request_session_stop(self, session: SwapSession, *, delete: bool) -> None:
        if self._signal_session_stop(session, delete=delete):
            self._interrupt_session_resources(session)

    def _request_session_stop_async(self, session: SwapSession, *, delete: bool) -> None:
        """Retire now, but release slow native resources off the caller path.

        Closing PyAV and terminating FFmpeg is intentionally synchronous for an
        explicit DELETE/unload. During a swipe, however, the caller is waiting
        for ``activate_session`` before it can play an already-decoded next
        card. Logical cancellation is sufficient to prevent stale production;
        the lifecycle lock keeps the bounded background interruption idempotent.
        """
        if not self._signal_session_stop(session, delete=delete):
            return

        def interrupt() -> None:
            self._interrupt_session_resources(session)
            # A created session may be replaced before its producer is started.
            # Its normal producer-finally path therefore cannot schedule cleanup.
            if session.producer is None:
                with session.condition:
                    session.complete = True
                    session.condition.notify_all()
                self._schedule_spool_cleanup(session, delay=0.0)

        threading.Thread(
            target=interrupt,
            name=f"PongSwapInterrupt-{session.channel}",
            daemon=True,
        ).start()

    def health(self) -> dict[str, Any]:
        # Health is a control-plane probe and must not queue behind a full-res
        # frame render. Model publication/teardown uses the GIL plus the model
        # lock; an observational ready flag may be one instruction stale but is
        # preferable to Android declaring the entire service unavailable while
        # a preview frame owns the GPU lock.
        # Configuration publication replaces the normalized dictionaries while
        # holding the GIL. Taking the config lock here created a model -> config
        # inversion because warm() calls health() while holding the model lock,
        # whereas update_config() deliberately takes config -> model. A health
        # sample may be one revision stale, which is acceptable for telemetry.
        config = self._config
        runtime = deepcopy(config["runtime"])
        config_revision = self._config_revision
        warm_error = self._warm_error
        embedding_prime_error = self._embedding_prime_error
        embedding_primer_active = self._thread_is_alive(
            getattr(self, "_embedding_prime_thread", None)
        )
        models = self._models
        semantic_landmark_estimator = self._semantic_landmark_estimator
        classifier_ready, classifier_backend, classifier_providers = (
            self._presentation_classifier.health_snapshot()
        )
        restorers = models.restorer_status() if models is not None else {}
        residency = deepcopy(self._model_residency)
        if models is not None:
            try:
                residency["loaded"] = models.loaded_model_attrs()
            except Exception:
                pass
        ready = models is not None and classifier_ready
        semantic_requested = bool(
            runtime.get("temporalSemanticMeshEnabled", False)
            or runtime.get("temporalSemanticFeaturePatchesEnabled", False)
        )
        if semantic_requested:
            ready = ready and semantic_landmark_estimator is not None
        parameters = config["parameters"]
        selected_edge = {"GPEN256": "256", "GPEN512": "512", "GPEN1024": "1024"}.get(parameters.get("RestorerTypeTextSel"))
        if parameters.get("RestorerSwitch") and selected_edge is not None:
            ready = ready and bool(restorers.get(selected_edge, {}).get("ready"))
        gpu = {}
        try:
            import torch

            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                gpu = {
                    "name": torch.cuda.get_device_name(0),
                    "freeMiB": round(free / 1024 / 1024),
                    "totalMiB": round(total / 1024 / 1024),
                }
        except Exception:
            pass
        gpu_worker_queue = getattr(self, "_gpu_worker_queue", None)
        gpu_worker_queued = (
            int(gpu_worker_queue.qsize())
            if gpu_worker_queue is not None
            else 0
        )
        return {
            "ok": not bool(warm_error),
            "ready": ready,
            "engine": "Rope-Bronze headless adapter",
            "approvedFaces": len(self._faces),
            "activeSessions": self._active_session_count(),
            "instanceId": self._instance_id,
            "configRevision": config_revision,
            "gpu": gpu,
            "lastError": warm_error,
            "embeddingPrimeError": embedding_prime_error,
            "embeddingPrimerActive": embedding_primer_active,
            "runtime": runtime,
            "restorers": restorers,
            "orderedGpuSubmissions": int(getattr(
                getattr(models, "_ordered_io_runner", None), "ordered_calls", 0
            )),
            "identityClassifier": {
                "ready": classifier_ready,
                "requestedBackend": classifier_backend,
                "providers": list(classifier_providers),
            },
            "colorMatchGraph": {
                "capturedGraphs": sum(state is not None for state in list(getattr(self._vm, '_color_match_graphs', {}).values())),
                "fallbackError": getattr(self._vm, 'color_match_graph_error', None),
            },
            "semanticLandmarks": {
                "requested": semantic_requested,
                "ready": semantic_landmark_estimator is not None,
                "provider": (
                    str(semantic_landmark_estimator.provider)
                    if semantic_landmark_estimator is not None
                    else ""
                ),
            },
            "modelResidency": residency,
            "lastGpuOom": deepcopy(self._last_gpu_oom),
            "gpuWorker": {
                "alive": self._thread_is_alive(
                    getattr(self, "_gpu_worker_thread", None)
                ),
                "threadId": int(getattr(self, "_gpu_worker_ident", 0) or 0),
                "queued": gpu_worker_queued,
                "inflight": int(getattr(self, "_gpu_worker_inflight", 0) or 0),
                "activeLabel": str(getattr(self, "_gpu_worker_active_label", "") or ""),
                "activeSince": float(getattr(self, "_gpu_worker_active_since", 0.0) or 0.0),
                "lastCompletedAt": float(getattr(self, "_gpu_worker_last_completed_at", 0.0) or 0.0),
                "cancelledBeforeStart": int(
                    getattr(self, "_gpu_worker_cancelled_before_start", 0) or 0
                ),
            },
            "standbySources": self._standby_sources.status() if getattr(self, "_standby_sources", None) else {},
        }

    def _frame_tensor(self, rgb: np.ndarray):
        torch = self._torch
        return torch.from_numpy(np.ascontiguousarray(rgb, dtype=np.uint8)).to("cuda").permute(2, 0, 1)

    def _warm_frame_enhancer(self, config: dict[str, Any] | None = None) -> None:
        if self._enhancer_session is not None:
            return
        effective_config = self._config if config is None else config
        runtime = effective_config["runtime"]
        if str(runtime.get("frameEnhancerType")) != "RealEsrgan-x2-Plus":
            raise ValueError("Only the imported RealEsrgan-x2-Plus enhancer is currently supported")
        import onnxruntime

        model_path = MODELS_DIR / "RealESRGAN_x2plus.fp16.onnx"
        if not model_path.exists():
            raise FileNotFoundError(f"Frame enhancer model is missing: {model_path}")
        face_scope = str(runtime.get("frameEnhancerScope", "full")) == "face"
        profile_tile = 256 if face_scope else 512
        profile_batch = 1 if face_scope else 6
        self._enhancer_batch_max = profile_batch
        cache_dir = MODELS_DIR / (
            "ort_trt_cache_realesrgan_x2_face256"
            if face_scope
            else "ort_trt_cache_realesrgan_x2_b6"
        )
        cache_dir.mkdir(parents=True, exist_ok=True)
        trt_options = {
            "trt_max_workspace_size": 4 << 30,
            "trt_engine_cache_enable": True,
            "trt_engine_cache_path": str(cache_dir.resolve()),
            "trt_timing_cache_enable": True,
            "trt_timing_cache_path": str(cache_dir.resolve()),
            "trt_fp16_enable": True,
            "trt_builder_optimization_level": 2,
            "trt_auxiliary_streams": 2,
            # Common Pong portrait sources create 6 tiles at 720p and 12
            # tiles at 1080p.  An explicit profile lets TensorRT optimize
            # both without changing the uploaded model or its output.
            "trt_profile_min_shapes": f"input:1x3x{profile_tile}x{profile_tile}",
            "trt_profile_opt_shapes": f"input:{profile_batch}x3x{profile_tile}x{profile_tile}",
            "trt_profile_max_shapes": f"input:{profile_batch}x3x{profile_tile}x{profile_tile}",
        }
        cuda_options = {
            "cudnn_conv_algo_search": "EXHAUSTIVE",
            "do_copy_in_default_stream": True,
        }
        self._enhancer_session = onnxruntime.InferenceSession(
            str(model_path),
            providers=[
                ("TensorrtExecutionProvider", trt_options),
                ("CUDAExecutionProvider", cuda_options),
            ],
        )
        # Materialize CUDA kernels during service warmup, not after the phone
        # button is pressed.
        dummy = self._torch.zeros(
            (profile_batch, 3, profile_tile, profile_tile),
            dtype=self._torch.float32,
            device="cuda",
        )
        self._run_enhancer_batch(dummy, effective_config)

    def _run_enhancer_batch(self, image, config: dict[str, Any] | None = None):
        self._warm_frame_enhancer(config)
        if image.shape[0] > self._enhancer_batch_max:
            return self._torch.cat(
                [
                    self._run_enhancer_batch(chunk.contiguous(), config)
                    for chunk in image.split(self._enhancer_batch_max)
                ],
                dim=0,
            )
        scale = 2
        output = self._torch.empty(
            (image.shape[0], image.shape[1], image.shape[2] * scale, image.shape[3] * scale),
            dtype=self._torch.float32,
            device="cuda",
        ).contiguous()
        binding = self._enhancer_session.io_binding()
        binding.bind_input(
            name="input",
            device_type="cuda",
            device_id=0,
            element_type=np.float32,
            shape=tuple(image.shape),
            buffer_ptr=image.data_ptr(),
        )
        binding.bind_output(
            name="output",
            device_type="cuda",
            device_id=0,
            element_type=np.float32,
            shape=tuple(output.shape),
            buffer_ptr=output.data_ptr(),
        )
        self._torch.cuda.synchronize()
        self._enhancer_session.run_with_iobinding(binding)
        return output

    def _enhance_face_region(self, image_chw, kps, config: dict[str, Any]):
        torch = self._torch
        _, height, width = image_chw.shape
        # Five landmarks cover the inner face. Expand around them to include
        # the whole jaw/forehead while keeping the enhancer workload fixed.
        points = np.asarray(kps, dtype=np.float32)
        center_x = float((points[:, 0].min() + points[:, 0].max()) * 0.5)
        center_y = float((points[:, 1].min() + points[:, 1].max()) * 0.5)
        span = max(float(np.ptp(points[:, 0])), float(np.ptp(points[:, 1])))
        side = max(64, int(round(span * 3.2)))
        left, top, right, bottom = _bounded_square_roi(
            width,
            height,
            center_x,
            center_y,
            side,
            vertical_anchor=0.55,
        )

        crop = image_chw[:, top:bottom, left:right].to(torch.float32).unsqueeze(0)
        model_input = torch.nn.functional.interpolate(
            crop,
            size=(256, 256),
            mode="bilinear",
            align_corners=False,
        ).div_(255.0).contiguous()
        enhanced_crop = self._run_enhancer_batch(model_input, config)[0].clamp_(0.0, 1.0)

        output = torch.nn.functional.interpolate(
            image_chw.to(torch.float32).unsqueeze(0),
            size=(height * 2, width * 2),
            mode="bilinear",
            align_corners=False,
        )[0].div_(255.0)
        target_height = (bottom - top) * 2
        target_width = (right - left) * 2
        enhanced_crop = torch.nn.functional.interpolate(
            enhanced_crop.unsqueeze(0),
            size=(target_height, target_width),
            mode="bilinear",
            align_corners=False,
        )[0]

        # Feather only the outside edge of the ROI. The central face receives
        # the imported preset's full 100% enhancer blend.
        feather = max(4, min(target_height, target_width) // 12)
        yy = torch.minimum(
            torch.arange(target_height, device="cuda"),
            torch.arange(target_height - 1, -1, -1, device="cuda"),
        ).to(torch.float32)
        xx = torch.minimum(
            torch.arange(target_width, device="cuda"),
            torch.arange(target_width - 1, -1, -1, device="cuda"),
        ).to(torch.float32)
        alpha = torch.minimum(yy[:, None], xx[None, :]).div_(float(feather)).clamp_(0.0, 1.0)
        alpha = alpha.unsqueeze(0)
        output_region = output[:, top * 2 : bottom * 2, left * 2 : right * 2]
        output_region.mul_(1.0 - alpha).add_(enhanced_crop * alpha)
        output = output.mul_(255.0).clamp_(0.0, 255.0)
        if config["runtime"].get("frameEnhancerDownscale"):
            output = torch.nn.functional.interpolate(
                output.unsqueeze(0),
                size=(height, width),
                mode="bilinear",
                align_corners=False,
            )[0]
        return output.to(torch.uint8)

    def _enhance_face_realtime(self, image_chw, kps):
        """Low-latency face detail pass for live playback.

        This is intentionally a separate, named profile rather than silently
        pretending to be RealESRGAN. It leaves identity generation untouched
        and spends only a small CUDA budget on the swapped face region.
        """
        if kps is None:
            return image_chw
        torch = self._torch
        points = np.asarray(kps, dtype=np.float32)
        _, height, width = image_chw.shape
        center_x = float((points[:, 0].min() + points[:, 0].max()) * 0.5)
        center_y = float((points[:, 1].min() + points[:, 1].max()) * 0.5)
        span = max(float(np.ptp(points[:, 0])), float(np.ptp(points[:, 1])))
        side = max(48, int(round(span * 3.0)))
        left, top, right, bottom = _bounded_square_roi(
            width,
            height,
            center_x,
            center_y,
            side,
            vertical_anchor=0.55,
        )
        output = image_chw.clone()
        crop = output[:, top:bottom, left:right].to(torch.float32).unsqueeze(0)
        blur = torch.nn.functional.avg_pool2d(crop, kernel_size=3, stride=1, padding=1)
        # A two-scale, face-only detail pass is substantially cheaper than a
        # full-frame restorer while recovering texture softened by the 128px
        # swap model. The broad term restores local contrast; the fine term
        # brings back eyes/hair detail without altering the rest of the video.
        broad = torch.nn.functional.avg_pool2d(crop, kernel_size=5, stride=1, padding=2)
        sharpened = (
            crop + 0.98 * (crop - blur) + 0.22 * (crop - broad)
        ).clamp_(0.0, 255.0)[0]
        region_height, region_width = sharpened.shape[-2:]
        feather = max(3, min(region_height, region_width) // 12)
        yy = torch.minimum(
            torch.arange(region_height, device="cuda"),
            torch.arange(region_height - 1, -1, -1, device="cuda"),
        ).to(torch.float32)
        xx = torch.minimum(
            torch.arange(region_width, device="cuda"),
            torch.arange(region_width - 1, -1, -1, device="cuda"),
        ).to(torch.float32)
        alpha = torch.minimum(yy[:, None], xx[None, :]).div_(float(feather)).clamp_(0.0, 1.0)
        alpha = alpha.unsqueeze(0)
        original = output[:, top:bottom, left:right].to(torch.float32)
        output[:, top:bottom, left:right] = (
            original.mul_(1.0 - alpha).add_(sharpened * alpha).clamp_(0.0, 255.0).to(torch.uint8)
        )
        return output

    def _enhance_frame(
        self,
        image_chw,
        kps=None,
        config: dict[str, Any] | None = None,
    ):
        """Apply VisoMaster's RealESRGAN x2 tile/blend semantics on CUDA.

        Tiles are submitted as one dynamic batch.  This preserves the imported
        model, 512px tile size, x2 output, and 100% blend while removing the
        per-tile Python/ONNX dispatch overhead from the reference UI.
        """
        effective_config = self._config if config is None else config
        runtime = effective_config["runtime"]
        if not runtime.get("frameEnhancerEnabled"):
            return image_chw
        if str(runtime.get("frameEnhancerScope", "full")) == "realtime":
            # Texture Preserve recovers aligned-frame micro-texture while this
            # inexpensive ROI pass restores local contrast after inverse
            # affine composition. They address different losses, so retain the
            # proven sharpener unless an isolated A/B beats the combined path.
            return self._enhance_face_realtime(image_chw, kps)
        if str(runtime.get("frameEnhancerScope", "full")) == "face":
            if kps is None:
                # Keep the encoder's declared dimensions stable through a
                # temporary detection miss. Face-only enhancement has no ROI in
                # this frame, but downscale semantics still apply.
                if runtime.get("frameEnhancerDownscale"):
                    return image_chw
                _, height, width = image_chw.shape
                return self._torch.nn.functional.interpolate(
                    image_chw.to(self._torch.float32).unsqueeze(0),
                    size=(height * 2, width * 2),
                    mode="bilinear",
                    align_corners=False,
                )[0].clamp_(0.0, 255.0).to(self._torch.uint8)
            return self._enhance_face_region(image_chw, kps, effective_config)
        torch = self._torch
        tile = max(32, int(runtime.get("frameEnhancerTileSize", 512)))
        scale = 2
        _, height, width = image_chw.shape
        pad_right = (tile - (width % tile)) % tile
        pad_bottom = (tile - (height % tile)) % tile
        normalized = image_chw.to(torch.float32).div_(255.0).unsqueeze(0)
        if pad_right or pad_bottom:
            normalized = torch.nn.functional.pad(normalized, (0, pad_right, 0, pad_bottom))
        padded_height, padded_width = normalized.shape[-2:]
        tiles = []
        positions = []
        for top in range(0, padded_height, tile):
            for left in range(0, padded_width, tile):
                tiles.append(normalized[0, :, top : top + tile, left : left + tile])
                positions.append((top, left))
        enhanced_tiles = self._run_enhancer_batch(
            torch.stack(tiles).contiguous(),
            effective_config,
        )
        enhanced = torch.empty(
            (3, padded_height * scale, padded_width * scale),
            dtype=torch.float32,
            device="cuda",
        )
        for index, (top, left) in enumerate(positions):
            enhanced[
                :, top * scale : (top + tile) * scale, left * scale : (left + tile) * scale
            ] = enhanced_tiles[index]
        enhanced = enhanced[:, : height * scale, : width * scale].clamp_(0.0, 1.0)
        blend = max(0.0, min(1.0, float(runtime.get("frameEnhancerBlend", 100)) / 100.0))
        if blend < 1.0:
            original = torch.nn.functional.interpolate(
                image_chw.to(torch.float32).unsqueeze(0),
                size=(height * scale, width * scale),
                mode="bilinear",
                align_corners=False,
            )[0].div_(255.0)
            enhanced.mul_(blend).add_(original, alpha=1.0 - blend)
        enhanced = enhanced.mul_(255.0).clamp_(0.0, 255.0).to(torch.uint8)
        if runtime.get("frameEnhancerDownscale"):
            enhanced = torch.nn.functional.interpolate(
                enhanced.to(torch.float32).unsqueeze(0),
                size=(height, width),
                mode="bilinear",
                align_corners=False,
            )[0].clamp_(0.0, 255.0).to(torch.uint8)
        return enhanced

    def output_dimensions(
        self,
        width: int,
        height: int,
        config: dict[str, Any] | None = None,
    ) -> tuple[int, int]:
        effective_config = self._config if config is None else config
        runtime = effective_config["runtime"]
        if (
            runtime.get("frameEnhancerEnabled")
            and str(runtime.get("frameEnhancerScope", "full")) != "realtime"
            and not runtime.get("frameEnhancerDownscale")
        ):
            return width * 2, height * 2
        return width, height

    def _detect(
        self,
        img_chw,
        *,
        recognize: bool = False,
        config: dict[str, Any] | None = None,
        max_faces: int | None = None,
        detector_score: float = INTERNAL_FACE_DETECT_SCORE,
    ):
        effective_config = self._config if config is None else config
        params = effective_config["parameters"]
        # Baseline 1.12: per-face detector scores for the landmark guard.
        self._models._last_detect_scores = None
        kpss = self._models.run_detect(
            img_chw,
            str(params.get("DetectTypeTextSel", "SCRDF")),
            max_num=max(
                1,
                int(
                    max_faces
                    if max_faces is not None
                    else effective_config["runtime"].get("maximumFaces", 1)
                ),
            ),
            score=max(DetectionCalibration.MINIMUM, min(1.0, float(detector_score))),
            input_size=int(params.get("DetectInputSizeTextSel", 320)),
        )
        scores = getattr(self._models, "_last_detect_scores", None)
        self._detect_score_lookup = (
            {
                np.asarray(points, dtype=np.float32).tobytes(): float(value)
                for points, value in zip(kpss, scores)
            }
            if scores is not None and len(scores) == len(kpss)
            else {}
        )
        rows = []
        for kps in kpss:
            emb = None
            if recognize:
                # The headless pipeline consumes only the embedding. Avoid the
                # extra uint8 thumbnail conversion retained for Rope's GUI.
                emb, _ = self._models.run_recognize(
                    img_chw,
                    kps,
                    return_crop=False,
                )
            width = float(np.max(kps[:, 0]) - np.min(kps[:, 0]))
            height = float(np.max(kps[:, 1]) - np.min(kps[:, 1]))
            rows.append((width * height, kps, emb))
        return sorted(rows, key=lambda row: row[0], reverse=True)

    def _target_detection_score(self) -> float:
        calibration = getattr(self, "_detection_calibration", None)
        return calibration.threshold if calibration is not None else INTERNAL_FACE_DETECT_SCORE

    def _embedding_profile_key(self, config: dict[str, Any]) -> str:
        recognizer = MODELS_DIR / "w600k_r50.onnx"
        try:
            stat = recognizer.stat()
            recognizer_version = f"{stat.st_size}:{stat.st_mtime_ns}"
        except OSError:
            recognizer_version = "missing"
        params = config["parameters"]
        payload = {
            "recognizer": recognizer_version,
            "merge": str(params.get("MergeTextSel", "Mean")),
            # Source-face alignment can change with the detector/profile, so a
            # settings edit must not silently reuse an embedding made by a
            # different alignment pipeline.
            "detectType": str(params.get("DetectTypeTextSel", "SCRDF")),
            "detectSize": str(params.get("DetectInputSizeTextSel", "320")),
            "detectScore": INTERNAL_FACE_DETECT_SCORE,
            "sourcePreparation": "context-padding-v1",
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:16]

    def _embedding_cache_path(
        self,
        face: ApprovedFace,
        config: dict[str, Any] | None = None,
    ) -> Path:
        effective_config = self._config if config is None else config
        profile_key = self._embedding_profile_key(effective_config)
        digest = hashlib.sha256(
            f"{face.id}|{profile_key}".encode("utf-8")
        ).hexdigest()[:20]
        return self._embedding_cache_dir / f"{_slug(face.name)}-{digest}.npy"

    def _embedding_key_lock(self, key: tuple[str, str]) -> threading.Lock:
        with self._embedding_key_locks_guard:
            return self._embedding_key_locks.setdefault(key, threading.Lock())

    @contextmanager
    def _foreground_embedding_priority(self):
        """Temporarily make live session work outrank all-face priming.

        A counter, rather than a boolean Event, keeps overlapping Pong 1/Pong 2
        requests from clearing each other's reservation.  This condition is
        deliberately never held while acquiring ``_lock`` so the scheduler
        cannot introduce a lock-order deadlock.
        """
        with self._embedding_priority_condition:
            self._foreground_embedding_work += 1
            self._embedding_priority_condition.notify_all()
        try:
            yield
        finally:
            with self._embedding_priority_condition:
                self._foreground_embedding_work = max(
                    0,
                    self._foreground_embedding_work - 1,
                )
                self._embedding_priority_condition.notify_all()

    def _wait_for_embedding_prime_turn(self) -> None:
        """Pause speculative identity priming while playback work is relevant."""
        while True:
            with self._embedding_priority_condition:
                foreground = self._foreground_embedding_work > 0
            with self._sessions_lock:
                live_session = any(
                    not session.complete and not session.stop.is_set()
                    for session in self._sessions.values()
                )
            if not foreground and not live_session:
                return
            # Session retirement does not need to know about this low-priority
            # condition. A short timed wait keeps lock ordering one-directional
            # and resumes priming promptly once Pong is genuinely idle.
            with self._embedding_priority_condition:
                self._embedding_priority_condition.wait(timeout=0.20)

    def embedding_for_face(
        self,
        face_id: str,
        config: dict[str, Any] | None = None,
        *,
        queue_cancel_event: threading.Event | None = None,
    ) -> np.ndarray:
        if queue_cancel_event is not None and queue_cancel_event.is_set():
            raise RuntimeError("embedding preparation cancelled")
        effective_config = self._config if config is None else config
        profile_key = self._embedding_profile_key(effective_config)
        cache_key = (face_id, profile_key)
        cached = self._embedding_cache.get(cache_key)
        if cached is not None:
            return cached

        # /faces primes in the background while the first playback request may
        # ask for the same identity. Serialize only that identity/profile so
        # separate cached faces remain independently readable.
        with self._embedding_key_lock(cache_key):
            cached = self._embedding_cache.get(cache_key)
            if cached is not None:
                return cached
            self._run_gpu_work(
                self.warm,
                priority=0,
                queue_cancel_event=queue_cancel_event,
                work_label="embedding-warm",
                config=effective_config,
            )
            if queue_cancel_event is not None and queue_cancel_event.is_set():
                raise RuntimeError("embedding preparation cancelled")
            face = self.face(face_id)
            cache_path = self._embedding_cache_path(face, effective_config)
            merged = None
            try:
                disk_value = np.load(cache_path, allow_pickle=False)
                disk_value = np.asarray(disk_value, dtype=np.float32).reshape(-1)
                if disk_value.shape == (512,) and np.isfinite(disk_value).all():
                    merged = disk_value
            except (OSError, ValueError):
                pass
            if merged is None:
                merged = self.embedding_from_images(
                    face.files,
                    effective_config,
                    queue_cancel_event=queue_cancel_event,
                )
                if merged is None or (
                    queue_cancel_event is not None and queue_cancel_event.is_set()
                ):
                    raise RuntimeError("embedding preparation cancelled")
                temp_path = cache_path.with_name(
                    f"{cache_path.name}.{uuid.uuid4().hex}.tmp"
                )
                try:
                    with temp_path.open("wb") as target:
                        np.save(target, merged, allow_pickle=False)
                    os.replace(temp_path, cache_path)
                except OSError:
                    try:
                        temp_path.unlink(missing_ok=True)
                    except OSError:
                        pass

            with self._lock:
                self._embedding_cache[cache_key] = merged
                same_profile = [
                    value
                    for (_, cached_profile), value in self._embedding_cache.items()
                    if cached_profile == profile_key
                ]
                if same_profile:
                    mean_embedding = np.mean(np.stack(same_profile), axis=0)
                    self._models.set_session_mean_embedding(mean_embedding)
                    self._vm.clear_latent_cache()
            return merged

    def source_frame_for_face(
        self,
        face_id: str,
        config: dict[str, Any] | None = None,
    ):
        """Return UniFace's approved 256px source image on the live CUDA stream.

        The cache is keyed by the same detector/alignment profile as source
        embeddings. It is created only when UniFace is selected, so the normal
        InSwapper/AlphaFace/HyperSwap startup path pays no image-conditioning
        work or VRAM.
        """
        effective_config = self._config if config is None else config
        if str(effective_config["parameters"].get("SwapperTypeTextSel", "128")) != "UniFace":
            return None
        profile_key = self._embedding_profile_key(effective_config)
        cache_key = (face_id, profile_key)
        cached = self._source_frame_cache.get(cache_key)
        if cached is not None:
            return cached
        self._run_gpu_work(
            self.warm,
            priority=0,
            config=effective_config,
        )
        face = self.face(face_id)
        with self._lock:
            cached = self._source_frame_cache.get(cache_key)
            if cached is not None:
                return cached
            prepared = None
            ffhq_template = np.asarray(
                [
                    [0.37691676, 0.46864664],
                    [0.62285697, 0.46912813],
                    [0.50123859, 0.61331904],
                    [0.39308822, 0.72541100],
                    [0.61150205, 0.72490465],
                ],
                dtype=np.float32,
            ) * 256.0
            for path in face.files:
                bgr = cv2.imread(str(path))
                if bgr is None:
                    continue
                for detection_bgr in self._approved_source_detection_views(bgr):
                    rgb = cv2.cvtColor(detection_bgr, cv2.COLOR_BGR2RGB)
                    detected = self._detect(
                        self._frame_tensor(rgb),
                        recognize=False,
                        config=effective_config,
                    )
                    if not detected:
                        continue
                    kps = np.asarray(detected[0][1], dtype=np.float32)
                    matrix = cv2.estimateAffinePartial2D(
                        kps,
                        ffhq_template,
                        method=cv2.RANSAC,
                        ransacReprojThreshold=100,
                    )[0]
                    if matrix is None:
                        continue
                    aligned_bgr = cv2.warpAffine(
                        detection_bgr,
                        matrix,
                        (256, 256),
                        flags=cv2.INTER_AREA,
                        borderMode=cv2.BORDER_REPLICATE,
                    )
                    aligned_rgb = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2RGB)
                    prepared = np.ascontiguousarray(
                        aligned_rgb.transpose(2, 0, 1)[None],
                        dtype=np.float32,
                    ) / 255.0
                    break
                if prepared is not None:
                    break
            if prepared is None:
                raise ValueError("No usable face was detected for UniFace source conditioning")
            with self._torch.cuda.stream(self._compute_stream):
                source_tensor = self._torch.from_numpy(prepared).to("cuda")
            self._compute_stream.synchronize()
            self._source_frame_cache[cache_key] = source_tensor
            return source_tensor

    def _presentation_key_lock(self, key: tuple[str, str]) -> threading.Lock:
        with self._presentation_key_locks_guard:
            return self._presentation_key_locks.setdefault(key, threading.Lock())

    def _presentation_profile_key(self, config: dict[str, Any]) -> str:
        try:
            stat = self._presentation_classifier.model_path.stat()
            classifier_version = f"{stat.st_size}:{stat.st_mtime_ns}"
        except OSError:
            classifier_version = "missing"
        return f"{self._embedding_profile_key(config)}:{classifier_version}"

    def _presentation_for_face_on_gpu(
        self,
        face_id: str,
        config: dict[str, Any],
        cancel_event: threading.Event | None = None,
    ) -> FacePresentation:
        face = self.face(face_id)
        observations: list[FacePresentation] = []
        for path in face.files[:3]:
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError("presentation preparation cancelled")
            bgr = cv2.imread(str(path))
            if bgr is None:
                continue
            for detection_bgr in self._approved_source_detection_views(bgr):
                rgb = cv2.cvtColor(detection_bgr, cv2.COLOR_BGR2RGB)
                with self._lock:
                    stream = self._compute_stream
                    if stream is None:
                        raise RuntimeError("Pong Swap CUDA stream is not initialized")
                    with self._torch.cuda.stream(stream):
                        detected = self._detect(
                            self._frame_tensor(rgb),
                            recognize=False,
                            config=config,
                            max_faces=1,
                        )
                    stream.synchronize()
                if not detected:
                    continue
                observations.append(
                    self._presentation_classifier.classify(rgb, detected[0][1])
                )
                break
        known = [value for value in observations if value.known]
        if not known:
            return FacePresentation("unknown", 0.0)
        labels = {
            label: [value for value in known if value.label == label]
            for label in ("female", "male")
        }
        selected_label = max(
            labels,
            key=lambda label: (
                len(labels[label]),
                sum(value.confidence for value in labels[label]),
            ),
        )
        selected_values = labels[selected_label]
        appearance_values = [
            np.asarray(value.appearance, dtype=np.float32)
            for value in selected_values
            if value.appearance
        ]
        appearance = ()
        if appearance_values and all(
            value.shape == appearance_values[0].shape for value in appearance_values
        ):
            appearance = tuple(
                float(value) for value in np.median(
                    np.stack(appearance_values, axis=0), axis=0
                )
            )
        return FacePresentation(
            selected_label,
            float(sum(value.confidence for value in selected_values) / len(selected_values)),
            appearance,
        )

    def presentation_for_face(
        self,
        face_id: str,
        config: dict[str, Any] | None = None,
        *,
        queue_cancel_event: threading.Event | None = None,
    ) -> FacePresentation:
        effective_config = self._config if config is None else config
        profile_key = self._presentation_profile_key(effective_config)
        cache_key = (face_id, profile_key)
        cached = self._presentation_cache.get(cache_key)
        if cached is not None:
            return cached
        with self._presentation_key_lock(cache_key):
            cached = self._presentation_cache.get(cache_key)
            if cached is not None:
                return cached
            self._run_gpu_work(
                self.warm,
                priority=0,
                queue_cancel_event=queue_cancel_event,
                work_label="presentation-warm",
                config=effective_config,
            )
            value = self._run_gpu_work(
                self._presentation_for_face_on_gpu,
                face_id,
                effective_config,
                queue_cancel_event,
                priority=0,
                queue_cancel_event=queue_cancel_event,
                work_label="source-presentation",
            )
            self._presentation_cache[cache_key] = value
            return value

    def _hair_for_multi_target(self, frame, keypoints):
        from pong_hair_policy import head_crop, color_from_hair_mask, segmented_hair_score
        crop = head_crop(frame, keypoints)
        if crop is None:
            return ('unknown', 0.0)
        # Acquisition only; reuse the already-resident parser and owned stream.
        # No new model, per-render-frame inference, or quality-preset changes.
        with self._lock:
            torch = self._torch
            with torch.cuda.stream(self._compute_stream):
                inp = torch.from_numpy(np.ascontiguousarray(crop.transpose(2,0,1))).to('cuda', dtype=torch.float32).div_(255.)
                mean = torch.tensor([.485,.456,.406],device='cuda')[:,None,None]
                std = torch.tensor([.229,.224,.225],device='cuda')[:,None,None]
                inp = ((inp-mean)/std).unsqueeze(0).contiguous()
                output = torch.empty((1,19,512,512),device='cuda',dtype=torch.float32)
                self._models.run_faceparser(inp, output)
                probability = segmented_hair_score(output[0]).cpu().numpy()
            self._compute_stream.synchronize()
        return color_from_hair_mask(crop, probability)

    def _select_compatible_identity_for_frame(
        self,
        frame: np.ndarray,
        candidates: tuple[CandidateIdentity, ...],
        config: dict[str, Any],
        frame_evidence: FrameEvidence,
        cancel_event: threading.Event | None = None,
        manual_target_point: tuple[float, float] | None = None,
        manual_target_embedding: np.ndarray | None = None,
        manual_target_presentation: FacePresentation | None = None,
        multi_source_face_id: str | None = None,
    ):
        if cancel_event is not None and cancel_event.is_set():
            return None
        with self._lock:
            stream = self._compute_stream
            if stream is None:
                raise RuntimeError("Pong Swap CUDA stream is not initialized")
            with self._torch.cuda.stream(stream):
                detected = self._detect(
                    self._frame_tensor(frame),
                    recognize=True,
                    config=config,
                    detector_score=self._target_detection_score(),
                    # Initial acquisition must see every plausible person even
                    # though rendering transforms only the one locked pair.
                    max_faces=10,
                )
            stream.synchronize()
        frame_evidence.detection_attempted = True
        frame_evidence.detections = tuple(detected)
        frame_evidence.recognition_complete = True
        targets: list[TargetIdentity] = []
        from pong_hair_policy import required_hair
        needs_hair = len(candidates) > 1 and any(required_hair(c.face_id) for c in candidates)
        for area, keypoints, embedding in detected:
            if embedding is None:
                continue
            if cancel_event is not None and cancel_event.is_set():
                return None
            if manual_target_embedding is not None:
                raw_similarity = rope_similarity(manual_target_embedding, embedding)
                lock_floor = target_identity_lock_threshold(
                    (config.get("parameters") or {}).get("DetectScoreSlider", 45)
                )
                if identity_similarity_upper_bound(raw_similarity) < lock_floor:
                    continue
            try:
                presentation = self._presentation_classifier.classify(frame, keypoints)
            except Exception:
                presentation = FacePresentation("unknown", 0.0)
            hair_color, hair_confidence = ('unknown', 0.0)
            if needs_hair:
                try:
                    hair_color, hair_confidence = self._hair_for_multi_target(frame, keypoints)
                except Exception:
                    # Restricted sources cannot silently bypass unavailable evidence.
                    pass
            targets.append(
                TargetIdentity(
                    keypoints=np.asarray(keypoints, dtype=np.float32),
                    embedding=np.asarray(embedding, dtype=np.float32),
                    presentation=presentation,
                    area=float(area),
                    hair_color=hair_color,
                    hair_confidence=hair_confidence,
                )
            )
        minimum_similarity = float(
            (config.get("parameters") or {}).get("DetectScoreSlider", 45)
        )
        minimum_presentation_confidence = presentation_confidence_for_strictness(
            minimum_similarity
        )
        selection = None
        def select_sources(target_list):
            if len(candidates) > 1:
                source_choices = tuple(c for c in candidates if c.face_id == multi_source_face_id) if multi_source_face_id else candidates
                decision = choose_multi_face(source_choices, target_list,
                    minimum_similarity=minimum_similarity,
                    minimum_presentation_confidence=minimum_presentation_confidence)
                frame_evidence.multi_face_decision = decision.public()
                return decision.selection
            return choose_compatible_identity(candidates, target_list,
                minimum_similarity=minimum_similarity,
                minimum_presentation_confidence=minimum_presentation_confidence)
        if manual_target_embedding is not None and targets:
            locked_embedding = np.asarray(
                manual_target_embedding,
                dtype=np.float32,
            ).reshape(-1)
            strictness = float(
                (config.get("parameters") or {}).get("DetectScoreSlider", 45)
            )
            locked_presentation = (
                manual_target_presentation
                if isinstance(manual_target_presentation, FacePresentation)
                else FacePresentation("unknown", 0.0)
            )
            locked_candidate = CandidateIdentity(
                face_id="manual-target-lock",
                embedding=locked_embedding,
                presentation=locked_presentation,
            )
            locked_rankings: list[IdentitySelection] = []
            if locked_presentation.known:
                for target in targets:
                    locked_rankings.extend(
                        compatible_identity_rankings(
                            (locked_candidate,),
                            target,
                            minimum_similarity=target_identity_lock_threshold(strictness),
                            minimum_presentation_confidence=presentation_confidence_for_strictness(
                                strictness
                            ),
                            similarity_mode="identity",
                        )
                    )
            else:
                for target in targets:
                    similarity = rope_similarity(locked_embedding, target.embedding)
                    if similarity >= target_identity_lock_threshold(strictness):
                        locked_rankings.append(
                            IdentitySelection(locked_candidate, target, similarity)
                        )
            locked_rankings.sort(key=lambda item: item.similarity, reverse=True)
            if locked_rankings:
                selected_target = locked_rankings[0].target
                selection = select_sources([selected_target])
        elif manual_target_point is not None and targets:
            target_x = max(0.0, min(1.0, float(manual_target_point[0])))
            target_y = max(0.0, min(1.0, float(manual_target_point[1])))
            height, width = frame.shape[:2]
            selected_target = min(
                targets,
                key=lambda target: (
                    ((float(np.mean(target.keypoints[:, 0])) / max(1.0, float(width))) - target_x) ** 2
                    + ((float(np.mean(target.keypoints[:, 1])) / max(1.0, float(height))) - target_y) ** 2
                ),
            )
            # A direct tap is authoritative only for *which* detected person is
            # evaluated.  It must not bypass the same presentation and face-match
            # gates used by live playback, otherwise the fixed-frame editor can
            # show a swap that the video correctly refuses.
            selection = select_sources([selected_target])
        else:
            selection = select_sources(targets)
        if selection is not None:
            frame_evidence.selected_target_embedding = np.asarray(
                selection.target.embedding,
                dtype=np.float32,
            )
            frame_evidence.selected_target_similarity = float(selection.similarity)
        return selection

    def prime_embeddings_async(self, *, delay_seconds: float = 0.0) -> None:
        """Warm the selected pipeline and all approved identities once.

        Persistent .npy entries make later launches nearly free. The guard is
        intentionally one-shot per service lifetime so repeated menu opens do
        not create competing TensorRT builds.
        """
        # Lock order is always config -> primer. Model lifecycle updates take the
        # same config lock before checking this registered thread.
        # Capturing and registering atomically prevents a model-lifecycle PUT
        # from slipping between the snapshot and thread registration.
        with self._config_lock:
            with self._embedding_prime_lock:
                if self._embedding_prime_started:
                    return
                self._embedding_prime_started = True
                # Each generation owns an immutable cancellation token.  A
                # lifecycle change may set it, but no later primer or unload is
                # allowed to clear it behind the still-running worker's back.
                prime_cancel = threading.Event()
                self._embedding_prime_cancel = prime_cancel
                prime_config = deepcopy(self._config)

                def worker() -> None:
                    errors: list[str] = []
                    try:
                        if delay_seconds > 0:
                            if prime_cancel.wait(max(0.0, float(delay_seconds))):
                                return
                        if prime_cancel.is_set():
                            return
                        self._wait_for_embedding_prime_turn()
                        if prime_cancel.is_set():
                            return
                        self._run_gpu_work(
                            self.warm,
                            priority=10,
                            queue_cancel_event=prime_cancel,
                            work_label="primer-warm",
                        )
                        for face_id in list(self._faces):
                            if prime_cancel.is_set():
                                break
                            # Re-check between identities.  A foreground request
                            # may wait for the one inference already in flight,
                            # but never for the remainder of the approved list.
                            self._wait_for_embedding_prime_turn()
                            if prime_cancel.is_set():
                                break
                            try:
                                self.embedding_for_face(
                                    face_id,
                                    prime_config,
                                    queue_cancel_event=prime_cancel,
                                )
                                self.presentation_for_face(
                                    face_id,
                                    prime_config,
                                    queue_cancel_event=prime_cancel,
                                )
                            except Exception as exc:
                                if prime_cancel.is_set():
                                    break
                                errors.append(
                                    f"Approved face {face_id}: {type(exc).__name__}: {exc}"
                                )
                    except Exception as exc:
                        errors.append(f"{type(exc).__name__}: {exc}")
                    finally:
                        # One unreadable approved image should be visible in
                        # diagnostics without declaring the already-warm swap
                        # engine unhealthy for every other approved identity.
                        with self._lock:
                            self._embedding_prime_error = errors[-1] if errors else ""
                        with self._embedding_prime_lock:
                            if self._embedding_prime_thread is threading.current_thread():
                                self._embedding_prime_thread = None
                                self._embedding_prime_started = False

                primer = threading.Thread(
                    target=worker,
                    name="PongSwapEmbeddingPrime",
                    daemon=True,
                )
                self._embedding_prime_thread = primer
                # The new thread blocks on _lock inside warm() until registration
                # is fully visible, so starting here closes the final race window.
                primer.start()

    def embedding_from_images(
        self,
        files: list[Path] | tuple[Path, ...],
        config: dict[str, Any] | None = None,
        *,
        queue_cancel_event: threading.Event | None = None,
    ) -> np.ndarray | None:
        """Build one source identity from local, explicitly approved images."""
        return self._run_gpu_work(
            self._embedding_from_images_on_gpu,
            files,
            priority=0,
            queue_cancel_event=queue_cancel_event,
            cancelled_value=None,
            work_label="embedding-images",
            config=config,
            cancel_event=queue_cancel_event,
        )

    @staticmethod
    def _approved_source_detection_views(bgr: np.ndarray):
        """Yield the source and context-padded fallbacks for tight portraits."""
        yield bgr
        height, width = bgr.shape[:2]
        for ratio in (0.25, 0.50):
            pad_y = max(16, int(round(height * ratio)))
            pad_x = max(16, int(round(width * ratio)))
            yield cv2.copyMakeBorder(
                bgr,
                pad_y,
                pad_y,
                pad_x,
                pad_x,
                cv2.BORDER_REPLICATE,
            )

    def _embedding_from_images_on_gpu(
        self,
        files: list[Path] | tuple[Path, ...],
        config: dict[str, Any] | None = None,
        *,
        cancel_event: threading.Event | None = None,
    ) -> np.ndarray:
        """Build an identity on the persistent GPU execution owner."""
        effective_config = self._config if config is None else config
        self.warm(config=effective_config)
        embeddings = []
        with self._lock:
            for path in files:
                if cancel_event is not None and cancel_event.is_set():
                    raise RuntimeError("embedding preparation cancelled")
                bgr = cv2.imread(str(path))
                if bgr is None:
                    continue
                for detection_bgr in self._approved_source_detection_views(bgr):
                    rgb = cv2.cvtColor(detection_bgr, cv2.COLOR_BGR2RGB)
                    detected = self._detect(
                        self._frame_tensor(rgb),
                        recognize=True,
                        config=effective_config,
                    )
                    if detected and detected[0][2] is not None:
                        embeddings.append(np.asarray(detected[0][2], dtype=np.float32))
                        break
            if not embeddings:
                raise ValueError("No usable face was detected in the approved source image(s)")
            if len(embeddings) == 1:
                merged = embeddings[0]
            else:
                from rope.EmbeddingMerge import combine

                merged = combine(
                    embeddings,
                    effective_config["parameters"].get("MergeTextSel", "Mean"),
                )
            return np.asarray(merged, dtype=np.float32)

    def _choose_target(
        self,
        img_chw,
        anchor: np.ndarray | None,
        *,
        verify_identity: bool = True,
        config: dict[str, Any] | None = None,
        prior_kps: np.ndarray | None = None,
        frame_shape: tuple[int, ...] | None = None,
        frame_evidence: FrameEvidence | None = None,
        frame_rgb: np.ndarray | None = None,
        required_presentation: FacePresentation | None = None,
        manual_target_point: tuple[float, float] | None = None,
        allow_anchor_adaptation: bool = False,
        reacquisition_anchors: Sequence[np.ndarray] | None = None,
    ):
        effective_config = self._config if config is None else config
        try:
            previous_track = np.asarray(prior_kps, dtype=np.float32).reshape(5, 2)
            has_track = bool(np.isfinite(previous_track).all())
        except (TypeError, ValueError):
            has_track = False
        comparison_anchor = anchor
        identity_gallery: list[np.ndarray] = []
        if anchor is not None and not has_track:
            current_anchor = np.asarray(anchor, dtype=np.float32).reshape(-1)
            for stored_anchor in tuple(reacquisition_anchors or ()):
                try:
                    stable_anchor = np.asarray(stored_anchor, dtype=np.float32).reshape(-1)
                except (TypeError, ValueError):
                    continue
                if (
                    stable_anchor.shape == current_anchor.shape
                    and stable_anchor.size > 0
                    and np.isfinite(stable_anchor).all()
                ):
                    identity_gallery.append(stable_anchor)
            if identity_gallery:
                comparison_anchor = identity_gallery[0]
        # After a lost track, geometric association has no history to use.
        # Recognize immediately, retaining the normal reacquisition threshold
        # and immutable identity anchor rather than waiting for a periodic tick.
        recognize = anchor is None or verify_identity or not has_track
        if frame_evidence is not None and frame_evidence.detection_attempted:
            detected = list(frame_evidence.detections)
        else:
            # Detect once. If identity verification is required, enrich these
            # exact candidates below rather than running the detector again.
            detected = self._detect(
                img_chw,
                recognize=False,
                config=effective_config,
                detector_score=self._target_detection_score(),
                # Rendering remains single-face, but identity verification
                # must inspect the whole scene. Limiting this pass to
                # maximumFaces=1 made the largest bystander the only candidate
                # and effectively hid the selected person from strictness.
                # Association also needs all candidates between recognition
                # deadlines; detector ordering/area must not hide the track.
                max_faces=10,
            )
            if frame_evidence is not None:
                frame_evidence.detection_attempted = True
                frame_evidence.detections = tuple(detected)
                frame_evidence.recognition_complete = False
        if recognize and not (
            frame_evidence is not None and frame_evidence.recognition_complete
        ):
            recognized = []
            for area, candidate_kps, embedding in detected:
                if embedding is None:
                    embedding, _ = self._models.run_recognize(
                        img_chw,
                        candidate_kps,
                        return_crop=False,
                    )
                recognized.append((area, candidate_kps, embedding))
            detected = recognized
            if frame_evidence is not None:
                frame_evidence.detections = tuple(detected)
                frame_evidence.recognition_complete = True
        if not detected:
            if frame_evidence is not None:
                frame_evidence.rejection_reasons.append("target-not-detected")
            return None, comparison_anchor
        if comparison_anchor is None:
            selected = detected[0]
            if manual_target_point is not None and frame_shape is not None:
                height, width = frame_shape[:2]
                target_x = max(0.0, min(1.0, float(manual_target_point[0])))
                target_y = max(0.0, min(1.0, float(manual_target_point[1])))
                selected = min(
                    detected,
                    key=lambda row: (
                        ((float(np.mean(row[1][:, 0])) / max(1.0, float(width))) - target_x) ** 2
                        + ((float(np.mean(row[1][:, 1])) / max(1.0, float(height))) - target_y) ** 2
                    ),
                )
            _, kps, emb = selected
            selected_embedding = np.asarray(emb, dtype=np.float32)
            if frame_evidence is not None:
                frame_evidence.selected_target_embedding = selected_embedding
                frame_evidence.selected_target_similarity = 100.0
            return kps, selected_embedding
        if not recognize:
            # Preserve the active geometric track rather than silently
            # switching to whichever detection has the largest area.
            try:
                previous = np.asarray(prior_kps, dtype=np.float32).reshape(5, 2)
            except (TypeError, ValueError):
                previous = None
            if previous is None or not np.isfinite(previous).all():
                if frame_evidence is not None:
                    frame_evidence.rejection_reasons.append("target-association-missing-history")
                return None, anchor
            status = np.ones((5, 1), dtype=np.uint8)
            scored: list[tuple[float, np.ndarray]] = []
            for _area, candidate, _embedding in detected:
                points = np.asarray(candidate, dtype=np.float32).reshape(-1, 2)
                if points.shape != (5, 2) or not np.isfinite(points).all():
                    continue
                if frame_shape is not None and not _tracked_landmarks_are_valid(
                    previous,
                    points,
                    previous,
                    status,
                    status,
                    frame_shape,
                ):
                    continue
                transform, _ = cv2.estimateAffinePartial2D(
                    previous,
                    points,
                    method=cv2.LMEDS,
                )
                if transform is None or not np.isfinite(transform).all():
                    continue
                projected = cv2.transform(previous.reshape(1, -1, 2), transform)[0]
                span = max(1.0, _landmark_span(previous))
                fit = float(np.median(np.linalg.norm(projected - points, axis=1))) / span
                motion = float(np.median(np.linalg.norm(points - previous, axis=1))) / span
                scored.append((motion + fit * 2.0, points))
            if not scored:
                if frame_evidence is not None:
                    frame_evidence.rejection_reasons.append("target-association")
                return None, anchor
            scored.sort(key=lambda item: item[0])
            return scored[0][1], anchor
        strictness = float(
            effective_config["parameters"].get("DetectScoreSlider", 45)
        )
        threshold = target_identity_lock_threshold(strictness)
        continuity_threshold = target_identity_continuity_threshold()
        try:
            previous = np.asarray(prior_kps, dtype=np.float32).reshape(5, 2)
        except (TypeError, ValueError):
            previous = None
        if previous is not None and not np.isfinite(previous).all():
            previous = None
        # With no valid adjacent track there is no continuity exemption. The
        # stronger reacquisition floor can reject impossible identities before
        # the expensive appearance classifier, without changing any decisions.
        identity_floor = continuity_threshold if previous is not None else threshold
        scored_identities: list[tuple[float, np.ndarray, np.ndarray]] = []
        for _, kps, emb in detected:
            # Do not run a CPU appearance classifier on a face that cannot
            # pass even the permissive adjacent-frame identity floor. Detection
            # and recognition still run at the original cadence, so a returning
            # target is never delayed and no accepted identity decision changes.
            candidate_embedding = np.asarray(emb)
            candidate_anchors = identity_gallery or [comparison_anchor]
            raw_similarity, candidate_anchor = max(
                (
                    (rope_similarity(candidate_embedding, known_anchor), known_anchor)
                    for known_anchor in candidate_anchors
                ),
                key=lambda item: item[0],
            )
            if frame_evidence is not None:
                prior_best_raw = getattr(
                    frame_evidence, "best_target_raw_similarity", None
                )
                frame_evidence.best_target_raw_similarity = (
                    float(raw_similarity) if prior_best_raw is None
                    else max(float(prior_best_raw), float(raw_similarity))
                )
            if identity_similarity_upper_bound(raw_similarity) < identity_floor:
                if frame_evidence is not None:
                    frame_evidence.rejection_reasons.append("target-identity-below-floor")
                continue
            observed_presentation = None
            if required_presentation is not None:
                if frame_rgb is None:
                    if frame_evidence is not None:
                        frame_evidence.rejection_reasons.append("target-appearance-frame-missing")
                    continue
                try:
                    observed_presentation = self._presentation_classifier.classify(
                        frame_rgb,
                        kps,
                    )
                except Exception:
                    observed_presentation = FacePresentation("unknown", 0.0)
                if (
                    not required_presentation.known
                    or not observed_presentation.known
                    or observed_presentation.label != required_presentation.label
                ):
                    if frame_evidence is not None:
                        frame_evidence.rejection_reasons.append(
                            "target-appearance-unknown" if not observed_presentation.known
                            else "target-appearance-mismatch"
                        )
                    continue
            if (
                isinstance(required_presentation, FacePresentation)
                and required_presentation.known
                and isinstance(observed_presentation, FacePresentation)
            ):
                ranking = compatible_identity_rankings(
                    (
                        CandidateIdentity(
                            "locked-target",
                            np.asarray(candidate_anchor, dtype=np.float32),
                            required_presentation,
                        ),
                    ),
                    TargetIdentity(
                        keypoints=np.asarray(kps, dtype=np.float32),
                        embedding=np.asarray(emb, dtype=np.float32),
                        presentation=observed_presentation,
                    ),
                    minimum_similarity=0.0,
                    minimum_presentation_confidence=presentation_confidence_for_strictness(
                        strictness
                    ),
                    similarity_mode="identity",
                )
                score = ranking[0].similarity if ranking else -math.inf
            else:
                score = raw_similarity
            if math.isfinite(score):
                scored_identities.append(
                    (float(score), kps, np.asarray(emb, dtype=np.float32))
                )
            elif frame_evidence is not None:
                frame_evidence.rejection_reasons.append("target-appearance-confidence")
        if not scored_identities:
            return None, comparison_anchor
        if frame_evidence is not None:
            frame_evidence.best_target_similarity = max(
                item[0] for item in scored_identities
            )
        # A difficult profile/edge view may score below the conservative
        # reacquisition floor. Keep that same person only when their landmarks
        # are a valid adjacent-frame continuation. This recovers first/last
        # partial views without letting a spatially unrelated bystander claim
        # an absent target.
        continuous: list[tuple[float, float, np.ndarray, np.ndarray]] = []
        if previous is not None and np.isfinite(previous).all():
            previous_span = max(1.0, _landmark_span(previous))
            for score, candidate_kps, embedding in scored_identities:
                points = np.asarray(candidate_kps, dtype=np.float32).reshape(-1, 2)
                if points.shape != (5, 2) or not np.isfinite(points).all():
                    continue
                candidate_span = max(1.0, _landmark_span(points))
                scale_ratio = candidate_span / previous_span
                if scale_ratio < 0.55 or scale_ratio > 1.80:
                    continue
                transform, _ = cv2.estimateAffinePartial2D(
                    previous,
                    points,
                    method=cv2.LMEDS,
                )
                if transform is None or not np.isfinite(transform).all():
                    continue
                projected = cv2.transform(
                    previous.reshape(1, -1, 2),
                    transform,
                )[0]
                fit = float(
                    np.median(np.linalg.norm(projected - points, axis=1))
                ) / previous_span
                motion = float(
                    np.median(np.linalg.norm(points - previous, axis=1))
                ) / previous_span
                if motion > 0.75 or fit > 0.22 or score < continuity_threshold:
                    continue
                continuity_cost = motion + fit * 2.0 + abs(math.log(scale_ratio)) * 0.20
                continuous.append((continuity_cost, score, points, embedding))
        def adapted_anchor(embedding: np.ndarray) -> np.ndarray:
            if not allow_anchor_adaptation:
                return comparison_anchor
            previous_anchor = np.asarray(comparison_anchor, dtype=np.float32).reshape(-1)
            observation = np.asarray(embedding, dtype=np.float32).reshape(-1)
            if previous_anchor.shape != observation.shape:
                return comparison_anchor
            blended = previous_anchor * 0.80 + observation * 0.20
            norm = float(np.linalg.norm(blended))
            return blended / norm if math.isfinite(norm) and norm > 1e-12 else comparison_anchor

        if continuous:
            continuous.sort(key=lambda item: (item[0], -item[1]))
            if (
                len(continuous) > 1
                and continuous[1][0] - continuous[0][0] < 0.08
                and abs(continuous[0][1] - continuous[1][1]) < 3.0
            ):
                if frame_evidence is not None:
                    frame_evidence.rejection_reasons.append(
                        "target-continuity-ambiguous"
                    )
                return None, comparison_anchor
            selected = continuous[0]
            if frame_evidence is not None:
                frame_evidence.selected_target_embedding = selected[3]
                frame_evidence.selected_target_similarity = float(selected[1])
            return selected[2], adapted_anchor(selected[3])

        scored_identities = [
            item for item in scored_identities if item[0] >= threshold
        ]
        if not scored_identities:
            return None, comparison_anchor
        scored_identities.sort(key=lambda item: item[0], reverse=True)
        # Never jump between two similarly plausible people.  The session's
        # original ArcFace anchor remains immutable; when two visible targets
        # are too close to distinguish confidently, fail closed for this frame
        # and let the established track recover instead of picking arbitrarily.
        if (
            len(scored_identities) > 1
            and scored_identities[0][0] - scored_identities[1][0] < 3.0
        ):
            if frame_evidence is not None:
                frame_evidence.rejection_reasons.append("target-identity-ambiguous")
            return None, comparison_anchor
        if frame_evidence is not None:
            frame_evidence.selected_target_embedding = scored_identities[0][2]
            frame_evidence.selected_target_similarity = float(scored_identities[0][0])
        return scored_identities[0][1], adapted_anchor(scored_identities[0][2])

    def _redetect_landmarks_for_temporal_reuse(
        self,
        frame: np.ndarray,
        tracking_state: dict[str, Any],
        *,
        config: dict[str, Any],
        cancel_event: threading.Event | None = None,
        frame_evidence: FrameEvidence | None = None,
        media_time_seconds: float | None = None,
    ) -> LandmarkTrackAdvance | None:
        """Recover a strict five-point track without running swap/restoration.

        LK may lose one point on harmless motion.  A detector observation can
        safely recover the cheap lane when its complete five-point geometry is
        continuous with the prior track; the independent local-appearance gate
        still runs afterward and rejects expressions or occlusion changes.
        State remains uncommitted until the rendered residual is accepted.
        """
        if cancel_event is not None and cancel_event.is_set():
            return None
        prior_raw = tracking_state.get("rawKps", tracking_state.get("kps"))
        prior_rendered = tracking_state.get("kps")
        if prior_raw is None or not isinstance(frame, np.ndarray):
            return None
        prior_points = np.asarray(prior_raw, dtype=np.float32).reshape(-1, 2)
        if prior_points.shape != (5, 2) or not np.isfinite(prior_points).all():
            return None
        current_gray = (
            frame_evidence.gray
            if frame_evidence is not None and isinstance(frame_evidence.gray, np.ndarray)
            else cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        )
        if frame_evidence is not None and frame_evidence.gray is None:
            frame_evidence.gray = current_gray
        if frame_evidence is not None and frame_evidence.detection_attempted:
            detected = list(frame_evidence.detections)
        else:
            with self._lock:
                if cancel_event is not None and cancel_event.is_set():
                    return None
                compute_stream = self._compute_stream
                if compute_stream is None:
                    return None
                with self._torch.cuda.stream(compute_stream):
                    detected = self._detect(
                        self._frame_tensor(frame),
                        recognize=False,
                        config=config,
                        detector_score=self._target_detection_score(),
                        max_faces=10,
                    )
                compute_stream.synchronize()
            if frame_evidence is not None:
                frame_evidence.detection_attempted = True
                frame_evidence.detections = tuple(detected)
                frame_evidence.recognition_complete = False
        status = np.ones((5, 1), dtype=np.uint8)
        best_points = None
        best_motion = math.inf
        for _, candidate, _ in detected:
            candidate_points = np.asarray(candidate, dtype=np.float32).reshape(-1, 2)
            if candidate_points.shape != (5, 2):
                continue
            if not _tracked_landmarks_are_valid(
                prior_points,
                candidate_points,
                prior_points,
                status,
                status,
                frame.shape,
            ):
                continue
            motion = float(
                np.median(np.linalg.norm(candidate_points - prior_points, axis=1))
            )
            if motion < best_motion:
                best_points = candidate_points
                best_motion = motion
        if best_points is None:
            return None
        transform, _ = cv2.estimateAffinePartial2D(
            prior_points,
            best_points,
            method=cv2.LMEDS,
        )
        if transform is None or not np.isfinite(transform).all():
            return None
        projected = cv2.transform(prior_points.reshape(1, -1, 2), transform)[0]
        fit_residual = float(
            np.max(np.linalg.norm(projected - best_points, axis=1))
        )
        if not math.isfinite(fit_residual):
            return None
        rendered = _smooth_tracked_landmarks(
            prior_rendered,
            best_points,
            delta_seconds=float(tracking_state.get("frameDeltaSeconds", 1.0 / 30.0)),
        )
        evidence = LandmarkTrackEvidence(
            points=best_points,
            observed_mask=np.ones(5, dtype=bool),
            reverse_errors=np.zeros(5, dtype=np.float32),
            reconstructed=False,
            fit_residual=fit_residual,
        )
        return LandmarkTrackAdvance(
            points=rendered,
            current_gray=current_gray,
            evidence=evidence,
            since_detect=1,
            pose=None,
        )

    def process_frame(
        self,
        frame: Any,
        source_embedding: np.ndarray,
        anchor: np.ndarray | None,
        *,
        source_frame=None,
        verify_identity: bool = True,
        tracking_state: dict[str, Any] | None = None,
        cancel_event: threading.Event | None = None,
        config: dict[str, Any] | None = None,
        diagnostics: dict[str, list[float]] | None = None,
        temporal_context: dict[str, Any] | None = None,
        frame_evidence: FrameEvidence | None = None,
        manual_target_point: tuple[float, float] | None = None,
        tracking_lookahead: TrackingLookahead | None = None,
        next_frame: np.ndarray | None = None,
    ):
        frame_wall_started = time.perf_counter()
        effective_config = self._config if config is None else config
        # Cancellation can arrive while a stale card is waiting to enter this
        # method. It must not trigger model warmup or a host-to-device upload.
        if cancel_event is not None and cancel_event.is_set():
            return None, anchor
        # Do not run the full health/GPU-memory probe for every frame. Active
        # sessions prevent idle unload, so a cheap publication check is enough.
        if getattr(self, "_models", None) is None or getattr(self, "_vm", None) is None:
            self.warm(config=effective_config)
        else:
            self._last_used = time.time()
        torch = self._torch
        detect_interval = max(
            1,
            int(effective_config["runtime"].get("targetDetectIntervalFrames", 1)),
        )
        gray_started = time.perf_counter()
        current_gray = None
        if tracking_lookahead is not None and tracking_state is not None:
            prepared = tracking_lookahead.consume(frame, tracking_state)
            if prepared is not None:
                if frame_evidence is None:
                    frame_evidence = FrameEvidence(
                        prior_track_revision=int(tracking_state.get("trackRevision", 0))
                    )
                frame_evidence.gray, frame_evidence.lk_flow_evidence = prepared
                frame_evidence.lk_flow_prepared = True
        if tracking_state is not None and isinstance(frame, np.ndarray):
            current_gray = (
                frame_evidence.gray
                if frame_evidence is not None and isinstance(frame_evidence.gray, np.ndarray)
                else cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
            )
            if frame_evidence is not None and frame_evidence.gray is None:
                frame_evidence.gray = current_gray
        if diagnostics is not None:
            diagnostics.setdefault("grayCpuMs", []).append((time.perf_counter() - gray_started) * 1000.0)
        lock_wait_started = time.perf_counter()
        with self._lock:
            if diagnostics is not None:
                diagnostics.setdefault("modelLockWaitMs", []).append((time.perf_counter() - lock_wait_started) * 1000.0)
            # A swipe can retire a producer while it is queued behind a GPU
            # inference owned by the prior card. Do not let that stale frame
            # consume even a host-to-device upload once the lock opens.
            if cancel_event is not None and cancel_event.is_set():
                return None, anchor
            compute_stream = self._compute_stream
            if compute_stream is None:
                raise RuntimeError("Pong Swap CUDA stream is not initialized")
            cuda_marks: list[tuple[str, Any]] = []

            def mark_cuda(name: str) -> None:
                if diagnostics is None:
                    return
                event = torch.cuda.Event(enable_timing=True)
                event.record(compute_stream)
                cuda_marks.append((name, event))

            with torch.cuda.stream(compute_stream):
                mark_cuda("begin")
                # A new visual selection must be explicitly warmed before live
                # inference; never compile an unprepared GPEN inside a frame.
                self._warm_selected_restorer(
                    self._models, torch, compute_stream, effective_config, allow_create=False,
                )
                img_chw = self._frame_tensor(frame)
                mark_cuda("upload")
                self._vm.parameters = dict(effective_config["parameters"])
                self._vm.color_match_cuda_graph_enabled = bool(effective_config['runtime'].get('colorMatchCudaGraph', False))
                kps = None
                raw_kps = None
                proposed_pose = None
                pending_track_advance = None
                detector_lk_prediction = None
                track_attempted = False
                track_failed = False
                track_generation_invalidated = False
                if temporal_context is not None:
                    temporal_context['restorerDetectorRecoveryConfirmed'] = False
                # Standalone benchmark/preview callers also need the recognized
                # evidence used by the same conservative recovery contract.
                if frame_evidence is None:
                    frame_evidence = FrameEvidence()
                if tracking_state is not None and isinstance(frame, np.ndarray):
                    # Keep raw LK points separate from the lightly smoothed points
                    # used for rendering. Feeding filtered points back into LK would
                    # accumulate lag and eventually turn smoothing into drift.
                    prior_kps = tracking_state.get(
                        "rawKps",
                        tracking_state.get("kps"),
                    )
                    prior_gray = tracking_state.get("gray")
                    since_detect = int(tracking_state.get("sinceDetect", detect_interval))
                    if (
                        prior_kps is not None
                        and prior_gray is not None
                        and since_detect < detect_interval
                        and not verify_identity
                    ):
                        track_attempted = True
                        pending_track_advance = _advance_prefetch_tracking(
                            frame,
                            tracking_state,
                            detect_interval,
                            require_all_observed=False,
                            commit=False,
                            return_advance=True,
                            frame_evidence=frame_evidence,
                            media_time_seconds=(
                                temporal_context.get("mediaTimeSeconds")
                                if temporal_context is not None
                                else None
                            ),
                        )
                        if isinstance(pending_track_advance, LandmarkTrackAdvance):
                            raw_kps = pending_track_advance.evidence.points
                            kps = pending_track_advance.points
                            proposed_pose = pending_track_advance.pose
                        else:
                            track_failed = True
                    elif (
                        prior_kps is not None
                        and prior_gray is not None
                        and (
                            bool(
                                effective_config["runtime"].get(
                                    "temporalDetectorLkFusionEnabled",
                                    False,
                                )
                            )
                            or bool(
                                effective_config["runtime"].get(
                                    "temporalDetectorShapeContinuityEnabled",
                                    False,
                                )
                            )
                        )
                    ):
                        # A scheduled detector/identity frame still gets a
                        # same-frame LK prediction. It is never committed as
                        # raw tracking state; it can only preserve local feature
                        # geometry after the detector supplies absolute pose.
                        if frame_evidence.lk_flow_prepared:
                            prediction_evidence = frame_evidence.lk_flow_evidence
                        else:
                            prediction_evidence = _track_landmarks_lk(
                                prior_gray,
                                current_gray,
                                np.asarray(prior_kps, dtype=np.float32),
                                frame.shape,
                                return_evidence=True,
                            )
                        if isinstance(prediction_evidence, LandmarkTrackEvidence):
                            detector_lk_prediction = (
                                _transport_render_correction_with_lk(
                                    prior_kps,
                                    tracking_state.get("kps"),
                                    prediction_evidence.points,
                                )
                            )
                if kps is None:
                    if tracking_state is not None and track_attempted and track_failed:
                        # A detector observation may still be geometrically
                        # continuous with the active target. Force dependent
                        # stages exact, but preserve the pose long enough to
                        # evaluate that same-frame handoff.
                        if temporal_context is not None:
                            temporal_context["forceExact"] = True
                            force_reasons = temporal_context.setdefault(
                                "forceExactReasons", []
                            )
                            if "lk-failure" not in force_reasons:
                                force_reasons.append("lk-failure")
                    stable_identity_anchor = (
                        tracking_state.get("targetIdentityAnchor")
                        if tracking_state is not None else None
                    )
                    selection_anchor = anchor
                    if stable_identity_anchor is not None:
                        try:
                            stable_values = np.asarray(
                                stable_identity_anchor, dtype=np.float32
                            ).reshape(-1)
                            prior_values = np.asarray(prior_kps, dtype=np.float32).reshape(5, 2)
                            has_valid_prior = bool(np.isfinite(prior_values).all())
                            if (
                                stable_values.size > 0
                                and np.isfinite(stable_values).all()
                                and (selection_anchor is None or not has_valid_prior)
                            ):
                                selection_anchor = stable_values
                        except (TypeError, ValueError):
                            pass
                    detected_kps, anchor = self._choose_target(
                        img_chw,
                        selection_anchor,
                        # A failed geometric track is exactly where an adjacent
                        # person could otherwise inherit the swap.  Re-identify
                        # immediately and fail closed on ambiguity. Successful
                        # tracks retain the configured sparse verification cadence.
                        # A Face Detect tap is an identity lock, not a moving
                        # screen coordinate. Once acquired, every exact
                        # detector frame re-associates against that recognized
                        # identity instead of geometry that can cross people.
                        verify_identity=(
                            verify_identity
                            or track_failed
                            or bool(
                                tracking_state is not None
                                and tracking_state.get("manualTargetIdentityLock")
                            )
                        ),
                        config=effective_config,
                        prior_kps=(
                            tracking_state.get("rawKps", tracking_state.get("kps"))
                            if tracking_state is not None
                            else None
                        ),
                        frame_shape=frame.shape if isinstance(frame, np.ndarray) else None,
                        frame_evidence=frame_evidence,
                        frame_rgb=(frame if isinstance(frame, np.ndarray) else None),
                        required_presentation=(
                            tracking_state.get("targetPresentation")
                            if tracking_state is not None
                            else None
                        ),
                        manual_target_point=(
                            manual_target_point if selection_anchor is None else None
                        ),
                        allow_anchor_adaptation=bool(
                            tracking_state is not None
                            and not tracking_state.get("manualTargetIdentityLock")
                        ),
                        reacquisition_anchors=(
                            tracking_state.get("targetIdentityGallery", ())
                            if tracking_state is not None else ()
                        ),
                    )
                    if (verify_identity and tracking_state is not None
                            and frame_evidence.recognition_complete
                            and frame_evidence.selected_target_embedding is not None
                            and effective_config['runtime'].get('temporalVerifiedIdentityRefreshReuseEnabled', False)):
                        _release_verified_identity_deadline(
                            temporal_context,
                            tracking_state.get('rawKps', tracking_state.get('kps')),
                            detected_kps, frame_evidence.selected_target_similarity,
                            temporal_context.get('nominalFrameSeconds', 0.0) if temporal_context else 0.0,
                        )
                    if (
                        tracking_state is not None
                        and frame_evidence.selected_target_embedding is not None
                        and frame_evidence.selected_target_similarity is not None
                        and frame_evidence.selected_target_similarity
                            >= target_identity_lock_threshold(
                                effective_config["parameters"].get(
                                    "DetectScoreSlider", 45
                                )
                            )
                    ):
                        gallery = tracking_state.setdefault(
                            "targetIdentityGallery", []
                        )
                        observed_identity = np.asarray(
                            frame_evidence.selected_target_embedding,
                            dtype=np.float32,
                        ).reshape(-1).copy()
                        if (
                            observed_identity.size > 0
                            and np.isfinite(observed_identity).all()
                            and not any(
                                rope_similarity(observed_identity, item) >= 90.0
                                for item in gallery
                            )
                        ):
                            if len(gallery) >= 12:
                                del gallery[1]
                            gallery.append(observed_identity)
                    if track_failed and temporal_context is not None:
                        recovered = bool(
                            effective_config['runtime'].get('temporalRestorerDetectorRecoveryEnabled', False)
                            and temporal_context.get('correctionLocalGuardEnabled', False)
                            and _restorer_detector_recovery_is_safe(
                                prior_kps, detected_kps,
                                frame_evidence.selected_target_similarity,
                                temporal_context.get('nominalFrameSeconds', 0.0),
                            )
                        )
                        temporal_context['restorerDetectorRecoveryConfirmed'] = recovered
                        if not recovered:
                            temporal_context.pop('restorerAnchor', None)
                        mask_recovered = recovered and effective_config['runtime'].get(
                            'temporalMaskDetectorRecoveryEnabled', False,
                        )
                        if mask_recovered:
                            # The current detector/recognizer recovered the
                            # track. Each stage still applies its own canonical
                            # appearance, occlusion and elapsed-age gates; no
                            # history is made valid merely by detector ordering.
                            reasons = [r for r in temporal_context.get('forceExactReasons', []) if r != 'lk-failure']
                            temporal_context['forceExactReasons'] = reasons
                            temporal_context['forceExact'] = bool(reasons)
                        else:
                            for state_key in ('occluderAnchor', 'faceParserAnchor'):
                                temporal_context.pop(state_key, None)
                    # No still-pose fallback when both detector and optical
                    # flow fail: old coordinates are not evidence that the
                    # same face remains under those pixels.
                    if (
                        detected_kps is None
                        and detector_lk_prediction is not None
                        and anchor is not None
                        and tracking_state is not None
                    ):
                        # Brief, elapsed-time-bounded grace requires a valid
                        # current-frame optical-flow observation, never a
                        # frozen previous pose or a new detector index.
                        identity_grace = int(
                            tracking_state.get("identityGraceFrames", 0)
                        )
                        grace_points = np.asarray(
                            detector_lk_prediction,
                            dtype=np.float32,
                        ).reshape(-1, 2)
                        if (
                            identity_grace < max(1, int(round(
                                0.20 / max(1e-3, float(
                                    (temporal_context or {}).get("nominalFrameSeconds", 1.0 / 30.0)
                                ))
                            )))
                            and grace_points.shape == (5, 2)
                            and np.isfinite(grace_points).all()
                        ):
                            detected_kps = grace_points
                            tracking_state["identityGraceFrames"] = identity_grace + 1
                            if frame_evidence is not None:
                                frame_evidence.selected_target_similarity = (
                                    target_identity_continuity_threshold()
                                )
                                frame_evidence.rejection_reasons.append(
                                    "target-identity-lk-grace"
                                )
                    elif detected_kps is not None and tracking_state is not None:
                        tracking_state["identityGraceFrames"] = 0
                    # Baseline 1.7: short occlusion bridge. When BOTH the
                    # detector and optical flow lose an already-locked face
                    # for a moment (hair whipping across the nose, a hand or a
                    # cone), the frame used to flash back to the original face.
                    # Carry the last observed motion forward for at most
                    # ~0.15 s instead. Never bridges when the detector sees any
                    # face where the prediction lands (a different person or a
                    # rejected candidate), and never starts without a lock.
                    if detected_kps is None:
                        import os as _debug_os
                        _debug_path = _debug_os.environ.get("PONG_BRIDGE_DEBUG_PATH", "")
                    if detected_kps is None and _debug_path:
                        import json as _debug_json
                        try:
                            with open(_debug_path, "a", encoding="utf-8") as debug_log:
                                debug_log.write(_debug_json.dumps({
                                    "frame": (temporal_context or {}).get("frameIndex"),
                                    "anchor": anchor is not None,
                                    "tracking": tracking_state is not None,
                                    "trackFailed": bool(track_failed),
                                    "lkPrediction": detector_lk_prediction is not None,
                                    "reasons": list(getattr(frame_evidence, "rejection_reasons", []) or []),
                                    "detections": len(getattr(frame_evidence, "detections", ()) or ()),
                                    "lastKps": tracking_state.get("kps") is not None if tracking_state is not None else None,
                                }) + "\n")
                        except Exception:
                            pass
                    if (
                        detected_kps is None
                        and anchor is not None
                        and tracking_state is not None
                        and bool(effective_config["runtime"].get("targetOcclusionBridgeEnabled", True))
                    ):
                        bridge_frames = int(tracking_state.get("occlusionBridgeFrames", 0))
                        nominal_seconds = float(
                            (temporal_context or {}).get("nominalFrameSeconds", 1.0 / 30.0)
                        ) or (1.0 / 30.0)
                        bridge_limit = max(1, int(round(float(
                            effective_config["runtime"].get("targetOcclusionBridgeSeconds", 0.15)
                        ) / max(1e-3, nominal_seconds))))
                        try:
                            last_kps = np.asarray(tracking_state.get("kps"), dtype=np.float32).reshape(5, 2)
                        except (TypeError, ValueError):
                            last_kps = None
                        if (
                            bridge_frames < bridge_limit
                            and last_kps is not None
                            and np.isfinite(last_kps).all()
                        ):
                            span = max(1.0, _landmark_span(last_kps))
                            velocity = np.zeros_like(last_kps)
                            try:
                                before_kps = np.asarray(
                                    tracking_state.get("bridgePrevKps"), dtype=np.float32
                                ).reshape(5, 2)
                                if np.isfinite(before_kps).all():
                                    velocity = last_kps - before_kps
                            except (TypeError, ValueError):
                                pass
                            speed = float(np.median(np.linalg.norm(velocity, axis=1)))
                            if speed > 0.15 * span:
                                velocity *= (0.15 * span) / speed
                            predicted = last_kps + velocity
                            center = predicted.mean(axis=0)
                            # A face found at the predicted spot but rejected
                            # only for landmark geometry is the occluded target
                            # itself (hair/hands distort its points). Block the
                            # bridge when an identity check rejected a nearby
                            # face, or when several faces crowd the spot.
                            reasons = set(getattr(frame_evidence, "rejection_reasons", []) or [])
                            identity_rejected = any(
                                r.startswith("target-identity") or r.startswith("target-appearance")
                                for r in reasons
                            )
                            nearby = 0
                            for _area, other_kps, _embedding in tuple(
                                getattr(frame_evidence, "detections", ()) or ()
                            ):
                                try:
                                    other = np.asarray(other_kps, dtype=np.float32).reshape(5, 2)
                                except (TypeError, ValueError):
                                    continue
                                if float(np.linalg.norm(other.mean(axis=0) - center)) < span:
                                    nearby += 1
                            crowded = nearby > 1 or (nearby == 1 and identity_rejected)
                            if not crowded:
                                detected_kps = predicted
                                tracking_state["occlusionBridgeFrames"] = bridge_frames + 1
                                if frame_evidence is not None:
                                    frame_evidence.rejection_reasons.append(
                                        "target-occlusion-bridge"
                                    )
                    elif detected_kps is not None and tracking_state is not None:
                        tracking_state["occlusionBridgeFrames"] = 0
                    if (
                        detected_kps is not None
                        and tracking_state is not None
                        and os.environ.get("PONG_LANDMARK_GUARD", "1") != "0"
                    ):
                        # Baseline 1.12: repair detector guesses for covered
                        # face parts (hands, food, hair, objects) before they
                        # reach the LK fusion and the swap alignment.
                        from pong_landmark_guard import LandmarkGuard
                        guard = tracking_state.get("landmarkGuard")
                        now = time.monotonic()
                        if (
                            guard is None
                            or now - float(tracking_state.get("landmarkGuardSeenAt", 0.0)) > 1.0
                        ):
                            guard = tracking_state["landmarkGuard"] = LandmarkGuard()
                        tracking_state["landmarkGuardSeenAt"] = now
                        detected_points = np.asarray(detected_kps, dtype=np.float32).reshape(5, 2)
                        detected_kps = guard.observe(
                            detected_points,
                            getattr(self, "_detect_score_lookup", {}).get(
                                detected_points.tobytes()
                            ),
                        )
                        if detected_kps is None and frame_evidence is not None:
                            frame_evidence.rejection_reasons.append("landmark-guard-hold")
                    if detected_kps is not None and tracking_state is not None:
                        raw_kps = np.asarray(detected_kps, dtype=np.float32)
                        if detector_lk_prediction is not None:
                            if bool(
                                effective_config["runtime"].get(
                                    "temporalDetectorShapeContinuityEnabled",
                                    False,
                                )
                            ):
                                kps = _reconcile_detector_pose_with_lk_shape(
                                    raw_kps,
                                    detector_lk_prediction,
                                    detector_detail_weight=float(
                                        effective_config["runtime"].get(
                                            "temporalDetectorShapeContinuityWeight",
                                            0.20,
                                        )
                                    ),
                                    max_local_residual_ratio=float(
                                        effective_config["runtime"].get(
                                            "temporalDetectorShapeContinuityMaxResidualRatio",
                                            0.05,
                                        )
                                    ),
                                )
                            else:
                                kps = _fuse_detector_with_lk_prediction(
                                    raw_kps,
                                    detector_lk_prediction,
                                    minimum_detector_gain=float(
                                        effective_config["runtime"].get(
                                            "temporalDetectorLkFusionWeight",
                                            0.5,
                                        )
                                    ),
                                    high_innovation_ratio=float(
                                        effective_config["runtime"].get(
                                            "temporalDetectorLkFusionMaxResidualRatio",
                                            0.02,
                                        )
                                    ),
                                )
                        else:
                            # Detector observations remain the absolute
                            # authority whenever no strictly valid same-frame
                            # prediction exists.
                            kps = raw_kps
                    else:
                        kps = detected_kps
                    if tracking_state is not None:
                        tracking_state["sinceDetect"] = 1
                        tracking_state["rawKps"] = (
                            None if raw_kps is None else np.asarray(raw_kps, dtype=np.float32)
                        )
                        if kps is None and not track_generation_invalidated:
                            tracking_state["trackGeneration"] = int(
                                tracking_state.get("trackGeneration", 0)
                            ) + 1
                            tracking_state.pop("renderPose", None)
                            if temporal_context is not None:
                                for state_key in (
                                    "restorerAnchor",
                                    "occluderAnchor",
                                    "faceParserAnchor",
                                    "spatialExactBlendRecentTriggerFrames",
                                    "spatialExactBlendBurstUntilFrame",
                                    "spatialExactBlendLastTriggerFrame",
                                    "spatialExactBlendLastObservedFrame",
                                ):
                                    temporal_context.pop(state_key, None)
                                temporal_context["forceExact"] = True
                                force_reasons = temporal_context.setdefault(
                                    "forceExactReasons", []
                                )
                                if "target-loss" not in force_reasons:
                                    force_reasons.append("target-loss")
                if tracking_state is not None:
                    if isinstance(pending_track_advance, LandmarkTrackAdvance):
                        _commit_tracking_advance(tracking_state, pending_track_advance)
                    else:
                        if proposed_pose is not None:
                            tracking_state["renderPose"] = proposed_pose
                        if raw_kps is not None:
                            tracking_state["trackRevision"] = int(
                                tracking_state.get("trackRevision", 0)
                            ) + 1
                    # Baseline 1.7: previous pose for the occlusion bridge's
                    # one-frame motion estimate.
                    tracking_state["bridgePrevKps"] = tracking_state.get("kps")
                    tracking_state["kps"] = (
                        None if kps is None else np.asarray(kps, dtype=np.float32)
                    )
                    if current_gray is not None:
                        tracking_state["gray"] = current_gray
                mark_cuda("target")
                if tracking_lookahead is not None and tracking_state is not None:
                    tracking_lookahead.prepare(tracking_state, next_frame)
                adaptive_mask_backend = None
                if kps is not None:
                    if effective_config["parameters"].get("RestorerSwitch"):
                        self._vm.parameters["RestorerTypeTextSel"] = select_restorer(effective_config, kps)
                    adaptive_mask_backend = _selected_adaptive_mask_backend(
                        effective_config["runtime"], tracking_state
                    )
                    default_mask_backend = (
                        adaptive_mask_backend
                        or str(
                            effective_config["runtime"].get(
                                "maskBackendPreference", "cuda"
                            )
                        ).lower()
                    )
                    occluder_backend = str(
                        effective_config["runtime"].get(
                            "maskOccluderBackendPreference", "inherit"
                        )
                    ).lower()
                    face_parser_backend = str(
                        effective_config["runtime"].get(
                            "maskFaceParserBackendPreference", "inherit"
                        )
                    ).lower()
                    occluder_backend = (
                        occluder_backend
                        if occluder_backend in {"cuda", "trt"}
                        else default_mask_backend
                    )
                    face_parser_backend = (
                        face_parser_backend
                        if face_parser_backend in {"cuda", "trt"}
                        else default_mask_backend
                    )
                    mask_backend_selection = {
                        "occluder": occluder_backend,
                        # Models._get_mask_session uses the canonical lowercase
                        # family name ``faceparser``.  A mixed-case key silently
                        # fell back to the global CUDA preference and produced
                        # an unintended TRT-occluder/CUDA-parser pipeline.
                        "faceparser": face_parser_backend,
                    }
                    prior_mask_backend = self._models._mask_runtime_backend
                    self._models._mask_runtime_backend = mask_backend_selection
                    if temporal_context is not None:
                        temporal_context["adaptiveMaskMotionClass"] = (
                            adaptive_mask_backend or "unclassified"
                        )
                        temporal_context["maskRuntimeBackend"] = (
                            f"occluder:{occluder_backend}|faceParser:{face_parser_backend}"
                        )
                        temporal_context["maskOccluderRuntimeBackend"] = occluder_backend
                        temporal_context["maskFaceParserRuntimeBackend"] = face_parser_backend
                    if adaptive_mask_backend is not None:
                        if diagnostics is not None:
                            diagnostics.setdefault(
                                f"maskAdaptiveBackend.{adaptive_mask_backend}", []
                            ).append(1.0)
                    try:
                        img_chw = self._vm.swap_core(
                            img_chw,
                            kps,
                            source_embedding,
                            self._vm.parameters,
                            self._vm.control,
                            slot=None,
                            source_frame=source_frame,
                            diagnostics=diagnostics,
                            temporal_context=temporal_context,
                        )
                    finally:
                        self._models._mask_runtime_backend = prior_mask_backend
                mark_cuda("swap")
                img_chw = self._enhance_frame(img_chw, kps, effective_config)
                if adaptive_mask_backend == "trt":
                    img_chw = self._micro_sharpen_face_roi(
                        img_chw,
                        kps,
                        float(
                            effective_config["runtime"].get(
                                "maskTrtPostSharpenAmount", 0.0
                            )
                        ),
                    )
                    img_chw = self._sparse_edge_boost_face_roi(
                        img_chw,
                        kps,
                        float(
                            effective_config["runtime"].get(
                                "maskTrtSparseEdgeBoostThreshold", 0.0
                            )
                        ),
                    )
                result = img_chw.permute(1, 2, 0).to(torch.uint8).contiguous()
                mark_cuda("output")
            # The caller downloads/encodes ``result`` immediately, commonly
            # from a different/default stream. Retain one frame-boundary wait
            # for correctness while removing the old per-model host fences.
            compute_stream.synchronize()
            if diagnostics is not None and len(cuda_marks) >= 2:
                for (prior_name, prior_event), (name, event) in zip(cuda_marks, cuda_marks[1:]):
                    diagnostics.setdefault(f"cuda_{prior_name}_to_{name}Ms", []).append(
                        float(prior_event.elapsed_time(event))
                    )
            if diagnostics is not None:
                swap_events = diagnostics.pop("_swapCudaEvents", [])
                for (prior_name, prior_event), (name, event) in zip(swap_events, swap_events[1:]):
                    diagnostics.setdefault(f"cuda_swap_{prior_name}_to_{name}Ms", []).append(
                        float(prior_event.elapsed_time(event))
                    )
            self._last_used = time.time()
        if diagnostics is not None:
            diagnostics.setdefault("frameWallMs", []).append((time.perf_counter() - frame_wall_started) * 1000.0)
        return result, anchor

    def _process_frame_to_rgb(
        self,
        frame: Any,
        source_embedding: np.ndarray,
        anchor: np.ndarray | None,
        **kwargs,
    ) -> tuple[np.ndarray | None, np.ndarray | None]:
        """Run the exact frame path and download it on the GPU owner thread."""
        swapped, updated_anchor = self.process_frame(
            frame,
            source_embedding,
            anchor,
            **kwargs,
        )
        if swapped is None:
            return None, updated_anchor
        return swapped.cpu().numpy(), updated_anchor

    def _micro_sharpen_face_roi(self, image, kps, amount: float):
        """Apply a tiny post-composite correction without touching masks.

        The operation stays on the active CUDA stream and is confined to a
        bounded face region.  A zero amount is an exact no-op.
        """
        strength = max(0.0, float(amount))
        if strength <= 0.0 or kps is None:
            return image
        try:
            points = np.asarray(kps, dtype=np.float32).reshape(5, 2)
        except (TypeError, ValueError):
            return image
        if not np.isfinite(points).all():
            return image
        height, width = int(image.shape[-2]), int(image.shape[-1])
        span = max(8.0, _landmark_span(points))
        center = (points.min(axis=0) + points.max(axis=0)) * 0.5
        side = max(24, int(round(span * 3.2)))
        left = max(0, int(round(float(center[0]) - side * 0.5)))
        top = max(0, int(round(float(center[1]) - side * 0.52)))
        right = min(width, left + side)
        bottom = min(height, top + side)
        if right - left < 8 or bottom - top < 8:
            return image
        result = image.clone()
        region = result[:, top:bottom, left:right].to(self._torch.float32)
        padded = self._torch.nn.functional.pad(
            region.unsqueeze(0), (1, 1, 1, 1), mode="replicate"
        )
        low = self._torch.nn.functional.avg_pool2d(padded, 3, stride=1)[0]
        result[:, top:bottom, left:right].copy_(
            (region + (region - low) * strength).clamp_(0.0, 255.0)
        )
        return result

    def _sparse_edge_boost_face_roi(self, image, kps, threshold: float):
        """Move only strong central face edges by one integer level.

        The prior fractional sharpener wrote into uint8 storage, so strengths
        below half a level were exact no-ops and the first effective setting
        changed too many pixels.  This bounded correction is intentionally
        discrete: it preserves flat regions and the outer blend boundary while
        recovering only one lost quantization level at stable local edges.
        """
        minimum = max(0.0, float(threshold))
        if minimum <= 0.0 or kps is None:
            return image
        try:
            points = np.asarray(kps, dtype=np.float32).reshape(5, 2)
        except (TypeError, ValueError):
            return image
        if not np.isfinite(points).all():
            return image
        height, width = int(image.shape[-2]), int(image.shape[-1])
        span = max(8.0, _landmark_span(points))
        center = (points.min(axis=0) + points.max(axis=0)) * 0.5
        side = max(20, int(round(span * 2.35)))
        left = max(0, int(round(float(center[0]) - side * 0.5)))
        top = max(0, int(round(float(center[1]) - side * 0.52)))
        right = min(width, left + side)
        bottom = min(height, top + side)
        if right - left < 8 or bottom - top < 8:
            return image
        # This is the terminal operation before the frame is converted to HWC;
        # the composite is uniquely owned here, so avoid a 720p full-frame copy.
        result = image
        region = result[:, top:bottom, left:right].to(self._torch.float32)
        padded = self._torch.nn.functional.pad(
            region.unsqueeze(0), (1, 1, 1, 1), mode="replicate"
        )
        low = self._torch.nn.functional.avg_pool2d(padded, 3, stride=1)[0]
        high = region - low
        region_height, region_width = int(region.shape[-2]), int(region.shape[-1])
        yy = (
            self._torch.arange(region_height, device=region.device, dtype=self._torch.float32)
            + 0.5
        ) / float(region_height)
        xx = (
            self._torch.arange(region_width, device=region.device, dtype=self._torch.float32)
            + 0.5
        ) / float(region_width)
        # Preserve the central semantic-feature ellipse exactly.  The sparse
        # correction belongs to hair/forehead/outer-cheek texture, where one
        # recovered level can improve perceived detail without moving the
        # eyes, nose, or mouth used by temporal attachment diagnostics.
        central = (
            ((xx[None, :] - 0.5) / 0.33).square()
            + ((yy[:, None] - 0.52) / 0.39).square()
        ) <= 1.0
        outer = (~central).unsqueeze(0)
        correction = (
            self._torch.sign(high)
            * (self._torch.abs(high) >= minimum)
            * outer
        )
        result[:, top:bottom, left:right].copy_(
            (region + correction).clamp_(0.0, 255.0).to(self._torch.uint8)
        )
        return result

    @staticmethod
    def _frame_preview_tracking_profile(config: dict[str, Any]) -> str:
        """Identify controls which invalidate fixed-frame landmark reuse."""
        parameters = config.get("parameters") or {}
        runtime = config.get("runtime") or {}
        values = {
            name: parameters.get(name)
            for name in (
                "DetectTypeTextSel",
                "DetectInputSizeTextSel",
                "DetectScoreSlider",
                "ThresholdSlider",
                "LandmarkDetectTypeTextSel",
                "LandmarkDetectAdjustSlider",
            )
        }
        values["maximumFaces"] = runtime.get("maximumFaces")
        return json.dumps(values, sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _decode_frame_preview_source(source_url: str, start_seconds: float) -> np.ndarray:
        import av

        container = av.open(source_url, timeout=(10.0, 5.0))
        try:
            stream = highest_quality_video_stream(container)
            if stream is None:
                raise ValueError("source URL has no decodable video stream")
            start = max(0.0, float(start_seconds or 0.0))
            if start > 0 and stream.time_base:
                container.seek(
                    int(start / float(stream.time_base)),
                    stream=stream,
                    backward=True,
                    any_frame=False,
                )
            fallback = None
            frame_duration = 1.0 / max(
                1.0,
                float(stream.average_rate or stream.base_rate or 30.0),
            )
            for decoded in container.decode(stream):
                rgb = decoded.to_ndarray(format="rgb24")
                fallback = rgb
                if decoded.pts is None or not stream.time_base:
                    return np.ascontiguousarray(rgb)
                timestamp = float(decoded.pts * stream.time_base)
                if timestamp + frame_duration >= start:
                    return np.ascontiguousarray(rgb)
            if fallback is not None:
                return np.ascontiguousarray(fallback)
            raise ValueError("source URL did not yield a decodable video frame")
        finally:
            container.close()

    @staticmethod
    def _validate_frame_preview(frame: np.ndarray) -> np.ndarray:
        if frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError("captured frame must be an RGB image")
        height, width = int(frame.shape[0]), int(frame.shape[1])
        if width < 1 or height < 1 or width > 4096 or height > 4096:
            raise ValueError("captured frame dimensions must be within 4096x4096")
        contiguous = np.ascontiguousarray(frame, dtype=np.uint8)
        if contiguous.nbytes > 64 * 1024 * 1024:
            raise ValueError("decoded captured frame must contain at most 64 MiB")
        return contiguous

    def _prune_frame_previews(
        self,
        *,
        maximum: int = 6,
        maximum_bytes: int = 64 * 1024 * 1024,
        ttl_seconds: float = 600.0,
    ) -> None:
        now = time.time()
        with self._frame_previews_lock:
            stale = [
                preview_id
                for preview_id, preview in self._frame_previews.items()
                if now - preview.last_used_at > ttl_seconds
            ]
            for preview_id in stale:
                self._frame_previews.pop(preview_id, None)
            overflow = max(0, len(self._frame_previews) - maximum)
            if overflow:
                oldest = sorted(
                    self._frame_previews.values(),
                    key=lambda preview: preview.last_used_at,
                )[:overflow]
                for preview in oldest:
                    self._frame_previews.pop(preview.id, None)
            total_bytes = sum(
                int(preview.frame.nbytes)
                for preview in self._frame_previews.values()
            )
            if total_bytes > maximum_bytes:
                for preview in sorted(
                    self._frame_previews.values(),
                    key=lambda item: item.last_used_at,
                ):
                    if total_bytes <= maximum_bytes:
                        break
                    removed = self._frame_previews.pop(preview.id, None)
                    if removed is not None:
                        total_bytes -= int(removed.frame.nbytes)

    def create_frame_preview(
        self,
        *,
        source_url: str,
        face_id: str,
        start_seconds: float,
    ) -> FramePreview:
        parsed = urlparse(source_url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("sourceUrl must be an HTTP(S) Pong playback URL")
        self.face(face_id)
        frame = self._validate_frame_preview(
            self._decode_frame_preview_source(source_url, start_seconds)
        )
        preview = FramePreview(
            id=uuid.uuid4().hex,
            source_url=source_url,
            face_id=face_id,
            start_seconds=max(0.0, float(start_seconds or 0.0)),
            frame=frame,
        )
        with self._frame_previews_lock:
            self._frame_previews[preview.id] = preview
        self._prune_frame_previews()
        return preview

    def create_frame_preview_from_encoded(
        self,
        *,
        encoded: bytes,
        source_url: str,
        face_id: str,
        start_seconds: float,
        geometry_only: bool = False,
    ) -> FramePreview:
        if not encoded or len(encoded) > 20 * 1024 * 1024:
            raise ValueError("captured frame must contain at most 20 MiB")
        self.face(face_id)
        bgr = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
        if bgr is None or bgr.size == 0:
            raise ValueError("captured frame could not be decoded")
        frame = self._validate_frame_preview(
            cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        )
        preview = FramePreview(
            id=uuid.uuid4().hex,
            source_url=source_url,
            face_id=face_id,
            start_seconds=max(0.0, float(start_seconds or 0.0)),
            frame=frame,
            geometry_only=bool(geometry_only),
        )
        with self._frame_previews_lock:
            self._frame_previews[preview.id] = preview
        self._prune_frame_previews()
        return preview

    def frame_preview(self, preview_id: str) -> FramePreview:
        with self._frame_previews_lock:
            preview = self._frame_previews.get(preview_id)
        if preview is None:
            raise KeyError("frame preview was not found")
        preview.last_used_at = time.time()
        return preview

    def frame_preview_original(self, preview_id: str) -> tuple[bytes, str]:
        """Encode the untouched source frame retained for the live editor."""
        preview = self.frame_preview(preview_id)
        bgr = cv2.cvtColor(np.ascontiguousarray(preview.frame), cv2.COLOR_RGB2BGR)
        ok, encoded = cv2.imencode(
            ".webp",
            bgr,
            [int(cv2.IMWRITE_WEBP_QUALITY), 94],
        )
        media_type = "image/webp"
        if not ok:
            ok, encoded = cv2.imencode(
                ".jpg",
                bgr,
                [int(cv2.IMWRITE_JPEG_QUALITY), 95],
            )
            media_type = "image/jpeg"
        if not ok:
            raise RuntimeError("could not encode the original frame preview")
        return encoded.tobytes(), media_type

    def frame_preview_faces(self, preview_id: str) -> list[dict[str, Any]]:
        """Return normalized tappable bounds for every face in the frozen frame."""
        preview = self.frame_preview(preview_id)
        params = self._config['parameters']
        profile = json.dumps([params.get('DetectTypeTextSel'), params.get('DetectInputSizeTextSel'),
                              self._target_detection_score(), preview.geometry_only])
        with preview.lock:
            if preview.detected_faces is not None and preview.detection_profile == profile:
                return deepcopy(preview.detected_faces)
            preview.recovered_indices.clear()
            faces = self._frame_preview_faces_uncached(preview)
            preview.detection_token = uuid.uuid4().hex
            for face in faces:
                face['detectionToken'] = preview.detection_token
            preview.detected_faces = deepcopy(faces)
            preview.detection_profile = profile
            return faces

    def _frame_preview_faces_uncached(self, preview: FramePreview) -> list[dict[str, Any]]:
        self._run_gpu_work(self.warm, priority=0, work_label="face-detect-warm")

        def detect() -> list[tuple[float, np.ndarray, np.ndarray | None]]:
            with self._lock:
                stream = self._compute_stream
                if stream is None:
                    raise RuntimeError("Pong Swap CUDA stream is not initialized")
                with self._torch.cuda.stream(stream):
                    tensor = self._frame_tensor(preview.frame)
                    # Manual boxes get one permissive pass. Original frames
                    # additionally establish which detections need recovery;
                    # recognition runs exactly once per final original face.
                    rows = self._detect(tensor, recognize=not preview.geometry_only,
                                        max_faces=10, detector_score=DetectionCalibration.MINIMUM)
                    if not preview.geometry_only:
                        primary = self._detect(tensor, recognize=False, max_faces=10,
                                               detector_score=self._target_detection_score())
                        for index, (_, points, _) in enumerate(rows):
                            scale = max(12.0, float(np.ptp(points[:, 0])), float(np.ptp(points[:, 1])))
                            if not any(float(np.linalg.norm(points - p, axis=1).mean()) / scale < 0.15
                                       for _, p, _ in primary):
                                preview.recovered_indices.add(index)
                stream.synchronize()
                return rows

        detected = self._run_gpu_work(
            detect,
            priority=0,
            work_label="frame-preview-face-detect",
        )
        height, width = preview.frame.shape[:2]
        faces: list[dict[str, Any]] = []
        for index, (_area, keypoints, embedding) in enumerate(detected):
            points = np.asarray(keypoints, dtype=np.float32).reshape(-1, 2)
            identity_embedding = np.asarray(embedding if embedding is not None else [], dtype=np.float32).reshape(-1)
            if (
                points.shape != (5, 2)
                or not np.isfinite(points).all()
                or (not preview.geometry_only and (not identity_embedding.size or not np.isfinite(identity_embedding).all()))
            ):
                continue
            presentation = FacePresentation("unknown", 0.0)
            if not preview.geometry_only:
                try:
                    presentation = self._presentation_classifier.classify(preview.frame, points)
                except Exception:
                    pass
            landmark_width = max(12.0, float(np.ptp(points[:, 0])))
            landmark_height = max(12.0, float(np.ptp(points[:, 1])))
            box_width = max(40.0, landmark_width * 2.15)
            box_height = max(48.0, landmark_height * 2.65)
            center_x = float(np.mean(points[:, 0]))
            center_y = float(np.mean(points[:, 1])) - box_height * 0.08
            left = max(0.0, center_x - box_width * 0.5)
            top = max(0.0, center_y - box_height * 0.5)
            right = min(float(width), center_x + box_width * 0.5)
            bottom = min(float(height), center_y + box_height * 0.5)
            faces.append(
                {
                    "index": index,
                    "geometryOnly": preview.geometry_only,
                    "learningSupported": not preview.geometry_only,
                    "x": left / max(1.0, float(width)),
                    "y": top / max(1.0, float(height)),
                    "width": max(0.0, right - left) / max(1.0, float(width)),
                    "height": max(0.0, bottom - top) / max(1.0, float(height)),
                    "centerX": center_x / max(1.0, float(width)),
                    "centerY": float(np.mean(points[:, 1])) / max(1.0, float(height)),
                    # The app keeps this memory-only descriptor with the video
                    # source and sends it back for every seek/replay session.
                    # It is the selected person, independent of face numbering
                    # or where that person moves in later frames.
                    "identityEmbedding": [] if preview.geometry_only else identity_embedding.tolist(),
                    "presentation": {
                        "label": presentation.label,
                        "confidence": float(presentation.confidence),
                        "appearance": list(presentation.appearance),
                    },
                }
            )
        return faces

    def confirm_detected_face(self, preview_id: str, index: int, token: str = '') -> dict[str, Any]:
        preview = self.frame_preview(preview_id)
        with preview.lock:
            if preview.geometry_only:
                raise ValueError('Displayed swap geometry cannot train original-person detection')
            if not token or token != preview.detection_token:
                raise ValueError('Detection changed; confirm a current original-frame box')
            # Require the exact cached detection that the user actually tapped.
            selected = next((face for face in (preview.detected_faces or []) if face['index'] == index), None)
            if selected is None or not selected.get('identityEmbedding'):
                raise ValueError('Confirm a detected original face first')
            return self._detection_calibration.confirm(preview.source_url,
                                                       recovered=index in preview.recovered_indices)

    def confirm_match_feedback(self, preview_id: str, index: int, token: str, face_id: str) -> dict[str, Any]:
        self.face(face_id)  # Must still be an approved, existing source.
        preview = self.frame_preview(preview_id)
        with preview.lock:
            if preview.geometry_only or not token or token != preview.detection_token:
                raise ValueError('Confirm a current original-frame detection first')
            face = next((f for f in (preview.detected_faces or []) if f['index'] == index), None)
            if not face or not face.get('identityEmbedding'):
                raise ValueError('The detected original face is no longer available')
            p = face.get('presentation') or {}
            presentation = FacePresentation(p.get('label', 'unknown'), float(p.get('confidence', 0)))
            if not approved_source_allows_target(face_id, presentation):
                raise ValueError('Match blocked: uncertain target, or male target without Approved 18')
            return MATCH_FEEDBACK.confirm(token, index, face_id, face['identityEmbedding'])

    def render_frame_preview(
        self,
        preview_id: str,
        config: dict[str, Any],
        face_id: str | None = None,
        manual_target_x: float | None = None,
        manual_target_y: float | None = None,
    ) -> tuple[bytes, str, float]:
        if self.frame_preview(preview_id).geometry_only:
            raise ValueError('Geometry-only display frames cannot be used as swap originals')
        # A fixed-frame edit is a live consumer of the selected graph even while
        # it waits between warm, embedding and render stages. Lifecycle changes
        # must not unload the graph in those gaps.
        with self._frame_previews_lock:
            self._frame_preview_render_leases += 1
        try:
            return self._render_frame_preview(
                preview_id,
                config,
                face_id,
                manual_target_x,
                manual_target_y,
            )
        finally:
            with self._frame_previews_lock:
                self._frame_preview_render_leases = max(
                    0,
                    self._frame_preview_render_leases - 1,
                )

    def _render_frame_preview(
        self,
        preview_id: str,
        config: dict[str, Any],
        face_id: str | None = None,
        manual_target_x: float | None = None,
        manual_target_y: float | None = None,
    ) -> tuple[bytes, str, float]:
        preview = self.frame_preview(preview_id)
        selected_face_id = str(face_id or preview.face_id)
        self.face(selected_face_id)
        preview.face_id = selected_face_id
        candidate = self._normalized_config(config)
        apply_face_restoration(candidate, selected_face_id)
        # Backend/session/model changes require a deliberate process-local
        # settings preview before this call. Silently substituting the active
        # graph used to make the editor claim that a picture was updated while
        # showing the old swapper/restorer result.
        active_config = self.config
        if self._model_lifecycle_changed(active_config, candidate):
            raise ConfigUpdateConflict(
                "Apply the process-local preview configuration before rendering "
                "a frame with a different model lifecycle"
            )
        # Swapper/restorer selection is hot and non-persistent in this editor.
        # Warm the exact selected graph before acquiring embeddings so model
        # creation never occurs halfway through the fixed-frame render.
        self._run_gpu_work(
            self.warm,
            priority=0,
            config=candidate,
            allow_create_selected=True,
        )
        started = time.perf_counter()
        with self._foreground_embedding_priority():
            source_embedding = self.embedding_for_face(selected_face_id, candidate)
            source_frame = self.source_frame_for_face(selected_face_id, candidate)
            source_presentation = self.presentation_for_face(selected_face_id, candidate)
        tracking_profile = self._frame_preview_tracking_profile(candidate)
        with preview.lock:
            next_manual_target = (
                (
                    max(0.0, min(1.0, float(manual_target_x))),
                    max(0.0, min(1.0, float(manual_target_y))),
                )
                if manual_target_x is not None and manual_target_y is not None
                else None
            )
            previous_manual_target = (
                (preview.manual_target_x, preview.manual_target_y)
                if preview.manual_target_x is not None and preview.manual_target_y is not None
                else None
            )
            if next_manual_target != previous_manual_target:
                preview.anchor = None
                preview.tracking_state = {}
                preview.manual_target_x = next_manual_target[0] if next_manual_target else None
                preview.manual_target_y = next_manual_target[1] if next_manual_target else None
            if tracking_profile != preview.tracking_profile:
                preview.anchor = None
                preview.tracking_state = {}
                preview.tracking_profile = tracking_profile
            frame_evidence = FrameEvidence(frame_index=0, media_time_seconds=preview.start_seconds)
            source_candidate = CandidateIdentity(
                face_id=selected_face_id,
                embedding=np.asarray(source_embedding, dtype=np.float32),
                presentation=source_presentation,
                source_frame=source_frame,
            )
            selection = self._run_gpu_work(
                self._select_compatible_identity_for_frame,
                preview.frame,
                (source_candidate,),
                candidate,
                frame_evidence,
                None,
                next_manual_target,
                priority=0,
                work_label="frame-preview-compatibility",
            )
            if selection is None:
                # Match live playback exactly: while no compatible target is
                # accepted, Pong shows the untouched source frame rather than
                # a misleading still-image-only swap.
                preview.anchor = None
                preview.tracking_state = {}
                swapped = np.ascontiguousarray(preview.frame)
            else:
                target_points = np.asarray(selection.target.keypoints, dtype=np.float32)
                frame_height, frame_width = preview.frame.shape[:2]
                selected_target_point = (
                    float(np.mean(target_points[:, 0])) / max(1.0, float(frame_width)),
                    float(np.mean(target_points[:, 1])) / max(1.0, float(frame_height)),
                )
                # Render from a fresh anchor every time. The still must reflect
                # the current compatibility threshold, selected face, and
                # manual target rather than retaining a prior accepted anchor.
                preview.anchor = None
                preview.tracking_state = {
                    "targetPresentation": selection.target.presentation,
                    "sourcePresentation": selection.candidate.presentation,
                }
                swapped, preview.anchor = self._run_gpu_work(
                    self._process_frame_to_rgb,
                    preview.frame,
                    selection.candidate.embedding,
                    None,
                    priority=0,
                    source_frame=selection.candidate.source_frame,
                    verify_identity=True,
                    tracking_state=preview.tracking_state,
                    config=candidate,
                    manual_target_point=selected_target_point,
                    frame_evidence=frame_evidence,
                )
                if swapped is None:
                    swapped = np.ascontiguousarray(preview.frame)
            rgb = np.ascontiguousarray(swapped)
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            ok, encoded = cv2.imencode(
                ".webp",
                bgr,
                [int(cv2.IMWRITE_WEBP_QUALITY), 94],
            )
            media_type = "image/webp"
            if not ok:
                ok, encoded = cv2.imencode(
                    ".jpg",
                    bgr,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 95],
                )
                media_type = "image/jpeg"
            if not ok:
                raise RuntimeError("could not encode the frame preview")
            preview.last_used_at = time.time()
            return encoded.tobytes(), media_type, (time.perf_counter() - started) * 1000.0

    def delete_frame_preview(self, preview_id: str) -> bool:
        with self._frame_previews_lock:
            return self._frame_previews.pop(preview_id, None) is not None

    def create_session(
        self,
        *,
        channel: str,
        source_url: str,
        source_urls: tuple[str, ...] | list[str] | None = None,
        face_id: str,
        face_ids: tuple[str, ...] | list[str] | None = None,
        start_seconds: float,
        prefetch: bool = False,
        prebuffer_seconds: float = 0.0,
        navigation_class: str = "prefetch",
        restoration_profile: str = "default",
        client_epoch: str = "",
        activation_sequence: int = 0,
        diagnostics_enabled: bool = False,
        manual_target_x: float | None = None,
        manual_target_y: float | None = None,
        manual_target_embedding: list[float] | tuple[float, ...] | np.ndarray | None = None,
        manual_target_presentation_label: str = "",
        manual_target_presentation_confidence: float = 0.0,
        manual_target_appearance: list[float] | tuple[float, ...] | None = None,
    ) -> SwapSession:
        # Announce the foreground request *before* trying the global model lock.
        # The all-face primer will finish at most its current identity and then
        # yield, instead of repeatedly winning the lock for every remaining face.
        with self._foreground_embedding_priority():
            parsed = urlparse(source_url)
            if parsed.scheme not in {"http", "https"}:
                raise ValueError("sourceUrl must be an HTTP(S) Pong playback URL")
            normalized_source_candidates: list[str] = []
            for candidate_url in (source_url, *(source_urls or ())):
                candidate = str(candidate_url or "").strip()
                if not candidate or candidate in normalized_source_candidates:
                    continue
                candidate_parsed = urlparse(candidate)
                if candidate_parsed.scheme not in {"http", "https"}:
                    continue
                normalized_source_candidates.append(candidate)
                if len(normalized_source_candidates) >= 2:
                    break
            candidate_face_ids = normalize_face_ids(
                tuple(face_ids or ()) + (face_id,),
                maximum=MAX_MULTI_FACES,
            )
            if not candidate_face_ids:
                raise ValueError("at least one approved face is required")
            for candidate_face_id in candidate_face_ids:
                self.face(candidate_face_id)
            normalized_client_epoch = str(client_epoch or "").strip()[:96]
            channel = normalize_swap_channel(channel, normalized_client_epoch)
            normalized_activation_sequence = max(0, int(activation_sequence or 0))
            normalized_target_embedding = None
            if manual_target_embedding is not None:
                candidate_target_embedding = np.asarray(
                    manual_target_embedding,
                    dtype=np.float32,
                ).reshape(-1)
                if candidate_target_embedding.size:
                    if (
                        candidate_target_embedding.size > 1024
                        or not np.isfinite(candidate_target_embedding).all()
                    ):
                        raise ValueError("targetEmbedding is invalid")
                    normalized_target_embedding = candidate_target_embedding.copy()
            normalized_target_presentation = None
            presentation_label = str(manual_target_presentation_label or "").strip().lower()
            if normalized_target_embedding is not None and presentation_label in {"female", "male"}:
                appearance = tuple(
                    float(value)
                    for value in (manual_target_appearance or ())
                    if math.isfinite(float(value))
                )[:16]
                normalized_target_presentation = FacePresentation(
                    presentation_label,
                    max(0.0, min(1.0, float(manual_target_presentation_confidence or 0.0))),
                    appearance,
                )
            # Register while holding the same control-plane lock used by
            # update_config(). GPU inference has an independent lock, so seeking
            # and direct foreground session creation cannot starve behind a hot
            # producer repeatedly reacquiring the model lock.
            # Otherwise a lifecycle-changing PUT could unload/reconfigure models in
            # the gap after this session captured the old preset but before it became
            # visible to the active-session guard.
            with self._config_lock:
                session_config = session_config_for_profile(self._config, restoration_profile)
                apply_face_restoration(session_config, candidate_face_ids[0])
                config_revision = self._config_revision
                effective_prebuffer_seconds = self._effective_prebuffer_seconds(
                    bool(prefetch),
                    prebuffer_seconds,
                    session_config,
                )
                normalized_navigation_class = str(navigation_class or "").strip().lower()
                if normalized_navigation_class not in {"foreground", "prefetch", "seek"}:
                    normalized_navigation_class = "prefetch" if prefetch else "foreground"
                fragment_seconds = self._fragment_seconds_for_session(
                    bool(prefetch),
                    normalized_navigation_class,
                    session_config,
                )
                session = SwapSession(
                    id=uuid.uuid4().hex,
                    channel=channel,
                    source_url=source_url,
                    face_id=candidate_face_ids[0],
                    start_seconds=max(0.0, float(start_seconds or 0.0)),
                    source_candidates=tuple(normalized_source_candidates),
                    candidate_face_ids=candidate_face_ids,
                    client_epoch=normalized_client_epoch,
                    activation_sequence=normalized_activation_sequence,
                    prefetch=bool(prefetch),
                    prebuffer_seconds=effective_prebuffer_seconds,
                    fragment_seconds=fragment_seconds,
                    navigation_class=normalized_navigation_class,
                    activation_requested=not prefetch,
                    diagnostics_enabled=bool(diagnostics_enabled),
                    config=session_config,
                    config_revision=config_revision,
                    manual_target_x=(
                        max(0.0, min(1.0, float(manual_target_x)))
                        if manual_target_x is not None and manual_target_y is not None
                        else None
                    ),
                    manual_target_y=(
                        max(0.0, min(1.0, float(manual_target_y)))
                        if manual_target_x is not None and manual_target_y is not None
                        else None
                    ),
                    manual_target_embedding=normalized_target_embedding,
                    manual_target_presentation=normalized_target_presentation,
                )
                spool_dir = CACHE_DIR / "sessions"
                spool_dir.mkdir(parents=True, exist_ok=True)
                session.spool_path = spool_dir / f"{session.id}.mp4"
                stale_sessions: list[SwapSession] = []
                with self._sessions_lock:
                    if (
                        not prefetch
                        and normalized_client_epoch
                        and normalized_activation_sequence > 0
                    ):
                        activation_key = (normalized_client_epoch, channel)
                        latest_sequence = int(
                            self._activation_by_client_channel.get(activation_key, 0)
                        )
                        if normalized_activation_sequence < latest_sequence:
                            raise StaleActivationError(
                                "a newer face-swap activation already owns this channel"
                            )
                        self._activation_by_client_channel[activation_key] = (
                            normalized_activation_sequence
                        )
                    prior_id = self._active_by_channel.get(channel)
                    for candidate in self._sessions.values():
                        if candidate.channel != channel or candidate.stop.is_set():
                            continue
                        candidate_epoch = str(candidate.client_epoch or "")
                        old_client_epoch = bool(
                            normalized_client_epoch
                            and candidate_epoch
                            and candidate_epoch != normalized_client_epoch
                        )
                        same_client = bool(
                            not normalized_client_epoch
                            or not candidate_epoch
                            or candidate_epoch == normalized_client_epoch
                        )
                        # Multiple distinct next-card prefetches intentionally
                        # share a channel. Retiring every existing speculative
                        # session whenever another one registered reduced the
                        # advertised two-card look-ahead to a race-selected
                        # single card. Replace only duplicate work for the same
                        # render target; the browser explicitly prunes obsolete
                        # keys and the age sweep remains a final safety net.
                        superseded_prefetch = bool(
                            candidate.prefetch
                            and same_client
                            and candidate.source_url == session.source_url
                            and abs(candidate.start_seconds - session.start_seconds) < 0.01
                            and tuple(candidate.candidate_face_ids)
                            == tuple(session.candidate_face_ids)
                        )
                        superseded_active = bool(
                            not prefetch and prior_id and candidate.id == prior_id
                        )
                        if old_client_epoch or superseded_prefetch or superseded_active:
                            stale_sessions.append(candidate)
                    self._sessions[session.id] = session
                    if not prefetch:
                        self._active_by_channel[channel] = session.id
        # Session registration is also the ownership boundary. Retire every
        # obsolete speculative producer for this client/channel immediately;
        # waiting for an age-based sweep left hidden HTTP subscribers and GPU
        # work alive for minutes. Teardown remains asynchronous so the new POST
        # can return its stream URL without waiting on PyAV/FFmpeg shutdown.
        for stale_session in {item.id: item for item in stale_sessions}.values():
            self._request_session_stop_async(stale_session, delete=True)
        # Start every producer at registration. Foreground sessions used to
        # wait until WebView opened the stream GET, serializing source open,
        # first inference and fMP4 muxing behind the POST response and media
        # element setup. The spool is already the handoff buffer, so beginning
        # here safely overlaps those phases for both cold selection and seek.
        self._ensure_session_producer(session)
        return session

    @staticmethod
    def _fragment_seconds_for_session(
        prefetch: bool,
        navigation_class: str,
        config: dict[str, Any],
    ) -> float:
        runtime = config.get("runtime", {}) if isinstance(config, dict) else {}
        if not bool(runtime.get("pipeline2Enabled", True)):
            # Exact 27.38 fallback behavior.
            if prefetch:
                return 0.0
            return 1.0
        if navigation_class == "seek":
            value = runtime.get("seekFragmentSeconds", 0.50)
        elif prefetch:
            value = runtime.get("prefetchFragmentSeconds", 0.75)
        else:
            value = runtime.get("foregroundFragmentSeconds", 0.50)
        return max(0.25, min(2.0, float(value or 0.50)))

    @staticmethod
    def _mux_fragment_frame_target(fps: float) -> int:
        """Return the exact sample count in each low-latency MP4 fragment.

        The stream muxer uses ``frag_every_frame`` so the first transformed
        frame is immediately a complete moof/mdat pair. This changes only MP4
        packaging, not swap inference, restoration, encoder CQ, or image data.
        """
        return 1

    @staticmethod
    def _effective_prebuffer_seconds(
        prefetch: bool,
        requested_seconds: float,
        config: dict[str, Any],
    ) -> float:
        """Keep a prepared stream at or above the runtime safety target.

        Speculative preparation is clamped to the scheduler's minimum headroom.
        Foreground streams honor their smaller requested startup lead so the
        original can remain visible until playback has enough transformed media
        to absorb short inference bursts. This changes delivery timing only.
        """
        runtime = config.get("runtime", {}) if isinstance(config, dict) else {}
        if not prefetch:
            foreground_default = float(runtime.get("foregroundFragmentSeconds", 0.50))
            return max(
                0.25,
                min(5.0, float(requested_seconds or foreground_default or 0.50)),
            )
        requested = max(0.25, min(5.0, float(requested_seconds or 1.5)))
        minimum_headroom = max(
            1.0,
            min(5.0, float(runtime.get("minimumHeadroom", 1.25))),
        )
        return max(requested, minimum_headroom)

    @staticmethod
    def _attainable_prebuffer_seconds(
        requested_seconds: float,
        *,
        source_duration: float,
        start_seconds: float,
        fps: float,
    ) -> float:
        """Clamp a preload target to whole frames that remain after a seek.

        For ordinary streams this is deliberately a no-op. Near EOF it keeps
        the minimum-headroom safety clamp from becoming an impossible promise:
        e.g. a 1.25 s target becomes 1.0 s when only 24 frames at 24 fps remain.
        """
        requested = max(0.0, float(requested_seconds or 0.0))
        if requested <= 0.0 or source_duration <= 0.0 or fps <= 0.0:
            return requested
        remaining_seconds = max(
            0.0,
            float(source_duration) - max(0.0, float(start_seconds)),
        )
        if remaining_seconds <= 0.0:
            return requested
        # Floor to complete, decodable frame intervals. The small epsilon
        # absorbs decimal serialization noise without granting a phantom frame.
        remaining_frames = max(1, math.floor((remaining_seconds * fps) + 1e-6))
        attainable_seconds = remaining_frames / fps
        return min(requested, attainable_seconds)

    def prune_prefetch_sessions(self, max_age_seconds: float = 60.0) -> int:
        cutoff = time.time() - max(15.0, float(max_age_seconds))
        pruned = 0
        with self._sessions_lock:
            sessions = list(self._sessions.values())
        for session in sessions:
            if (
                session.prefetch
                and session.created_at < cutoff
                and not session.stop.is_set()
            ):
                self._request_session_stop(session, delete=True)
                pruned += 1
        return pruned

    def session(self, session_id: str) -> SwapSession:
        with self._sessions_lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("swap session was not found")
        return session

    def prepare_source(self, source_url: str) -> dict[str, Any]:
        """Speculatively negotiate one visible VOD source, without rendering.

        The existing two-entry pool owns cancellation/expiry and admits only
        HTTP(S). A foreground request never waits for this optional operation;
        it takes a ready container or opens normally. No frame or face state is
        reused, and no source is opened merely by listing the whole deck.
        """
        queued = self._standby_sources.warm(str(source_url or ""))
        return {"queued": queued, "sources": self._standby_sources.status()}

    def session_first_frame_webp(
        self,
        session_id: str,
        *,
        wait_seconds: float = 0.0,
    ) -> tuple[bytes, bool]:
        """Return the first exact rendered seek frame, optionally waiting briefly.

        This is a visual bridge for Android's comparatively slow fragmented-MP4
        startup. The ordinary stream remains authoritative for playback.
        """
        session = self.session(session_id)
        deadline = time.monotonic() + max(0.0, min(8.0, float(wait_seconds or 0.0)))
        with session.condition:
            while not session.first_rendered_frame_webp:
                if session.stop.is_set() or (session.complete and not session.first_rendered_frame_pending):
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                session.condition.wait(timeout=min(0.10, remaining))
            return (
                bytes(session.first_rendered_frame_webp),
                bool(session.first_rendered_frame_transformed),
            )

    def activate_session(
        self,
        session_id: str,
        *,
        client_epoch: str = "",
        activation_sequence: int = 0,
    ) -> SwapSession:
        """Promote a pre-opened stream without forcing the client to reload it."""
        session = self.session(session_id)
        normalized_client_epoch = str(client_epoch or session.client_epoch or "").strip()[:96]
        normalized_activation_sequence = max(
            0,
            int(activation_sequence or session.activation_sequence or 0),
        )
        stale_sessions: list[SwapSession] = []
        with self._sessions_lock:
            if normalized_client_epoch and normalized_activation_sequence > 0:
                activation_key = (normalized_client_epoch, session.channel)
                latest_sequence = int(
                    self._activation_by_client_channel.get(activation_key, 0)
                )
                if normalized_activation_sequence < latest_sequence:
                    raise StaleActivationError(
                        "a newer face-swap activation already owns this channel"
                    )
                self._activation_by_client_channel[activation_key] = (
                    normalized_activation_sequence
                )
                session.client_epoch = normalized_client_epoch
                session.activation_sequence = normalized_activation_sequence
            prior_id = self._active_by_channel.get(session.channel)
            for candidate in self._sessions.values():
                if (
                    candidate.id == session.id
                    or candidate.channel != session.channel
                    or candidate.stop.is_set()
                ):
                    continue
                candidate_epoch = str(candidate.client_epoch or "")
                old_client_epoch = bool(
                    normalized_client_epoch
                    and candidate_epoch
                    and candidate_epoch != normalized_client_epoch
                )
                same_client = bool(
                    not normalized_client_epoch
                    or not candidate_epoch
                    or candidate_epoch == normalized_client_epoch
                )
                # Promoting one decoded look-ahead must not retire the other
                # distinct future-card prefetches. The browser owns that
                # bounded set and explicitly prunes obsolete keys. Deleting
                # every same-client prefetch here left its already-decoded
                # WebView reader pointing at a 404, forcing the next swipe
                # through a multi-second cold-session fallback.
                if old_client_epoch or (prior_id and candidate.id == prior_id):
                    stale_sessions.append(candidate)
            self._active_by_channel[session.channel] = session.id
        for stale_session in {item.id: item for item in stale_sessions}.values():
            # A swipe already owns a decoded reader for `session`. Do not make
            # its /activate response wait for the previous PyAV/FFmpeg process
            # to close; that teardown measured 2.4--4.5 seconds on Android and
            # happened before video.play(). Stop the old producer logically,
            # then reclaim native resources on a bounded daemon thread.
            self._request_session_stop_async(stale_session, delete=True)
        with session.condition:
            session.activation_requested = True
            if not session.playback_started_at:
                session.playback_started_at = time.monotonic()
            session.prefetch = False
            session.condition.notify_all()
        self._release_prefetch_admission(session)
        self._promote_queued_session_work(session)
        self._ensure_session_producer(session)
        return session

    def suspend_session(self, session_id: str) -> SwapSession:
        """Yield GPU production while the user is actively moving a scrubber."""
        session = self.session(session_id)
        with session.condition:
            if not session.stop.is_set() and not session.complete:
                session.scrub_suspended.set()
            session.condition.notify_all()
        return session

    def resume_session(self, session_id: str) -> SwapSession:
        """Resume a scrub-suspended session when replacement preparation fails."""
        session = self.session(session_id)
        with session.condition:
            session.scrub_suspended.clear()
            session.condition.notify_all()
        return session

    def sessions_public(self) -> list[dict[str, Any]]:
        with self._sessions_lock:
            sessions = list(self._sessions.values())
        return [session.public() for session in sessions]

    def stop_session(self, session_id: str, *, deferred: bool = False) -> SwapSession:
        session = self.session(session_id)
        if deferred:
            self._request_session_stop_async(session, delete=True)
        else:
            self._request_session_stop(session, delete=True)
        if not deferred and session.producer is None:
            session.complete = True
            self._schedule_spool_cleanup(session, delay=0.0)
        return session

    def _schedule_spool_cleanup(self, session: SwapSession, *, delay: float) -> None:
        with session.condition:
            if session.cleanup_started:
                return
            session.cleanup_started = True

        def cleanup() -> None:
            if delay > 0:
                # The stop event is also set on an unexpected producer error,
                # so Event.wait() would defeat the diagnostic retention delay.
                # A condition wait preserves that delay but lets an explicit
                # DELETE wake cleanup and retire the session immediately.
                deadline = time.monotonic() + delay
                with session.condition:
                    while not session.delete_requested:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        session.condition.wait(timeout=remaining)
            resources_alive = False
            for _ in range(120):
                # Reissue interruption in case cancellation raced resource
                # registration (for example, stop arrived during av.open).
                self._interrupt_session_resources(session)
                with session.condition:
                    subscribers = session.subscribers
                resources_alive = self._session_has_live_resources(session)
                if subscribers <= 0 and not resources_alive:
                    break
                time.sleep(0.25)
            resources_alive = self._session_has_live_resources(session)
            if resources_alive:
                # Never retire a live producer and make it invisible to health
                # or idle-unload. Retry later after a bounded wait.
                with session.condition:
                    session.cleanup_started = False
                self._schedule_spool_cleanup(session, delay=1.0)
                return
            with session.condition:
                if not session.resources_released_at:
                    session.resources_released_at = time.time()
                session.condition.notify_all()
            path = session.spool_path
            if path is not None:
                for _ in range(20):
                    try:
                        path.unlink(missing_ok=True)
                        break
                    except PermissionError:
                        time.sleep(0.25)
            # The old implementation removed only the spool file. Every swipe
            # still left its SwapSession, events, ranges and thread reference in
            # the process forever. Retire the record once no reader can use it.
            with self._sessions_lock:
                if self._sessions.get(session.id) is session:
                    self._sessions.pop(session.id, None)
                if self._active_by_channel.get(session.channel) == session.id:
                    self._active_by_channel.pop(session.channel, None)

        threading.Thread(
            target=cleanup,
            name=f"PongSwapCleanup-{session.channel}",
            daemon=True,
        ).start()

    def _ensure_session_producer(self, session: SwapSession) -> None:
        with self._sessions_lock:
            with session.condition:
                if session.producer is not None or session.complete or session.stop.is_set():
                    return
                producer = threading.Thread(
                    target=self._produce_session,
                    args=(session,),
                    name=f"PongSwapProducer-{session.channel}",
                    daemon=True,
                )
                session.producer = producer
                producer.start()

    @staticmethod
    def _playable_media_seconds(session: SwapSession) -> float:
        """Return media time that has crossed the muxer when known."""
        if session.fps <= 0:
            return 0.0
        fed_seconds = max(0.0, float(session.frames) / float(session.fps))
        muxed_seconds = session.muxed_media_seconds()
        if muxed_seconds > 0:
            return min(fed_seconds, muxed_seconds)
        return fed_seconds

    @staticmethod
    def _prefetch_has_safe_lead(session: SwapSession) -> bool:
        """Return whether a speculative producer may pause for activation.

        The feed thread must use the same mux-aware readiness predicate that
        the API exposes.  Stopping at the raw frame target can deadlock a CBR
        prefetch: FFmpeg may still be holding part of the final GOP, leaving
        ``prepared`` false forever while the producer waits for activation.
        """
        return session.is_prepared()

    @staticmethod
    def _prefetch_frame_may_reuse(
        session: SwapSession,
        runtime: dict[str, Any],
        *,
        verify_identity: bool,
    ) -> bool:
        """Return whether this hidden frame may skip expensive inference.

        The feature is off by default. It is restricted to sessions which are
        still speculative and re-checks both activation signals at every frame;
        a promoted/visible stream therefore resumes full inference immediately.
        """
        try:
            stride = max(1, min(2, int(runtime.get("prefetchInferenceStride", 1))))
        except (TypeError, ValueError):
            stride = 1
        return bool(
            stride > 1
            and session.prefetch
            and not session.activation_requested
            and not session.playback_started_at
            and session.frames > 0
            and (session.frames % stride) != 0
            and not verify_identity
        )

    @staticmethod
    def _session_temporal_frame_may_reuse(
        session: SwapSession,
        runtime: dict[str, Any],
        *,
        verify_identity: bool,
        last_exact_frame: int,
        current_timeline_seconds: float | None = None,
        last_exact_timeline_seconds: float | None = None,
        timeline_reliable: bool = False,
    ) -> bool:
        """Admit a tracked residual frame inside a fixed media-time horizon.

        This is independent of playback pressure: a slow GPU never extends the
        quality horizon. Failed tracking, identity verification, seeks and
        generation replacement all fall back to the unchanged exact pipeline.
        """
        if not bool(runtime.get("temporalForegroundReuseEnabled", False)):
            return False
        try:
            anchor_hz = max(
                0.25, float(runtime.get("temporalFullAnchorHz", 5.0))
            )
            max_anchor_frames = max(
                1, int(math.ceil(max(1.0, session.fps) / anchor_hz))
            )
        except (TypeError, ValueError, OverflowError):
            return False
        age = int(session.frames) - int(last_exact_frame)
        if not timeline_reliable:
            return False
        try:
            timeline_age = float(current_timeline_seconds) - float(
                last_exact_timeline_seconds
            )
        except (TypeError, ValueError, OverflowError):
            return False
        if not math.isfinite(timeline_age):
            return False
        max_anchor_seconds = max_anchor_frames / max(1.0, float(session.fps))
        frame_tolerance = 0.5 / max(1.0, float(session.fps))
        within_frame_horizon = 0 < age < max_anchor_frames
        if (
            bool(runtime.get("temporalFullAdaptiveGraceEnabled", False))
            and age == max_anchor_frames
        ):
            within_frame_horizon = True
        return bool(
            last_exact_frame >= 0
            and within_frame_horizon
            and 0.0 < timeline_age < max_anchor_seconds + frame_tolerance
            and not verify_identity
        )

    @staticmethod
    def _foreground_reuse_allowed_for_source(
        session: SwapSession,
        runtime: dict[str, Any],
        frame_shape: tuple[int, ...],
    ) -> bool:
        """Restrict whole-frame transport to sources that need its headroom.

        Fresh InSwapper inference plus temporal GPEN/mask reuse is faster and
        more stable for phone-sized and <=25 fps media. At 720p/30, residual
        transport is still required to stay ahead of playback. This gate makes
        that decision from immutable source properties, so cadence cannot
        oscillate while a clip is playing.
        """
        if not bool(runtime.get("temporalForegroundReuseEnabled", False)):
            return False
        if not bool(runtime.get("temporalForegroundReuseHighLoadOnly", False)):
            return True
        try:
            height = max(0, int(frame_shape[0]))
            width = max(0, int(frame_shape[1]))
            minimum_pixels = max(
                0,
                int(runtime.get("temporalForegroundReuseMinimumPixels", 700000)),
            )
            minimum_fps = max(
                0.0,
                float(runtime.get("temporalForegroundReuseMinimumFps", 27.0)),
            )
            minimum_pixel_rate = max(
                0.0,
                float(runtime.get("temporalForegroundReuseMinimumPixelRate", 0.0)),
            )
        except (IndexError, TypeError, ValueError, OverflowError):
            return False
        if minimum_pixel_rate > 0.0:
            return bool(
                height * width * max(1.0, float(session.fps))
                >= minimum_pixel_rate
            )
        return bool(
            height * width >= minimum_pixels
            and float(session.fps) >= minimum_fps
        )

    @staticmethod
    def _estimated_playback_position_seconds(
        session: SwapSession,
        now: float,
    ) -> float:
        """Estimate the reader position from the latest sparse browser report.

        A fresh report is authoritative. Between reports an actively playing
        reader advances at wall-clock speed; a paused/background reader does
        not. Older clients retain the activation-clock fallback.
        """
        if session.playback_position_updated_at > 0:
            played = max(0.0, float(session.playback_position_seconds))
            if not session.playback_paused:
                played += max(
                    0.0,
                    float(now) - float(session.playback_position_updated_at),
                )
            return played
        if not session.playback_started_at:
            return 0.0
        return max(0.0, float(now) - float(session.playback_started_at))

    @staticmethod
    def _playback_headroom_seconds(session: SwapSession, now: float) -> float:
        """Estimate encoded media still available ahead of live playback.

        Complete fragment timing is compared with the browser's sparse playback
        position feedback. This avoids overproducing while Android is paused or
        backgrounded and avoids assuming a fixed bitrate or uninterrupted play.
        """
        if session.fps <= 0 or not session.playback_started_at:
            return 0.0
        produced = PongSwapEngine._playable_media_seconds(session)
        played = PongSwapEngine._estimated_playback_position_seconds(session, now)
        return produced - played

    def update_playback(
        self,
        session_id: str,
        *,
        position_seconds: float,
        paused: bool,
    ) -> SwapSession:
        """Apply a bounded browser playback-credit update to one live session."""
        session = self.session(session_id)
        position = max(0.0, float(position_seconds or 0.0))
        with session.condition:
            # Event ordering can race around seek/replacement. Never move the
            # production clock backward for a given immutable session.
            session.playback_position_seconds = max(
                session.playback_position_seconds,
                position,
            )
            session.playback_position_updated_at = time.monotonic()
            session.playback_paused = bool(paused)
            session.condition.notify_all()
        return session

    def _foreground_playback_needs_gpu(
        self,
        excluded_session_id: str,
        *,
        now: float | None = None,
    ) -> bool:
        """Return True while an activated viewed stream is below headroom."""
        observed_at = time.monotonic() if now is None else float(now)
        with self._sessions_lock:
            candidates = list(self._sessions.values())
            active_ids = set(self._active_by_channel.values())
        for candidate in candidates:
            if (
                candidate.id == excluded_session_id
                or candidate.id not in active_ids
                or candidate.complete
                or candidate.stop.is_set()
                or candidate.subscribers <= 0
                or candidate.prefetch
                or not candidate.activation_requested
                or not candidate.playback_started_at
                or candidate.fps <= 0
            ):
                continue
            minimum_headroom = max(
                1.0,
                float(
                    (candidate.config or self._config)["runtime"].get(
                        "minimumHeadroom", 1.25
                    )
                ),
            )
            if self._playback_headroom_seconds(candidate, observed_at) < minimum_headroom:
                return True
        return False

    def _yield_prefetch_for_foreground(self, session: SwapSession) -> int:
        """Pause speculative inference until live playback regains headroom.

        This is intentionally called at the frame boundary, before the global
        model lock is requested.  A speculative session may finish the frame
        already inside inference, but it cannot repeatedly reacquire CUDA while
        an activated stream is at the growing-fMP4 live edge.  Foreground work
        never takes the prefetch gate and is therefore never blocked here.

        Returns the number of waits, which keeps the policy directly testable
        without exposing scheduler counters through the service API.
        """
        waits = 0
        while (
            session.prefetch
            and not session.playback_started_at
            and not session.activation_requested
            and not session.stop.is_set()
            and self._foreground_playback_needs_gpu(session.id)
        ):
            waits += 1
            # Activation and cancellation notify this condition, while the
            # short timeout lets freshly produced foreground frames update the
            # headroom decision without adding synchronization to the hot path.
            with session.condition:
                session.condition.wait(timeout=0.01)
        return waits


    def _produce_session(self, session: SwapSession) -> None:
        session.state = "starting"
        session.started_at = time.time()
        # Backward compatibility is useful for in-process tests constructing a
        # SwapSession directly; service-created sessions always have a snapshot.
        session_config = session.config or self._config_snapshot()[0]
        container = None
        process = None
        decoder = None
        feeder = None
        source_opener = None
        stderr_thread = None
        stderr_tail = bytearray()
        feeder_error: queue.Queue[Any] = queue.Queue(maxsize=1)
        decode_stop = threading.Event()
        # Source negotiation can outlive the producer's bounded teardown wait.
        # Close publication before reclaiming a not-yet-decoded container.
        source_open_cancel = threading.Event()
        try:
            if session.stop.is_set():
                session.state = "stopped"
                return
            import av

            source_open_result: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

            def open_source() -> None:
                # Two speculative sessions may negotiate their media sources in
                # parallel, but additional hidden work waits here. Promotion
                # turns this into foreground work and must never wait on a
                # speculative networking slot.
                source_gate_owned = False
                if session.prefetch and not session.activation_requested:
                    while not session.stop.is_set():
                        with session.condition:
                            promoted = bool(
                                not session.prefetch
                                or session.activation_requested
                                or session.playback_started_at
                            )
                        if promoted:
                            break
                        if self._prefetch_source_open_gate.acquire(timeout=0.10):
                            source_gate_owned = True
                            break
                if session.stop.is_set():
                    try:
                        source_open_result.put_nowait(("stopped", None))
                    except queue.Full:
                        pass
                    if source_gate_owned:
                        self._prefetch_source_open_gate.release()
                    return

                source_candidates = tuple(dict.fromkeys(
                    session.source_candidates or (session.source_url,)
                ))[:2]
                race_lock = threading.Lock()
                race_state: dict[str, Any] = {
                    "winner": False,
                    "remaining": len(source_candidates),
                    "errors": [],
                }

                def open_candidate(candidate_url: str) -> None:
                    opened = None
                    reused = False
                    candidate_error: BaseException | None = None
                    won = False
                    try:
                        # A source can now be negotiated while the approved-face
                        # menu is open, including first playback at time zero.
                        opened = self._standby_sources.take(candidate_url)
                        reused = opened is not None
                        if opened is None:
                            opened = av.open(candidate_url, timeout=(10.0, 5.0))
                    except Exception as exc:
                        candidate_error = exc
                    with race_lock:
                        with session.lifecycle_lock:
                            if (
                                opened is not None
                                and not session.stop.is_set()
                                and not source_open_cancel.is_set()
                                and not race_state["winner"]
                            ):
                                race_state["winner"] = True
                                won = True
                                session.container = opened
                                session.source_url = candidate_url
                                session.source_opened_at = time.time()
                                session.source_decoder_reused = reused
                        if candidate_error is not None:
                            race_state["errors"].append(candidate_error)
                        race_state["remaining"] -= 1
                        remaining = int(race_state["remaining"])
                        winner_exists = bool(race_state["winner"])
                        final_error = (
                            race_state["errors"][0]
                            if race_state["errors"]
                            else RuntimeError("source opening stopped")
                        )
                    if won:
                        try:
                            source_open_result.put_nowait(("ok", opened))
                        except queue.Full:
                            won = False
                    if opened is not None and not won:
                        try:
                            opened.close()
                        except Exception:
                            pass
                    if remaining == 0 and not winner_exists:
                        try:
                            source_open_result.put_nowait((
                                "stopped" if session.stop.is_set() else "error",
                                None if session.stop.is_set() else final_error,
                            ))
                        except queue.Full:
                            pass

                candidate_threads = [
                    threading.Thread(
                        target=open_candidate,
                        args=(candidate_url,),
                        name=f"PongSwapRoute-{session.channel}-{index + 1}",
                        daemon=True,
                    )
                    for index, candidate_url in enumerate(source_candidates)
                ]
                try:
                    for candidate_thread in candidate_threads:
                        candidate_thread.start()
                    for candidate_thread in candidate_threads:
                        candidate_thread.join()
                finally:
                    if source_gate_owned:
                        self._prefetch_source_open_gate.release()

            # Source/CDN negotiation is independent of model warmup and the
            # selected-face embedding. Start it before speculative GPU admission
            # so both predicted videos can negotiate concurrently while model
            # execution remains strictly foreground-prioritized.
            source_opener = threading.Thread(
                target=open_source,
                name=f"PongSwapOpen-{session.channel}",
                daemon=True,
            )
            with session.lifecycle_lock:
                session.source_opener = source_opener
            source_opener.start()
            # Admit speculative GPU work only after network preparation has
            # started. Foreground sessions bypass this gate and promotion
            # releases it immediately; no face-quality behavior changes here.
            if session.prefetch and not session.activation_requested:
                admitted = self._acquire_prefetch_admission(session)
                if not admitted and session.error_code == "GPU_HEADROOM":
                    return
            if session.stop.is_set():
                session.state = "stopped"
                return
            # Selected-session startup is latency-sensitive.  Signal priority
            # before waiting on the model lock so the speculative all-face
            # primer yields after its current identity, and automatically resumes
            # when this selected embedding is available.
            with self._foreground_embedding_priority():
                self._run_gpu_work(
                    self.warm,
                    priority=(10 if session.prefetch else 0),
                    queue_cancel_event=session.stop,
                    work_label="session-warm",
                    config=session_config,
                    allow_create_selected=bool(session_config["runtime"].get("tiktokRestorerProfile")),
                )
                session.models_ready_at = time.time()
                if session.stop.is_set():
                    session.state = "stopped"
                    return
                prepared_candidates: list[CandidateIdentity] = []
                for candidate_face_id in (
                    session.candidate_face_ids or (session.face_id,)
                ):
                    if session.stop.is_set():
                        session.state = "stopped"
                        return
                    candidate_embedding = self.embedding_for_face(
                        candidate_face_id,
                        session_config,
                        queue_cancel_event=session.stop,
                    )
                    candidate_source_frame = self.source_frame_for_face(
                        candidate_face_id,
                        session_config,
                    )
                    candidate_presentation = self.presentation_for_face(
                        candidate_face_id,
                        session_config,
                        queue_cancel_event=session.stop,
                    )
                    prepared_candidates.append(
                        CandidateIdentity(
                            face_id=candidate_face_id,
                            embedding=candidate_embedding,
                            presentation=candidate_presentation,
                            source_frame=candidate_source_frame,
                        )
                    )
                if not prepared_candidates:
                    raise ValueError("No approved face could be prepared")
                candidates = tuple(prepared_candidates)
                # The first candidate provides a harmless placeholder until a
                # compatible target locks one source identity for this video.
                source_embedding = candidates[0].embedding
                source_frame = candidates[0].source_frame
                session.embedding_ready_at = time.time()
            if session.stop.is_set():
                session.state = "stopped"
                return

            while True:
                if session.stop.is_set():
                    session.state = "stopped"
                    return
                try:
                    source_status, source_value = source_open_result.get(timeout=0.10)
                    break
                except queue.Empty:
                    continue
            if source_status == "error":
                raise source_value
            if source_status != "ok" or source_value is None:
                session.state = "stopped"
                return
            container = source_value
            if session.stop.is_set():
                self._interrupt_session_resources(session)
                session.state = "stopped"
                return
            video_stream = highest_quality_video_stream(container)
            if video_stream is None:
                raise ValueError("source URL has no decodable video stream")
            source_duration = 0.0
            try:
                if container.duration is not None and int(container.duration) > 0:
                    source_duration = float(container.duration) / float(av.time_base)
                elif video_stream.duration is not None and video_stream.time_base:
                    source_duration = float(video_stream.duration * video_stream.time_base)
            except (TypeError, ValueError, OverflowError):
                source_duration = 0.0
            session.source_duration = max(0.0, source_duration)
            source_fps = max(1.0, float(video_stream.average_rate or video_stream.base_rate or 30.0))
            fps, frame_stride = _quality_preserving_output_cadence(
                source_fps, session_config['runtime'].get('qualityPreservingMaxFps', 0.0),
            )
            session.source_fps = source_fps
            session.source_frame_stride = frame_stride
            width, height = int(video_stream.codec_context.width), int(video_stream.codec_context.height)
            output_width, output_height = self.output_dimensions(
                width,
                height,
                session_config,
            )
            session.width = output_width
            session.height = output_height
            session.fps = fps
            if session.prebuffer_seconds > 0:
                # The scheduler's minimum-headroom clamp is a safety target,
                # not a reason to leave terminal seeks permanently unprepared.
                # Once source metadata is known, advertise and encode only the
                # whole-frame duration that can actually exist after the seek.
                with session.condition:
                    session.prebuffer_seconds = self._attainable_prebuffer_seconds(
                        session.prebuffer_seconds,
                        source_duration=session.source_duration,
                        start_seconds=session.start_seconds,
                        fps=fps,
                    )
                    session.condition.notify_all()
            if session.start_seconds > 0 and video_stream.time_base:
                try:
                    container.seek(
                        int(session.start_seconds / float(video_stream.time_base)),
                        stream=video_stream, backward=True, any_frame=False,
                    )
                except Exception:
                    if not session.source_decoder_reused or session.stop.is_set():
                        raise
                    # A standby HTTP connection may have expired. Retry once
                    # through the unchanged cold path before failing the seek.
                    container.close()
                    container = av.open(session.source_url, timeout=(10.0, 5.0))
                    with session.lifecycle_lock:
                        session.container = container
                        session.source_decoder_reused = False
                        session.source_opened_at = time.time()
                    video_stream = highest_quality_video_stream(container)
                    if video_stream is None:
                        raise ValueError("source URL has no decodable video stream")
                    container.seek(
                        int(session.start_seconds / float(video_stream.time_base)),
                        stream=video_stream, backward=True, any_frame=False,
                    )
            runtime = session_config["runtime"]
            _apply_source_fps_runtime_cadence(runtime, fps)
            # A speculative reader can decode only after FFmpeg has closed the
            # first moof/mdat pair. Fragment cadence is independent from total
            # prepared lead: short fragments improve first-presentation and
            # seek latency while production continues to the full safety target.
            fragment_seconds = session.fragment_seconds
            if fragment_seconds <= 0:
                # 27.38 compatibility path when Pipeline 2 is disabled.
                fragment_seconds = (
                    session.prebuffer_seconds if session.prefetch else 1.0
                )
            gop_frames = max(
                1,
                round(fps * max(1.0 / fps, fragment_seconds)),
            )
            # `-g` continues to control random-access/keyframe cadence. MP4
            # packaging closes every encoded sample independently, allowing a
            # slow high-quality restorer to become playable after frame one
            # rather than waiting for an entire GOP. CQ and pixels are unchanged.
            session.fragment_frame_target = self._mux_fragment_frame_target(fps)
            ffmpeg = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{output_width}x{output_height}",
                "-r", f"{fps:.6f}", "-i", "pipe:0",
            ]
            include_audio = bool(runtime.get("swapAudioEnabled", False))
            if include_audio:
                # Audio requires a second source connection because PyAV owns
                # the decoded video connection. Keep this opt-in for users who
                # need sound; Pong's normal muted swap path avoids the extra
                # request, CDN seek, and startup dependency entirely.
                ffmpeg.extend([
                    "-ss", f"{session.start_seconds:.6f}", "-i", session.source_url,
                    "-map", "0:v:0", "-map", "1:a:0?",
                ])
            else:
                ffmpeg.extend(["-map", "0:v:0", "-an"])
            ffmpeg.extend([
                # PyAV has already converted the decoded source into full-range
                # RGB.  Declare the RGB->YUV matrix explicitly so mobile
                # decoders do not guess BT.601 for HD video and shift skin tones.
                "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p",
                "-c:v", "h264_nvenc", "-preset", str(runtime.get("encoderPreset", "p1")),
                "-tune", "ll",
            ])
            # Prepared and direct streams use the exact same configured quality
            # policy. Readiness is derived from complete fragments, not a fixed
            # bitrate assumption, so promotion cannot silently change quality.
            ffmpeg.extend([
                "-rc", "vbr", "-cq", str(runtime.get("encoderCq", 23)),
                "-b:v", "0",
            ])
            ffmpeg.extend([
                "-g", str(gop_frames), "-keyint_min", str(gop_frames),
                "-bf", "0", "-rc-lookahead", "0", "-delay", "0", "-zerolatency", "1",
                "-color_range", "tv", "-colorspace", "bt709",
                "-color_primaries", "bt709", "-color_trc", "bt709",
                "-movflags", "frag_every_frame+empty_moov+default_base_moof",
                "-flush_packets", "1",
                "-f", "mp4", "pipe:1",
            ])
            if include_audio:
                # Insert audio encoding before the muxer options. FFmpeg accepts
                # output options in either order before the output URL, but
                # keeping them adjacent makes generated diagnostics clearer.
                mux_index = ffmpeg.index("-movflags")
                ffmpeg[mux_index:mux_index] = [
                    "-c:a", "aac", "-b:a", "128k", "-shortest",
                ]
            process = subprocess.Popen(
                ffmpeg,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            session.encoder_started_at = time.time()

            def drain_stderr() -> None:
                stream = process.stderr
                if stream is None:
                    return
                try:
                    while True:
                        diagnostic = stream.read(4096)
                        if not diagnostic:
                            break
                        stderr_tail.extend(diagnostic)
                        if len(stderr_tail) > 64 * 1024:
                            del stderr_tail[: len(stderr_tail) - (64 * 1024)]
                except (OSError, ValueError):
                    pass

            # Drain concurrently: a native error must never fill stderr and
            # block FFmpeg before its stdout pipe can reach EOF.
            stderr_thread = threading.Thread(
                target=drain_stderr,
                name=f"PongSwapStderr-{session.channel}",
                daemon=True,
            )
            stderr_thread.start()
            with session.lifecycle_lock:
                session.process = process
            if session.stop.is_set():
                self._interrupt_session_resources(session)
                session.state = "stopped"
                return
            lead_buffer_seconds = max(
                1.0,
                float(runtime.get("leadBufferSeconds", 3.0)),
            )

            # Keep CPU/network decode one small bounded step ahead of the GPU.
            # PyAV conversion and CUDA inference otherwise serialize even though
            # they use independent resources. Three RGB frames are enough to
            # hide ordinary decode jitter without allowing a background or
            # abandoned session to consume unbounded memory/work.
            mask_preflight_enabled = bool(
                runtime.get("maskAdaptiveBackendEnabled", False)
                and runtime.get("maskAdaptivePreflightEnabled", False)
            )
            mask_preflight_frame_count = max(
                2,
                int(runtime.get("maskAdaptivePreflightFrames", 5)),
            )
            mask_preflight_threshold = max(
                0.0,
                float(runtime.get("maskAdaptiveFlowP90Threshold", 0.80)),
            )
            mask_preflight_ready = threading.Event()
            mask_preflight_result: dict[str, Any] = {}
            mask_motion_preflight = MaskMotionPreflight(
                frame_count=mask_preflight_frame_count,
                flow_p90_threshold=mask_preflight_threshold,
            )
            decode_queue: queue.Queue[Any] = queue.Queue(
                maxsize=(
                    max(3, mask_preflight_frame_count)
                    if mask_preflight_enabled else 3
                )
            )
            decode_sentinel = object()

            def publish_decoded(item: Any) -> bool:
                while not decode_stop.is_set() and not session.stop.is_set():
                    try:
                        decode_queue.put(item, timeout=0.05)
                        return True
                    except queue.Full:
                        continue
                return False

            def decode_source() -> None:
                try:
                    eligible_source_frames = 0
                    for decoded in container.decode(video_stream):
                        if decode_stop.is_set() or session.stop.is_set():
                            break
                        timeline_seconds = None
                        if decoded.pts is not None and video_stream.time_base:
                            timestamp = float(decoded.pts * video_stream.time_base)
                            if timestamp + (1.0 / source_fps) < session.start_seconds:
                                continue
                            timeline_seconds = max(0.0, timestamp - session.start_seconds)
                        take_frame = eligible_source_frames % frame_stride == 0
                        eligible_source_frames += 1
                        if not take_frame:
                            session.cadence_skipped_frames += 1
                            continue
                        frame = decoded.to_ndarray(format="rgb24")
                        if mask_preflight_enabled and not mask_preflight_ready.is_set():
                            if mask_motion_preflight.add(frame, rgb=True):
                                mask_preflight_result.update(
                                    mask_motion_preflight.result()
                                )
                                mask_preflight_ready.set()
                        if not publish_decoded((frame, timeline_seconds)):
                            break
                except Exception as exc:
                    if not decode_stop.is_set() and not session.stop.is_set():
                        publish_decoded(exc)
                finally:
                    if mask_preflight_enabled and not mask_preflight_ready.is_set():
                        mask_preflight_result.update(
                            mask_motion_preflight.result()
                        )
                        mask_preflight_ready.set()
                    publish_decoded(decode_sentinel)
                    # PyAV/native decoder ownership is singular. Closing from
                    # this owner avoids a close-vs-decode race during rapid
                    # swipes while the configured read timeout still bounds a
                    # blocked network source.
                    try:
                        container.close()
                    except Exception:
                        pass
                    with session.lifecycle_lock:
                        if session.container is container:
                            session.container = None

            decoder = threading.Thread(
                target=decode_source,
                name=f"PongSwapDecode-{session.channel}",
                daemon=True,
            )
            with session.lifecycle_lock:
                session.decoder = decoder
                if not session.stop.is_set():
                    decoder.start()
            if decoder.ident is None:
                session.state = "stopped"
                return

            def feed() -> None:
                nonlocal source_embedding, source_frame
                anchor = None
                identity_locked = False
                multi_face_consensus = MultiFaceConsensus() if len(candidates) > 1 else None
                multi_choice_key = multi_video_key(session.channel, session.client_epoch,
                    session.source_url, session.candidate_face_ids, session.config_revision,
                    manual=session.manual_target_x is not None or session.manual_target_embedding is not None)
                next_compatibility_probe_frame = 0
                pending_source_switch: tuple[CandidateIdentity, float] | None = None
                switch_challenger_id = ""
                switch_challenger_confirmations = 0
                foreground_oom_retry_used = False
                tracking_state: dict[str, Any] = {
                    "trackGeneration": 0,
                    "sharedLandmarkEstimator": bool(
                        runtime.get("temporalDetectorLkFusionEnabled", False)
                    ),
                    "disableLkSmoothing": bool(
                        runtime.get("temporalDisableLkSmoothing", False)
                    ),
                }

                def seed_mask_preflight_state() -> None:
                    if not mask_preflight_enabled or not mask_preflight_result:
                        return
                    tracking_state["maskAdaptiveBackend"] = {
                        "generation": int(tracking_state.get("trackGeneration", 0)),
                        "backend": str(
                            mask_preflight_result.get("backend", "cuda")
                        ),
                        "locked": True,
                        "samples": [],
                        "preflightMedianFlowP90": float(
                            mask_preflight_result.get("medianFlowP90", math.inf)
                        ),
                        "preflightSampleCount": int(
                            mask_preflight_result.get("sampleCount", 0)
                        ),
                    }

                if mask_preflight_enabled:
                    while (
                        not mask_preflight_ready.wait(timeout=0.05)
                        and not session.stop.is_set()
                        and decoder.is_alive()
                    ):
                        pass
                    if session.stop.is_set():
                        return
                    seed_mask_preflight_state()
                previous_source_frame: np.ndarray | None = None
                previous_swapped_frame: np.ndarray | None = None
                previous_swap_kps: np.ndarray | None = None
                previous_canonical_transform: np.ndarray | None = None
                previous_render_signature: tuple[Any, ...] | None = None
                last_exact_frame = -1
                last_exact_timeline_seconds: float | None = None
                previous_timeline_seconds: float | None = None
                configured_identity_interval = max(
                    1,
                    int(runtime.get("identityCheckIntervalFrames", 12)),
                )
                full_anchor_frames_for_identity = max(
                    1,
                    int(
                        math.ceil(
                            fps
                            / max(
                                0.25,
                                float(runtime.get("temporalFullAnchorHz", 5.0)),
                            )
                        )
                    ),
                )
                # Align identity verification with an already-exact render
                # boundary.  Round down, never up: identity is checked at least
                # as often as configured while avoiding an extra GPEN frame a
                # few milliseconds after a scheduled exact anchor.
                # Identity verification rides on the existing full-quality
                # anchor cadence.  The strictness change previously made it
                # true on *every* locked frame, which disabled the temporal
                # path and reduced a measured 30-fps phone stream to 8.9 fps.
                # Checking every exact anchor keeps the all-face identity gate
                # at 5 Hz while the intervening frames retain fail-closed
                # geometric, appearance, and optical-flow guards.
                identity_interval = min(
                    configured_identity_interval,
                    full_anchor_frames_for_identity,
                )
                parameters = session_config.get("parameters", {})
                selected_source_policy = face_switch_policy(
                    100 if multi_face_consensus is not None else parameters.get("FaceLockSlider", 100)
                )
                source_match_threshold = max(
                    0.0,
                    min(100.0, float(parameters.get("DetectScoreSlider", 45))),
                )
                temporal_context = build_temporal_restorer_context(
                    runtime,
                    enabled=bool(
                        runtime.get("adaptiveRestorer", False)
                        and parameters.get("RestorerSwitch", False)
                        and str(parameters.get("RestorerTypeTextSel", "")) in {"GPEN256", "GPEN512", "GPEN1024"}
                    ),
                )
                semantic_mesh_configured = bool(
                    runtime.get("temporalSemanticMeshEnabled", False)
                )
                semantic_feature_configured = bool(
                    runtime.get("temporalSemanticFeaturePatchesEnabled", False)
                )
                semantic_motion_allowed = bool(
                    not runtime.get("temporalSemanticHighMotionOnly", False)
                    or str(mask_preflight_result.get("backend", "")) == "cuda"
                )
                semantic_mesh_enabled_for_session = bool(
                    semantic_mesh_configured and semantic_motion_allowed
                )
                semantic_feature_enabled_for_session = bool(
                    semantic_feature_configured and semantic_motion_allowed
                )
                sparse_mesh_enabled_for_session = bool(
                    runtime.get("temporalFullSparseMeshResidual", False)
                    and (
                        not semantic_mesh_configured
                        or semantic_mesh_enabled_for_session
                    )
                )
                semantic_landmark_estimator = (
                    self._semantic_landmark_estimator
                    if (
                        semantic_mesh_enabled_for_session
                        or semantic_feature_enabled_for_session
                    )
                    else None
                )
                if (
                    semantic_mesh_enabled_for_session
                    or semantic_feature_enabled_for_session
                ) and semantic_landmark_estimator is None:
                    raise RuntimeError("semantic landmark graph is not warm")
                semantic_refresh_frames = max(
                    1,
                    int(
                        math.ceil(
                            fps
                            / max(
                                0.1,
                                float(
                                    runtime.get(
                                        "temporalSemanticLandmarkRefreshHz", 1.0
                                    )
                                ),
                            )
                        )
                    ),
                )
                last_semantic_refresh_frame = -semantic_refresh_frames

                def invalidate_temporal_chain(
                    *,
                    clear_tracking: bool,
                    reason: str,
                ) -> None:
                    nonlocal previous_source_frame
                    nonlocal previous_swapped_frame
                    nonlocal previous_swap_kps
                    nonlocal previous_canonical_transform
                    nonlocal previous_render_signature
                    nonlocal last_exact_frame
                    nonlocal last_exact_timeline_seconds
                    nonlocal last_semantic_refresh_frame
                    tracking_generation = int(tracking_state.get("trackGeneration", 0)) + 1
                    if clear_tracking:
                        tracking_state.clear()
                    tracking_state["trackGeneration"] = tracking_generation
                    tracking_state["sharedLandmarkEstimator"] = bool(
                        runtime.get("temporalDetectorLkFusionEnabled", False)
                    )
                    tracking_state["disableLkSmoothing"] = bool(
                        runtime.get("temporalDisableLkSmoothing", False)
                    )
                    seed_mask_preflight_state()
                    previous_source_frame = None
                    previous_swapped_frame = None
                    previous_swap_kps = None
                    previous_canonical_transform = None
                    previous_render_signature = None
                    last_exact_frame = -1
                    last_exact_timeline_seconds = None
                    last_semantic_refresh_frame = -semantic_refresh_frames
                    for state_key in (
                        "restorerAnchor",
                        "occluderAnchor",
                        "faceParserAnchor",
                        "spatialExactBlendRecentTriggerFrames",
                        "spatialExactBlendBurstUntilFrame",
                        "spatialExactBlendLastTriggerFrame",
                        "spatialExactBlendLastObservedFrame",
                    ):
                        temporal_context.pop(state_key, None)
                    temporal_context["forceExact"] = True
                    temporal_context["lastInvalidationReason"] = str(reason)
                    temporal_context.setdefault("pendingInvalidationReasons", []).append(
                        str(reason)
                    )

                def record_temporal_rejection(
                    reason: str,
                    sample: dict[str, Any] | None = None,
                ) -> None:
                    session.temporal_reuse_rejections[reason] = int(
                        session.temporal_reuse_rejections.get(reason, 0)
                    ) + 1
                    if sample and len(session.temporal_appearance_samples) < 64:
                        session.temporal_appearance_samples.append(dict(sample))

                residual_overlap_enabled = bool(
                    runtime.get("exactCpuResidualOverlap", False)
                    and not runtime.get("temporalFullDenseFlowResidual", False)
                    and not sparse_mesh_enabled_for_session
                    and not semantic_feature_enabled_for_session
                )
                output_executor = (
                    concurrent.futures.ThreadPoolExecutor(
                        max_workers=1,
                        thread_name_prefix=f"PongResidual-{session.channel}",
                    )
                    if residual_overlap_enabled else None
                )
                # Speculate only the next decoded frame's unchanged CPU LK
                # calculation. The helper is bounded, validates frame/track
                # ownership, and stays disabled for cheap small-frame work.
                tracking_lookahead = TrackingLookahead(_track_landmarks_lk)
                pending_outputs: list[dict[str, Any]] = []

                def render_residual_plan(
                    plan: ResidualWarpPlan,
                    diagnostics: dict[str, Any],
                ) -> tuple[np.ndarray | None, float]:
                    started = time.perf_counter()
                    rendered = _render_prior_swap_residual(
                        plan,
                        diagnostics=diagnostics,
                    )
                    return rendered, time.perf_counter() - started

                def emit_pending_output(record: dict[str, Any]) -> None:
                    rendered = record.get("result")
                    render_seconds = 0.0
                    future = record.get("future")
                    if future is not None:
                        rendered, render_seconds = future.result()
                        session.residual_warp_seconds += render_seconds
                        session.reuse_work_seconds += render_seconds
                    if rendered is None:
                        raise RuntimeError("temporal residual render returned no frame")
                    if session.stop.is_set():
                        return
                    contiguous_output = np.ascontiguousarray(rendered)
                    if (
                        session.navigation_class in {"seek", "foreground"}
                        and int(record.get("frameIndex", -1)) == 0
                        and not session.first_rendered_frame_webp
                    ):
                        _start_seek_preview(session, contiguous_output, bool(record.get("transformed")))
                    encoder_write_started = time.perf_counter()
                    process.stdin.write(memoryview(contiguous_output).cast("B"))
                    if record.get("transformed"):
                        session.transformed_frames += 1
                        from pong_frame_ranges import append_transformed_range
                        append_transformed_range(session.transformed_frame_ranges, record["frameIndex"])
                    encoder_write_seconds = (
                        time.perf_counter() - encoder_write_started
                    )
                    session.encoder_write_seconds += encoder_write_seconds
                    session.frame_work_seconds += float(
                        record.get("frameWorkSeconds", 0.0)
                    ) + render_seconds + encoder_write_seconds

                def flush_pending_outputs() -> None:
                    while pending_outputs:
                        emit_pending_output(pending_outputs.pop(0))

                acquisition_hold_frames = (
                    3
                    if session.manual_target_embedding is None
                    and session.manual_target_x is None
                    and session.manual_target_y is None
                    else 0
                )

                def backfill_automatic_acquisition_frames() -> None:
                    """Swap a tiny held entry window after automatic identity acquisition."""

                    if not acquisition_hold_frames or anchor is None:
                        return
                    target_presentation = tracking_state.get("targetPresentation")
                    for record in pending_outputs:
                        input_frame = record.pop("inputFrame", None)
                        if input_frame is None or not record.get("compatibilityPassthrough"):
                            continue
                        evidence = FrameEvidence(
                            frame_index=int(record.get("frameIndex", -1)),
                            media_time_seconds=float(record.get("timelineSeconds", 0.0)),
                        )
                        backfill_tracking = {
                            "targetPresentation": target_presentation,
                            # Keep the confirmed automatic anchor immutable while
                            # rendering earlier frames out of chronological order.
                            "manualTargetIdentityLock": True,
                        }
                        started = time.perf_counter()
                        rendered, _ = self._run_gpu_work(
                            self._process_frame_to_rgb,
                            input_frame,
                            source_embedding,
                            np.asarray(anchor, dtype=np.float32).copy(),
                            priority=0,
                            queue_cancel_event=session.stop,
                            cancelled_value=(None, anchor),
                            work_label="automatic-acquisition-backfill",
                            source_frame=source_frame,
                            verify_identity=True,
                            tracking_state=backfill_tracking,
                            cancel_event=session.stop,
                            config=session_config,
                            diagnostics=None,
                            temporal_context=None,
                            frame_evidence=evidence,
                        )
                        if rendered is not None:
                            record["result"] = rendered
                            record["future"] = None
                            record["transformed"] = True
                            frame_index = int(record.get("frameIndex", -1))
                            if frame_index >= 0:
                                session.automatic_acquisition_backfilled_frames.append(
                                    frame_index
                                )
                        record["frameWorkSeconds"] = float(
                            record.get("frameWorkSeconds", 0.0)
                        ) + (time.perf_counter() - started)

                try:
                    while not session.stop.is_set():
                        try:
                            decoded_item = decode_queue.get(timeout=0.10)
                        except queue.Empty:
                            if not decoder.is_alive():
                                break
                            continue
                        if decoded_item is decode_sentinel:
                            break
                        if isinstance(decoded_item, BaseException):
                            raise decoded_item
                        frame, decoded_timeline_seconds = decoded_item
                        if session.stop.is_set():
                            break
                        # A progress-bar gesture needs WebView/compositor GPU
                        # responsiveness more than additional old-timeline
                        # headroom. Finish at most the in-flight frame, then
                        # yield until the replacement activates or a failed
                        # seek explicitly resumes this session.
                        while session.scrub_suspended.is_set() and not session.stop.is_set():
                            with session.condition:
                                session.condition.wait(timeout=0.025)
                        if session.stop.is_set():
                            break
                        timeline_reliable = False
                        timeline_seconds = session.frames / fps
                        if decoded_timeline_seconds is not None:
                            try:
                                decoded_time = float(decoded_timeline_seconds)
                                if math.isfinite(decoded_time):
                                    timeline_seconds = decoded_time
                                    timeline_reliable = True
                            except (TypeError, ValueError, OverflowError):
                                timeline_reliable = False
                        frame_delta_seconds = 1.0 / max(1.0, fps)
                        pts_discontinuity = not timeline_reliable
                        if timeline_reliable and previous_timeline_seconds is not None:
                            pts_delta = timeline_seconds - previous_timeline_seconds
                            max_pts_gap = max(
                                3.5 / max(1.0, fps),
                                float(runtime.get("temporalMaxPtsGapSeconds", 0.25)),
                            )
                            pts_discontinuity = bool(
                                not math.isfinite(pts_delta)
                                or pts_delta <= 0.0
                                or pts_delta > max_pts_gap
                            )
                            if not pts_discontinuity:
                                frame_delta_seconds = pts_delta
                        if pts_discontinuity:
                            invalidate_temporal_chain(
                                clear_tracking=True,
                                reason="pts-discontinuity",
                            )
                        previous_timeline_seconds = (
                            timeline_seconds if timeline_reliable else None
                        )
                        if (
                            session.prefetch_gate_owned
                            and (
                                session.activation_requested
                                or session.playback_started_at
                                or not session.prefetch
                            )
                        ):
                            self._release_prefetch_admission(session)
                        if session.prefetch and not session.playback_started_at:
                            while not session.stop.is_set():
                                with session.condition:
                                    if session.activation_requested:
                                        session.playback_started_at = time.monotonic()
                                        session.prefetch = False
                                        self._release_prefetch_admission(session)
                                        session.condition.notify_all()
                                        break
                                    # Reaching the requested frame count is not
                                    # enough: the stdout reader must have parsed
                                    # a complete moof followed by its complete
                                    # mdat payload. Continue producing until
                                    # both the temporal and container boundaries
                                    # are satisfied.
                                    if not self._prefetch_has_safe_lead(session):
                                        break
                                    self._release_prefetch_admission(session)
                                    session.condition.wait(timeout=0.20)
                            if session.stop.is_set():
                                break

                        # Keep only a small ephemeral lead on disk.  Without this
                        # gate a fast RTX GPU can encode several minutes while the
                        # phone has played only a few seconds, wasting storage and
                        # making a reconnect unnecessarily expensive.
                        # Pace against complete encoded media and the browser's
                        # sparse playback position. A paused/background reader
                        # therefore stops consuming credit instead of silently
                        # drifting forward on a server wall clock.
                        pacing_wait_started = time.perf_counter()
                        while not session.stop.is_set():
                            # Do not let an early pause/load event cap a low-
                            # entropy stream at a tiny body Android WebView has
                            # already proven it may reject as FORMAT_ERROR.
                            # This bypass ends as soon as the measured startup
                            # byte floor and a complete fragment are available.
                            if not session.browser_startup_ready():
                                break
                            produced_seconds = self._playable_media_seconds(session)
                            played_seconds = (
                                self._estimated_playback_position_seconds(
                                    session,
                                    time.monotonic(),
                                )
                                if session.playback_started_at
                                else 0.0
                            )
                            excess_lead = (
                                produced_seconds
                                - played_seconds
                                - render_ahead_ceiling_seconds(
                                    base_seconds=lead_buffer_seconds,
                                    max_foreground_seconds=max(12.0, lead_buffer_seconds),
                                    foreground_pacing_wait_seconds=session.foreground_pacing_wait_seconds,
                                    active_foreground=bool(session.playback_started_at and session.activation_requested and not session.prefetch),
                                    playback_paused=session.playback_paused,
                                    startup_ready=True,
                                    scrub_suspended=session.scrub_suspended.is_set(),
                                )
                            )
                            session.render_ahead_ceiling_seconds = produced_seconds - played_seconds - excess_lead
                            if excess_lead <= 0:
                                break
                            bank_idle_time = bool(
                                session.playback_started_at and session.activation_requested
                                and not session.prefetch and not session.playback_paused
                                and not session.scrub_suspended.is_set()
                            )
                            lead_wait_started = time.perf_counter()
                            with session.condition:
                                session.condition.wait(
                                    timeout=min(0.05, max(0.005, excess_lead)),
                                )
                            if bank_idle_time and not session.playback_paused and not session.scrub_suspended.is_set():
                                session.foreground_pacing_wait_seconds += time.perf_counter() - lead_wait_started
                        session.pacing_wait_seconds += (
                            time.perf_counter() - pacing_wait_started
                        )
                        if session.stop.is_set():
                            break
                        # The prefetch gate still admits only one speculative
                        # producer, but frame-level priority belongs to a viewed
                        # stream until its safety buffer is healthy.  Waiting
                        # outside process_frame's global model lock prevents a
                        # fast prefetch loop from starving the growing fMP4 and
                        # making Android WebView seek back to its live edge.
                        self._yield_prefetch_for_foreground(session)
                        if session.stop.is_set():
                            break
                        if pending_source_switch is not None:
                            next_candidate, next_similarity = pending_source_switch
                            pending_source_switch = None
                            source_embedding = next_candidate.embedding
                            source_frame = next_candidate.source_frame
                            session.face_id = next_candidate.face_id
                            session.selected_face_id = next_candidate.face_id
                            apply_face_restoration(session_config, next_candidate.face_id)
                            session.selected_face_similarity = float(next_similarity)
                            tracking_state["sourcePresentation"] = (
                                next_candidate.presentation
                            )
                            # Retain the immutable target-person anchor and its
                            # geometric track, but prevent any temporal output
                            # made with the prior approved source from crossing
                            # this boundary.
                            invalidate_temporal_chain(
                                clear_tracking=False,
                                reason="approved-source-switch",
                            )
                        if not session.first_source_frame_at:
                            session.first_source_frame_at = time.time()
                        frame_work_started = time.perf_counter()
                        # Prove the immutable target identity on every exact
                        # anchor. Between anchors, the temporal path advances
                        # the already-verified face only while its geometry and
                        # appearance remain continuous; any uncertainty falls
                        # back to an exact all-face identity check.
                        verify_identity = bool(
                            session.frames % identity_interval == 0
                        )
                        restorer_anchor_hz = max(
                            0.25,
                            float(runtime.get("temporalRestorerAnchorHz", 3.0)),
                        )
                        temporal_context["frameIndex"] = int(session.frames)
                        temporal_context["mediaTimeSeconds"] = float(timeline_seconds)
                        temporal_context["nominalFrameSeconds"] = frame_delta_seconds
                        temporal_context["frameDependencyAnchorFrame"] = int(session.frames)
                        temporal_context["frameDependencyAnchorTimeSeconds"] = float(timeline_seconds)
                        temporal_context["frameHadStageReuse"] = False
                        temporal_context["maxAnchorFrames"] = max(
                            1,
                            int(math.ceil(fps / restorer_anchor_hz)),
                        )
                        force_exact_reasons = []
                        if verify_identity:
                            force_exact_reasons.append("identity-deadline")
                        if pts_discontinuity:
                            force_exact_reasons.append("pts-discontinuity")
                        force_exact_reasons.extend(
                            str(reason)
                            for reason in temporal_context.pop(
                                "pendingInvalidationReasons", []
                            )
                            if reason
                        )
                        # Preserve insertion order while removing duplicates so
                        # stage provenance has a stable primary reason.
                        temporal_context["forceExactReasons"] = list(
                            dict.fromkeys(force_exact_reasons)
                        )
                        temporal_context["forceExact"] = bool(
                            temporal_context["forceExactReasons"]
                        )
                        tracking_state['frameDeltaSeconds'] = frame_delta_seconds
                        frame_evidence = FrameEvidence(
                            frame_index=int(session.frames),
                            media_time_seconds=float(timeline_seconds),
                            prior_track_revision=int(
                                tracking_state.get("trackRevision", 0)
                            ),
                        )
                        output_frame = None
                        output_future = None
                        frame_was_transformed = False
                        compatibility_passthrough = False
                        identity_just_locked = False
                        if (
                            not identity_locked
                            and int(session.frames) >= int(next_compatibility_probe_frame)
                        ):
                            session.compatibility_checks += 1
                            selection = self._run_gpu_work(
                                self._select_compatible_identity_for_frame,
                                frame,
                                candidates,
                                session_config,
                                frame_evidence,
                                session.stop,
                                (
                                    (session.manual_target_x, session.manual_target_y)
                                    if session.manual_target_x is not None
                                    and session.manual_target_y is not None
                                    else None
                                ),
                                session.manual_target_embedding,
                                session.manual_target_presentation,
                                priority=(10 if session.prefetch else 0),
                                queue_cancel_event=session.stop,
                                cancelled_value=None,
                                work_label="identity-compatibility",
                                multi_source_face_id=self._multi_video_sources.bind(multi_choice_key),
                            )
                            if multi_face_consensus is not None:
                                session.multi_face_decision = getattr(frame_evidence, "multi_face_decision", {})
                                selection = multi_face_consensus.observe(selection, float(timeline_seconds))
                                if selection is not None:
                                    bound = self._multi_video_sources.bind(multi_choice_key, selection.candidate.face_id)
                                    if bound != selection.candidate.face_id:
                                        # Another prepared session established this video's
                                        # source while inference was in flight. Reacquire the
                                        # bound source; never paint a transient different face.
                                        multi_face_consensus = MultiFaceConsensus()
                                        selection = None
                                    else:
                                        session.multi_face_decision = {**session.multi_face_decision, "reason": "locked-for-video", "sourceChoiceRetainedAcrossSeeks": multi_choice_key is not None}
                            if selection is not None:
                                identity_locked = True
                                identity_just_locked = True
                                source_embedding = selection.candidate.embedding
                                source_frame = selection.candidate.source_frame
                                anchor = np.asarray(
                                    session.manual_target_embedding
                                    if session.manual_target_embedding is not None
                                    else selection.target.embedding,
                                    dtype=np.float32,
                                ).reshape(-1).copy()
                                tracking_state["targetIdentityAnchor"] = anchor.copy()
                                tracking_state["targetIdentityGallery"] = [anchor.copy()]
                                session.face_id = selection.candidate.face_id
                                session.selected_face_id = selection.candidate.face_id
                                apply_face_restoration(session_config, selection.candidate.face_id)
                                session.selected_face_similarity = float(selection.similarity)
                                locked_target_presentation = (
                                    session.manual_target_presentation
                                    if isinstance(
                                        session.manual_target_presentation,
                                        FacePresentation,
                                    )
                                    else selection.target.presentation
                                )
                                session.selected_target_presentation = (
                                    locked_target_presentation.label
                                )
                                if session.manual_target_embedding is None:
                                    session.automatic_target_lock_frame = int(
                                        session.frames
                                    )
                                    session.automatic_target_lock_seconds = float(
                                        timeline_seconds
                                    )
                                session.compatibility_status = "locked"
                                tracking_state["targetPresentation"] = (
                                    locked_target_presentation
                                )
                                tracking_state["lastTargetVerifiedFrame"] = int(
                                    session.frames
                                )
                                tracking_state["sourcePresentation"] = (
                                    selection.candidate.presentation
                                )
                                # The tap is used once to acquire a person.
                                # Persist that person's recognized identity so
                                # later motion cannot move the swap to a nearby
                                # face. Loss fails closed until they return.
                                if session.manual_target_embedding is not None:
                                    tracking_state["manualTargetIdentityLock"] = True
                                    tracking_state["manualTargetEmbedding"] = np.asarray(
                                        session.manual_target_embedding,
                                        dtype=np.float32,
                                    )
                                switch_challenger_id = ""
                                switch_challenger_confirmations = 0
                            else:
                                session.compatibility_rejections += 1
                                session.compatibility_status = "no-compatible-face"
                                # Foreground acquisition checks every frame so
                                # the first confident appearance is not skipped
                                # between 5 Hz probes. Speculative work remains
                                # sparse because it is not yet user-visible.
                                next_compatibility_probe_frame = int(session.frames) + acquisition_probe_step(
                                    fps, session.prefetch,
                                    multi_face_consensus is not None and multi_face_consensus.pending is not None,
                                )
                        if not identity_locked:
                            output_frame = np.ascontiguousarray(frame)
                            if output_frame.shape[:2] != (output_height, output_width):
                                output_frame = cv2.resize(
                                    output_frame,
                                    (output_width, output_height),
                                    interpolation=cv2.INTER_LINEAR,
                                )
                            compatibility_passthrough = True
                        output_render_diagnostics: dict[str, Any] | None = None
                        foreground_temporal_reuse = bool(
                            identity_locked
                            and
                            temporal_context.get("enabled")
                            and self._foreground_reuse_allowed_for_source(
                                session,
                                runtime,
                                frame.shape,
                            )
                            and not bool(
                                runtime.get("temporalCurrentGeometryEnabled", False)
                            )
                            and self._session_temporal_frame_may_reuse(
                                session,
                                runtime,
                                verify_identity=verify_identity,
                                last_exact_frame=last_exact_frame,
                                current_timeline_seconds=timeline_seconds,
                                last_exact_timeline_seconds=last_exact_timeline_seconds,
                                timeline_reliable=timeline_reliable,
                            )
                        )
                        try:
                            temporal_anchor_frames = max(
                                1,
                                int(
                                    math.ceil(
                                        max(1.0, session.fps)
                                        / max(
                                            0.25,
                                            float(
                                                runtime.get(
                                                    "temporalFullAnchorHz", 5.0
                                                )
                                            ),
                                        )
                                    )
                                ),
                            )
                        except (TypeError, ValueError, OverflowError):
                            temporal_anchor_frames = 1
                        temporal_grace_frame = bool(
                            foreground_temporal_reuse
                            and bool(runtime.get("temporalFullAdaptiveGraceEnabled", False))
                            and int(session.frames) - int(last_exact_frame)
                            == temporal_anchor_frames
                        )
                        legacy_prefetch_reuse = self._prefetch_frame_may_reuse(
                            session,
                            runtime,
                            verify_identity=verify_identity,
                        ) if identity_locked else False
                        current_render_signature = (
                            int(tracking_state.get("trackGeneration", 0)),
                            int(session.config_revision),
                            str(session.face_id),
                            str(parameters.get("SwapperTypeTextSel", "128")),
                            str(parameters.get("RestorerTypeTextSel", "")),
                        )
                        reuse_requested = bool(
                            foreground_temporal_reuse or legacy_prefetch_reuse
                        )
                        reuse_anchor_available = bool(
                            previous_source_frame is not None
                            and previous_swapped_frame is not None
                            and previous_swap_kps is not None
                        )
                        if reuse_requested and not reuse_anchor_available:
                            record_temporal_rejection("missing-anchor")
                        elif reuse_requested and previous_render_signature != current_render_signature:
                            record_temporal_rejection("signature")
                        elif reuse_requested:
                            detect_interval = max(
                                1,
                                int(runtime.get("targetDetectIntervalFrames", 1)),
                            )
                            if foreground_temporal_reuse:
                                detect_interval = max(
                                    detect_interval,
                                    int(temporal_anchor_frames) + 1,
                                )
                            pending_advance = _advance_prefetch_tracking(
                                frame,
                                tracking_state,
                                detect_interval,
                                require_all_observed=foreground_temporal_reuse,
                                commit=False,
                                return_advance=True,
                                frame_evidence=frame_evidence,
                                media_time_seconds=float(timeline_seconds),
                            )
                            if (
                                not isinstance(pending_advance, LandmarkTrackAdvance)
                                and foreground_temporal_reuse
                            ):
                                redetect_started = time.perf_counter()
                                pending_advance = self._run_gpu_work(
                                    self._redetect_landmarks_for_temporal_reuse,
                                    frame,
                                    tracking_state,
                                    priority=(10 if session.prefetch else 0),
                                    queue_cancel_event=session.stop,
                                    cancelled_value=None,
                                    work_label="temporal-redetect",
                                    config=session_config,
                                    cancel_event=session.stop,
                                    frame_evidence=frame_evidence,
                                    media_time_seconds=float(timeline_seconds),
                                )
                                session.redetect_seconds += (
                                    time.perf_counter() - redetect_started
                                )
                                if isinstance(pending_advance, LandmarkTrackAdvance):
                                    session.temporal_redetect_recoveries += 1
                            appearance_diagnostics: dict[str, Any] = {}
                            appearance_started = time.perf_counter()
                            dense_flow_residual = bool(
                                foreground_temporal_reuse
                                and runtime.get("temporalFullDenseFlowResidual", False)
                            )
                            semantic_feature_residual = bool(
                                foreground_temporal_reuse
                                and semantic_feature_enabled_for_session
                            )
                            sparse_mesh_residual = bool(
                                foreground_temporal_reuse
                                and sparse_mesh_enabled_for_session
                            )
                            appearance_safe = bool(
                                isinstance(pending_advance, LandmarkTrackAdvance)
                                and (
                                    dense_flow_residual
                                    or
                                    sparse_mesh_residual
                                    or
                                    not foreground_temporal_reuse
                                    or _full_frame_reuse_appearance_is_safe(
                                        frame,
                                        previous_source_frame,
                                        previous_swap_kps,
                                        pending_advance.points,
                                        max_face_mae=float(runtime.get("temporalFullMaxFaceMae", 14.0)),
                                        max_face_p90=float(runtime.get("temporalFullMaxFaceP90", 32.0)),
                                        max_patch_mae=float(runtime.get("temporalFullMaxPatchMae", 46.0)),
                                        diagnostics=appearance_diagnostics,
                                    )
                                )
                            )
                            if isinstance(pending_advance, LandmarkTrackAdvance):
                                session.appearance_guard_seconds += (
                                    time.perf_counter() - appearance_started
                                )
                            if not isinstance(pending_advance, LandmarkTrackAdvance):
                                record_temporal_rejection("tracking")
                            elif not appearance_safe:
                                record_temporal_rejection(
                                    str(appearance_diagnostics.get("reason") or "appearance"),
                                    appearance_diagnostics,
                                )
                            else:
                                warp_started = time.perf_counter()
                                warp_diagnostics: dict[str, Any] = {}
                                next_sparse_mesh_state = None
                                if semantic_feature_residual:
                                    # The semantic feature path used to be
                                    # warmed and rebased below but was never
                                    # selected here, so enabling its setting
                                    # could not affect a live frame. Keep the
                                    # established whole-face residual as the
                                    # authoritative result, then admit only
                                    # appearance-safe eye/nose/mouth islands.
                                    # Any missing or unsafe semantic evidence
                                    # falls back inside the helper without
                                    # interrupting playback.
                                    output_frame, next_sparse_mesh_state = (
                                        _warp_prior_swap_with_semantic_features(
                                            frame,
                                            previous_source_frame,
                                            previous_swapped_frame,
                                            previous_swap_kps,
                                            pending_advance.points,
                                            tracking_state.get("sparseResidualMesh"),
                                            max_landmark_residual_ratio=float(
                                                runtime.get(
                                                    "temporalFullMaxLandmarkResidualRatio",
                                                    0.12,
                                                )
                                            ),
                                            interpolation=(
                                                cv2.INTER_CUBIC
                                                if bool(runtime.get(
                                                    "temporalFullBicubicResidual",
                                                    False,
                                                ))
                                                else cv2.INTER_LINEAR
                                            ),
                                            feature_strength=float(runtime.get(
                                                "temporalFullFeaturePatchLockStrength",
                                                0.65,
                                            )),
                                            feature_max_mae=float(runtime.get(
                                                "temporalFullFeaturePatchMaxMae",
                                                16.0,
                                            )),
                                            feature_max_p90=float(runtime.get(
                                                "temporalFullFeaturePatchMaxP90",
                                                34.0,
                                            )),
                                            feature_groups=tuple(
                                                str(value)
                                                for value in runtime.get(
                                                    "temporalSemanticFeatureGroups",
                                                    ("leftEye", "rightEye"),
                                                )
                                            ),
                                            diagnostics=warp_diagnostics,
                                        )
                                    )
                                elif sparse_mesh_residual:
                                    output_frame, next_sparse_mesh_state = (
                                        _warp_prior_swap_residual_sparse_mesh(
                                            frame,
                                            previous_source_frame,
                                            previous_swapped_frame,
                                            previous_swap_kps,
                                            pending_advance.points,
                                            tracking_state.get("sparseResidualMesh"),
                                            mesh_size=int(
                                                runtime.get("temporalFullSparseMeshSize", 128)
                                            ),
                                            diagnostics=warp_diagnostics,
                                        )
                                    )
                                elif dense_flow_residual:
                                    output_frame = _warp_prior_swap_residual_dense_flow(
                                        frame,
                                        previous_source_frame,
                                        previous_swapped_frame,
                                        previous_swap_kps,
                                        pending_advance.points,
                                        flow_size=int(
                                            runtime.get("temporalFullDenseFlowSize", 192)
                                        ),
                                        diagnostics=warp_diagnostics,
                                    )
                                else:
                                    current_canonical_transform = None
                                    canonical_transport_enabled = bool(
                                        runtime.get(
                                            "temporalCanonicalResidualTransport",
                                            False,
                                        )
                                    )
                                    if bool(runtime.get(
                                        "temporalCanonicalResidualLowMotionOnly", False
                                    )):
                                        canonical_transport_enabled = bool(
                                            canonical_transport_enabled
                                            and _selected_adaptive_mask_backend(
                                                runtime, tracking_state
                                            ) == "trt"
                                        )
                                    if (
                                        canonical_transport_enabled
                                        and previous_canonical_transform is not None
                                    ):
                                        try:
                                            current_canonical_transform, _pipeline_size = (
                                                self._vm.canonical_face_transform_matrix(
                                                    pending_advance.points,
                                                    parameters,
                                                )
                                            )
                                        except (TypeError, ValueError, ArithmeticError):
                                            current_canonical_transform = None
                                    residual_arguments = {
                                        "max_landmark_residual_ratio": float(
                                            runtime.get(
                                                "temporalFullMaxLandmarkResidualRatio",
                                                0.12,
                                            )
                                        ),
                                        "interpolation": (
                                            cv2.INTER_CUBIC
                                            if bool(runtime.get(
                                                "temporalFullBicubicResidual", False
                                            ))
                                            else cv2.INTER_LINEAR
                                        ),
                                        "continuous_linear": bool(
                                            runtime.get(
                                                "temporalContinuousResidualWarp",
                                                False,
                                            )
                                        ),
                                        "feature_patch_lock_strength": (
                                            float(runtime.get(
                                                "temporalFullFeaturePatchLockStrength",
                                                0.0,
                                            ))
                                            if bool(runtime.get(
                                                "temporalFullFeaturePatchLockEnabled",
                                                False,
                                            ))
                                            else 0.0
                                        ),
                                        "feature_patch_max_mae": float(
                                            runtime.get(
                                                "temporalFullFeaturePatchMaxMae", 16.0
                                            )
                                        ),
                                        "feature_patch_max_p90": float(
                                            runtime.get(
                                                "temporalFullFeaturePatchMaxP90", 34.0
                                            )
                                        ),
                                        "source_to_canonical": previous_canonical_transform,
                                        "target_to_canonical": current_canonical_transform,
                                        "canonical_blend_weight": float(runtime.get(
                                            "temporalCanonicalResidualBlendWeight", 1.0
                                        )),
                                        "pose_aware_affine": bool(runtime.get(
                                            "temporalPoseAwareAffineResidual", False
                                        )),
                                        "pose_aware_affine_max_anisotropy": float(
                                            runtime.get(
                                                "temporalPoseAwareAffineMaxAnisotropy",
                                                1.12,
                                            )
                                        ),
                                        "pose_aware_affine_min_improvement": float(
                                            runtime.get(
                                                "temporalPoseAwareAffineMinImprovement",
                                                0.12,
                                            )
                                        ),
                                        "pose_aware_affine_min_residual_ratio": float(
                                            runtime.get(
                                                "temporalPoseAwareAffineMinResidualRatio",
                                                0.008,
                                            )
                                        ),
                                        "diagnostics": warp_diagnostics,
                                    }
                                    if residual_overlap_enabled:
                                        output_frame = _plan_prior_swap_residual(
                                            frame,
                                            previous_source_frame,
                                            previous_swapped_frame,
                                            previous_swap_kps,
                                            pending_advance.points,
                                            **residual_arguments,
                                        )
                                    else:
                                        output_frame = _warp_prior_swap_residual(
                                            frame,
                                            previous_source_frame,
                                            previous_swapped_frame,
                                            previous_swap_kps,
                                            pending_advance.points,
                                            **residual_arguments,
                                        )
                                _record_adaptive_mask_motion(
                                    runtime,
                                    tracking_state,
                                    warp_diagnostics,
                                )
                                if output_frame is not None and temporal_grace_frame:
                                    grace_safe = bool(
                                        float(appearance_diagnostics.get("faceMae", math.inf))
                                        <= float(runtime.get("temporalFullMaxFaceMae", 14.0)) * 0.5
                                        and float(appearance_diagnostics.get("faceP90", math.inf))
                                        <= float(runtime.get("temporalFullMaxFaceP90", 32.0)) * 0.5
                                        and float(appearance_diagnostics.get("patchMae", math.inf))
                                        <= float(runtime.get("temporalFullMaxPatchMae", 46.0)) * 0.5
                                        and float(warp_diagnostics.get("landmarkResidualRatio", math.inf))
                                        <= min(
                                            0.015,
                                            float(
                                                runtime.get(
                                                    "temporalFullMaxLandmarkResidualRatio",
                                                    0.12,
                                                )
                                            ) * 0.5,
                                        )
                                    )
                                    if not grace_safe:
                                        output_frame = None
                                        record_temporal_rejection("adaptive-grace")
                                session.residual_warp_seconds += (
                                    time.perf_counter() - warp_started
                                )
                                if output_frame is not None:
                                    if next_sparse_mesh_state is not None:
                                        tracking_state["sparseResidualMesh"] = next_sparse_mesh_state
                                    _commit_tracking_advance(
                                        tracking_state,
                                        pending_advance,
                                    )
                                    if (
                                        residual_overlap_enabled
                                        and output_executor is not None
                                        and isinstance(output_frame, ResidualWarpPlan)
                                    ):
                                        output_render_diagnostics = warp_diagnostics
                                        output_future = output_executor.submit(
                                            render_residual_plan,
                                            output_frame,
                                            output_render_diagnostics,
                                        )
                                        output_frame = None
                                else:
                                    record_temporal_rejection(
                                        str(warp_diagnostics.get("reason") or "warp"),
                                        warp_diagnostics,
                                    )
                            # The legacy prefetch-only shortcut must not cross a
                            # promotion boundary. The quality-gated temporal
                            # path is explicitly valid for foreground playback.
                            if (
                                not foreground_temporal_reuse
                                and (session.activation_requested or session.playback_started_at)
                            ):
                                if output_future is not None:
                                    _discard_residual_future_for_promotion(
                                        output_future
                                    )
                                    output_future = None
                                output_frame = None
                        if output_frame is None and output_future is None:
                            exact_work_started = time.perf_counter()
                            temporal_context.pop("fullCanonicalTransform", None)
                            temporal_context.pop("fullCanonicalPipelineSize", None)
                            next_tracking_frame = None
                            if not session.prefetch:
                                # Never wait for another frame or remove it from
                                # the decoder. First-frame and seek latency keep
                                # their ordinary immediate rendering path.
                                with decode_queue.mutex:
                                    next_decoded = (
                                        decode_queue.queue[0]
                                        if decode_queue.queue else None
                                    )
                                    if isinstance(next_decoded, tuple):
                                        next_tracking_frame = next_decoded[0]
                            try:
                                output_frame, anchor = self._run_gpu_work(
                                    self._process_frame_to_rgb,
                                    frame,
                                    source_embedding,
                                    anchor,
                                    priority=(10 if session.prefetch else 0),
                                    queue_cancel_event=session.stop,
                                    cancelled_value=(None, anchor),
                                    work_label="frame-render",
                                    tracking_lookahead=tracking_lookahead,
                                    next_frame=next_tracking_frame,
                                    source_frame=source_frame,
                                    verify_identity=verify_identity,
                                    tracking_state=tracking_state,
                                    cancel_event=session.stop,
                                    config=session_config,
                                    diagnostics=(
                                        session.frame_diagnostics
                                        if session.diagnostics_enabled
                                        else None
                                    ),
                                    temporal_context=(
                                        temporal_context
                                        if temporal_context.get("enabled")
                                        else None
                                    ),
                                    frame_evidence=frame_evidence,
                                )
                            except Exception as exc:
                                if (
                                    foreground_oom_retry_used
                                    or session.prefetch
                                    or not self._gpu_oom_error(exc)
                                ):
                                    raise
                                # Preserve every configured quality stage. The
                                # visible card gets one retry after optional work
                                # and allocator caches have been reclaimed.
                                foreground_oom_retry_used = True
                                self._record_gpu_oom(session, exc)
                                self._recover_foreground_gpu_memory(session)
                                anchor = None
                                invalidate_temporal_chain(
                                    clear_tracking=True,
                                    reason="gpu-oom-retry",
                                )
                                output_frame, anchor = self._run_gpu_work(
                                    self._process_frame_to_rgb,
                                    frame,
                                    source_embedding,
                                    anchor,
                                    priority=(10 if session.prefetch else 0),
                                    queue_cancel_event=session.stop,
                                    cancelled_value=(None, anchor),
                                    work_label="frame-render-oom-retry",
                                    source_frame=source_frame,
                                    verify_identity=True,
                                    tracking_state=tracking_state,
                                    cancel_event=session.stop,
                                    config=session_config,
                                    diagnostics=(
                                        session.frame_diagnostics
                                        if session.diagnostics_enabled
                                        else None
                                    ),
                                    temporal_context=(
                                        temporal_context
                                        if temporal_context.get("enabled")
                                        else None
                                    ),
                                    frame_evidence=frame_evidence,
                                )
                            if output_frame is None or session.stop.is_set():
                                break
                            session.inference_frames += 1
                            # Re-rank the selected approved faces only when the
                            # existing target-identity verification has already
                            # produced an ArcFace embedding. This is at most five
                            # vector dot products and adds no detector, recognizer,
                            # swapper, or restorer inference. A confirmed change
                            # takes effect on the next frame; the target-person
                            # anchor itself is never replaced.
                            if (
                                identity_locked
                                and len(candidates) > 1
                                and not selected_source_policy.disabled
                                and frame_evidence.selected_target_embedding is not None
                            ):
                                target_presentation = tracking_state.get(
                                    "targetPresentation"
                                )
                                if not isinstance(target_presentation, FacePresentation):
                                    target_presentation = FacePresentation(
                                        str(session.selected_target_presentation or "unknown"),
                                        1.0,
                                    )
                                current_candidate = next(
                                    (
                                        candidate
                                        for candidate in candidates
                                        if candidate.face_id == session.selected_face_id
                                    ),
                                    None,
                                )
                                target_identity = TargetIdentity(
                                    keypoints=np.asarray(
                                        tracking_state.get(
                                            "kps",
                                            np.zeros((5, 2), dtype=np.float32),
                                        ),
                                        dtype=np.float32,
                                    ),
                                    embedding=np.asarray(
                                        frame_evidence.selected_target_embedding,
                                        dtype=np.float32,
                                    ),
                                    presentation=target_presentation,
                                )
                                ranked_sources = compatible_identity_rankings(
                                    candidates,
                                    target_identity,
                                    minimum_similarity=source_match_threshold,
                                    minimum_presentation_confidence=presentation_confidence_for_strictness(
                                        source_match_threshold
                                    ),
                                )
                                best_source = ranked_sources[0] if ranked_sources else None
                                current_similarity = (
                                    rope_similarity(
                                        current_candidate.embedding,
                                        target_identity.embedding,
                                    )
                                    if current_candidate is not None
                                    else -math.inf
                                )
                                if math.isfinite(current_similarity):
                                    session.selected_face_similarity = float(
                                        current_similarity
                                    )
                                should_challenge = bool(
                                    not selected_source_policy.disabled
                                    and current_candidate is not None
                                    and best_source is not None
                                    and best_source.candidate.face_id
                                    != current_candidate.face_id
                                    and best_source.similarity - current_similarity
                                    > selected_source_policy.minimum_gain
                                )
                                if should_challenge:
                                    challenger_id = best_source.candidate.face_id
                                    if challenger_id == switch_challenger_id:
                                        switch_challenger_confirmations += 1
                                    else:
                                        switch_challenger_id = challenger_id
                                        switch_challenger_confirmations = 1
                                    if (
                                        switch_challenger_confirmations
                                        >= selected_source_policy.confirmations
                                    ):
                                        pending_source_switch = (
                                            best_source.candidate,
                                            float(best_source.similarity),
                                        )
                                        switch_challenger_id = ""
                                        switch_challenger_confirmations = 0
                                else:
                                    switch_challenger_id = ""
                                    switch_challenger_confirmations = 0
                            current_kps = tracking_state.get("kps")
                            if identity_locked and frame_evidence.recognition_complete:
                                session.target_identity_checks += 1
                                target_similarity = frame_evidence.selected_target_similarity
                                if current_kps is None or target_similarity is None:
                                    session.target_identity_rejections += 1
                                    samples = session.target_identity_rejection_samples
                                    reasons = list(dict.fromkeys(frame_evidence.rejection_reasons))
                                    if (not samples
                                        or float(timeline_seconds) - samples[-1]["seconds"] >= 0.25
                                        or reasons != samples[-1]["reasons"]):
                                        session.target_identity_rejection_samples.append(
                                            {
                                                "frame": int(session.frames),
                                                "seconds": float(timeline_seconds),
                                                "sourceSeconds": float(session.start_seconds + timeline_seconds),
                                                "detectedFaces": len(frame_evidence.detections),
                                                "bestRawSimilarity": frame_evidence.best_target_raw_similarity,
                                                "bestSimilarity": frame_evidence.best_target_similarity,
                                                "reasons": reasons,
                                            }
                                        )
                                        del samples[:-80]
                                else:
                                    similarity_value = float(target_similarity)
                                    if (
                                        frame_evidence.selected_target_embedding
                                        is not None
                                    ):
                                        tracking_state[
                                            "lastTargetVerifiedFrame"
                                        ] = int(session.frames)
                                    if session.target_identity_min_similarity <= 0:
                                        session.target_identity_min_similarity = similarity_value
                                    else:
                                        session.target_identity_min_similarity = min(
                                            session.target_identity_min_similarity,
                                            similarity_value,
                                        )
                                    session.target_identity_max_similarity = max(
                                        session.target_identity_max_similarity,
                                        similarity_value,
                                    )
                            frame_was_transformed = current_kps is not None
                            if frame_was_transformed and not session.first_transformed_frame_at:
                                session.first_transformed_frame_at = time.time()
                            # PyAV's ndarray and the downloaded CUDA result own
                            # their storage. Retaining those arrays is safe and
                            # avoids two extra full-frame copies on every model
                            # frame; ascontiguousarray copies only an unusual
                            # non-contiguous input.
                            if current_kps is None:
                                invalidate_temporal_chain(
                                    clear_tracking=False,
                                    reason="target-loss",
                                )
                            else:
                                if (
                                    bool(runtime.get(
                                        "temporalExactOutputStabilizationEnabled",
                                        False,
                                    ))
                                    and previous_source_frame is not None
                                    and previous_swapped_frame is not None
                                    and previous_swap_kps is not None
                                    and previous_render_signature
                                    == (
                                        int(tracking_state.get("trackGeneration", 0)),
                                        int(session.config_revision),
                                        str(session.face_id),
                                        str(parameters.get("SwapperTypeTextSel", "128")),
                                        str(parameters.get("RestorerTypeTextSel", "")),
                                    )
                                ):
                                    exact_stabilization_diagnostics = (
                                        {} if session.diagnostics_enabled else None
                                    )
                                    output_frame = _stabilize_exact_output_with_prior(
                                        frame,
                                        output_frame,
                                        previous_source_frame,
                                        previous_swapped_frame,
                                        previous_swap_kps,
                                        np.asarray(current_kps, dtype=np.float32),
                                        current_weight=float(runtime.get(
                                            "temporalExactOutputCurrentWeight", 0.85
                                        )),
                                        max_face_mae=float(runtime.get(
                                            "temporalFullMaxFaceMae", 14.0
                                        )),
                                        max_face_p90=float(runtime.get(
                                            "temporalFullMaxFaceP90", 32.0
                                        )),
                                        max_patch_mae=float(runtime.get(
                                            "temporalFullMaxPatchMae", 46.0
                                        )),
                                        max_landmark_residual_ratio=float(runtime.get(
                                            "temporalFullMaxLandmarkResidualRatio", 0.12
                                        )),
                                        dense_flow=bool(runtime.get(
                                            "temporalExactOutputDenseFlowEnabled", False
                                        )),
                                        delta_seconds=frame_delta_seconds,
                                        half_life_seconds=float(runtime.get(
                                            "temporalExactOutputHalfLifeSeconds", 0.020
                                        )),
                                        local_change_low=float(runtime.get(
                                            "temporalExactOutputLocalChangeLow", 3.0
                                        )),
                                        local_change_high=float(runtime.get(
                                            "temporalExactOutputLocalChangeHigh", 18.0
                                        )),
                                        motion_low_per_second=float(runtime.get(
                                            "temporalExactOutputMotionLowPerSecond", 0.20
                                        )),
                                        motion_high_per_second=float(runtime.get(
                                            "temporalExactOutputMotionHighPerSecond", 1.50
                                        )),
                                        pose_aware_affine=bool(runtime.get(
                                            "temporalExactOutputPoseAwareAffine", True
                                        )),
                                        diagnostics=exact_stabilization_diagnostics,
                                    )
                                    if exact_stabilization_diagnostics is not None:
                                        for key, value in (
                                            exact_stabilization_diagnostics.items()
                                        ):
                                            session.frame_diagnostics.setdefault(
                                                key, []
                                            ).append(value)
                                if (
                                    bool(runtime.get(
                                        "temporalExactMouthStabilizationEnabled",
                                        False,
                                    ))
                                    and previous_source_frame is not None
                                    and previous_swapped_frame is not None
                                    and previous_swap_kps is not None
                                    and previous_render_signature
                                    == (
                                        int(tracking_state.get("trackGeneration", 0)),
                                        int(session.config_revision),
                                        str(session.face_id),
                                        str(parameters.get("SwapperTypeTextSel", "128")),
                                        str(parameters.get("RestorerTypeTextSel", "")),
                                    )
                                ):
                                    mouth_diagnostics: dict[str, Any] = {}
                                    output_frame = _stabilize_exact_mouth_with_prior(
                                        frame,
                                        output_frame,
                                        previous_source_frame,
                                        previous_swapped_frame,
                                        previous_swap_kps,
                                        np.asarray(current_kps, dtype=np.float32),
                                        current_weight=float(runtime.get(
                                            "temporalExactMouthCurrentWeight", 0.80
                                        )),
                                        max_mae=float(runtime.get(
                                            "temporalExactMouthMaxMae", 10.0
                                        )),
                                        max_p90=float(runtime.get(
                                            "temporalExactMouthMaxP90", 24.0
                                        )),
                                        diagnostics=mouth_diagnostics,
                                    )
                                    if session.diagnostics_enabled:
                                        for key, value in mouth_diagnostics.items():
                                            session.frame_diagnostics.setdefault(
                                                key, []
                                            ).append(value)
                                previous_source_frame = np.ascontiguousarray(frame)
                                previous_swapped_frame = np.ascontiguousarray(output_frame)
                                previous_swap_kps = np.asarray(
                                    current_kps,
                                    dtype=np.float32,
                                ).copy()
                                exact_canonical_transform = temporal_context.get(
                                    "fullCanonicalTransform"
                                )
                                if exact_canonical_transform is None:
                                    previous_canonical_transform = None
                                else:
                                    canonical_matrix = np.asarray(
                                        exact_canonical_transform,
                                        dtype=np.float64,
                                    )
                                    previous_canonical_transform = (
                                        canonical_matrix.copy()
                                        if canonical_matrix.shape == (3, 3)
                                        and np.isfinite(canonical_matrix).all()
                                        else None
                                    )
                                if bool(
                                    sparse_mesh_enabled_for_session
                                    or semantic_feature_enabled_for_session
                                ):
                                    semantic_landmarks = None
                                    refresh_due = bool(
                                        semantic_landmark_estimator is not None
                                        and session.frames - last_semantic_refresh_frame
                                        >= semantic_refresh_frames
                                    )
                                    if refresh_due:
                                        try:
                                            semantic_result = self._run_gpu_work(
                                                semantic_landmark_estimator.detect,
                                                frame,
                                                current_kps,
                                                priority=(10 if session.prefetch else 0),
                                                queue_cancel_event=session.stop,
                                                cancelled_value=None,
                                                work_label="semantic-landmarks",
                                            )
                                            if semantic_result is not None:
                                                session.semantic_landmark_seconds += max(
                                                    0.0,
                                                    float(semantic_result.inference_ms)
                                                    / 1000.0,
                                                )
                                                session.semantic_landmark_last_score = float(
                                                    semantic_result.score
                                                )
                                                session.semantic_landmark_provider = str(
                                                    semantic_result.provider
                                                )
                                                tracking_state[
                                                    "semanticLandmarkProvider"
                                                ] = str(semantic_result.provider)
                                                tracking_state[
                                                    "semanticLandmarkInferenceMs"
                                                ] = float(semantic_result.inference_ms)
                                                tracking_state[
                                                    "semanticLandmarkScore"
                                                ] = float(semantic_result.score)
                                                if float(semantic_result.score) >= float(
                                                    runtime.get(
                                                        "temporalSemanticMinimumScore",
                                                        0.75,
                                                    )
                                                ):
                                                    semantic_landmarks = (
                                                        semantic_result.points
                                                    )
                                                    last_semantic_refresh_frame = int(
                                                        session.frames
                                                    )
                                                    tracking_state[
                                                        "semanticLandmarkRefreshes"
                                                    ] = int(
                                                        tracking_state.get(
                                                            "semanticLandmarkRefreshes",
                                                            0,
                                                        )
                                                    ) + 1
                                                    session.semantic_landmark_refreshes += 1
                                                else:
                                                    session.semantic_landmark_failures += 1
                                                    record_temporal_rejection(
                                                        "semantic-landmark-score",
                                                        {
                                                            "score": float(
                                                                semantic_result.score
                                                            )
                                                        },
                                                    )
                                        except Exception as exc:
                                            # Semantic refresh is a sparse
                                            # stabilizer, never a reason to stop
                                            # playback. Keep the last valid mesh
                                            # and retry at the next exact anchor.
                                            tracking_state[
                                                "semanticLandmarkError"
                                            ] = f"{type(exc).__name__}: {exc}"
                                            session.semantic_landmark_failures += 1
                                            record_temporal_rejection(
                                                "semantic-landmark-error"
                                            )
                                    tracking_state["sparseResidualMesh"] = (
                                        _rebase_sparse_residual_mesh(
                                            frame,
                                            current_kps,
                                            tracking_state.get(
                                                "sparseResidualMesh"
                                            ),
                                            semantic_landmarks=semantic_landmarks,
                                            maximum_features=(
                                                0
                                                if semantic_feature_enabled_for_session
                                                else 40
                                            ),
                                            semantic_indices_to_keep=(
                                                np.arange(36, 48, dtype=np.int16)
                                                if semantic_feature_enabled_for_session
                                                and set(
                                                    str(value)
                                                    for value in runtime.get(
                                                        "temporalSemanticFeatureGroups",
                                                        ("leftEye", "rightEye"),
                                                    )
                                                )
                                                == {"leftEye", "rightEye"}
                                                else None
                                            ),
                                        )
                                    )
                                last_exact_frame = int(
                                    temporal_context.get(
                                        "frameDependencyAnchorFrame",
                                        session.frames,
                                    )
                                )
                                try:
                                    last_exact_timeline_seconds = float(
                                        temporal_context.get(
                                            "frameDependencyAnchorTimeSeconds",
                                            timeline_seconds,
                                        )
                                    )
                                except (TypeError, ValueError, OverflowError):
                                    last_exact_timeline_seconds = None
                                previous_render_signature = (
                                    int(tracking_state.get("trackGeneration", 0)),
                                    int(session.config_revision),
                                    str(session.face_id),
                                    str(parameters.get("SwapperTypeTextSel", "128")),
                                    str(parameters.get("RestorerTypeTextSel", "")),
                                )
                            session.exact_work_seconds += (
                                time.perf_counter() - exact_work_started
                            )
                        elif not compatibility_passthrough:
                            frame_was_transformed = True
                            session.temporal_reuse_frames += 1
                            session.reuse_work_seconds += (
                                time.perf_counter() - frame_work_started
                            )
                        pending_outputs.append({
                            "result": output_frame,
                            "future": output_future,
                            "transformed": frame_was_transformed,
                            "compatibilityPassthrough": compatibility_passthrough,
                            "inputFrame": (
                                np.ascontiguousarray(frame)
                                if acquisition_hold_frames and not identity_locked
                                else None
                            ),
                            "frameIndex": int(session.frames),
                            "timelineSeconds": float(timeline_seconds),
                            "frameWorkSeconds": (
                                time.perf_counter() - frame_work_started
                            ),
                        })
                        session.frames += 1
                        # Keep encoded output strictly ordered. A reuse frame's
                        # CPU materialization may overlap the next exact GPU
                        # render; the next non-overlapped frame drains both in
                        # original timeline order.
                        if identity_just_locked:
                            backfill_automatic_acquisition_frames()
                            flush_pending_outputs()
                        elif not identity_locked and acquisition_hold_frames:
                            while len(pending_outputs) > acquisition_hold_frames:
                                emit_pending_output(pending_outputs.pop(0))
                        elif not residual_overlap_enabled or output_future is None:
                            flush_pending_outputs()
                    flush_pending_outputs()
                except Exception as exc:
                    if not session.stop.is_set():
                        try:
                            feeder_error.put_nowait(exc)
                        except queue.Full:
                            pass
                finally:
                    tracking_lookahead.close()
                    if output_executor is not None:
                        output_executor.shutdown(
                            wait=True,
                            cancel_futures=True,
                        )
                    self._release_prefetch_admission(session)
                    decode_stop.set()
                    # Decoder owns the container and observes decode_stop at
                    # its next native boundary. Keep BufferedWriter.close
                    # outside the lock because its final flush can briefly wait
                    # for FFmpeg to consume data.
                    if decoder is not threading.current_thread() and decoder.is_alive():
                        decoder.join(timeout=0.75)
                    try:
                        process.stdin.close()
                    except Exception:
                        pass

            feeder = threading.Thread(target=feed, name=f"PongSwapFeed-{session.channel}", daemon=True)
            with session.lifecycle_lock:
                session.feeder = feeder
                if not session.stop.is_set():
                    feeder.start()
            if feeder.ident is None:
                session.state = "stopped"
                return
            if session.spool_path is None:
                raise RuntimeError("swap spool path was not initialized")
            with session.spool_path.open("wb", buffering=0) as spool:
                transport_writer = _FragmentedMp4TransportWriter(
                    spool,
                    minimum_fragment_bytes=int(
                        runtime.get("transportMinimumFragmentBytes", 0) or 0
                    ),
                    padding_interval_fragments=int(
                        runtime.get("transportPaddingIntervalFragments", 1) or 1
                    ),
                    duration_seconds=max(0.0, session.source_duration - session.start_seconds),
                )
                standby_source_requested = False
                while True:
                    # BufferedReader.read(n) waits for the full n bytes on a
                    # pipe. A sub-second preview is often smaller than 256 KiB,
                    # which left playable MP4 bytes trapped inside this reader
                    # forever. os.read returns as soon as any encoder output is
                    # available, allowing the phone to open the first fragment.
                    chunk = os.read(process.stdout.fileno(), 64 * 1024)
                    if not chunk:
                        break
                    complete_fragment = transport_writer.write(chunk)
                    with session.condition:
                        session.bytes_written = transport_writer.bytes_written
                        session.transport_padding_bytes = transport_writer.padding_bytes
                        session.complete_fragments = transport_writer.probe.complete_fragment_count
                        if not session.first_byte_at:
                            session.first_byte_at = time.time()
                        if complete_fragment and not session.media_fragment_ready:
                            session.media_fragment_ready = True
                            session.playable_at = time.time()
                        if not session.stop.is_set():
                            session.state = "streaming"
                        session.condition.notify_all()
                    if (session.media_fragment_ready and not standby_source_requested
                            and not session.prefetch and session.source_duration > 0
                            and not session.stop.is_set()):
                        standby_source_requested = True
                        self._standby_sources.warm(session.source_url)
                complete_fragment = transport_writer.finish()
                if complete_fragment:
                    with session.condition:
                        session.bytes_written = transport_writer.bytes_written
                        session.transport_padding_bytes = transport_writer.padding_bytes
                        session.complete_fragments = transport_writer.probe.complete_fragment_count
                        if not session.media_fragment_ready:
                            session.media_fragment_ready = True
                            session.playable_at = time.time()
                        session.condition.notify_all()
            if feeder is not None:
                feeder.join(timeout=5.0)
            if not feeder_error.empty() and not session.stop.is_set():
                feeder_exception = feeder_error.get_nowait()
                if isinstance(feeder_exception, BaseException):
                    raise feeder_exception
                raise RuntimeError(str(feeder_exception))
            return_code = process.wait(timeout=5.0)
            if stderr_thread is not None:
                stderr_thread.join(timeout=1.0)
            stderr_text = bytes(stderr_tail).decode(
                "utf-8",
                errors="replace",
            ).strip()
            if return_code and not session.stop.is_set():
                raise RuntimeError(stderr_text or f"ffmpeg exited with status {return_code}")
            session.state = "stopped" if session.stop.is_set() else "finished"
        except Exception as exc:
            if session.stop.is_set():
                session.state = "stopped"
            else:
                session.error = f"{type(exc).__name__}: {exc}"
                if self._gpu_oom_error(exc):
                    session.error_code = "GPU_OOM"
                    self._record_gpu_oom(session, exc)
                elif isinstance(exc, ValueError) and "No usable face was detected" in str(exc):
                    session.error_code = "FACE_SOURCE_INVALID"
                else:
                    session.error_code = "SWAP_FAILED"
                session.state = "error"
                session.stop.set()
        finally:
            decode_stop.set()
            source_open_cancel.set()
            self._release_prefetch_admission(session)
            self._interrupt_session_resources(session)
            if source_opener is not None and source_opener.is_alive():
                source_opener.join(timeout=0.25)
            if stderr_thread is not None and stderr_thread.is_alive():
                stderr_thread.join(timeout=0.5)
            if (
                decoder is not None
                and decoder is not threading.current_thread()
                and decoder.is_alive()
            ):
                decoder.join(timeout=2.0)
            # A winner may be registered before the producer consumes its
            # queue result, leaving local `container` None during cancellation.
            # Publication is closed above, so reclaim the registered resource;
            # never close a container owned by a started native decoder.
            if decoder is None or decoder.ident is None:
                with session.lifecycle_lock:
                    unclaimed_container = session.container
                    session.container = None
                if unclaimed_container is not None:
                    try:
                        unclaimed_container.close()
                    except Exception:
                        pass
            if (
                feeder is not None
                and feeder is not threading.current_thread()
                and feeder.is_alive()
            ):
                feeder.join(timeout=2.0)
            with session.lifecycle_lock:
                if (
                    session.source_opener is source_opener
                    and not self._thread_is_alive(source_opener)
                ):
                    session.source_opener = None
                if session.feeder is feeder and not self._thread_is_alive(feeder):
                    session.feeder = None
                if session.decoder is decoder and not self._thread_is_alive(decoder):
                    session.decoder = None
                if session.process is process and not self._process_is_alive(process):
                    session.process = None
            with session.condition:
                session.complete = True
                if (
                    not self._thread_is_alive(source_opener)
                    and not self._thread_is_alive(decoder)
                    and not self._thread_is_alive(feeder)
                    and not self._process_is_alive(process)
                    and session.container is None
                ):
                    session.resources_released_at = time.time()
                session.condition.notify_all()
            with self._sessions_lock:
                if self._active_by_channel.get(session.channel) == session.id:
                    self._active_by_channel.pop(session.channel, None)
            # Once the last producer releases the graph, retire any swapper or
            # restorer that is no longer the selected production choice. This
            # is deliberately after native teardown so an in-flight ORT call
            # can never lose its session underneath it.
            if self._models is not None:
                try:
                    reconcile = self._reconcile_idle_model_residency
                    if hasattr(self, "_gpu_worker_queue"):
                        self._run_gpu_work(
                            reconcile,
                            session.id,
                            priority=20,
                            work_label="idle-model-reconcile",
                        )
                    else:
                        reconcile(session.id)
                except Exception:
                    pass
            self._schedule_spool_cleanup(
                session,
                # Keep unexpected failures queryable for a few seconds. The UI
                # can report the real cause and avoid turning one bad stream
                # into a rapid create/404/retry loop. Explicitly cancelled
                # swipe-away work is still removed immediately.
                delay=0.0 if session.delete_requested else (5.0 if session.state == "error" else 120.0),
            )

    def stream_session(
        self,
        session_id: str,
        request_range: str = "",
        *,
        activate: bool = True,
        finite_preload: bool = False,
        media_source: bool = False,
    ) -> Iterator[bytes]:
        session = self.session(session_id)
        if activate:
            self.activate_session(session_id)
        with session.condition:
            session.stream_requests += 1
            session.subscribers += 1
            session.condition.notify_all()
            if len(session.request_ranges) < 12:
                session.request_ranges.append(str(request_range or ""))
        self._ensure_session_producer(session)
        offset = 0
        reader = None
        preload_caught_up_at = 0.0
        try:
            while True:
                with session.condition:
                    available = session.bytes_written
                    complete = session.complete
                    prepared = session.is_prepared()
                    startup_ready = session.stream_startup_ready(media_source)
                    # A speculative WebView request only needs the complete
                    # warm-up fragment. Keeping that response open while the
                    # producer is intentionally paused makes Android reconnect
                    # repeatedly and leaves multiple subscribers behind.
                    if finite_preload and prepared and offset >= available:
                        now = time.monotonic()
                        if not preload_caught_up_at:
                            preload_caught_up_at = now
                        elif now - preload_caught_up_at >= 0.25:
                            break
                    else:
                        preload_caught_up_at = 0.0
                    # Withhold the entire first body until the muxer has both a
                    # complete fragment and enough bytes for Android's MP4
                    # sniffer. Sending 30 KiB and then stalling at the playback
                    # lead gate reproducibly produced MEDIA_ERR_SRC_NOT_SUPPORTED;
                    # releasing 32 KiB atomically decoded, so production keeps
                    # a 48 KiB margin from the runtime configuration.
                    if offset == 0 and not startup_ready and not complete:
                        session.condition.wait(timeout=0.05)
                        continue
                    if offset >= available and not complete:
                        session.condition.wait(timeout=0.10 if finite_preload else 0.5)
                        continue
                if offset < available:
                    if reader is None:
                        if session.spool_path is None or not session.spool_path.exists():
                            time.sleep(0.02)
                            continue
                        reader = session.spool_path.open("rb", buffering=0)
                        reader.seek(offset)
                    chunk = reader.read(min(256 * 1024, available - offset))
                    if chunk:
                        offset += len(chunk)
                        yield chunk
                        continue
                if complete:
                    break
        finally:
            if reader is not None:
                reader.close()
            with session.condition:
                session.subscribers = max(0, session.subscribers - 1)
                session.condition.notify_all()


ENGINE = PongSwapEngine()
