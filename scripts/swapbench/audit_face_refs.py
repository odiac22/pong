"""Audit an approved face's reference photos (CPU, read-only).

For every photo: detector score, face size, head yaw estimate, sharpness of
the aligned 112px crop, and ArcFace similarity to the leave-one-out mean of
the other photos (the same detector/recognizer files Pong Swap uses).
Low leave-one-out similarity flags a photo that pulls the merged identity
away from the rest (different person, heavy occlusion, extreme angle, blur).
usage: python audit_face_refs.py "<approved-faces dir>" [face folder ...]
"""
from __future__ import annotations

import json
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort

MODELS = r"C:\Users\arian\Documents\Codex\2026-07-15\files-mentioned-by-the-user-chatgpt\work\pong\Pong Swap\runtime\models"
ARC_TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                         [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)

det = ort.InferenceSession(os.path.join(MODELS, "det_10g.onnx"), providers=["CPUExecutionProvider"])
rec = ort.InferenceSession(os.path.join(MODELS, "w600k_r50.onnx"), providers=["CPUExecutionProvider"])


def detect(bgr: np.ndarray):
    size = 640
    h, w = bgr.shape[:2]
    scale = size / max(h, w)
    resized = cv2.resize(bgr, (int(w * scale), int(h * scale)))
    canvas = np.zeros((size, size, 3), np.uint8)
    canvas[:resized.shape[0], :resized.shape[1]] = resized
    blob = cv2.dnn.blobFromImage(canvas, 1 / 128, (size, size), (127.5, 127.5, 127.5), swapRB=True)
    outs = det.run(None, {det.get_inputs()[0].name: blob})
    best = None
    for i, stride in enumerate((8, 16, 32)):
        scores, boxes, kps = outs[i][:, 0], outs[i + 3] * stride, outs[i + 6] * stride
        gh = gw = size // stride
        centers = np.stack(np.mgrid[:gh, :gw][::-1], axis=-1).reshape(-1, 2) * stride
        centers = np.repeat(centers, 2, axis=0).astype(np.float32)
        for j in np.where(scores > 0.5)[0]:
            c = centers[j]
            box = np.array([c[0] - boxes[j, 0], c[1] - boxes[j, 1], c[0] + boxes[j, 2], c[1] + boxes[j, 3]]) / scale
            area = (box[2] - box[0]) * (box[3] - box[1])
            if best is None or area > best[2]:
                best = (float(scores[j]), box, area, (kps[j].reshape(5, 2) + c) / scale)
    return best


def embed(bgr, kps):
    matrix = cv2.estimateAffinePartial2D(kps.astype(np.float32), ARC_TEMPLATE, method=cv2.LMEDS)[0]
    crop = cv2.warpAffine(bgr, matrix, (112, 112), borderValue=0.0)
    blob = cv2.dnn.blobFromImage(crop, 1 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
    vec = rec.run(None, {rec.get_inputs()[0].name: blob})[0].reshape(-1)
    sharp = float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
    return vec / np.linalg.norm(vec), sharp


def audit(folder: str):
    rows = []
    paths = sorted(os.path.relpath(os.path.join(d, f), folder) for d, _, fs in os.walk(folder) for f in fs)
    for name in paths:
        if not name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        bgr = cv2.imdecode(np.fromfile(os.path.join(folder, name), np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        found = None
        for pad in (0, 0.25, 0.5):
            view = bgr if not pad else cv2.copyMakeBorder(bgr, int(bgr.shape[0] * pad), int(bgr.shape[0] * pad),
                                                          int(bgr.shape[1] * pad), int(bgr.shape[1] * pad), cv2.BORDER_REPLICATE)
            found = detect(view)
            if found:
                bgr = view
                break
        if not found:
            rows.append({"photo": name, "face": False})
            continue
        score, box, _, kps = found
        vec, sharp = embed(bgr, kps)
        eye_mid = (kps[0] + kps[1]) / 2
        eye_dist = float(np.linalg.norm(kps[1] - kps[0]))
        yaw = float((kps[2][0] - eye_mid[0]) / max(1.0, eye_dist))  # ~0 frontal, |>0.35| strongly turned
        rows.append({"photo": name, "face": True, "det": round(score, 3), "facepx": int(box[2] - box[0]),
                     "yaw": round(yaw, 2), "sharp": round(sharp, 1), "vec": vec})
    vecs = [r["vec"] for r in rows if r.get("face")]
    mean = np.mean(vecs, axis=0)
    for r in rows:
        if not r.get("face"):
            continue
        others = [v for v in vecs if v is not r["vec"]]
        loo = np.mean(others, axis=0) if others else r["vec"]
        r["simToOthers"] = round(float(np.dot(r["vec"], loo / np.linalg.norm(loo))), 3)
        del r["vec"]
    pair = [float(np.dot(a, b)) for i, a in enumerate(vecs) for b in vecs[i + 1:]]
    return {"photos": len(rows), "faces": len(vecs), "meanPairSim": round(float(np.mean(pair)), 3) if pair else None,
            "meanNorm": round(float(np.linalg.norm(mean)), 3), "rows": rows}


if __name__ == "__main__":
    root = sys.argv[1]
    names = sys.argv[2:] or sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    print(json.dumps({name: audit(os.path.join(root, name)) for name in names}, indent=1))
