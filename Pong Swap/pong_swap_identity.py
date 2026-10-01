from __future__ import annotations

import math
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import cv2
import numpy as np


ARC_FACE_112_V2 = np.asarray(
    [
        [0.34191607, 0.46157411],
        [0.65653393, 0.45983393],
        [0.50022500, 0.64050536],
        [0.37097589, 0.82469196],
        [0.63151696, 0.82325089],
    ],
    dtype=np.float32,
)


@dataclass(frozen=True)
class FacePresentation:
    """The classifier's visual-presentation result, not a claim about identity."""

    label: str
    confidence: float
    # Robust central-face colour/contrast statistics. They describe only the
    # selected pixels in this image and are never converted into ethnicity or
    # another demographic label.
    appearance: tuple[float, ...] = ()

    @property
    def known(self) -> bool:
        return self.label in {"female", "male"} and math.isfinite(self.confidence)


@dataclass(frozen=True)
class CandidateIdentity:
    face_id: str
    embedding: np.ndarray
    presentation: FacePresentation
    source_frame: Any = None


@dataclass(frozen=True)
class TargetIdentity:
    keypoints: np.ndarray
    embedding: np.ndarray
    presentation: FacePresentation
    area: float = 0.0
    hair_color: str = 'unknown'
    hair_confidence: float = 0.0


@dataclass(frozen=True)
class IdentitySelection:
    candidate: CandidateIdentity
    target: TargetIdentity
    similarity: float


@dataclass(frozen=True)
class FaceSwitchPolicy:
    """Cheap source-identity hysteresis derived from the 0..100 UI control."""

    strictness: int
    minimum_gain: float
    confirmations: int
    disabled: bool


def normalize_face_ids(face_ids: Iterable[str], *, maximum: int = 5) -> tuple[str, ...]:
    """Return a stable, unique, bounded set of approved-face identifiers."""

    normalized: list[str] = []
    seen: set[str] = set()
    for value in face_ids:
        face_id = str(value or "").strip()
        if not face_id or face_id in seen:
            continue
        normalized.append(face_id)
        seen.add(face_id)
        if len(normalized) >= max(1, int(maximum)):
            break
    return tuple(normalized)


def rope_similarity(first: np.ndarray, second: np.ndarray) -> float:
    """Map ArcFace cosine distance onto an intuitive full 0..100 range.

    Rope's historic ``50 + 50*cosine`` presentation packed most unrelated and
    moderately similar adult faces into roughly 50-60.  The UI now represents
    strictness, so expand the useful ArcFace interval instead: <=.05 maps to 0
    and >=.70 maps to 100, with every slider point meaningful in between.
    """

    left = np.asarray(first, dtype=np.float32).reshape(-1)
    right = np.asarray(second, dtype=np.float32).reshape(-1)
    if left.shape != right.shape or not left.size:
        return -math.inf
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if not math.isfinite(denominator) or denominator <= 1e-12:
        return -math.inf
    cosine = max(-1.0, min(1.0, float(np.dot(left, right) / denominator)))
    return 100.0 * max(0.0, min(1.0, (cosine - 0.05) / 0.65))


def appearance_similarity(first: FacePresentation, second: FacePresentation) -> float | None:
    """Compare lighting-tolerant face appearance without demographic inference."""

    left = np.asarray(first.appearance, dtype=np.float32).reshape(-1)
    right = np.asarray(second.appearance, dtype=np.float32).reshape(-1)
    if not left.size or left.shape != right.shape or not np.isfinite(left).all() or not np.isfinite(right).all():
        return None
    distance = float(np.sqrt(np.mean(np.square(left - right))))
    return 100.0 * math.exp(-5.0 * max(0.0, distance))


def presentations_are_compatible(
    source: FacePresentation,
    target: FacePresentation,
    *,
    minimum_confidence: float = 0.0,
) -> bool:
    """Reject unknown/cross-presentation pairs with configurable confidence."""

    confidence = max(0.0, min(1.0, float(minimum_confidence)))
    return (
        source.known
        and target.known
        and source.label == target.label
        and source.confidence >= confidence
        and target.confidence >= confidence
    )


def presentation_confidence_for_strictness(value: float | int) -> float:
    """Make high identity strictness demand stronger female/male evidence.

    The established baseline (45) retains its previous permissive confidence
    behavior. Above 50, every point tightens the presentation gate until 100
    requires 95% classifier confidence for both the selected and video face.
    """

    strictness = max(0.0, min(100.0, float(value)))
    return 0.5 + max(0.0, strictness - 50.0) * 0.009


