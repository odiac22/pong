"""Exact pointwise identity-residual experiment; unchanged temporal policy."""
import ctypes as ct
import inspect
import math
import sys
import textwrap
import threading

from experiment_cuda_module import CudaModule

SOURCE = r'''
extern "C" __global__ void identity_blend(
    const float* current, const float* prior, const float* residual,
    const float* delta, float* output, float* stable,
    int h, int w, float weight, float complement, float low, float inverse_range) {
    int p=blockIdx.x*blockDim.x+threadIdx.x;
    int n=h*w;
    if (p>=n) return;
    int y=p/w, x=p%w;
    float sum=0.f;
    for(int dy=-1;dy<=1;dy++) {
        int yy=y+dy;
        if(yy<0 || yy>=h) continue;
        for(int dx=-1;dx<=1;dx++) {
            int xx=x+dx;
            if(xx<0 || xx>=w) continue;
            float v=(delta[yy*w+xx]-low)*inverse_range;
            if(v<0.f) v=0.f;
            if(v>1.f) v=1.f;
            sum+=v;
        }
    }
    float local=sum/9.f;
    float alpha=weight+complement*local;
    for(int c=0;c<3;c++) {
        int i=c*n+p;
        float start=prior[i], end=residual[i];
        float s=fabsf(alpha)<.5f ? fmaf(alpha,end-start,start)
                              : fmaf(-(end-start),1.f-alpha,end);
        stable[i]=s;
        float v=current[i]+s;
        if(v<0.f) v=0.f;
        if(v>255.f) v=255.f;
        output[i]=v;
    }
}
'''
_module=None
_lock=threading.RLock()

def prewarm():
    global _module
    with _lock:
        if _module is None:
            _module=CudaModule(SOURCE, ('identity_blend',))

def apply(current, prior, residual, delta, weight, low, high):
    import torch
    from experiment_identity_graph import _ops
    tensors=(current,prior,residual,delta)
    if not (all(t.is_cuda and t.device.index==0 and t.dtype==torch.float32 and t.is_contiguous() for t in tensors)
            and current.ndim==3 and current.shape[0]==3 and min(current.shape[1:])>0
            and prior.shape==current.shape and residual.shape==current.shape
            and tuple(delta.shape)==(1,*current.shape[1:])
            and all(math.isfinite(v) for v in (weight,low,high)) and high>low):
        return _ops(*tensors,weight,low,high)
    prewarm()
    output=torch.empty_like(current)
    stable=torch.empty_like(residual)
    h,w=current.shape[1:]
    values=(*tensors,output,stable)
    _module.launch('identity_blend',h*w,
        [ct.c_void_p(t.data_ptr()) for t in values]
        +[ct.c_int(h),ct.c_int(w),ct.c_float(weight),ct.c_float(1.-weight),ct.c_float(low),ct.c_float(1./(high-low))],values)
    return output,stable

def install():
    from rope.VideoManager import VideoManager
    from experiment_identity_graph import _OLD, _NEW
    original=VideoManager._temporal_identity_residual
    if getattr(original,'_isolated_identity_blend',False):
        return
    source=textwrap.dedent(getattr(VideoManager, '_isolated_identity_guard_source', None) or inspect.getsource(original))
    if source.count(_OLD)!=1:
        raise RuntimeError('Identity blend source contract changed')
    scope={}
    exec(compile(source.replace(_OLD,_NEW),__file__,'exec'),sys.modules[VideoManager.__module__].__dict__,scope)
    VideoManager._isolated_identity_graph_apply=lambda self,*a:apply(*a)
    VideoManager._temporal_identity_residual=scope['_temporal_identity_residual']
    VideoManager._temporal_identity_residual._isolated_identity_blend=True

if __name__=='__main__':
    import torch
    from experiment_identity_graph import _ops
    from experiment_identity_delta_kernel import _assert_exact
    torch.manual_seed(3090)
    total=0
    for shape in ((1,1),(3,5),(64,64),(511,513),(1024,1024)):
        current=torch.rand((3,*shape),device='cuda')*255
        prior=torch.randn_like(current)*100
        residual=torch.randn_like(current)*100
        delta=torch.rand((1,*shape),device='cuda')*30
        for weight,low,high in ((0.,2.,14.),(.25,2.,14.),(.763063211,2.,14.),(.99,.17,9.421),(1.,2.,14.)):
            expected=_ops(current,prior,residual,delta,weight,low,high)
            actual=apply(current,prior,residual,delta,weight,low,high)
            for name,a,b in zip(('output','stable'),actual,expected):
                _assert_exact(a,b,(shape,weight,name))
            total+=1
    print({'cases':total,'fp32BitParity':True},flush=True)
