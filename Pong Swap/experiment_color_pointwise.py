"""Rejected LAB pointwise fusion prototype; never install in a video runner.

The CUDA kernels compile, but primitive tests found FP32 forward mismatches and
uint8 inverse mismatches on realistic LAB data. This file remains an isolated
research artifact, not a qualified optimization. Import is CPU-only.
"""

import ctypes as ct
from pathlib import Path


CUDA_SOURCE = r'''
__device__ __forceinline__ float lab_f(float x) {
    const float eps = (float)(216.0 / 24389.0);
    const float kappa = (float)(24389.0 / 27.0);
    float upper = powf(fmaxf(x, 1.0e-12f), (float)(1.0 / 3.0));
    float lower = (kappa * x + 16.0f) * (1.0f / 116.0f);
    return x > eps ? upper : lower;
}
__device__ __forceinline__ float linearize(float x) {
    float upper = powf((x + 0.055f) * (1.0f / 1.055f), 2.4f);
    float lower = x * (1.0f / 12.92f);
    return x > 0.04045f ? upper : lower;
}
extern "C" __global__ void rgb_to_lab_u8(const unsigned char* src, float* dst, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    float r = linearize((float)src[i] * (1.0f / 255.0f));
    float g = linearize((float)src[n+i] * (1.0f / 255.0f));
    float b = linearize((float)src[2*n+i] * (1.0f / 255.0f));
    float X = ((0.4124564f*r + 0.3575761f*g) + 0.1804375f*b) * (1.0f/0.95047f);
    float Y = (0.2126729f*r + 0.7151522f*g) + 0.0721750f*b;
    float Z = ((0.0193339f*r + 0.1191920f*g) + 0.9503041f*b) * (1.0f/1.08883f);
    float fx = lab_f(X), fy = lab_f(Y), fz = lab_f(Z);
    dst[i] = 116.0f*fy - 16.0f;
    dst[n+i] = 500.0f*(fx-fy);
    dst[2*n+i] = 200.0f*(fy-fz);
}
__device__ __forceinline__ float inverse_f(float x) {
    const float kappa = (float)(24389.0 / 27.0);
    float upper = (x*x)*x;
    float lower = (116.0f*x - 16.0f) * (1.0f/kappa);
    return x > (float)(6.0 / 29.0) ? upper : lower;
}
__device__ __forceinline__ float srgb(float x) {
    x = fminf(fmaxf(x, 0.0f), 1.0f);
    float upper = 1.055f*powf(fmaxf(x, 1.0e-12f), (float)(1.0/2.4)) - 0.055f;
    float lower = 12.92f*x;
    return x > 0.0031308f ? upper : lower;
}
extern "C" __global__ void lab_to_rgb_u8(const float* src, unsigned char* dst, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    float L=src[i], a=src[n+i], b=src[2*n+i];
    float fy=(L+16.0f)*(1.0f/116.0f);
    float fx=fy+a*(1.0f/500.0f), fz=fy-b*(1.0f/200.0f);
    float X=inverse_f(fx)*0.95047f, Y=inverse_f(fy), Z=inverse_f(fz)*1.08883f;
    float R=(3.2404542f*X-1.5371385f*Y)-0.4985314f*Z;
    float G=(-0.9692660f*X+1.8760108f*Y)+0.0415560f*Z;
    float B=(0.0556434f*X-0.2040259f*Y)+1.0572252f*Z;
    float r=fminf(fmaxf(srgb(R),0.0f),1.0f)*255.0f;
    float g=fminf(fmaxf(srgb(G),0.0f),1.0f)*255.0f;
    float bb=fminf(fmaxf(srgb(B),0.0f),1.0f)*255.0f;
    dst[i]=(unsigned char)r; dst[n+i]=(unsigned char)g; dst[2*n+i]=(unsigned char)bb;
}
'''


