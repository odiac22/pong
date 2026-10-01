"""Extract reference candidates; no identity inference and no GPU model loading."""
from pathlib import Path
import cv2, json, numpy as np, argparse
parser=argparse.ArgumentParser()
parser.add_argument('--source')
parser.add_argument('--output')
parser.add_argument('--max-per-clip',type=int,default=8)
args=parser.parse_args()
ROOT=Path(__file__).resolve().parents[1]
SRC=Path('C:/Users/arian/Documents/New project/.codex-remote-attachments/01a0dbe8-530e-7f00-b933-da90986c6315/9b5e2c5e-f155-452c-8068-94623e6d3f89')
OUT=ROOT/'artifacts/approved-28-review/candidates'
if args.source: SRC=Path(args.source)
if args.output: OUT=Path(args.output)/'candidates'
OUT.mkdir(parents=True,exist_ok=False)
cv2.setNumThreads(2)
det=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')
report=[]
for clip in sorted(SRC.glob('*.mp4')):
 cap=cv2.VideoCapture(str(clip)); fps=cap.get(cv2.CAP_PROP_FPS); count=cap.get(cv2.CAP_PROP_FRAME_COUNT)
 rows=[]
 for t in np.arange(0.25,count/fps,0.5):
  cap.set(cv2.CAP_PROP_POS_MSEC,float(t)*1000);ok,frame=cap.read()
  if not ok:continue
  scale=min(1,640/frame.shape[1]);gray=cv2.cvtColor(cv2.resize(frame,None,fx=scale,fy=scale),cv2.COLOR_BGR2GRAY)
  faces=det.detectMultiScale(gray,1.1,5,minSize=(40,40))
  if len(faces)!=1:continue
  x,y,w,h=[int(v/scale) for v in faces[0]]
  if min(w,h)<95:continue
  patch=cv2.cvtColor(frame[y:y+h,x:x+w],cv2.COLOR_BGR2GRAY)
  sharp=float(cv2.Laplacian(patch,cv2.CV_64F).var());brightness=float(patch.mean())
  if sharp<35 or not 35<brightness<225:continue
  signature=cv2.resize(patch,(32,32)).astype(float)
  rows.append(dict(time=float(t),sharpness=sharp,faceSize=w,score=sharp**0.5*w,signature=signature,frame=frame))
 cap.release();chosen=[]
 for row in sorted(rows,key=lambda r:r['score'],reverse=True):
  if any(abs(row['time']-r['time'])<2 or np.mean(abs(row['signature']-r['signature']))<9 for r in chosen):continue
  chosen.append(row)
  if len(chosen)>=args.max_per_clip:break
 for i,row in enumerate(chosen):
  name=f'clip-{clip.name[0]}-{i+1:02}.png';cv2.imwrite(str(OUT/name),row['frame'])
  report.append(dict(file=name,clip=clip.name,time=row['time'],sharpness=round(row['sharpness'],2),faceSize=row['faceSize']))
 print(clip.name[0], 'usable candidates',len(rows),'selected',len(chosen),flush=True)
(OUT.parent/'selection.json').write_text(json.dumps(report,indent=2))
# Review contact sheet; full-resolution selected frames remain untouched.
tiles=[]
for row in report:
 frame=cv2.imread(str(OUT/row['file'])); h,w=frame.shape[:2]
 scale=min(200/w,250/h); thumb=cv2.resize(frame,(round(w*scale),round(h*scale)))
 tile=np.zeros((280,200,3),np.uint8);tile[:thumb.shape[0],:thumb.shape[1]]=thumb
 cv2.putText(tile,row['file'],(4,271),cv2.FONT_HERSHEY_SIMPLEX,.4,(255,255,255),1)
 tiles.append(tile)
for start in range(0,len(tiles),20):
 page=tiles[start:start+20]
 while len(page)%5:page.append(np.zeros_like(tiles[0]))
 cv2.imwrite(str(OUT.parent/f'contact-{start//20}.jpg'),np.vstack([np.hstack(page[i:i+5]) for i in range(0,len(page),5)]))
