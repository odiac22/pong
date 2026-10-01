"""Review retained encoded output only; never labels missing paint as success."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('report', type=Path)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
r = json.loads(a.report.read_text())
trials = [t for t in r['trials'] if t.get('distinctVideo')]
media = {m['trial']: m for m in r.get('retainedMedia', []) if m.get('file')}
canvas = np.full((len(trials)*275, 900, 3), 22, np.uint8)
evidence = []
for y,t in enumerate(trials):
    record = media.get(t['index'])
    samples = t.get('samples', [])
    if record:
        samples = [s for s in samples if s['renderer'].get('id') == record['session']
                   and s['view'].get('session') == record['session']]
    evidence.append({'trial': t['index'], 'retained': bool(record and samples)})
    for col,at in enumerate((1000, 2500, 4000)):
        label = f"Trial {t['index']} @ {at/1000}s"
        cv2.putText(canvas,label,(col*300+7,y*275+20),cv2.FONT_HERSHEY_SIMPLEX,.5,(230,230,230),1,cv2.LINE_AA)
        if not record or not samples:
            cv2.putText(canvas,'No owned output retained',(col*300+7,y*275+100),cv2.FONT_HERSHEY_SIMPLEX,.4,(170,170,230),1)
            continue
        sample = min(samples,key=lambda s:abs(s['at']-at))
        view = sample['view']
        second = view.get('lastPaintedMediaTime')
        if not isinstance(second,(int,float)) or second<0:
            second = (view.get('sync') or {}).get('target',0)
        second = max(0,float(second or 0))
        cap=cv2.VideoCapture(record['file']);cap.set(cv2.CAP_PROP_POS_MSEC,second*1000)
        ok,frame=cap.read();cap.release()
        if not ok:
            continue
        scale=min(292/frame.shape[1],230/frame.shape[0])
        frame=cv2.resize(frame,(round(frame.shape[1]*scale),round(frame.shape[0]*scale)))
        x=col*300+(300-frame.shape[1])//2;top=y*275+27+(230-frame.shape[0])//2
        canvas[top:top+frame.shape[0],x:x+frame.shape[1]]=frame
        text=f"output {second:.2f}s; visible={bool(view.get('visible'))}"
        cv2.putText(canvas,text,(col*300+7,y*275+269),cv2.FONT_HERSHEY_SIMPLEX,.36,(200,200,200),1)
a.output.parent.mkdir(parents=True,exist_ok=True)
if not cv2.imwrite(str(a.output),canvas):raise RuntimeError('Image save failed')
print(json.dumps(evidence))