def target_identity_lock_threshold(value: float | int) -> float:
    """Return the ArcFace floor for retaining one target person.

    Face-match strictness decides whether a source picture may attach to a
    person in the first place.  Once attached, continuity must never become so
    permissive that another same-presentation bystander can inherit the swap.
    The full slider remains meaningful, but even zero keeps a conservative
    identity floor; a missed match renders the original frame until the locked
    person returns.
    """

    strictness = max(0.0, min(100.0, float(value)))
    return 55.0 + strictness * 0.05


def target_identity_continuity_threshold() -> float:
    """Low-view identity floor used only with a valid adjacent-frame track.

    Extreme profile/edge views can reduce ArcFace confidence even though the
    five landmarks still move continuously from the preceding target frame.
    This lower floor is never used for initial acquisition or reacquisition,
    so a spatially unrelated bystander cannot claim an absent target.
    """

    return 25.0


def identity_similarity_upper_bound(arcface_score: float) -> float:
    """Best possible retention score before expensive appearance extraction.

    Identity ranking is either raw ArcFace or .85*ArcFace + .15*appearance.
    Appearance cannot exceed 100. This bound can only reject candidates that
    the complete calculation would reject; it does not relax identity gates.
    Do not use for initial lookalike matching, whose weights are different.
    """
    score = float(arcface_score)
    if not math.isfinite(score):
        return -math.inf
    return max(score, 0.85 * score + 15.0)


def compatible_identity_rankings(
    candidates: Sequence[CandidateIdentity],
    target: TargetIdentity,
    *,
    minimum_similarity: float = 0.0,
    minimum_presentation_confidence: float = 0.0,
    similarity_mode: str = "lookalike",
) -> tuple[IdentitySelection, ...]:
    """Rank compatible faces for lookalike acquisition or identity retention.

    Approved source photos usually depict a different person from the video,
    so acquisition emphasizes visible appearance. Once a video person is
    chosen, retention switches to ArcFace-authoritative identity matching.
    """

    threshold = max(0.0, min(100.0, float(minimum_similarity)))
    mode = "identity" if str(similarity_mode).lower() == "identity" else "lookalike"
    ranked: list[IdentitySelection] = []
    for candidate in candidates:
        # Source admission applies to both automatic and manually tapped
        # targets. Internal target-to-target continuity probes are not source
        # choices; their already-admitted source is retained by the engine.
        continuity_probe = similarity_mode == "identity" and candidate.face_id in {
            "manual-target-lock", "locked-target"
        }
        if not continuity_probe and not approved_source_allows_target(candidate.face_id, target.presentation):
            continue
        if not presentations_are_compatible(
            candidate.presentation,
            target.presentation,
            minimum_confidence=minimum_presentation_confidence,
        ):
            continue
        arcface = rope_similarity(candidate.embedding, target.embedding)
        similarity = arcface
        appearance = appearance_similarity(candidate.presentation, target.presentation)
        if appearance is not None:
            if mode == "lookalike":
                # Source photos and video subjects are normally different
                # identities. Skin/contrast resemblance therefore leads the
                # acquisition score, with ArcFace adding a small structural cue.
                similarity = 0.10 * arcface + 0.90 * appearance
            else:
                # The video-to-video retention path compares the same person.
                similarity = 0.85 * arcface + 0.15 * appearance
            if (
                mode == "lookalike"
                and threshold > 50.0
                and appearance < max(0.0, threshold - 15.0)
            ):
                continue
        if not math.isfinite(similarity) or similarity < threshold:
            continue
        ranked.append(IdentitySelection(candidate, target, similarity))
    ranked.sort(
        key=lambda selection: (selection.similarity, selection.target.area),
        reverse=True,
    )
    return tuple(ranked)


def approved_source_allows_target(face_id: str, target: FacePresentation) -> bool:
    """Fail closed on uncertain presentation; only Approved 18 admits men.

    This is an image-presentation classifier guard, not an assertion about a
    person's gender identity. It cannot guarantee a classifier never errs.
    Exact label + content digest prevents Approved 180 matching Approved 18.
    """
    if not target.known or target.confidence < 0.90:
        return False
    if target.label == "female":
        return True
    return bool(re.fullmatch(r"approved-18(?:-[0-9a-f]{12})?", str(face_id)))


