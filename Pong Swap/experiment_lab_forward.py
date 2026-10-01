"""Exact-forward LAB fusion candidate; qualify all uint8 colors before use."""
import ctypes as ct
from experiment_cuda_module import CudaModule

SOURCE = r'''
__device__ float gamma(float v) {
    v = v*(1.0f/255.0f);
    return v>0.04045f ? powf((v+0.055f)*float(1.0/1.055),2.4f) : v*float(1.0/12.92);
}
__device__ float fn(float v) {
    return v>float(216.0/24389.0) ? powf(fmaxf(v,1.e-12f),float(1.0/3.0)) : (float(24389.0/27.0)*v+16.0f)*(1.0f/116.0f);
}
extern "C" __global__ void lab_forward(const unsigned char* src, float* out,
    int h,int w,long long sc,long long sy,long long sx) {
    int p=blockIdx.x*blockDim.x+threadIdx.x, n=h*w;
    if (p>=n) return;
    long long b=(long long)(p/w)*sy+(long long)(p%w)*sx;
    float r=gamma(float(src[b])),g=gamma(float(src[b+sc])),bl=gamma(float(src[b+2*sc]));
    float X=((0.4124564f*r+0.3575761f*g)+0.1804375f*bl)*float(1.0/0.95047);
    float Y=(0.2126729f*r+0.7151522f*g)+0.0721750f*bl;
    float Z=((0.0193339f*r+0.1191920f*g)+0.9503041f*bl)*float(1.0/1.08883);
    float fx=fn(X),fy=fn(Y),fz=fn(Z);
    out[p]=116.0f*fy-16.0f; out[n+p]=500.0f*(fx-fy); out[2*n+p]=200.0f*(fy-fz);
}
'''
_kernel = None


def forward(rgb):
    import torch
    global _kernel
    if _kernel is None:
        _kernel=CudaModule(SOURCE,('lab_forward',))
    out=torch.empty(rgb.shape,dtype=torch.float32,device=rgb.device)
    h,w=rgb.shape[1:]
    args=[ct.c_void_p(rgb.data_ptr()),ct.c_void_p(out.data_ptr()),ct.c_int(h),ct.c_int(w)]
    args += [ct.c_longlong(s) for s in rgb.stride()]
    _kernel.launch('lab_forward',h*w,args,(rgb,out))
    return out


def install():
    import torch
    from rope import VideoManager as module
    original=module._rgb_chw_to_lab
    def call(rgb):
        if (rgb.is_cuda and rgb.device.index==0 and rgb.dtype==torch.uint8
                and rgb.ndim==3 and rgb.shape[0]==3 and min(rgb.shape[1:])>0
                and all(s>0 for s in rgb.stride())):
            return forward(rgb)
        return original(rgb)
    module._rgb_chw_to_lab=call


if __name__=='__main__':
    import sys
    from pathlib import Path
    sys.path.insert(0,str(Path(__file__).parent/'engine'/'Rope'))
    import torch
    from rope.VideoManager import _rgb_chw_to_lab
    for first in range(0,1<<24,1<<20):
        keys=torch.arange(first,first+(1<<20),device='cuda',dtype=torch.int32)
        rgb=torch.stack(((keys>>16).to(torch.uint8),(keys>>8).to(torch.uint8),keys.to(torch.uint8))).reshape(3,1024,1024)
        a,b=_rgb_chw_to_lab(rgb),forward(rgb)
        bad=int((a.view(torch.int32)!=b.view(torch.int32)).sum().item())
        print(first,'differing',bad,'max',float((a-b).abs().max().item()),flush=True)
        if bad: raise AssertionError('FP32 LAB forward is not bit exact')
    print('All 16,777,216 uint8 RGB colors have identical FP32 LAB output')
