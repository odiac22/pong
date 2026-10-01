"""Optional exact FP32 paste-back blend and uint8 conversion in one kernel."""
import ctypes as ct
import inspect
import sys
import textwrap
import threading
from experiment_cuda_module import CudaModule

SOURCE=r'''
extern "C" __global__ void composite(
    const float* swap,const float* mask,const unsigned char* image,unsigned char* out,
    int h,int w,long long sy,long long sx,long long sc,
    long long my,long long mx,long long iy,long long ix,long long ic) {
    int p=blockIdx.x*blockDim.x+threadIdx.x;
    if(p>=h*w*3) return;
    int c=p%3,x=(p/3)%w,y=p/(3*w);
    float v=swap[y*sy+x*sx+c*sc]+mask[y*my+x*mx]*(float)image[y*iy+x*ix+c*ic];
    out[p]=(unsigned char)__float2int_rz(v);
}
'''
_module=None
_lock=threading.RLock()

def prewarm():
    global _module
    with _lock:
        if _module is None:
            _module=CudaModule(SOURCE,('composite',))

def eligible(swap,mask,image,context):
    import torch
    return (not (context and (context.get('exactPastebackFloat64Composite',False)
                              or context.get('exactPastebackRoundToNearest',False)))
            and swap.is_cuda and swap.device.index==0 and swap.dtype==torch.float32
            and image.device==swap.device and image.dtype==torch.uint8
            and mask.device==swap.device and mask.dtype==torch.float32
            and swap.ndim==3 and swap.shape[-1]==3 and min(swap.shape)>0
            and image.shape==swap.shape and tuple(mask.shape)==(*swap.shape[:2],1)
            and all(s>=0 for t in (swap,mask,image) for s in t.stride()))

def composite(swap,mask,image):
    import torch
    prewarm()
    output=torch.empty(swap.shape,device=swap.device,dtype=torch.uint8)
    h,w=swap.shape[:2]
    tensors=(swap,mask,image,output)
    _module.launch('composite',h*w*3,[ct.c_void_p(t.data_ptr()) for t in tensors]
        +[ct.c_int(h),ct.c_int(w)]
        +[ct.c_longlong(s) for s in (*swap.stride(),*mask.stride()[:2],*image.stride())],tensors)
    return output

def install():
    from rope.VideoManager import VideoManager
    original=VideoManager.swap_core
    source=getattr(original,'_isolated_source',None) or textwrap.dedent(inspect.getsource(original))
    start=source.index('        float64_composite = bool(')
    end=source.index('        swap = swap.permute(2,0,1)',start)
    block=source[start:end]
    replacement=('        if self._isolated_composite_eligible(swap, swap_mask, img_crop, temporal_context):\n'
                 '            swap = self._isolated_composite(swap, swap_mask, img_crop)\n'
                 '        else:\n'+textwrap.indent(block,'    '))
    patched=source[:start]+replacement+source[end:]
    scope={}
    exec(compile(patched,__file__,'exec'),sys.modules[VideoManager.__module__].__dict__,scope)
    VideoManager._isolated_composite_eligible=staticmethod(eligible)
    VideoManager._isolated_composite=staticmethod(composite)
    VideoManager.swap_core=scope['swap_core']
    VideoManager.swap_core._isolated_source=patched

if __name__=='__main__':
    import torch
    torch.manual_seed(3080)
    cases=0
    for h,w in ((1,1),(3,5),(256,256),(511,513),(1080,1920)):
        for strided in (False,True):
            swap=torch.randn((h,w,3),device='cuda')*300
            mask=torch.rand((h,w,1),device='cuda')*2-0.5
            image=torch.randint(0,256,(h,w,3),device='cuda',dtype=torch.uint8)
            if strided:
                swap=swap.permute(2,0,1).contiguous().permute(1,2,0)
                mask=mask.expand(h,w,4)[...,2:3]
                image=image.permute(2,0,1).contiguous().permute(1,2,0)
            expected=torch.add(swap,torch.mul(mask,image)).to(torch.uint8)
            actual=composite(swap,mask,image)
            if not torch.equal(actual,expected):
                raise AssertionError((h,w,strided,int((actual!=expected).sum().item())))
            cases+=1
    print({'cases':cases,'byteParity':True},flush=True)
