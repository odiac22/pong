"""Baseline 1.12: occlusion-robust 5-point landmarks for any video.

When hands, food, hair or objects cover part of a face, RetinaFace still
returns all five points but guesses the hidden ones; its score drops and the
guessed points distort the face (live example: eyes 10% too far apart and
mouth 10% too high while fingers covered the face, which squashed the swap,
and the LK tracker carried that shape for several frames).

The guard learns the current person's 2D face shape (similarity-normalised,
so it follows head turns including side profiles) from confident frames.
A low-score detection that disagrees with that shape is repaired: the pair
of points that best explains the others under a similarity transform
(least-median of squares over all 10 point pairs) defines the pose, points
that agree are kept, and points that disagree are predicted from the shape.
Before any confident frame exists, a low-score detection is held back for a
short window so a track never starts from a guessed shape; afterwards it is
accepted so swaps still happen on persistently hard footage.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations

import numpy as np

# InsightFace ArcFace 112x112 template (eyes, nose, mouth corners).
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                     [41.5493, 92.3655], [70.7299, 92.2041]], np.float32)


def _similarity(src: np.ndarray, dst: np.ndarray):
    """Least-squares similarity (scale, rotation, translation) src -> dst."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    s, d = src - mu_s, dst - mu_d
    var = float((s ** 2).sum())
    if var < 1e-9:
        return None
    a = float((s * d).sum()) / var
    b = float((s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]).sum()) / var
    m = np.array([[a, -b], [b, a]], np.float32)
    return m, (mu_d - mu_s @ m.T).astype(np.float32)


def _apply(transform, points: np.ndarray) -> np.ndarray:
    m, t = transform
    return points @ m.T + t


def normalise(kps: np.ndarray) -> np.ndarray:
    """Map a 5-point shape onto the template frame (removes pose/scale)."""
    transform = _similarity(kps, TEMPLATE)
    return TEMPLATE.copy() if transform is None else _apply(transform, kps)


@dataclass
class LandmarkGuard:
    confident_score: float = 0.64     # side profiles sit at 0.65-0.70; covered faces 0.40-0.62
    agree_ratio: float = 0.07         # per-point agreement, fraction of eye distance
    learn_rate: float = 0.30          # shape follows head turns within ~0.1-0.2 s
    acquire_wait_frames: int = 12     # hold a low-score first detection up to ~0.4 s
    acquire_confident_frames: int = 3 # a new face is learned only after this many sure frames in a row
    shape: np.ndarray | None = None
    waited: int = 0
    streak: int = 0
    stats: dict = field(default_factory=lambda: {"repaired": 0, "held": 0, "accepted": 0, "learned": 0})

    def reset(self) -> None:
        self.shape = None
        self.waited = 0
        self.streak = 0

    def _learn(self, kps: np.ndarray) -> None:
        n = normalise(kps)
        self.shape = n if self.shape is None else (1 - self.learn_rate) * self.shape + self.learn_rate * n
        self.stats["learned"] += 1

    def observe(self, kps, score: float | None):
        """Return the landmarks to render with, or None to hold this frame."""
        if kps is None:
            return None
        kps = np.asarray(kps, np.float32).reshape(5, 2)
        score = 1.0 if score is None else float(score)
        if self.shape is None:
            self.streak = self.streak + 1 if score >= self.confident_score else 0
            if self.streak >= self.acquire_confident_frames:
                self._learn(kps)
                self.waited = 0
                self.stats["accepted"] += 1
                return kps
            if self.streak:
                # Confident, but not yet learned: render it unchanged so a
                # clear face never waits.
                self.stats["accepted"] += 1
                return kps
            # Never learn this person's shape from a guessed (low-score)
            # detection: a covered face at the start of a clip would become
            # the reference. Hold briefly, then repair against the standard
            # face shape until a confident frame arrives.
            self.waited += 1
            if self.waited <= self.acquire_wait_frames:
                self.stats["held"] += 1
                return None
            # Baseline 1.16: the standard shape is turned to the head's
            # estimated yaw, so a mostly hidden side face is rebuilt at its
            # real angle rather than as a front-facing face.
            from pong_head_pose import estimate_yaw, turned_template
            yaw, _ = estimate_yaw(kps)
            return self._repair(kps, turned_template(yaw), learn=False)
        return self._repair(kps, self.shape, learn=True, score=score)

    def _repair(self, kps: np.ndarray, shape: np.ndarray, *, learn: bool, score: float = 0.0):
        eye = float(np.linalg.norm(kps[1] - kps[0]))
        scale = max(eye, float(np.linalg.norm(kps[[3, 4]].mean(0) - kps[[0, 1]].mean(0))), 1.0)
        if not learn:
            # Standard-shape mode (no confident frame of this person yet):
            # anchor on the eyes, the points that usually stay visible when
            # hands, food or a cup cover the lower face. A consensus search
            # here picked the squashed mouth/nose pair and shrank the face.
            transform = _similarity(shape[[0, 1]], kps[[0, 1]])
            if transform is None:
                return kps
            predicted = _apply(transform, shape)
            outliers = np.linalg.norm(predicted - kps, axis=1) > self.agree_ratio * scale
            if not outliers.any():
                self.stats["accepted"] += 1
                return kps
            self.stats["repaired"] += 1
            return np.where(outliers[:, None], predicted, kps).astype(np.float32)
        # Least-median-of-squares pose from the best-agreeing point pair.
        best = None
        for i, j in combinations(range(5), 2):
            transform = _similarity(shape[[i, j]], kps[[i, j]])
            if transform is None:
                continue
            residual = np.linalg.norm(_apply(transform, shape) - kps, axis=1)
            key = float(np.median(residual))
            if best is None or key < best[0]:
                best = (key, transform, residual)
        if best is None:
            return kps
        # Refit on every point that agrees with that pair (robust consensus).
        inliers = best[2] <= self.agree_ratio * scale
        if inliers.sum() >= 2:
            transform = _similarity(shape[inliers], kps[inliers]) or best[1]
        else:
            transform = best[1]
        predicted = _apply(transform, shape)
        residual = np.linalg.norm(predicted - kps, axis=1)
        outliers = residual > self.agree_ratio * scale
        if score >= self.confident_score or not outliers.any():
            # Trusted observation: keep it and (with a learned shape) let the
            # shape follow the pose.
            if learn:
                self._learn(kps)
            self.stats["accepted"] += 1
            return kps
        repaired = np.where(outliers[:, None], predicted, kps).astype(np.float32)
        self.stats["repaired"] += 1
        return repaired
