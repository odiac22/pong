"""Same FP32 confidence math, separable storage to avoid redundant RGB loads."""
import ctypes as ct
import math
import threading
from experiment_cuda_module import CudaModule

SOURCE = r'''
extern "C" __global__ void rgb_change(const float* a, const float* b, float* d, int n) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    if (p >= n) return;
    float x = fabsf(a[p] - b[p]);
    float y = fabsf(a[p+n] - b[p+n]);
    float z = fabsf(a[p+2*n] - b[p+2*n]);
    d[p] = ((x + y) + z) * (1.0f/3.0f);
}
extern "C" __global__ void confidence_pool(const float* d, float* out, int h, int w, float low, float inv) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    if (p >= h*w) return;
    int y = p/w, x = p-y*w;
    float v = -__int_as_float(0x7f800000);
    for (int dy=-1; dy<=1; ++dy) {
        int yy=y+dy;
        if (yy<0 || yy>=h) continue;
        for (int dx=-1; dx<=1; ++dx) {
            int xx=x+dx;
            if (xx<0 || xx>=w) continue;
            float t=d[yy*w+xx];
            if (isnan(t) || t>v) v=t;
        }
    }
    v = 1.0f-(v-low)*inv;
    v = isnan(v) ? v : fminf(fmaxf(v,0.0f),1.0f);
    out[p] = (v*v)*(3.0f-2.0f*v);
}
'''
_kernel = None
_kernel_lock = threading.Lock()


def confidence(a, b, low=4.0, high=18.0):
    import torch
    global _kernel
    if _kernel is None:
        with _kernel_lock:
            if _kernel is None:
                _kernel = CudaModule(SOURCE, ('rgb_change', 'confidence_pool'))
    h, w = a.shape[-2:]
    delta = torch.empty((h, w), dtype=torch.float32, device=a.device)
    out = torch.empty((1, h, w), dtype=torch.float32, device=a.device)
    args = [ct.c_void_p(t.data_ptr()) for t in (a, b, delta)] + [ct.c_int(h*w)]
    _kernel.launch('rgb_change', h*w, args, (a, b, delta))
    args = [ct.c_void_p(t.data_ptr()) for t in (delta, out)]
    args += [ct.c_int(h), ct.c_int(w), ct.c_float(low), ct.c_float(1.0/max(1e-6, high-low))]
    _kernel.launch('confidence_pool', h*w, args, (delta, out))
    return out


def install():
    import torch
    from rope import VideoManager as module
    original = module._correction_confidence
    if getattr(original, '_isolated_confidence_twopass', False):
        return

    def call(a, b, low=4.0, high=18.0):
        if (a.is_cuda and b.device == a.device and a.device.index == 0
                and a.dtype == b.dtype == torch.float32 and a.shape == b.shape
                and a.ndim == 3 and a.shape[0] == 3
                and a.shape[1] > 0 and a.shape[2] > 0
                and type(low) in (int, float) and type(high) in (int, float)
                and math.isfinite(low) and math.isfinite(high)
                and a.is_contiguous() and b.is_contiguous()):
            return confidence(a, b, low, high)
        return original(a, b, low, high)

    call._isolated_confidence_twopass = True
    module._correction_confidence = call


if __name__ == '__main__':
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent / 'engine' / 'Rope'))
    import torch
    from rope.VideoManager import _correction_confidence
    torch.manual_seed(728)
    for h, w in ((3, 5), (64, 64), (256, 256), (1024, 1024)):
        for scale in (.001, 4, 16, 255):
            a = torch.rand((3, h, w), device='cuda')*255
            b = a+torch.randn_like(a)*scale
            expected = _correction_confidence(a, b)
            actual = confidence(a, b)
            if not torch.equal(expected.view(torch.int32), actual.view(torch.int32)):
                raise AssertionError((h, w, scale, float((expected-actual).abs().max().item())))
    a = torch.zeros((3, 9, 11), device='cuda')
    b = torch.zeros_like(a)
    a[0, 1, 1] = float('nan')
    a[1, 5, 4] = float('inf')
    for low, high in ((4, 18), (2, 2), (-2, 3)):
        expected, actual = _correction_confidence(a, b, low, high), confidence(a, b, low, high)
        torch.testing.assert_close(actual, expected, rtol=0, atol=0, equal_nan=True)
    print('Two-pass confidence primitive parity passed (random, borders, nonfinite, thresholds)')
