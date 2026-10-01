"""Process-local GPEN1024 normalization/denormalization fusion experiment.

The qualified model, precision, cadence, temporal decisions and settings stay
unchanged. A caller must prove primitive bit parity and full-frame CRC parity
before treating this as an optimization. No CUDA work occurs at import/install.
"""

import ctypes as ct
import inspect
from pathlib import Path
import sys
import textwrap


PRE_SOURCE = "input_face = input_face.to(torch.float32).div(127.5).sub(1.0).contiguous()"
PRE_REPLACEMENT = "input_face = self._isolated_restorer_normalize(input_face, parameters)"
POST_SOURCE = """outpred = torch.squeeze(model_output)
        outpred = torch.clamp(outpred, -1, 1)
        outpred = torch.add(outpred, 1)
        outpred = torch.div(outpred, 2)
        outpred = torch.mul(outpred, 255)"""
POST_REPLACEMENT = "outpred = self._isolated_restorer_denormalize(model_output, parameters)"

CUDA_SOURCE = r'''
extern "C" __global__ void normalize_u8(const unsigned char* source, float* output, int n) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    if (p >= n) return;
    float value = static_cast<float>(source[p]);
    // PyTorch's CUDA scalar div kernel multiplies by the rounded FP32
    // reciprocal; a precise per-element division differs by a few ulps.
    value = value * (1.0f / 127.5f);
    output[p] = value - 1.0f;
}
extern "C" __global__ void normalize_f32(const float* source, float* output, int n) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    if (p >= n) return;
    float value = source[p] * (1.0f / 127.5f);
    output[p] = value - 1.0f;
}
extern "C" __global__ void denormalize_f32(const float* source, float* output, int n) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    if (p >= n) return;
    float value = source[p];
    // torch.clamp propagates NaN. Keep the model's finite-output path and
    // preserve that propagation for an anomalous output as well.
    if (!isnan(value)) value = fminf(fmaxf(value, -1.0f), 1.0f);
    value = value + 1.0f;
    value = value / 2.0f;
    output[p] = value * 255.0f;
}
'''


