"""Frame-synchronous face comparisons. Never part of benchmark timing.

Crops are fixed per source (not per candidate), with no resize, interpolation,
colour filtering or temporal sampling. Individual original files remain available.
Each decoded composite plane is checked against the corresponding input plane.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from fractions import Fraction

import av
import numpy as np

ROOT = Path('E:/Pong Benchmarks/user-quality-review-2026-09-30')


def digest(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()


def preview(manifest, destination):
    import cv2
    canvas=np.full((5*270,3*400,3),24,np.uint8)
    for row,clip in enumerate(manifest['clips']):
        cap=cv2.VideoCapture(clip['source'])
        for col,second in enumerate([.5,3,5.5]):
            cap.set(cv2.CAP_PROP_POS_MSEC,second*1000);ok,frame=cap.read()
            if not ok: raise RuntimeError('Source preview unavailable')
            h,w=frame.shape[:2];scale=min(390/w,235/h)
            small=cv2.resize(frame,(round(w*scale),round(h*scale)))
            top=row*270+30;left=col*400+(400-small.shape[1])//2
            canvas[top:top+small.shape[0],left:left+small.shape[1]]=small
            cv2.putText(canvas,f"Clip {clip['id']} / {second}s / {w}x{h}",(col*400+6,row*270+22),cv2.FONT_HERSHEY_SIMPLEX,.5,(220,220,220),1)
        cap.release()
    if not cv2.imwrite(str(destination),canvas): raise RuntimeError('Preview failed')


def plane_array(frame, index):
    p=frame.planes[index]
    return np.frombuffer(p,dtype=np.uint8).reshape(p.height,p.line_size)[:,:p.width]


def verify_composite(before, after, output, crop, expected):
    x,y,w,h=crop
    with av.open(str(before)) as a,av.open(str(after)) as b,av.open(str(output)) as out:
        if out.streams.audio: raise ValueError('Audio is forbidden')
        if any(c.streams.video[0].codec_context.format.name!='yuv420p' for c in (a,b,out)):
            raise ValueError('Lossless plane verification requires matching yuv420p')
        streams=[iter(c.decode(video=0)) for c in (a,b,out)]
        count=0
        while True:
            frames=[next(s,None) for s in streams]
            if all(f is None for f in frames): break
            if any(f is None for f in frames): raise ValueError('Frame count mismatch')
            fa,fb,fo=frames
            if (fo.width,fo.height)!=(w*2,h):raise ValueError('Composite dimensions changed')
            if abs(float(fa.time)-float(fb.time))>.001 or abs(float(fa.time)-float(fo.time))>.001:
                raise ValueError('Composite timestamps are not aligned')
            for i in range(3):
                scale=1 if i==0 else 2
                xx,yy,ww,hh=x//scale,y//scale,w//scale,h//scale
                expected_plane=np.concatenate([plane_array(f,i)[yy:yy+hh,xx:xx+ww] for f in (fa,fb)],axis=1)
                if not np.array_equal(expected_plane,plane_array(fo,i)):
                    raise ValueError('Composite introduced a pixel change')
            count+=1
        if count!=expected: raise ValueError('Unexpected frame count')
        return {'frames':count,'width':w*2,'height':h,'audio':False,'pixelExact':True,'timestampsAligned':True}


def compose(candidate, manifest, crops):
    for row in candidate['clips']:
        clip=next(c for c in manifest['clips'] if c['id']==row['clip'])
        before=Path(row.get('before',{}).get('file') or clip['baseline']);after=Path(row['file'])
        for p,sha in [(before,row.get('before',{}).get('sha256') or clip['sha256']),(after,row['sha256'])]:
            if not p.resolve().is_relative_to(ROOT) or digest(p)!=sha:raise ValueError('Source identity changed')
        crop=crops[str(row['clip'])]
        x,y,w,h=crop
        if any(type(n)!=int or n%2 or n<0 for n in crop) or not w or not h:raise ValueError('Even chroma-aligned crop required')
        if x+w>row['integrity']['width'] or y+h>row['integrity']['height']:raise ValueError('Crop outside frame')
        directory=ROOT/'composites'/candidate['id'];directory.mkdir(parents=True,exist_ok=True)
        destination=directory/f"clip-{row['clip']}-faces-v1.webm"
        existing=row.get('comparison')
        if existing and Path(existing['file'])==destination and destination.exists() and digest(destination)==existing['sha256']:
            continue
        # Lossless VP9 profile 0 keeps the original decoded colour samples intact.
        # Unlike lossless H.264's 4:4:4-predictive profile, this remains a normal
        # browser-supported 8-bit 4:2:0 profile on Chrome/Firefox Android.
        # No height/width scaling: native-resolution face detail is preserved.
        filt=f'[0:v]crop={w}:{h}:{x}:{y}:exact=1[a];[1:v]crop={w}:{h}:{x}:{y}:exact=1[b];[a][b]hstack=inputs=2[v]'
        if not destination.exists():
            subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-i',str(before),'-i',str(after),
                '-filter_complex_threads','1','-filter_complex',filt,'-map','[v]','-an','-c:v','libvpx-vp9',
                '-threads','2','-deadline','realtime','-cpu-used','8','-row-mt','1','-lossless','1',
                '-pix_fmt','yuv420p','-fps_mode','passthrough',str(destination)],check=True)
        # A completed file from an interrupted publication may be reused only
        # after checking every decoded plane against both original inputs.
        integrity=verify_composite(before,after,destination,crop,row['integrity']['frames'])
        row['comparison']={'file':str(destination),'sha256':digest(destination),'crop':crop,'integrity':integrity,
            'layout':'before-left_after-right','method':'native face crop, lossless decoded YUV planes; originals retained'}
        print(json.dumps({'candidate':candidate['id'],'clip':row['clip'],**integrity}),flush=True)


def main():
    p=argparse.ArgumentParser();p.add_argument('--preview',type=Path);p.add_argument('--candidate',action='append');a=p.parse_args()
    mf=ROOT/'gallery.json';initial=mf.read_bytes();m=json.loads(initial)
    if a.preview:return preview(m,a.preview)
    crops=json.loads((ROOT/'face-review-crops.json').read_text())
    selected=[c for c in m['candidates'] if not a.candidate or c['id'] in a.candidate]
    for c in selected:compose(c,m,crops)
    if mf.read_bytes()!=initial:raise RuntimeError('Manifest changed concurrently; refusing to overwrite')
    temp=ROOT/'gallery-composites.next';temp.write_text(json.dumps(m,indent=2),encoding='utf8');os.replace(temp,mf)


if __name__=='__main__':main()
