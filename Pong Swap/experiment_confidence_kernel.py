"""Isolated FP32 confidence-kernel experiment. Not a production dependency."""
import ctypes as ct
from pathlib import Path
import sys
import inspect
import textwrap

SOURCE = r'''
extern "C" __global__ void confidence_map(
    const float* a, const float* b, float* result, int h, int w,
    float low, float inverse_range) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    int size = h * w;
    if (p >= size) return;
    int y = p / w, x = p - y * w;
    float maximum = -__int_as_float(0x7f800000);
    for (int dy = -1; dy <= 1; ++dy) {
        int yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (int dx = -1; dx <= 1; ++dx) {
            int xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            int q = yy * w + xx;
            float v0 = fabsf(a[q] - b[q]);
            float v1 = fabsf(a[q + size] - b[q + size]);
            float v2 = fabsf(a[q + 2*size] - b[q + 2*size]);
            float change = ((v0 + v1) + v2) * (1.0f / 3.0f);
            if (isnan(change) || change > maximum) maximum = change;
        }
    }
    float value = 1.0f - (maximum - low) * inverse_range;
    value = isnan(value) ? value : fminf(fmaxf(value, 0.0f), 1.0f);
    result[p] = (value * value) * (3.0f - 2.0f * value);
}
extern "C" __global__ void blend_correction(
    const float* correction, const float* prior, const float* confidence,
    float* result, int n, int plane, float weight) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    if (p >= n) return;
    result[p] = correction[p] + (prior[p] - correction[p]) * (weight * confidence[p % plane]);
}
'''


