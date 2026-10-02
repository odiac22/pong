"""Lower-face swap coverage and edge flicker (CPU).

coverage: share of the lower 60% of the original's face box where the output
          differs from the original (>10/255). Low = the real face shows
          through (occluder over-masking, "morphing back").
flicker:  output frame-to-frame change minus the original's, same region.
usage: python coverage.py original.mp4 start_s end_s out1.mp4 [out2.mp4 ...]
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stability as st  # noqa: E402


def main():
    original = st.read(sys.argv[1])
    start, end = float(sys.argv[2]), float(sys.argv[3])
    import cv2
    fps = cv2.VideoCapture(sys.argv[1]).get(cv2.CAP_PROP_FPS) or 30.0
    frames = range(max(0, int(start * fps)), min(len(original), int(end * fps)))
    boxes = {}
    last = None
    for i in frames:
        box = st.face_box(original[i])
        last = box if box is not None else last
        boxes[i] = last
    for path in sys.argv[4:]:
        out = st.read(path)
        coverage, flicker = [], []
        for i in frames:
            if boxes[i] is None or i >= len(out):
                continue
            x0, y0, x1, y1 = [max(0, int(v)) for v in boxes[i]]
            y0 += int((y1 - y0) * .4)
            o = original[i][y0:y1, x0:x1].astype(np.int16)
            s = out[i][y0:y1, x0:x1].astype(np.int16)
            coverage.append(float((np.abs(s - o).mean(axis=2) > 10).mean()))
            if i - 1 in boxes and i > frames[0]:
                flicker.append(float(np.abs(s - out[i - 1][y0:y1, x0:x1].astype(np.int16)).mean()
                                     - np.abs(o - original[i - 1][y0:y1, x0:x1].astype(np.int16)).mean()))
        print(f"{os.path.basename(path):34s} coverage median {np.median(coverage):5.0%}  p10 {np.percentile(coverage, 10):5.0%}"
              f"  worst {np.min(coverage):5.0%}  flicker {np.mean(flicker):.2f}")


if __name__ == "__main__":
    main()