class Kernel:
    def __init__(self):
        import torch
        if torch.cuda.current_device() != 0:
            raise RuntimeError("Color experiment requires CUDA:0")
        torch.empty(1, device="cuda:0")
        pointer = ct.c_void_p
        self.driver = ct.WinDLL("nvcuda.dll")
        self.nvrtc = ct.WinDLL(str(Path(torch.__file__).parent / "lib/nvrtc64_120_0.dll"))
        signatures = {
            "nvrtcCreateProgram": [ct.POINTER(pointer), ct.c_char_p, ct.c_char_p, ct.c_int, pointer, pointer],
            "nvrtcCompileProgram": [pointer, ct.c_int, ct.POINTER(ct.c_char_p)],
            "nvrtcGetProgramLogSize": [pointer, ct.POINTER(ct.c_size_t)],
            "nvrtcGetProgramLog": [pointer, pointer],
            "nvrtcGetPTXSize": [pointer, ct.POINTER(ct.c_size_t)],
            "nvrtcGetPTX": [pointer, pointer],
            "nvrtcDestroyProgram": [ct.POINTER(pointer)],
        }
        for name, args in signatures.items():
            f = getattr(self.nvrtc, name); f.argtypes = args; f.restype = ct.c_int
        self.driver.cuModuleLoadData.argtypes = [ct.POINTER(pointer), pointer]
        self.driver.cuModuleLoadData.restype = ct.c_int
        self.driver.cuModuleGetFunction.argtypes = [ct.POINTER(pointer), pointer, ct.c_char_p]
        self.driver.cuModuleGetFunction.restype = ct.c_int
        self.driver.cuLaunchKernel.argtypes = [pointer, *([ct.c_uint] * 7), pointer, ct.POINTER(pointer), pointer]
        self.driver.cuLaunchKernel.restype = ct.c_int
        program = pointer()
        self._check(self.nvrtc.nvrtcCreateProgram(ct.byref(program), CUDA_SOURCE.encode(), b"color-pointwise.cu", 0, None, None))
        try:
            major, minor = torch.cuda.get_device_capability(0)
            flags = [f"--gpu-architecture=compute_{major}{minor}".encode(), b"--fmad=false", b"--ftz=false", b"--prec-div=true", b"--prec-sqrt=true"]
            opts = (ct.c_char_p * len(flags))(*flags)
            status = self.nvrtc.nvrtcCompileProgram(program, len(flags), opts)
            size = ct.c_size_t(); self._check(self.nvrtc.nvrtcGetProgramLogSize(program, ct.byref(size)))
            log = ct.create_string_buffer(size.value); self._check(self.nvrtc.nvrtcGetProgramLog(program, log))
            if status: raise RuntimeError(log.value.decode(errors="replace"))
            self._check(self.nvrtc.nvrtcGetPTXSize(program, ct.byref(size)))
            ptx = ct.create_string_buffer(size.value); self._check(self.nvrtc.nvrtcGetPTX(program, ptx))
            self.module = pointer(); self._check(self.driver.cuModuleLoadData(ct.byref(self.module), ptx))
            self.forward = pointer(); self.inverse = pointer()
            self._check(self.driver.cuModuleGetFunction(ct.byref(self.forward), self.module, b"rgb_to_lab_u8"))
            self._check(self.driver.cuModuleGetFunction(ct.byref(self.inverse), self.module, b"lab_to_rgb_u8"))
        finally:
            self.nvrtc.nvrtcDestroyProgram(ct.byref(program))

    @staticmethod
    def _check(status):
        if status: raise RuntimeError(f"Color CUDA experiment API failed: {status}")

    def run(self, function, source, dtype):
        import torch
        n = source.shape[1] * source.shape[2]
        output = torch.empty(source.shape, device=source.device, dtype=dtype)
        values = [ct.c_void_p(source.data_ptr()), ct.c_void_p(output.data_ptr()), ct.c_int(n)]
        pointers = (ct.c_void_p * len(values))(*[ct.cast(ct.byref(v), ct.c_void_p) for v in values])
        stream = torch.cuda.current_stream(source.device)
        self._check(self.driver.cuLaunchKernel(function, (n+255)//256, 1, 1, 256, 1, 1, 0, ct.c_void_p(stream.cuda_stream), pointers, None))
        source.record_stream(stream); output.record_stream(stream)
        return output


_kernel = None
_originals = None
_coverage = {"forward": 0, "inverse": 0, "fallbackForward": 0, "fallbackInverse": 0}


def coverage():
    return dict(_coverage)


def prewarm():
    global _kernel
    if _kernel is None: _kernel = Kernel()


def install():
    global _originals
    import torch
    from rope import VideoManager as module
    if _originals is not None: return
    forward, inverse = module._rgb_chw_to_lab, module._lab_to_rgb_chw_uint8
    if forward.__code__.co_argcount != 1 or inverse.__code__.co_argcount != 1:
        raise RuntimeError("Color conversion source contract changed")
    _originals = (forward, inverse)

    def fused_forward(rgb):
        if (rgb.is_cuda and rgb.device.index == 0 and rgb.dtype == torch.uint8
                and rgb.is_contiguous() and rgb.ndim == 3 and rgb.shape[0] == 3):
            prewarm(); _coverage["forward"] += 1
            return _kernel.run(_kernel.forward, rgb, torch.float32)
        _coverage["fallbackForward"] += 1
        return forward(rgb)

    def fused_inverse(lab):
        if (lab.is_cuda and lab.device.index == 0 and lab.dtype == torch.float32
                and lab.is_contiguous() and lab.ndim == 3 and lab.shape[0] == 3):
            prewarm(); _coverage["inverse"] += 1
            return _kernel.run(_kernel.inverse, lab, torch.uint8)
        _coverage["fallbackInverse"] += 1
        return inverse(lab)

    module._rgb_chw_to_lab = fused_forward
    module._lab_to_rgb_chw_uint8 = fused_inverse
