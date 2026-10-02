"""Baseline 1.16: fit the swap to the head's real turn (yaw).

InSwapper's alignment fits the 5 points to a flat, front-facing template.
At a side angle the eyes and mouth corners crowd together, so that fit
shrinks and slides the face. Here a simple 3D face (the ArcFace template
with depth: nose forward, eyes and mouth slightly back) is turned by the
estimated yaw and projected; the similarity that maps this turned template
onto the observed points is the right framing for the head. The pipeline
still expects front-template points, so we hand it "pseudo points": the
front template carried through that similarity. At yaw 0 nothing changes.
"""
from __future__ import annotations

import numpy as np

TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                     [41.5493, 92.3655], [70.7299, 92.2041]], np.float32)
_CENTRE = np.array([56.0, 71.7], np.float32)
# Depth (towards the camera) in template units: nose tip well forward,
# eyes back, mouth corners slightly back. Typical adult proportions.
_DEPTH = np.array([-8.0, -8.0, 20.0, -4.0, -4.0], np.float32)
_YAWS = np.radians(np.arange(-80, 81, 2, dtype=np.float32))


def turned_template(yaw: float) -> np.ndarray:
    x = TEMPLATE[:, 0] - _CENTRE[0]
    out = TEMPLATE.copy()
    out[:, 0] = _CENTRE[0] + x * np.cos(yaw) + _DEPTH * np.sin(yaw)
    return out


_TURNED = [turned_template(y) for y in _YAWS]
_STACK = np.stack(_TURNED)


def _similarity(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    s, d = src - mu_s, dst - mu_d
    var = float((s ** 2).sum())
    if var < 1e-9:
        return None
    a = float((s * d).sum()) / var
    b = float((s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]).sum()) / var
    m = np.array([[a, -b], [b, a]], np.float32)
    return m, (mu_d - mu_s @ m.T).astype(np.float32)


def estimate_yaw(kps) -> tuple[float, tuple]:
    """Yaw (radians) whose turned template best explains the points, and the
    similarity for it."""
    k = np.asarray(kps, np.float32).reshape(5, 2)
    # All yaws at once (was a Python loop: 1.8 ms per frame).
    src = _STACK - _STACK.mean(1, keepdims=True)            # (Y,5,2)
    dst = k - k.mean(0)
    var = (src ** 2).sum((1, 2))
    a = (src * dst).sum((1, 2)) / var
    b = (src[..., 0] * dst[:, 1] - src[..., 1] * dst[:, 0]).sum(1) / var
    px = a[:, None] * src[..., 0] - b[:, None] * src[..., 1]
    py = b[:, None] * src[..., 0] + a[:, None] * src[..., 1]
    err = np.sqrt((px - dst[:, 0]) ** 2 + (py - dst[:, 1]) ** 2).sum(1) / (np.abs(a) + 1e-6)
    i = int(np.argmin(err))
    transform = _similarity(_TURNED[i], k)
    return float(_YAWS[i]), transform


def pseudo_points(kps, *, min_yaw_degrees: float = 12.0):
    """Points that make the front-template alignment frame the head at its
    real turn. Small turns are left exactly as they are."""
    k = np.asarray(kps, np.float32).reshape(5, 2)
    yaw, transform = estimate_yaw(k)
    if transform is None or abs(np.degrees(yaw)) < min_yaw_degrees:
        return k, yaw
    m, t = transform
    return (TEMPLATE @ m.T + t).astype(np.float32), yaw
