"""Build diagnostic original/output frame sheets, outside timed playback."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np

p = argparse.ArgumentParser()
p.add_argument('reports', nargs='+', type=Path)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
root = Path(__file__).resolve().parents[1] / 'Pong Swap/benchmarks/realtime-stock-corpus/input'
rows = {}
for report in a.reports:
    for row in json.loads(report.read_text())['clips']:
        if row.get('outputFile'):
            rows[row['clip']] = row
canvas = np.full((len(rows)*270, 960, 3), 24, np.uint8)
for y, (clip, row) in enumerate(sorted(rows.items())):
    for column, (label, file, second) in enumerate([
        ('original', root/f'clip-{clip:02d}.mp4', 2),
        ('swap 1s', Path(row['outputFile']), 1),
        ('swap 3s', Path(row['outputFile']), 3),
    ]):
        cap = cv2.VideoCapture(str(file)); cap.set(cv2.CAP_PROP_POS_MSEC, second*1000)
        ok, frame = cap.read(); cap.release()
        if not ok:
            continue
        scale = min(310/frame.shape[1], 232/frame.shape[0])
        frame = cv2.resize(frame, (round(frame.shape[1]*scale),round(frame.shape[0]*scale)))
        x = column*320+(320-frame.shape[1])//2
        top = y*270+28+(235-frame.shape[0])//2
        canvas[top:top+frame.shape[0],x:x+frame.shape[1]] = frame
        cv2.putText(canvas, f'{clip}: {label}', (column*320+8,y*270+20),cv2.FONT_HERSHEY_SIMPLEX,.5,(215,215,215),1,cv2.LINE_AA)
a.output.parent.mkdir(parents=True,exist_ok=True)
if not cv2.imwrite(str(a.output),canvas):
    raise RuntimeError('Contact sheet save failed')
print(a.output)