class Kernel:
    def __init__(self):
        import torch
        if torch.cuda.current_device() != 0:
            raise RuntimeError('Confidence kernel experiment requires CUDA:0 as the current device')
        self.driver = ct.WinDLL('nvcuda.dll')
        self.nvrtc = ct.WinDLL(str(Path(torch.__file__).parent / 'lib/nvrtc64_120_0.dll'))
        ptr = ct.c_void_p
        signatures = {
            'nvrtcCreateProgram': [ct.POINTER(ptr), ct.c_char_p, ct.c_char_p, ct.c_int, ptr, ptr],
            'nvrtcCompileProgram': [ptr, ct.c_int, ct.POINTER(ct.c_char_p)],
            'nvrtcGetProgramLogSize': [ptr, ct.POINTER(ct.c_size_t)],
            'nvrtcGetProgramLog': [ptr, ptr],
            'nvrtcGetPTXSize': [ptr, ct.POINTER(ct.c_size_t)],
            'nvrtcGetPTX': [ptr, ptr],
            'nvrtcDestroyProgram': [ct.POINTER(ptr)],
        }
        for name, argtypes in signatures.items():
            getattr(self.nvrtc, name).argtypes = argtypes
            getattr(self.nvrtc, name).restype = ct.c_int
        self.driver.cuModuleLoadData.argtypes = [ct.POINTER(ptr), ptr]
        self.driver.cuModuleGetFunction.argtypes = [ct.POINTER(ptr), ptr, ct.c_char_p]
        self.driver.cuLaunchKernel.argtypes = [ptr, *([ct.c_uint] * 7), ptr, ct.POINTER(ptr), ptr]
        program = ptr()
        self.check(self.nvrtc.nvrtcCreateProgram(ct.byref(program), SOURCE.encode(), b'confidence.cu', 0, None, None))
        try:
            capability = torch.cuda.get_device_capability(0)
            opts = [f'--gpu-architecture=compute_{capability[0]}{capability[1]}'.encode(),
                    b'--fmad=false', b'--ftz=false', b'--prec-div=true', b'--prec-sqrt=true']
            options = (ct.c_char_p * len(opts))(*opts)
            status = self.nvrtc.nvrtcCompileProgram(program, len(opts), options)
            size = ct.c_size_t()
            self.check(self.nvrtc.nvrtcGetProgramLogSize(program, ct.byref(size)))
            log = ct.create_string_buffer(size.value)
            self.check(self.nvrtc.nvrtcGetProgramLog(program, log))
            if status:
                raise RuntimeError(log.value.decode(errors='replace'))
            self.check(self.nvrtc.nvrtcGetPTXSize(program, ct.byref(size)))
            ptx = ct.create_string_buffer(size.value)
            self.check(self.nvrtc.nvrtcGetPTX(program, ptx))
            torch.cuda.current_stream()  # Torch owns context; do not create a second one.
            self.module = ptr()
            self.check(self.driver.cuModuleLoadData(ct.byref(self.module), ptx))
            self.function = ptr()
            self.check(self.driver.cuModuleGetFunction(ct.byref(self.function), self.module, b'confidence_map'))
            self.blend_function = ptr()
            self.check(self.driver.cuModuleGetFunction(ct.byref(self.blend_function), self.module, b'blend_correction'))
        finally:
            self.nvrtc.nvrtcDestroyProgram(ct.byref(program))

    @staticmethod
    def check(status):
        if status:
            raise RuntimeError(f'CUDA experiment API failed: {status}')

    def __call__(self, a, b, low=4.0, high=18.0):
        import torch
        assert a.is_cuda and a.device.index == 0 and a.dtype == b.dtype == torch.float32
        assert a.shape == b.shape and a.ndim == 3 and a.shape[0] == 3
        assert a.is_contiguous() and b.is_contiguous() and a.device == b.device
        h, w = a.shape[-2:]
        output = torch.empty((1, h, w), device=a.device, dtype=torch.float32)
        arguments = [ct.c_void_p(a.data_ptr()), ct.c_void_p(b.data_ptr()), ct.c_void_p(output.data_ptr()),
                     ct.c_int(h), ct.c_int(w), ct.c_float(low), ct.c_float(1.0/max(1e-6, high-low))]
        pointers = (ct.c_void_p * len(arguments))(*[ct.cast(ct.byref(v), ct.c_void_p) for v in arguments])
        stream = torch.cuda.current_stream(a.device)
        self.check(self.driver.cuLaunchKernel(self.function, (h*w + 255)//256, 1, 1, 256, 1, 1, 0,
                                              ct.c_void_p(stream.cuda_stream), pointers, None))
        for tensor in (a, b, output):
            tensor.record_stream(stream)
        return output

    def blend(self, correction, prior, confidence, weight):
        import torch
        assert correction.is_cuda and correction.device.index == 0
        assert correction.dtype == prior.dtype == confidence.dtype == torch.float32
        assert correction.shape == prior.shape and correction.ndim == 3
        assert correction.is_contiguous() and prior.is_contiguous() and confidence.is_contiguous()
        assert confidence.shape == (1, *correction.shape[-2:])
        output = torch.empty_like(correction)
        n, plane = correction.numel(), confidence.numel()
        arguments = [ct.c_void_p(correction.data_ptr()), ct.c_void_p(prior.data_ptr()),
                     ct.c_void_p(confidence.data_ptr()), ct.c_void_p(output.data_ptr()),
                     ct.c_int(n), ct.c_int(plane), ct.c_float(weight)]
        pointers = (ct.c_void_p * len(arguments))(*[ct.cast(ct.byref(v), ct.c_void_p) for v in arguments])
        stream = torch.cuda.current_stream(correction.device)
        self.check(self.driver.cuLaunchKernel(self.blend_function, (n+255)//256, 1, 1, 256, 1, 1, 0,
                                              ct.c_void_p(stream.cuda_stream), pointers, None))
        for tensor in (correction, prior, confidence, output):
            tensor.record_stream(stream)
        return output


def install(*, blend=False):
    from rope import VideoManager as module
    original = module._correction_confidence
    kernel = None
    def confidence(a, b, low=4.0, high=18.0):
        nonlocal kernel
        import torch
        if (a.is_cuda and a.device.index == 0
                and a.dtype == b.dtype == torch.float32 and a.device == b.device
                and a.shape == b.shape and a.ndim == 3 and a.shape[0] == 3
                and a.is_contiguous() and b.is_contiguous()):
            if kernel is None:
                kernel = Kernel()
            return kernel(a, b, low, high)
        return original(a, b, low, high)
    module._correction_confidence = confidence
    if blend:
        def blend_correction(correction, prior, confidence, weight):
            nonlocal kernel
            import torch
            values = (correction, prior, confidence)
            if all(v.is_cuda and v.device.index == 0 and v.dtype == torch.float32 and v.is_contiguous() for v in values):
                if kernel is None:
                    kernel = Kernel()
                return kernel.blend(correction, prior, confidence, weight)
            return correction + (prior - correction) * (weight * confidence)
        module._isolated_blend_correction = blend_correction
        original_stabilize = module._stabilize_restorer_correction
        source = textwrap.dedent(inspect.getsource(original_stabilize))
        old = "result = correction + (state['correction'] - correction) * (history_weight * confidence)"
        new = "result = _isolated_blend_correction(correction, state['correction'], confidence, history_weight)"
        if source.count(old) != 1:
            raise RuntimeError('Restorer correction source contract changed')
        scope = {}
        exec(compile(source.replace(old, new), module.__file__, 'exec'), module.__dict__, scope)
        module._stabilize_restorer_correction = scope[original_stabilize.__name__]


