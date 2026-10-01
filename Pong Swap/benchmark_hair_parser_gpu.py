"""Bounded, read-only GPU parser timing; no presets or live sessions touched."""
import json,time
import cv2,numpy as np,torch,onnxruntime as ort
from pong_swap_config import MODELS_DIR,FACES_DIR
from pong_hair_policy import color_from_hair_mask
if hasattr(ort,'preload_dlls'):ort.preload_dlls()
stream=torch.cuda.Stream()
session=ort.InferenceSession(str(MODELS_DIR/'faceparser_resnet34.onnx'),providers=[('CUDAExecutionProvider',{'user_compute_stream':str(stream.cuda_stream)})])
if session.get_providers()[0]!='CUDAExecutionProvider':raise RuntimeError('GPU provider unavailable')
image=cv2.cvtColor(cv2.resize(cv2.imread(str(FACES_DIR/'Approved 8'/'source.jpg')),(512,512)),cv2.COLOR_BGR2RGB)
rows=[]
for i in range(6):
 start=time.perf_counter()
 with torch.cuda.stream(stream):
  inp=torch.from_numpy(np.ascontiguousarray(image.transpose(2,0,1))).to('cuda',dtype=torch.float32)/255
  inp=((inp-torch.tensor([.485,.456,.406],device='cuda')[:,None,None])/torch.tensor([.229,.224,.225],device='cuda')[:,None,None]).unsqueeze(0).contiguous()
  out=torch.empty((1,19,512,512),device='cuda',dtype=torch.float32)
  binding=session.io_binding();binding.bind_input(session.get_inputs()[0].name,'cuda',0,np.float32,tuple(inp.shape),inp.data_ptr());binding.bind_output(session.get_outputs()[0].name,'cuda',0,np.float32,tuple(out.shape),out.data_ptr())
  session.run_with_iobinding(binding)
  probability=torch.softmax(out,dim=1)[0,17].cpu().numpy()
 stream.synchronize();color_from_hair_mask(image,probability)
 rows.append(round((time.perf_counter()-start)*1000,2))
print(json.dumps({'provider':'CUDA','coldMs':rows[0],'warmMs':rows[1:],'medianWarmMs':float(np.median(rows[1:]))}))