def face_switch_policy(value: float | int) -> FaceSwitchPolicy:
    """Map every slider point to a stricter, deterministic switch policy.

    The margin changes at every integer increment.  Confirmations add temporal
    hysteresis without another detector or recognition pass.  A value of 100
    is an explicit permanent source-face lock.
    """

    strictness = max(0, min(100, int(round(float(value)))))
    return FaceSwitchPolicy(
        strictness=strictness,
        minimum_gain=float(strictness) * 0.10,
        confirmations=1 + min(2, strictness // 34),
        disabled=strictness >= 100,
    )


def choose_compatible_identity(
    candidates: Sequence[CandidateIdentity],
    targets: Sequence[TargetIdentity],
    *,
    minimum_similarity: float = 0.0,
    minimum_presentation_confidence: float = 0.0,
    similarity_mode: str = "lookalike",
) -> IdentitySelection | None:
    """Choose one best compatible source/target pair for the entire video session."""

    best: IdentitySelection | None = None
    for target in targets:
        for selection in compatible_identity_rankings(
            candidates,
            target,
            minimum_similarity=minimum_similarity,
            minimum_presentation_confidence=minimum_presentation_confidence,
            similarity_mode=similarity_mode,
        ):
            if best is None:
                best = selection
                continue
            # Identity resemblance is authoritative. Area is a deterministic
            # tiebreaker only, so a large bystander cannot defeat a closer match.
            if (selection.similarity, selection.target.area) > (
                best.similarity,
                best.target.area,
            ):
                best = selection
    return best


class FairFacePresentationClassifier:
    """Serialized FP32 compatibility classifier, with a bounded CUDA option."""

    def __init__(self, model_path: Path, backend: str = "cpu") -> None:
        self.model_path = Path(model_path)
        self._session = None
        self._input_name = ""
        self._gender_output_index = -1
        self._gender_is_class_id = False
        self._lock = threading.RLock()
        self.backend = "cpu"
        self._health_state = (None, "cpu", ())
        self.set_backend(backend)

    def set_backend(self, backend: str) -> None:
        if backend not in ("cpu", "cuda"):
            raise ValueError("identityClassifierBackend must be cpu or cuda")
        with self._lock:
            if backend != self.backend:
                self._session = None
                self.backend = backend
                self._health_state = (None, backend, ())

    def unload(self) -> None:
        with self._lock:
            self._session = None
            self._health_state = (None, self.backend, ())

    @property
    def ready(self) -> bool:
        return self._session is not None

    def health_snapshot(self) -> tuple[bool, str, tuple[str, ...]]:
        """Read one published session/backend pair without waiting on inference."""
        session, backend, providers = self._health_state
        if session is None or session is not self._session:
            return False, backend, ()
        return True, backend, providers

    def warm(self) -> None:
        with self._lock:
            if self._session is not None:
                return
            if not self.model_path.is_file():
                raise FileNotFoundError(f"FairFace model is missing: {self.model_path}")
            import onnxruntime

            options = onnxruntime.SessionOptions()
            options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
            options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            providers = ["CPUExecutionProvider"]
            if self.backend == "cuda":
                providers = [("CUDAExecutionProvider", {
                    "arena_extend_strategy": "kSameAsRequested",
                    "cudnn_conv_algo_search": "HEURISTIC",
                    "cudnn_conv_use_max_workspace": "0",
                    "gpu_mem_limit": 512 * 1024 * 1024,
                    "use_tf32": "0",
                })]
            session = onnxruntime.InferenceSession(
                str(self.model_path),
                sess_options=options,
                providers=providers,
            )
            outputs = list(session.get_outputs())
            gender_index = next(
                (index for index, output in enumerate(outputs) if "gender" in output.name.lower()),
                -1,
            )
            if gender_index < 0:
                gender_index = next(
                    (
                        index
                        for index, output in enumerate(outputs)
                        if output.shape and output.shape[-1] == 2
                    ),
                    -1,
                )
            if gender_index < 0:
                raise RuntimeError("FairFace graph has no presentation output")
            input_name = session.get_inputs()[0].name
            # Source presentation may come from the persistent cache, leaving
            # the first target to pay for ORT construction and first execution.
            # Prime the unchanged FP32 graph before publishing readiness. A
            # failed probe must not leave a half-ready session behind.
            neutral = np.full((224, 224, 3), 127, dtype=np.uint8)
            self._appearance(self._crop(neutral, ARC_FACE_112_V2 * 224))
            session.run(None, {input_name: np.zeros((1, 3, 224, 224), dtype=np.float32)})
            self._input_name = input_name
            self._gender_output_index = gender_index
            self._gender_is_class_id = (
                outputs[gender_index].type.startswith("tensor(int")
                or outputs[gender_index].shape == [1]
            )
            self._health_state = (session, self.backend, tuple(session.get_providers()))
            # Publish the session last: ready must imply complete metadata.
            self._session = session

    @staticmethod
    def _crop(frame_rgb: np.ndarray, keypoints: np.ndarray) -> np.ndarray:
        points = np.asarray(keypoints, dtype=np.float32).reshape(5, 2)
        destination = ARC_FACE_112_V2 * np.asarray([224.0, 224.0], dtype=np.float32)
        matrix = cv2.estimateAffinePartial2D(
            points,
            destination,
            method=cv2.RANSAC,
            ransacReprojThreshold=100,
        )[0]
        if matrix is None or not np.isfinite(matrix).all():
            raise ValueError("could not align face for compatibility classification")
        return cv2.warpAffine(
            np.asarray(frame_rgb),
            matrix,
            (224, 224),
            flags=cv2.INTER_AREA,
            borderMode=cv2.BORDER_REPLICATE,
        )

    @staticmethod
    def _appearance(crop_rgb: np.ndarray) -> tuple[float, ...]:
        """Return robust, normalized central-face colour and contrast features."""

        crop = np.asarray(crop_rgb, dtype=np.uint8)
        height, width = crop.shape[:2]
        yy, xx = np.ogrid[:height, :width]
        # Central ellipse avoids most hair, clothing and background. Excluding
        # extreme highlights/shadows makes the descriptor useful across video
        # lighting without pretending to infer race or identity from colour.
        ellipse = (
            ((xx - width * 0.5) / max(1.0, width * 0.30)) ** 2
            + ((yy - height * 0.52) / max(1.0, height * 0.36)) ** 2
        ) <= 1.0
        lab = cv2.cvtColor(crop, cv2.COLOR_RGB2LAB).astype(np.float32) / 255.0
        hsv = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV).astype(np.float32)
        pixels = lab[ellipse]
        hsv_pixels = hsv[ellipse]
        if pixels.shape[0] < 32:
            return ()
        luminance = pixels[:, 0]
        keep = (luminance >= np.quantile(luminance, 0.10)) & (
            luminance <= np.quantile(luminance, 0.90)
        )
        pixels = pixels[keep]
        hsv_pixels = hsv_pixels[keep]
        if pixels.shape[0] < 16:
            return ()
        values = (
            float(np.median(pixels[:, 0])),
            float(np.median(pixels[:, 1])),
            float(np.median(pixels[:, 2])),
            float(np.quantile(pixels[:, 0], 0.25)),
            float(np.quantile(pixels[:, 0], 0.75)),
            float(np.median(hsv_pixels[:, 1]) / 255.0),
        )
        return tuple(max(0.0, min(1.0, value)) for value in values)

    def classify(self, frame_rgb: np.ndarray, keypoints: np.ndarray) -> FacePresentation:
        self.warm()
        raw_crop = self._crop(frame_rgb, keypoints)
        appearance = self._appearance(raw_crop)
        crop = raw_crop.astype(np.float32) / 255.0
        crop -= np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
        crop /= np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
        tensor = np.expand_dims(crop.transpose(2, 0, 1), axis=0)
        with self._lock:
            # unload()/set_backend() may have run during crop preparation.
            self.warm()
            outputs = self._session.run(None, {self._input_name: tensor})
            gender_output_index = self._gender_output_index
            gender_is_class_id = self._gender_is_class_id
        raw_gender = np.asarray(outputs[gender_output_index]).reshape(-1)
        if gender_is_class_id and raw_gender.shape == (1,):
            selected = int(raw_gender[0])
            if selected not in (0, 1):
                return FacePresentation("unknown", 0.0, appearance)
            return FacePresentation("female" if selected == 1 else "male", 1.0, appearance)
        logits = np.asarray(raw_gender, dtype=np.float32).reshape(-1)
        if logits.shape != (2,) or not np.isfinite(logits).all():
            return FacePresentation("unknown", 0.0, appearance)
        shifted = logits - float(np.max(logits))
        probabilities = np.exp(shifted)
        probabilities /= max(1e-12, float(np.sum(probabilities)))
        selected = int(np.argmax(probabilities))
        # FairFace emits [male, female].
        return FacePresentation(
            "female" if selected == 1 else "male",
            float(probabilities[selected]),
            appearance,
        )
