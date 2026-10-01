"""Sparse semantic landmark inference for Pong's temporal renderer.

This module deliberately owns only landmark inference and coordinate mapping.
It does not change the face-swap, restoration, masking, or composition models.
The 68-point detector is refreshed sparsely; the temporal renderer tracks its
output between refreshes.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading
import time
from typing import Any

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent
MODEL_ROOT = ROOT / "vendor" / "facefusion-benchmark" / ".assets" / "models"
FAN_68_5_PATH = MODEL_ROOT / "fan_68_5.onnx"
FAN_2D_68_PATH = MODEL_ROOT / "2dfan4.onnx"

_FFHQ_512_TEMPLATE = np.asarray(
    [
        [0.37691676, 0.46864664],
        [0.62285697, 0.46912813],
        [0.50123859, 0.61331904],
        [0.39308822, 0.72541100],
        [0.61150205, 0.72490465],
    ],
    dtype=np.float32,
)


@dataclass(frozen=True)
class SemanticLandmarkResult:
    points: np.ndarray
    score: float
    inference_ms: float
    provider: str


def _session_options():
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 1
    return options


def _provider_list(stream_id: int | None, *, use_cuda: bool) -> list[Any]:
    if not use_cuda:
        return ["CPUExecutionProvider"]
    cuda_options: dict[str, str | int] = {
        "device_id": 0,
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "EXHAUSTIVE",
    }
    if stream_id:
        cuda_options["user_compute_stream"] = str(int(stream_id))
    return [("CUDAExecutionProvider", cuda_options), "CPUExecutionProvider"]


class SemanticLandmarkEstimator:
    """Long-lived 68-point estimator with explicit CUDA-stream ownership."""

    def __init__(self, *, stream_id: int | None = None, use_cuda: bool = True):
        if not FAN_68_5_PATH.is_file() or not FAN_2D_68_PATH.is_file():
            raise FileNotFoundError("Pong semantic landmark models are missing")
        # Importing torch first loads the CUDA runtime DLLs needed by ORT on
        # Windows.  The object itself is intentionally not retained here.
        if use_cuda:
            import torch  # noqa: F401
        import onnxruntime as ort

        self._lock = threading.Lock()
        self._stream_id = int(stream_id or 0)
        self._fan_session = ort.InferenceSession(
            str(FAN_68_5_PATH),
            sess_options=_session_options(),
            providers=["CPUExecutionProvider"],
        )
        self._landmark_session = ort.InferenceSession(
            str(FAN_2D_68_PATH),
            sess_options=_session_options(),
            providers=_provider_list(self._stream_id, use_cuda=use_cuda),
        )
        self._provider = self._landmark_session.get_providers()[0]
        # Absorb CUDA kernel selection/allocation before the first visible
        # frame.  On the RTX 4070 the first Run can otherwise exceed 200 ms,
        # while steady-state refreshes are about 12 ms.
        self._landmark_session.run(
            None,
            {"input": np.zeros((1, 3, 256, 256), dtype=np.float32)},
        )

    @property
    def provider(self) -> str:
        return self._provider

    def estimate_from_five(self, points5: np.ndarray) -> np.ndarray:
        """Predict a stable 68-point topology from the current five points."""
        points = np.asarray(points5, dtype=np.float32).reshape(5, 2)
        matrix, _ = cv2.estimateAffinePartial2D(
            points,
            _FFHQ_512_TEMPLATE,
            method=cv2.RANSAC,
            ransacReprojThreshold=100,
        )
        if matrix is None or not np.isfinite(matrix).all():
            raise ValueError("cannot normalize five-point face geometry")
        normalized = cv2.transform(points.reshape(1, -1, 2), matrix).astype(np.float32)
        prediction = self._fan_session.run(None, {"input": normalized})[0][0]
        inverse = cv2.invertAffineTransform(matrix)
        mapped = cv2.transform(
            np.asarray(prediction, dtype=np.float32).reshape(1, -1, 2),
            inverse,
        )[0]
        if mapped.shape != (68, 2) or not np.isfinite(mapped).all():
            raise ValueError("five-to-68 landmark model returned invalid geometry")
        return mapped.astype(np.float32, copy=False)

    def detect(self, frame_rgb: np.ndarray, points5: np.ndarray) -> SemanticLandmarkResult:
        """Run a sparse visual 68-point refresh around the active face."""
        frame = np.asarray(frame_rgb)
        if frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError("semantic landmark input must be an RGB image")
        approximate = self.estimate_from_five(points5)
        minimum = np.min(approximate, axis=0)
        maximum = np.max(approximate, axis=0)
        extent = np.maximum(maximum - minimum, 1.0)
        # A small guard band keeps the jaw/forehead heatmaps away from the crop
        # boundary while retaining FaceFusion's trained 195-pixel face scale.
        bounding_box = np.asarray(
            [
                minimum[0] - extent[0] * 0.08,
                minimum[1] - extent[1] * 0.12,
                maximum[0] + extent[0] * 0.08,
                maximum[1] + extent[1] * 0.08,
            ],
            dtype=np.float32,
        )
        scale = 195.0 / max(
            1.0,
            float(bounding_box[2] - bounding_box[0]),
            float(bounding_box[3] - bounding_box[1]),
        )
        translation = (
            256.0
            - np.asarray(
                [bounding_box[2] + bounding_box[0], bounding_box[3] + bounding_box[1]],
                dtype=np.float32,
            )
            * scale
        ) * 0.5
        affine = np.asarray(
            [[scale, 0.0, translation[0]], [0.0, scale, translation[1]]],
            dtype=np.float32,
        )
        crop = cv2.warpAffine(
            frame,
            affine,
            (256, 256),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101,
        )
        tensor = np.ascontiguousarray(crop.transpose(2, 0, 1)[None], dtype=np.float32)
        tensor *= 1.0 / 255.0
        started = time.perf_counter()
        with self._lock:
            landmarks, heatmaps = self._landmark_session.run(None, {"input": tensor})
        inference_ms = (time.perf_counter() - started) * 1000.0
        points = np.asarray(landmarks, dtype=np.float32)[0, :, :2] * (256.0 / 64.0)
        points = cv2.transform(
            points.reshape(1, -1, 2),
            cv2.invertAffineTransform(affine),
        )[0]
        heatmaps = np.asarray(heatmaps, dtype=np.float32)
        raw_score = float(np.mean(np.max(heatmaps, axis=(2, 3))))
        score = float(np.clip(raw_score / 0.9, 0.0, 1.0))
        if points.shape != (68, 2) or not np.isfinite(points).all():
            raise ValueError("visual 68-point detector returned invalid geometry")
        return SemanticLandmarkResult(
            points=points.astype(np.float32, copy=False),
            score=score,
            inference_ms=inference_ms,
            provider=self._provider,
        )
