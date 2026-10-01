"""Read-only parser smoke check on approved source pictures; no data saved."""
import json,time
import cv2,numpy as np,onnxruntime as ort
from pong_swap_config import MODELS_DIR,FACES_DIR
from pong_hair_policy import color_from_hair_mask,head_crop
options=ort.SessionOptions();options.intra_op_num_threads=2
session=ort.InferenceSession(str(MODELS_DIR/'faceparser_resnet34.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
for n in (2,8):
    bgr=cv2.imread(str(FACES_DIR/f'Approved {n}'/'source.jpg'))
    cascade=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')
    boxes=cascade.detectMultiScale(cv2.cvtColor(bgr,cv2.COLOR_BGR2GRAY),1.1,5)
    if not len(boxes):raise RuntimeError('No face box for smoke probe')
    x0,y0,w,h=max(boxes,key=lambda b:b[2]*b[3])
    k=np.array([[x0+.3*w,y0+.4*h],[x0+.7*w,y0+.4*h],[x0+.5*w,y0+.6*h],[x0+.35*w,y0+.8*h],[x0+.65*w,y0+.8*h]])
    image=head_crop(cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB),k)
    if image is None:raise RuntimeError('Insufficient head crop for probe')
    x=image.astype(np.float32)/255
    x=np.ascontiguousarray(((x-[.485,.456,.406])/[.229,.224,.225]).transpose(2,0,1)[None],dtype=np.float32)
    start=time.perf_counter();logits=session.run(None,{session.get_inputs()[0].name:x})[0][0]
    e=np.exp(logits-logits.max(axis=0));p=e[17]/e.sum(axis=0)
    color,confidence=color_from_hair_mask(image,p)
    region=np.zeros((512,512),np.uint8);region[16:350,85:427]=1
    usable=cv2.erode(((p>=.8)&(region>0)).astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
    print(json.dumps({'approved':n,'usableHairPixels':int(usable.sum())}))
    lab=cv2.cvtColor(image,cv2.COLOR_RGB2LAB)[:,:,0].astype(float)*100/255
    print(json.dumps({'approved':n,'hair':color,'confidence':confidence,'cpuProbeMs':round((time.perf_counter()-start)*1000,1),'hairPixels':int((p>.8).sum()),'lightnessQuantiles':np.percentile(lab[p>.8],[10,25,50,75,90]).tolist()}))
