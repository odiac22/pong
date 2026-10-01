"""Optional strict-FP32 identity source-delta primitive; no policy changes.

Only contiguous 3xHxW CUDA:0 uint8/float32 pairs use the kernel. All other
layouts and dtypes use the original Torch expression. GPU byte parity must be
qualified before enabling this inside an end-to-end experiment.
"""

import ctypes as ct
import threading
import time


SOURCE = r'''
extern "C" __global__ void mean_abs_u8(
    const unsigned char* current, const unsigned char* prior, float* output,
    int spatial) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= spatial) return;
    float x = fabsf((float)current[i] - (float)prior[i]);
    float y = fabsf((float)current[spatial + i] - (float)prior[spatial + i]);
    float z = fabsf((float)current[2 * spatial + i] - (float)prior[2 * spatial + i]);
    output[i] = ((x + y) + z) * 0.3333333432674407958984375f;
}
extern "C" __global__ void mean_abs_f32(
    const float* current, const float* prior, float* output, int spatial) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= spatial) return;
    float x = fabsf(current[i] - prior[i]);
    float y = fabsf(current[spatial + i] - prior[spatial + i]);
    float z = fabsf(current[2 * spatial + i] - prior[2 * spatial + i]);
    output[i] = ((x + y) + z) * 0.3333333432674407958984375f;
}
'''


_module = None
_module_lock = threading.Lock()


def _ensure_module():
    global _module
    if _module is None:
        with _module_lock:
            if _module is None:
                from pong_exact_runtime.vendor.experiment_cuda_module import CudaModule
                _module = CudaModule(SOURCE, ('mean_abs_u8', 'mean_abs_f32'))
    return _module


def prewarm():
    """Compile/load once on the engine GPU-owner thread before measurement."""
    import torch

    started = time.perf_counter()
    was_compiled = _module is not None
    with torch.cuda.device(0):
        # Bind Torch's primary context on this worker before the driver's
        # cuModuleLoadData call inside CudaModule.
        torch.cuda.current_stream(0)
        _ensure_module()
    return {'compiled': True, 'cold': not was_compiled, 'device': 0,
            'seconds': time.perf_counter() - started}


def _qualified(current, prior):
    import torch

    return (
        isinstance(current, torch.Tensor) and isinstance(prior, torch.Tensor)
        and current.is_cuda and prior.is_cuda
        and current.device == prior.device and current.device.index == 0
        and current.dtype == prior.dtype
        and current.dtype in (torch.uint8, torch.float32)
        and current.ndim == 3 and tuple(current.shape) == tuple(prior.shape)
        and current.shape[0] == 3 and min(current.shape[1:]) > 0
        and current.is_contiguous() and prior.is_contiguous()
        and current.numel() // 3 <= 2**31 - 1
    )


def mean_abs_delta(current, prior):
    """Return original (1,H,W) delta, or the source Torch path on mismatch."""
    import torch

    if not _qualified(current, prior):
        return torch.mean(
            torch.abs(current.to(torch.float32) - prior.to(torch.float32)),
            dim=0, keepdim=True,
        )
    module = _ensure_module()
    height, width = current.shape[1:]
    output = torch.empty((1, height, width), dtype=torch.float32,
                         device=current.device)
    name = 'mean_abs_u8' if current.dtype == torch.uint8 else 'mean_abs_f32'
    module.launch(
        name, height * width,
        [ct.c_void_p(current.data_ptr()), ct.c_void_p(prior.data_ptr()),
         ct.c_void_p(output.data_ptr()), ct.c_int(height * width)],
        (current, prior, output),
    )
    return output


def _assert_exact(actual, expected, label):
    import torch

    same_class = (torch.isnan(actual) == torch.isnan(expected)) & (
        torch.isposinf(actual) == torch.isposinf(expected)) & (
        torch.isneginf(actual) == torch.isneginf(expected))
    if not bool(same_class.all().item()):
        raise AssertionError((label, 'nonfinite class differs'))
    finite = torch.isfinite(expected)
    if not torch.equal(actual[finite].view(torch.int32),
                       expected[finite].view(torch.int32)):
        bad = int((actual[finite].view(torch.int32)
                   != expected[finite].view(torch.int32)).sum().item())
        raise AssertionError((label, 'finite FP32 bits differ', bad))


if __name__ == '__main__':
    import torch

    torch.manual_seed(3061)
    tests = []
    for size in ((1, 1), (3, 5), (64, 64), (511, 513), (1024, 1024)):
        for dtype in (torch.uint8, torch.float32):
            if dtype == torch.uint8:
                a = torch.randint(0, 256, (3, *size), device='cuda:0', dtype=dtype)
                b = torch.randint(0, 256, (3, *size), device='cuda:0', dtype=dtype)
            else:
                a = torch.randn((3, *size), device='cuda:0', dtype=dtype) * 200
                b = torch.randn((3, *size), device='cuda:0', dtype=dtype) * 200
            tests.append((f'random-{dtype}-{size}', a, b, True))
            tests.append((f'zero-{dtype}-{size}', torch.zeros_like(a),
                          torch.zeros_like(b), True))
            tests.append((f'border-{dtype}-{size}', torch.full_like(a, 255),
                          torch.zeros_like(b), True))
    nonfinite = torch.randn((3, 7, 11), device='cuda:0')
    nonfinite[0, 0, 0] = float('nan')
    nonfinite[1, 1, 1] = float('inf')
    nonfinite[2, 2, 2] = float('-inf')
    tests.append(('nonfinite-f32', nonfinite, torch.zeros_like(nonfinite), True))
    layout = torch.randint(0, 256, (3, 13, 17), device='cuda:0', dtype=torch.uint8)
    tests.append(('transposed-fallback', layout.transpose(1, 2),
                  layout.transpose(1, 2), False))
    tests.append(('strided-fallback', layout[:, ::2, ::2],
                  layout[:, ::2, ::2], False))
    tests.append(('dtype-fallback', layout, layout.to(torch.float32), False))
    qualified = fallback = 0
    for label, current, prior, expect_kernel in tests:
        assert _qualified(current, prior) == expect_kernel, label
        expected = torch.mean(torch.abs(current.to(torch.float32)
                                        - prior.to(torch.float32)), dim=0, keepdim=True)
        _assert_exact(mean_abs_delta(current, prior), expected, label)
        qualified += bool(expect_kernel)
        fallback += not expect_kernel
    print({'qualified': qualified, 'fallback': fallback,
           'primitiveCases': len(tests), 'fp32BitParity': True}, flush=True)
