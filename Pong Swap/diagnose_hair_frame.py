"""Offline CPU-only diagnostic of an explicitly supplied original frame."""
import argparse, json
import cv2, numpy as np, onnxruntime as ort
from pong_swap_config import MODELS_DIR
from pong_hair_policy import head_crop, color_from_hair_mask

p=argparse.ArgumentParser()
p.add_argument('image')
p.add_argument('--eyes', type=float, nargs=4, required=True)
p.add_argument('--wide', action='store_true')
a=p.parse_args()
image=cv2.cvtColor(cv2.imread(a.image),cv2.COLOR_BGR2RGB)
points=np.zeros((5,2),np.float32);points[:2]=np.array(a.eyes).reshape(2,2)
crop=head_crop(image,points)
if a.wide:
    eyes=points[:2].mean(0);d=float(np.linalg.norm(points[1]-points[0]));side=6.5*d
    x,y=eyes+np.array([0,1.25*d])-side/2
    crop=cv2.resize(image[max(0,int(y)):min(image.shape[0],int(y+side)),max(0,int(x)):min(image.shape[1],int(x+side))],(512,512))
opts=ort.SessionOptions();opts.intra_op_num_threads=2
session=ort.InferenceSession(str(MODELS_DIR/'faceparser_resnet34.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
inp=(crop.astype(np.float32)/255-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
out=session.run(None,{session.get_inputs()[0].name:inp.transpose(2,0,1)[None]})[0][0]
exp=np.exp(out-out.max(axis=0,keepdims=True));prob=exp[17]/exp.sum(axis=0)
mask=prob>=.80
other=np.max(np.concatenate((out[:17],out[18:]),axis=0),axis=0)
separation=1/(1+np.exp(np.clip(other-out[17],-80,80)))
lab=cv2.cvtColor(crop,cv2.COLOR_RGB2LAB)[...,0].astype(float)*100/255
hsv=cv2.cvtColor(crop,cv2.COLOR_RGB2HSV)
region=np.zeros((512,512),bool);region[16:496,60:452]=True
robust=(separation>=.8)&region
robust=cv2.erode(robust.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
print(json.dumps({'classification':color_from_hair_mask(crop,prob),'pixels':int(mask.sum()),
 'separatedLab':np.percentile(lab[robust],[10,25,50,75,90]).tolist(),
 'separatedValue':np.percentile(hsv[...,2][robust],[10,25,50,75,90]).tolist(),
 'separated':{'pixels':int((separation>=.8).sum()),'classification':color_from_hair_mask(crop,separation)},
 'logitRange':[float(out.min()),float(out.max())], 'classes':np.bincount(out.argmax(axis=0).ravel(),minlength=19).tolist(),
 'labPercentiles':np.percentile(lab[mask],[10,25,50,75,90]).tolist() if mask.any() else [],
 'rgbMedian':np.median(crop[mask],axis=0).tolist() if mask.any() else [],
 'hsvMedian':np.median(hsv[mask],axis=0).tolist() if mask.any() else [],
 'dyedFraction':float(np.mean((hsv[...,1][mask]>120)&(hsv[...,0][mask]>35)&(hsv[...,0][mask]<170))) if mask.any() else None}))