if __name__ == '__main__':
    import torch
    import pong_swap_config as cfg
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    from rope.VideoManager import _correction_confidence
    torch.manual_seed(101)
    kernel = Kernel()
    def check_case(label, a, b, low=4.0, high=18.0):
        ref = _correction_confidence(a, b, low, high)
        candidate = kernel(a, b, low, high)
        bit_equal = torch.equal(ref.view(torch.int32), candidate.view(torch.int32))
        threshold_equal = torch.equal(ref < 0.25, candidate < 0.25)
        finite = torch.isfinite(ref) & torch.isfinite(candidate)
        max_finite_delta = (
            (ref[finite] - candidate[finite]).abs().max().item()
            if bool(finite.any()) else 0.0
        )
        print(label, 'bitEqual=', bit_equal,
              'thresholdEqual=', threshold_equal,
              'maxFiniteDelta=', max_finite_delta, flush=True)
        if not bit_equal or not threshold_equal:
            raise AssertionError(f'Confidence kernel differs for {label}')

    for edge in (8, 31, 64, 256, 1024):
        for scale in (0.001, 4, 16, 255):
            a = torch.rand((3, edge, edge), device='cuda:0') * 255
            b = a + torch.randn_like(a) * scale
            check_case(f'random {edge}x{edge} scale={scale}', a, b)

    for h, w in ((3, 5), (17, 31), (128, 256)):
        a = torch.randn((3, h, w), device='cuda:0', dtype=torch.float32) * 32
        b = torch.randn_like(a) * 32
        check_case(f'non-square {h}x{w}', a, b)

    a = torch.zeros((3, 9, 11), device='cuda:0', dtype=torch.float32)
    for boundary in (4.0, 18.0, 11.0):
        center = torch.full_like(a, boundary)
        lower = torch.nextafter(center, torch.full_like(a, -float('inf')))
        upper = torch.nextafter(center, torch.full_like(a, float('inf')))
        for label, b in (('below', lower), ('at', center), ('above', upper)):
            check_case(f'boundary {boundary} {label}', a, b)

    a = torch.zeros((3, 7, 13), device='cuda:0', dtype=torch.float32)
    b = torch.zeros_like(a)
    b[0, 0, 0] = float('nan')
    b[1, 2, 3] = float('inf')
    b[2, 4, 5] = -float('inf')
    b[0, 6, 12] = -0.0
    b[1, 0, 12] = torch.nextafter(
        torch.tensor(0.0, device='cuda:0'),
        torch.tensor(1.0, device='cuda:0'),
    )
    check_case('NaN infinity signed-zero subnormal', a, b)
    check_case('custom scalar range', a, b.nan_to_num(), 0.5, 7.5)
    for shape in ((3, 17, 31), (3, 1024, 1024)):
        correction = torch.randn(shape, device='cuda:0') * 32
        prior = torch.randn_like(correction) * 32
        confidence = torch.rand((1, *shape[-2:]), device='cuda:0')
        for weight in (0.0, 1.0, .5 ** (1/30/.04), .5 ** (1/24/.04)):
            ref = correction + (prior - correction) * (weight * confidence)
            actual = kernel.blend(correction, prior, confidence, weight)
            if not torch.equal(ref.view(torch.int32), actual.view(torch.int32)):
                raise AssertionError('Correction blend kernel differs')
    print('Correction blend parity passed')
    print('All primitive parity tests passed')