class Kernel:
    def __init__(self):
        import torch

        if torch.cuda.current_device() != 0:
            raise RuntimeError("Restorer pointwise experiment requires CUDA:0")
        # warm() may have initialized CUDA on the engine-owner thread only.
        # Bind PyTorch's primary context on this calling thread before using
        # the driver API; querying current_stream alone does not bind it.
        torch.empty(1, device="cuda:0")
        self.driver = ct.WinDLL("nvcuda.dll")
        self.nvrtc = ct.WinDLL(str(Path(torch.__file__).parent / "lib/nvrtc64_120_0.dll"))
        pointer = ct.c_void_p
        signatures = {
            "nvrtcCreateProgram": [ct.POINTER(pointer), ct.c_char_p, ct.c_char_p,
                                   ct.c_int, pointer, pointer],
            "nvrtcCompileProgram": [pointer, ct.c_int, ct.POINTER(ct.c_char_p)],
            "nvrtcGetProgramLogSize": [pointer, ct.POINTER(ct.c_size_t)],
            "nvrtcGetProgramLog": [pointer, pointer],
            "nvrtcGetPTXSize": [pointer, ct.POINTER(ct.c_size_t)],
            "nvrtcGetPTX": [pointer, pointer],
            "nvrtcDestroyProgram": [ct.POINTER(pointer)],
        }
        for name, args in signatures.items():
            function = getattr(self.nvrtc, name)
            function.argtypes = args
            function.restype = ct.c_int
        self.driver.cuModuleLoadData.argtypes = [ct.POINTER(pointer), pointer]
        self.driver.cuModuleLoadData.restype = ct.c_int
        self.driver.cuModuleGetFunction.argtypes = [ct.POINTER(pointer), pointer, ct.c_char_p]
        self.driver.cuModuleGetFunction.restype = ct.c_int
        self.driver.cuLaunchKernel.argtypes = [pointer, *([ct.c_uint] * 7), pointer,
                                              ct.POINTER(pointer), pointer]
        self.driver.cuLaunchKernel.restype = ct.c_int
        program = pointer()
        self._check(self.nvrtc.nvrtcCreateProgram(
            ct.byref(program), CUDA_SOURCE.encode(), b"restorer-pointwise.cu", 0, None, None,
        ))
        try:
            major, minor = torch.cuda.get_device_capability(0)
            flags = [f"--gpu-architecture=compute_{major}{minor}".encode(),
                     b"--fmad=false", b"--ftz=false", b"--prec-div=true",
                     b"--prec-sqrt=true"]
            options = (ct.c_char_p * len(flags))(*flags)
            status = self.nvrtc.nvrtcCompileProgram(program, len(flags), options)
            size = ct.c_size_t()
            self._check(self.nvrtc.nvrtcGetProgramLogSize(program, ct.byref(size)))
            log = ct.create_string_buffer(size.value)
            self._check(self.nvrtc.nvrtcGetProgramLog(program, log))
            if status:
                raise RuntimeError(log.value.decode(errors="replace"))
            self._check(self.nvrtc.nvrtcGetPTXSize(program, ct.byref(size)))
            ptx = ct.create_string_buffer(size.value)
            self._check(self.nvrtc.nvrtcGetPTX(program, ptx))
            torch.cuda.current_stream()
            self.module = pointer()
            self._check(self.driver.cuModuleLoadData(ct.byref(self.module), ptx))
            self.normalize_function = pointer()
            self.normalize_float_function = pointer()
            self.denormalize_function = pointer()
            self._check(self.driver.cuModuleGetFunction(
                ct.byref(self.normalize_function), self.module, b"normalize_u8",
            ))
            self._check(self.driver.cuModuleGetFunction(
                ct.byref(self.normalize_float_function), self.module, b"normalize_f32",
            ))
            self._check(self.driver.cuModuleGetFunction(
                ct.byref(self.denormalize_function), self.module, b"denormalize_f32",
            ))
        finally:
            self.nvrtc.nvrtcDestroyProgram(ct.byref(program))

    @staticmethod
    def _check(status):
        if status:
            raise RuntimeError(f"Restorer CUDA experiment API failed: {status}")

    def _launch(self, function, source, output):
        import torch

        n = source.numel()
        values = [ct.c_void_p(source.data_ptr()), ct.c_void_p(output.data_ptr()), ct.c_int(n)]
        pointers = (ct.c_void_p * len(values))(*[
            ct.cast(ct.byref(value), ct.c_void_p) for value in values
        ])
        stream = torch.cuda.current_stream(source.device)
        self._check(self.driver.cuLaunchKernel(
            function, (n + 255) // 256, 1, 1, 256, 1, 1, 0,
            ct.c_void_p(stream.cuda_stream), pointers, None,
        ))
        source.record_stream(stream)
        output.record_stream(stream)
        return output

    def normalize(self, source):
        import torch

        output = torch.empty(source.shape, device=source.device, dtype=torch.float32)
        function = (self.normalize_function if source.dtype == torch.uint8
                    else self.normalize_float_function)
        return self._launch(function, source, output)

    def denormalize(self, source):
        import torch

        output = torch.empty(source.shape[1:], device=source.device, dtype=torch.float32)
        return self._launch(self.denormalize_function, source, output)


_kernel = None
_coverage = {"normalizeU8": 0, "normalizeFp32": 0,
             "denormalizeFp32": 0, "fallbackPre": 0, "fallbackPost": 0}


def coverage():
    return dict(_coverage)


def prewarm():
    """Compile outside timed rendering, after the engine owns CUDA:0."""
    global _kernel
    if _kernel is None:
        _kernel = Kernel()


