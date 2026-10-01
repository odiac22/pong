"""Objective swap-stability meter (CPU).

For each frame, finds the face box on the ORIGINAL clip (det_10g) and reports:
  swap     mean |output - original| inside the face box. Near 0 = the swap
           vanished (dropout / "morphing back" to the real face).
  flicker  mean |output_t - output_t-1| minus the same for the original,
           inside the face box: change the swap adds that the video doesn't
           have (popping, shimmering, ghosting).
usage: python stability.py original.mp4 swapped.mp4 [more swapped.mp4 ...]
"""
from __future__ import annotations

import json
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort

MODELS = r"C:\Users\arian\Documents\Codex\2026-07-15\files-mentioned-by-the-user-chatgpt\work\pong\Pong Swap\runtime\models"
det = ort.InferenceSession(os.path.join(MODELS, "det_10g.onnx"), providers=["CPUExecutionProvider"])


def face_box(bgr):
    size = 640
    h, w = bgr.shape[:2]
    scale = size / max(h, w)
    canvas = np.zeros((size, size, 3), np.uint8)
    resized = cv2.resize(bgr, (int(w * scale), int(h * scale)))
    canvas[:resized.shape[0], :resized.shape[1]] = resized
    blob = cv2.dnn.blobFromImage(canvas, 1 / 128, (size, size), (127.5,) * 3, swapRB=True)
    outs = det.run(None, {det.get_inputs()[0].name: blob})
    best = None
    for i, stride in enumerate((8, 16, 32)):
        scores, boxes = outs[i][:, 0], outs[i + 3] * stride
        grid = size // stride
        centers = np.repeat(np.stack(np.mgrid[:grid, :grid][::-1], axis=-1).reshape(-1, 2) * stride, 2, axis=0)
        for j in np.where(scores > 0.35)[0]:
            c = centers[j]
            box = np.array([c[0] - boxes[j, 0], c[1] - boxes[j, 1], c[0] + boxes[j, 2], c[1] + boxes[j, 3]]) / scale
            area = (box[2] - box[0]) * (box[3] - box[1])
            if best is None or area > best[1]:
                best = (box, area)
    return None if best is None else best[0]


def read(path):
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            return frames
        frames.append(frame)


def main():
    original = read(sys.argv[1])
    boxes, last = [], None
    for frame in original:
        box = face_box(frame)
        last = box if box is not None else last  # hold the last box through detector misses
        boxes.append(last)
    report = {}
    for path in sys.argv[2:]:
        out = read(path)
        n = min(len(out), len(original))
        swap, flicker = [], []
        for i in range(n):
            if boxes[i] is None:
                swap.append(None); flicker.append(None); continue
            x0, y0, x1, y1 = [int(v) for v in boxes[i]]
            h, w = original[i].shape[:2]
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
            o = original[i][y0:y1, x0:x1].astype(np.int16)
            s = cv2.resize(out[i], (w, h))[y0:y1, x0:x1].astype(np.int16)
            swap.append(float(np.abs(s - o).mean()))
            if i:
                po = original[i - 1][y0:y1, x0:x1].astype(np.int16)
                ps = cv2.resize(out[i - 1], (w, h))[y0:y1, x0:x1].astype(np.int16)
                flicker.append(float(np.abs(s - ps).mean() - np.abs(o - po).mean()))
            else:
                flicker.append(None)
        valid_swap = [v for v in swap if v is not None]
        level = float(np.median(valid_swap)) if valid_swap else 0.0
        dropouts = [i for i, v in enumerate(swap) if v is not None and v < 0.35 * level]
        valid_flicker = [v for v in flicker if v is not None]
        report[os.path.basename(path)] = {
            "frames": n,
            "medianSwapStrength": round(level, 2),
            "dropoutFrames": len(dropouts),
            "dropoutAt": [round(i / 25.0, 2) for i in dropouts[:12]],
            "flickerMean": round(float(np.mean(valid_flicker)), 3),
            "flickerP95": round(float(np.percentile(valid_flicker, 95)), 3),
            "popFrames": int(sum(1 for v in valid_flicker if v > 6)),
        }
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
