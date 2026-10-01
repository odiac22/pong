"""Extract silent diagnostic contact sheets; never opens a player."""
import argparse
from pathlib import Path
import cv2
import numpy as np

p = argparse.ArgumentParser()
p.add_argument('--videos', nargs='+', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--time', type=float, default=6.8)
p.add_argument('--step', type=int, default=1)
p.add_argument('--crop', type=int, nargs=4)
a = p.parse_args()
rows = []
for video in a.videos:
    capture = cv2.VideoCapture(str(video))
    fps = capture.get(cv2.CAP_PROP_FPS)
    tiles = []
    for offset in range(8):
        frame_index = int(a.time * fps) + offset * a.step
        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        ok, frame = capture.read()
        if not ok:
            break
        if a.crop:
            x, y, w, h = a.crop
            frame = frame[y:y+h, x:x+w]
        tile = cv2.resize(frame, (240, round(frame.shape[0] * 240 / frame.shape[1])))
        cv2.putText(tile, f'{frame_index/fps:.3f}s', (4, 20), cv2.FONT_HERSHEY_SIMPLEX, .48, (0,255,0), 1)
        tiles.append(tile)
    capture.release()
    if len(tiles) == 8:
        rows.append(np.concatenate(tiles, axis=1))
if not rows:
    raise RuntimeError('No frames')
cv2.imwrite(str(a.output), np.concatenate(rows, axis=0))