def install():
    from rope import VideoManager as module

    original = module.VideoManager._apply_restorer_inner
    source = textwrap.dedent(inspect.getsource(original))
    if source.count(PRE_SOURCE) != 1 or source.count(POST_SOURCE) != 1:
        raise RuntimeError("Restorer pointwise source contract changed")

    def normalize(self, source_tensor, parameters):
        global _kernel
        import torch

        if (parameters.get("RestorerTypeTextSel") == "GPEN1024"
                and source_tensor.is_cuda and source_tensor.device.index == 0
                and source_tensor.dtype in (torch.uint8, torch.float32)
                and source_tensor.is_contiguous()
                and source_tensor.ndim == 4 and source_tensor.shape[0] == 1
                and source_tensor.shape[1] == 3):
            prewarm()
            _coverage["normalizeU8" if source_tensor.dtype == torch.uint8
                      else "normalizeFp32"] += 1
            return _kernel.normalize(source_tensor)
        _coverage["fallbackPre"] += 1
        return source_tensor.to(torch.float32).div(127.5).sub(1.0).contiguous()

    def denormalize(self, source_tensor, parameters):
        global _kernel
        import torch

        if (parameters.get("RestorerTypeTextSel") == "GPEN1024"
                and source_tensor.is_cuda and source_tensor.device.index == 0
                and source_tensor.dtype == torch.float32
                and source_tensor.is_contiguous()
                and tuple(source_tensor.shape) == (1, 3, 1024, 1024)):
            prewarm()
            _coverage["denormalizeFp32"] += 1
            return _kernel.denormalize(source_tensor)
        _coverage["fallbackPost"] += 1
        result = torch.squeeze(source_tensor)
        result = torch.clamp(result, -1, 1)
        result = torch.add(result, 1)
        result = torch.div(result, 2)
        return torch.mul(result, 255)

    module.VideoManager._isolated_restorer_normalize = normalize
    module.VideoManager._isolated_restorer_denormalize = denormalize
    scope = {}
    patched = source.replace(PRE_SOURCE, PRE_REPLACEMENT).replace(
        POST_SOURCE, POST_REPLACEMENT,
    )
    exec(compile(patched, module.__file__, "exec"), module.__dict__, scope)
    module.VideoManager._apply_restorer_inner = scope[original.__name__]
    return module.VideoManager


if __name__ == "__main__":
    import torch
    import statistics

    prewarm()
    inputs = [
        torch.arange(256, device="cuda:0", dtype=torch.uint8).repeat(3).reshape(1, 3, 16, 16),
        torch.randint(0, 256, (1, 3, 1024, 1024), device="cuda:0", dtype=torch.uint8),
        torch.linspace(-255, 511, 768, device="cuda:0").reshape(1, 3, 16, 16),
        torch.randn((1, 3, 1024, 1024), device="cuda:0") * 255,
    ]
    for values in inputs:
        expected = values.to(torch.float32).div(127.5).sub(1.0).contiguous()
        actual = _kernel.normalize(values)
        if not torch.equal(expected.view(torch.int32), actual.view(torch.int32)):
            raise AssertionError(f"FP32 normalize differs for {tuple(values.shape)}")
    edge = torch.tensor([
        -float("inf"), -2.0, -1.0, -0.0, 0.0, 1.0, 2.0, float("inf"),
        float("nan"),
    ], dtype=torch.float32, device="cuda:0")
    edge = torch.cat((edge, torch.nextafter(edge[:8], torch.full_like(edge[:8], float("inf")))))
    for values in (torch.linspace(-2, 2, 3072, device="cuda:0").reshape(1, 3, 32, 32),
                   torch.randn((1, 3, 1024, 1024), device="cuda:0"),
                   edge.reshape(1, 1, 1, -1)):
        expected = torch.mul(torch.div(torch.add(torch.clamp(values, -1, 1), 1), 2), 255)[0]
        actual = _kernel.denormalize(values)
        if not torch.equal(expected.view(torch.int32), actual.view(torch.int32)):
            raise AssertionError(f"FP32 denormalize differs for {tuple(values.shape)}")
    print("Restorer primitive parity passed")

    def time_calls(call, repetitions=80):
        for _ in range(5):
            call()
        torch.cuda.synchronize()
        samples = []
        for _ in range(3):
            start = torch.cuda.Event(enable_timing=True)
            stop = torch.cuda.Event(enable_timing=True)
            start.record()
            for _ in range(repetitions):
                call()
            stop.record()
            stop.synchronize()
            samples.append(start.elapsed_time(stop) / repetitions)
        return statistics.median(samples)

    u8 = inputs[1]
    fp32 = inputs[3]
    timings = {
        "normalizeU8TorchMs": time_calls(lambda: u8.to(torch.float32).div(127.5).sub(1.0).contiguous()),
        "normalizeU8KernelMs": time_calls(lambda: _kernel.normalize(u8)),
        "normalizeFp32TorchMs": time_calls(lambda: fp32.to(torch.float32).div(127.5).sub(1.0).contiguous()),
        "normalizeFp32KernelMs": time_calls(lambda: _kernel.normalize(fp32)),
        "denormalizeTorchMs": time_calls(lambda: torch.mul(torch.div(torch.add(torch.clamp(fp32, -1, 1), 1), 2), 255)[0]),
        "denormalizeKernelMs": time_calls(lambda: _kernel.denormalize(fp32)),
    }
    print("Restorer isolated primitive timings (ms/call):", timings, flush=True)
