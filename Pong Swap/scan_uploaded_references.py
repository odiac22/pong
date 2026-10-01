"""Silent, non-identifying reference-quality audit. Never changes active packs.

User-assigned folders remain authoritative. Detection/landmarks describe visible
faces only; no recognition embeddings, demographic classification or identity
matching are performed. Every video frame is decoded; detection samples about 4 Hz.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
INBOX = Path(json.loads((ROOT / 'face_upload_config.json').read_text())['inbox'])
GROUPS = json.loads((ROOT / 'approved_face_groups.json').read_text())['groups']
VIDEO = {'.mp4', '.mov', '.m4v', '.webm'}
FONT = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 15)

def sha256(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()

class Detector:
    def __init__(self):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 3
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(ROOT/'runtime/models/det_10g.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        self.centers = {}
        for stride in (8,16,32):
            xy = np.stack(np.mgrid[:640//stride,:640//stride][::-1], axis=-1).reshape(-1,2)*stride
            self.centers[stride] = np.repeat(xy, 2, axis=0)

    def detect(self, bgr):
        h,w = bgr.shape[:2]
        scale = 640/max(h,w)
        nh,nw = max(1,round(h*scale)),max(1,round(w*scale))
        canvas = np.zeros((640,640,3),np.float32)
        canvas[:nh,:nw] = (cv2.resize(bgr,(nw,nh)).astype(np.float32)-127.5)/128
        values = self.session.run(None, {'input.1':canvas.transpose(2,0,1)[None].copy()})
        candidates=[]
        for i,stride in enumerate((8,16,32)):
            scores=values[i].reshape(-1)
            for j in np.flatnonzero(scores>=.6):
                x,y=self.centers[stride][j]
                left,top,right,bottom=values[i+3][j]*stride
                box=np.array([x-left,y-top,x+right,y+bottom])/scale
                points=(values[i+6][j].reshape(5,2)*stride+self.centers[stride][j])/scale
                candidates.append((float(scores[j]),box,points))
        selected=[]
        for candidate in sorted(candidates,key=lambda v:v[0],reverse=True):
            box=candidate[1]
            overlap=False
            for prior in selected:
                a=prior[1]; intersect=np.maximum(0,np.minimum(box[2:],a[2:])-np.maximum(box[:2],a[:2])).prod()
                union=np.maximum(0,box[2:]-box[:2]).prod()+np.maximum(0,a[2:]-a[:2]).prod()-intersect
                if intersect/max(1,union)>.4: overlap=True;break
            if not overlap: selected.append(candidate)
        return sorted(selected,key=lambda v:v[1][0])

def phash(image):
    gray=cv2.cvtColor(cv2.resize(image,(9,8)),cv2.COLOR_BGR2GRAY)
    return ''.join('1' if v else '0' for v in (gray[:,1:]>gray[:,:-1]).flat)

def quality(bgr, score, box, points):
    h,w=bgr.shape[:2]
    x1,y1,x2,y2=np.rint(box).astype(int)
    clip=[max(0,x1),max(0,y1),min(w,x2),min(h,y2)]
    crop=bgr[clip[1]:clip[3],clip[0]:clip[2]]
    if crop.size==0:return None,None
    gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
    norm=cv2.resize(gray,(128,128),interpolation=cv2.INTER_AREA)
    eye=points[1]-points[0]; distance=max(1,float(np.linalg.norm(eye)))
    unit=eye/distance
    # Image-relative perspective proxy, not a calibrated anatomical yaw angle.
    nose_offset=float(np.dot(points[2]-(points[0]+points[1])/2,unit)/distance)
    roll=math.degrees(math.atan2(float(eye[1]),float(eye[0])))
    sharp=float(cv2.Laplacian(norm,cv2.CV_64F).var())
    flags=[]
    if min(crop.shape[:2])<100: flags.append('small-face')
    if sharp<45: flags.append('low-detail-or-soft')
    if score<.75: flags.append('weak-detection')
    if min(x1,y1)<0 or x2>=w or y2>=h: flags.append('face-at-image-edge')
    if abs(roll)>25: flags.append('strong-roll')
    q={'confidence':round(score,4),'box':[round(float(v),1) for v in box],
       'keypoints':np.round(points,2).tolist(),'faceWidth':crop.shape[1],'faceHeight':crop.shape[0],
       'sharpness128':round(sharp,2),'lumaMedian':round(float(np.median(gray)),1),
       'darkPixelFraction':round(float((gray<15).mean()),4),'brightPixelFraction':round(float((gray>240).mean()),4),
       'rollDegrees':round(roll,1),'noseOffsetProxy':round(nose_offset,3),
       'viewBin':'negative-oblique' if nose_offset<-.18 else 'positive-oblique' if nose_offset>.18 else 'near-front',
       'flags':flags}
    return q,crop

def save_sample(bgr, detector, output, key, when=None):
    detections=detector.detect(bgr)
    sample={'timeSeconds':when,'width':bgr.shape[1],'height':bgr.shape[0],
            'faceCount':len(detections),'faces':[],'differenceHash':phash(bgr)}
    preview=bgr.copy()
    for index,(score,box,points) in enumerate(detections,1):
        q,crop=quality(bgr,score,box,points)
        if q is None:continue
        face_path=output/'faces'/f'{key}-f{index}.jpg'
        face_path.parent.mkdir(parents=True,exist_ok=True)
        scale=min(1,512/max(crop.shape[:2]))
        cv2.imwrite(str(face_path),cv2.resize(crop,(max(1,round(crop.shape[1]*scale)),max(1,round(crop.shape[0]*scale)))),[cv2.IMWRITE_JPEG_QUALITY,92])
        q.update(number=index,preview=str(face_path))
        sample['faces'].append(q)
        x1,y1,x2,y2=np.rint(box).astype(int)
        cv2.rectangle(preview,(x1,y1),(x2,y2),(60,240,100),max(2,round(max(bgr.shape[:2])/400)))
        cv2.putText(preview,f'F{index}',(max(0,x1),max(30,y1)),cv2.FONT_HERSHEY_SIMPLEX,max(.6,max(bgr.shape[:2])/1400),(60,240,100),2)
    path=output/'previews'/f'{key}.jpg';path.parent.mkdir(parents=True,exist_ok=True)
    thumb=ImageOps.contain(Image.fromarray(cv2.cvtColor(preview,cv2.COLOR_BGR2RGB)),(600,600))
    thumb.save(path,quality=88)
    sample['preview']=str(path)
    return sample

def sheet(items, target, columns=4):
    if not items:return
    canvas=Image.new('RGB',(columns*300,math.ceil(len(items)/columns)*340),'#101722')
    draw=ImageDraw.Draw(canvas)
    for n,(path,label) in enumerate(items):
        with Image.open(path) as image: small=ImageOps.contain(image.convert('RGB'),(288,288))
        x=(n%columns)*300;y=(n//columns)*340
        canvas.paste(small,(x+(300-small.width)//2,y+(292-small.height)//2))
        for j,line in enumerate(label.split('\n')[:3]):draw.text((x+7,y+295+j*16),line[:39],font=FONT,fill='white')
    target.parent.mkdir(parents=True,exist_ok=True)
    canvas.save(target,quality=92)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);a=parser.parse_args()
    a.output.mkdir(parents=True,exist_ok=False)
    detector=Detector(); started=time.monotonic()
    report={'createdAt':datetime.now(timezone.utc).isoformat(),'scope':'All five user-assigned upload groups; no identity recognition or active-pack modification',
            'method':'Every video frame decoded silently; face detection about 4 Hz (first frame >=0.25 seconds after preceding sample) using CPU det_10g at 640px, score>=0.6. Faces numbered left-to-right per frame, NOT persistent identities. Full image difference hashes are only near-duplicate hints.',
            'groups':[],'files':[]}
    seen={}
    for group in GROUPS:
        rows=[];photo_tiles=[]
        for receipt_path in sorted((INBOX/group['id']).glob('*/receipt.json')):
            receipt=json.loads(receipt_path.read_text(encoding='utf-8'))
            row={'group':group['id'],'originalName':receipt['originalName'],'uploadId':receipt['id'],'complete':receipt['complete']}
            report['files'].append(row);rows.append(row)
            if not receipt['complete']:row['status']='incomplete-upload';continue
            path=receipt_path.parent/receipt['file'];row['path']=str(path)
            checksum=sha256(path);row['sha256']=checksum;row['bytes']=path.stat().st_size
            row['checksumVerified']=checksum==receipt.get('sha256')
            row['type']='video' if path.suffix.lower() in VIDEO else 'photo'
            if not row['checksumVerified']:row['status']='checksum-mismatch';continue
            if checksum in seen:
                row['status']='exact-duplicate';row['duplicateOf']=seen[checksum];continue
            seen[checksum]=receipt['id'];row['status']='scanned';row['samples']=[]
            out=a.output/group['id'];out.mkdir(exist_ok=True)
            key=receipt['id'][:8]
            print(f"Scanning {group['name']} / {receipt['originalName']}",flush=True)
            try:
                if row['type']=='photo':
                    with Image.open(path) as image:
                        bgr=cv2.cvtColor(np.array(ImageOps.exif_transpose(image).convert('RGB')),cv2.COLOR_RGB2BGR)
                    sample=save_sample(bgr,detector,out,key);row['samples']=[sample]
                    photo_tiles.append((sample['preview'],f"{receipt['originalName']}\n{sample['width']}x{sample['height']} / faces {sample['faceCount']}"))
                else:
                    capture=cv2.VideoCapture(str(path))
                    if not capture.isOpened():raise ValueError('Video could not open')
                    fps=float(capture.get(cv2.CAP_PROP_FPS));declared=int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
                    next_sample=0.;decoded=0;last_time=-1.;pts_fallbacks=0;last_bgr=None
                    while True:
                        ok,bgr=capture.read()
                        if not ok:break
                        t=float(capture.get(cv2.CAP_PROP_POS_MSEC))/1000
                        if not math.isfinite(t) or (decoded and t<=last_time):
                            t=decoded/max(fps,1);pts_fallbacks+=1
                        last_time=t;last_bgr=bgr
                        if t+1e-6>=next_sample:
                            sample=save_sample(bgr,detector,out,f'{key}-{decoded:05d}',round(t,4));sample['frameIndex']=decoded
                            row['samples'].append(sample);next_sample=t+.25
                        decoded+=1
                    capture.release()
                    if not decoded:raise ValueError('No decodable video frames')
                    if row['samples'][-1]['frameIndex']!=decoded-1:
                        sample=save_sample(last_bgr,detector,out,f'{key}-{decoded-1:05d}',round(last_time,4));sample['frameIndex']=decoded-1;row['samples'].append(sample)
                    row.update(fps=fps,declaredFrames=declared,decodedFrames=decoded,durationSeconds=round(last_time+1/max(fps,1),4),timestampFallbackCount=pts_fallbacks,
                               frameCountMatches=declared==decoded)
                    ix=np.unique(np.linspace(0,len(row['samples'])-1,min(16,len(row['samples']))).astype(int))
                    overview=out/f'{key}-video-overview.jpg'
                    sheet([(row['samples'][i]['preview'],f"{receipt['originalName']}\n{row['samples'][i]['timeSeconds']:.2f}s / faces {row['samples'][i]['faceCount']}") for i in ix],overview)
                    row['overview']=str(overview)
                row['sampleFaceCounts']=dict(Counter(str(s['faceCount']) for s in row['samples']))
                row['multipleFaceSamples']=sum(s['faceCount']>1 for s in row['samples'])
                row['noFaceSamples']=sum(s['faceCount']==0 for s in row['samples'])
            except Exception as error:
                row['status']='decode-or-analysis-error';row['error']=str(error)
            (a.output/'scan-progress.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        for i in range(0,len(photo_tiles),12):sheet(photo_tiles[i:i+12],a.output/group['id']/f'photos-{i//12+1}.jpg')
        faces=[f for r in rows for s in r.get('samples',[]) for f in s['faces'] if s['faceCount']==1]
        # Review shortlist: only one-detection frames, no identity assertion.
        shortlist=[]
        for r in rows:
            if r.get('multipleFaceSamples',0):
                continue  # whole mixed-person clip is held pending a user target selection
            available=[(s,f) for s in r.get('samples',[]) if s['faceCount']==1 for f in s['faces'] if f['faceWidth']>=100 and f['confidence']>=.75]
            chosen=[]
            for view in ('near-front','negative-oblique','positive-oblique'):
                options=sorted([(s,f) for s,f in available if f['viewBin']==view],key=lambda sf:sf[1]['sharpness128'],reverse=True)
                for s,f in options:
                    if all(s['timeSeconds'] is None or abs(s['timeSeconds']-prior['timeSeconds'])>=1 for prior in chosen):
                        chosen.append(s);shortlist.append({'originalName':r['originalName'],'uploadId':r['uploadId'],'timeSeconds':s['timeSeconds'],'face':f});break
        group_row={'id':group['id'],'name':group['name'],'photos':sum(r.get('type')=='photo' for r in rows),
                   'videoUploads':sum(r.get('type')=='video' for r in rows),'uniqueVideos':sum(r.get('type')=='video' and r['status']=='scanned' for r in rows),
                   'duplicates':sum(r['status']=='exact-duplicate' for r in rows),'decodedVideoFrames':sum(r.get('decodedFrames',0) for r in rows),
                   'videoSeconds':round(sum(r.get('durationSeconds',0) for r in rows),2),'viewBinsSingleDetection':dict(Counter(f['viewBin'] for f in faces)),
                   'filesWithMultipleDetectedFaces':[r['originalName'] for r in rows if r.get('multipleFaceSamples',0)],
                   'reviewShortlist':shortlist}
        report['groups'].append(group_row)
        for i in range(0,len(shortlist),12):
            sheet([(v['face']['preview'],f"{v['originalName']} @ {v['timeSeconds']}\nsharp {v['face']['sharpness128']:.0f} / {v['face']['viewBin']}") for v in shortlist[i:i+12]],a.output/group['id']/f'shortlist-{i//12+1}.jpg')
    # Conservative whole-image near-duplicate flags, never face matching.
    photos=[r for r in report['files'] if r.get('type')=='photo' and r.get('samples')]
    hints=[]
    for i,left in enumerate(photos):
        for right in photos[i+1:]:
            if left['group']!=right['group']:continue
            distance=sum(a!=b for a,b in zip(left['samples'][0]['differenceHash'],right['samples'][0]['differenceHash']))
            if distance<=6:hints.append({'group':left['group'],'first':left['originalName'],'second':right['originalName'],'wholeImageHashDistance':distance})
    report['nearDuplicatePhotoHints']=hints
    report['elapsedSeconds']=round(time.monotonic()-started,2)
    (a.output/'scan.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'report':str(a.output/'scan.json'),'groups':[{k:v for k,v in g.items() if k!='reviewShortlist'} for g in report['groups']]}),flush=True)

if __name__=='__main__':main()
