"""Isolated LAB inverse pointwise kernel; no change to channel statistics."""
import ctypes as ct
import threading
from experiment_cuda_module import CudaModule

SOURCE = r'''
__device__ float clamp01(float x) { return isnan(x) ? x : fminf(fmaxf(x,0.0f),1.0f); }
__device__ float inv_f(float t) {
    return t > float(6.0/29.0) ? (t*t)*t : (116.0f*t-16.0f)*float(1.0/(24389.0/27.0));
}
__device__ unsigned char encode(float x) {
    x=clamp01(x);
    float s=x>0.0031308f ? 1.055f*powf(fmaxf(x,1.e-12f),float(1.0/2.4))-0.055f : 12.92f*x;
    return (unsigned char)(clamp01(s)*255.0f);
}
extern "C" __global__ void lab_inverse(const float* lab, unsigned char* out, int n) {
    int p=blockIdx.x*blockDim.x+threadIdx.x;
    if (p>=n) return;
    float fy=(lab[p]+16.0f)*float(1.0/116.0);
    float fx=fy+lab[n+p]*float(1.0/500.0);
    float fz=fy-lab[2*n+p]*float(1.0/200.0);
    float X=inv_f(fx)*0.95047f, Y=inv_f(fy), Z=inv_f(fz)*1.08883f;
    float R=(3.2404542f*X-1.5371385f*Y)-0.4985314f*Z;
    float G=(-0.9692660f*X+1.8760108f*Y)+0.0415560f*Z;
    float B=(0.0556434f*X-0.2040259f*Y)+1.0572252f*Z;
    out[p]=encode(R); out[n+p]=encode(G); out[2*n+p]=encode(B);
}
extern "C" __global__ void lab_transfer(const float* lab, const float* sm, const float* ss,
    const float* tm, const float* ts, unsigned char* out, int n) {
    int p=blockIdx.x*blockDim.x+threadIdx.x;
    if (p>=n) return;
    float L=((lab[p]-sm[0])/ss[0])*ts[0]+tm[0];
    float a=((lab[n+p]-sm[1])/ss[1])*ts[1]+tm[1];
    float b=((lab[2*n+p]-sm[2])/ss[2])*ts[2]+tm[2];
    float fy=(L+16.0f)*float(1.0/116.0);
    float fx=fy+a*float(1.0/500.0);
    float fz=fy-b*float(1.0/200.0);
    float X=inv_f(fx)*0.95047f, Y=inv_f(fy), Z=inv_f(fz)*1.08883f;
    float R=(3.2404542f*X-1.5371385f*Y)-0.4985314f*Z;
    float G=(-0.9692660f*X+1.8760108f*Y)+0.0415560f*Z;
    float B=(0.0556434f*X-0.2040259f*Y)+1.0572252f*Z;
    out[p]=encode(R); out[n+p]=encode(G); out[2*n+p]=encode(B);
}
'''
_kernel = None
_kernel_lock = threading.RLock()


def prewarm():
    global _kernel
    with _kernel_lock:
        if _kernel is None:
            _kernel = CudaModule(SOURCE, ('lab_inverse', 'lab_transfer'))


def inverse(lab):
    import torch
    prewarm()
    out = torch.empty(lab.shape, dtype=torch.uint8, device=lab.device)
    n = lab.shape[1]*lab.shape[2]
    _kernel.launch('lab_inverse', n, [ct.c_void_p(lab.data_ptr()), ct.c_void_p(out.data_ptr()), ct.c_int(n)], (lab, out))
    return out


def transfer(lab, s_mean, s_std, t_mean, t_std):
    import torch
    prewarm()
    out = torch.empty(lab.shape, dtype=torch.uint8, device=lab.device)
    n = lab.shape[1]*lab.shape[2]
    tensors = (lab, s_mean, s_std, t_mean, t_std, out)
    _kernel.launch('lab_transfer', n, [ct.c_void_p(t.data_ptr()) for t in tensors]+[ct.c_int(n)], tensors)
    return out


def install(*, fuse_transfer=False):
    import torch
    from rope import VideoManager as module
    original = module._lab_to_rgb_chw_uint8
    if getattr(original, '_isolated_lab_inverse', False):
        raise RuntimeError('LAB inverse experiment is already installed')
    def call(lab):
        if (lab.is_cuda and lab.device.index == 0 and lab.dtype == torch.float32
                and lab.ndim == 3 and lab.shape[0] == 3 and min(lab.shape[1:]) > 0
                and lab.is_contiguous()):
            return inverse(lab)
        return original(lab)
    call._isolated_lab_inverse = True
    module._lab_to_rgb_chw_uint8 = call
    if fuse_transfer:
        import inspect
        import textwrap
        source = textwrap.dedent(inspect.getsource(module._match_lab_color))
        marker = '    return _lab_to_rgb_chw_uint8((swap_lab - s_mean) / s_std * t_std + t_mean)'
        if source.count(marker) != 1:
            raise RuntimeError('LAB transfer source contract changed')
        def guarded(lab, sm, ss, tm, ts):
            values = (lab, sm, ss, tm, ts)
            if (lab.is_cuda and lab.device.index == 0 and lab.ndim == 3
                    and lab.shape[0] == 3 and min(lab.shape[1:]) > 0
                    and all(t.dtype == torch.float32 and t.device == lab.device and t.is_contiguous() for t in values)
                    and all(t.numel() == 3 for t in values[1:])):
                return transfer(*values)
            return original((lab - sm) / ss * ts + tm)
        source = source.replace(marker, '    return _isolated_lab_transfer(swap_lab, s_mean, s_std, t_mean, t_std)', 1)
        module._isolated_lab_transfer = guarded
        scope = {}
        exec(compile(source, module.__file__, 'exec'), module.__dict__, scope)
        module._match_lab_color = scope['_match_lab_color']


if __name__ == '__main__':
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent / 'engine' / 'Rope'))
    import torch
    from rope.VideoManager import _lab_to_rgb_chw_uint8, _rgb_chw_to_lab
    torch.manual_seed(3040)
    for i in range(16):
        if i < 8:
            lab = torch.randn((3,1024,1024), device='cuda')*100
        else:
            rgb = torch.randint(0,256,(3,1024,1024),device='cuda',dtype=torch.uint8)
            lab = _rgb_chw_to_lab(rgb)
        expected, actual = _lab_to_rgb_chw_uint8(lab), inverse(lab)
        bad = int((expected != actual).sum().item())
        print(i, 'differing bytes', bad, flush=True)
        if bad:
            indices = (expected != actual).nonzero()[:10]
            print(indices, expected[tuple(indices.T)], actual[tuple(indices.T)], flush=True)
            raise AssertionError('LAB inverse is not pixel exact')
        sm = lab.mean((1,2),keepdim=True)
        ss = lab.std((1,2),keepdim=True)+1.e-6
        tm = torch.randn((3,1,1),device='cuda')*50
        ts = torch.rand((3,1,1),device='cuda')*30
        expected = _lab_to_rgb_chw_uint8((lab-sm)/ss*ts+tm)
        actual = transfer(lab,sm,ss,tm,ts)
        if not torch.equal(expected,actual):
            raise AssertionError(('LAB transfer differs', int((expected!=actual).sum().item())))
    print('LAB inverse byte parity passed')
