"""Baseline 1.15: steadier, side-angle-aware alignment points.

RetinaFace's 5 points guess the hidden eye and mouth corner at side angles
(both eyes collapse onto one spot) and shake on eating/occluded faces.
InsightFace 2d106det (106 points, ~0.5 ms) traces the real profile,
eyes, nose and lips. Averaging its 5 derived points with RetinaFace's
cut frame-to-frame jitter on all 18 test clips (side profile 2.26 -> 1.42,
noodles 3.35 -> 2.34, % of face size per frame^2); their errors are largely
independent. Gating by agreement was worse (switching adds jitter).
"""
from __future__ import annotations

import os

import numpy as np

MODEL_NAME = "2d106det.onnx"
INPUT = 192


def five_from_106(points: np.ndarray) -> np.ndarray:
    """Eye centres (contour means), nose tip, mouth corners."""
    p = np.asarray(points, np.float32).reshape(106, 2)
    return np.stack([p[33:43].mean(0), p[87:97].mean(0), p[86], p[52], p[61]]).astype(np.float32)


def face_box(kps: np.ndarray):
    k = np.asarray(kps, np.float32).reshape(5, 2)
    centre = k.mean(0)
    size = 2.1 * max(float(np.linalg.norm(k[1] - k[0])),
                     float(np.linalg.norm((k[3] + k[4]) / 2 - (k[0] + k[1]) / 2)), 4.0)
    return centre, size


class Landmark106:
    def __init__(self, models_dir):
        self.path = os.path.join(str(models_dir), MODEL_NAME)
        self.session = None
        self.failed = False

    def available(self) -> bool:
        return not self.failed and os.path.exists(self.path)

    def _session(self):
        if self.session is None and not self.failed:
            try:
                import onnxruntime as ort
                cache = os.path.join(os.path.dirname(self.path), "trt_cache_2d106det")
                self.session = ort.InferenceSession(self.path, providers=[
                    ("TensorrtExecutionProvider", {"trt_fp16_enable": False, "trt_engine_cache_enable": True,
                                                   "trt_engine_cache_path": cache}),
                    "CUDAExecutionProvider", "CPUExecutionProvider"])
            except Exception as exc:
                print(f"[landmark106] unavailable: {exc}")
                self.failed = True
        return self.session

    def points(self, torch, frame_chw, kps):
        """106 points in frame coordinates from a uint8 CHW CUDA frame."""
        session = self._session()
        if session is None:
            return None
        centre, size = face_box(kps)
        side = 1.5 * size
        height, width = int(frame_chw.shape[-2]), int(frame_chw.shape[-1])
        x0, y0 = int(round(centre[0] - side / 2)), int(round(centre[1] - side / 2))
        x1, y1 = x0 + int(round(side)), y0 + int(round(side))
        cx0, cy0, cx1, cy1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
        if cx1 - cx0 < 8 or cy1 - cy0 < 8:
            return None
        crop = frame_chw[:, cy0:cy1, cx0:cx1].float()[None]
        crop = torch.nn.functional.pad(crop, (cx0 - x0, x1 - cx1, cy0 - y0, y1 - cy1))
        crop = torch.nn.functional.interpolate(crop, size=(INPUT, INPUT), mode="bilinear",
                                               align_corners=False, antialias=True).contiguous()
        out = torch.empty((1, 212), device=crop.device, dtype=torch.float32)
        binding = session.io_binding()
        binding.bind_input(session.get_inputs()[0].name, "cuda", 0, np.float32, tuple(crop.shape), crop.data_ptr())
        binding.bind_output(session.get_outputs()[0].name, "cuda", 0, np.float32, (1, 212), out.data_ptr())
        torch.cuda.current_stream().synchronize()
        session.run_with_iobinding(binding)
        pts = (out.reshape(106, 2).cpu().numpy() + 1.0) * (INPUT / 2)
        scale = (x1 - x0) / INPUT
        return np.stack([pts[:, 0] * scale + x0, pts[:, 1] * scale + y0], 1).astype(np.float32)

    def fuse(self, torch, frame_chw, kps):
        """Average of RetinaFace's 5 points and the 106-derived ones."""
        try:
            pts = self.points(torch, frame_chw, kps)
        except Exception as exc:
            print(f"[landmark106] disabled after error: {exc}")
            self.failed = True
            return kps
        if pts is None or not np.isfinite(pts).all():
            return kps
        return ((np.asarray(kps, np.float32).reshape(5, 2) + five_from_106(pts)) / 2).astype(np.float32)
