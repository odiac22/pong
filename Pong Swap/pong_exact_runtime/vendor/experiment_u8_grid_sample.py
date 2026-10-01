"""Isolated uint8-to-FP32 grid sampler, avoiding full-frame FP32 conversion.

The original grid construction and validity mask stay unchanged. Only the
four source pixels per bilinear sample are converted to FP32. Bit parity
against the installed PyTorch implementation is mandatory before video use.
"""
import ctypes as ct
import inspect
import textwrap
from pong_exact_runtime.vendor.experiment_cuda_module import CudaModule

SOURCE = r'''
extern "C" __global__ void u8_sample(
    const unsigned char* src, const float* grid, float* dst,
    int h, int w, int channels, int oh, int ow, int sc, int sy, int sx) {
    int p = blockIdx.x * blockDim.x + threadIdx.x;
    int plane = oh * ow;
    if (p >= plane * channels) return;
    int c = p / plane, q = p % plane;
    float x = fmaf(grid[2*q] + 1.0f, float(w), -1.0f) * 0.5f;
    float y = fmaf(grid[2*q+1] + 1.0f, float(h), -1.0f) * 0.5f;
    if (!isfinite(x) || !isfinite(y) || x < -1.0f || y < -1.0f || x > w || y > h) {
        dst[p] = 0.0f;
        return;
    }
    int x0 = int(floorf(x)), y0 = int(floorf(y));
    int x1 = x0 + 1, y1 = y0 + 1;
    float nw = (float(x1)-x) * (float(y1)-y);
    float ne = (x-float(x0)) * (float(y1)-y);
    float sw = (float(x1)-x) * (y-float(y0));
    float se = (x-float(x0)) * (y-float(y0));
    float value = 0.0f;
    if (x0 >= 0 && x0 < w && y0 >= 0 && y0 < h)
        value = fmaf(float(src[c*sc+y0*sy+x0*sx]), nw, value);
    if (x1 >= 0 && x1 < w && y0 >= 0 && y0 < h)
        value = fmaf(float(src[c*sc+y0*sy+x1*sx]), ne, value);
    if (x0 >= 0 && x0 < w && y1 >= 0 && y1 < h)
        value = fmaf(float(src[c*sc+y1*sy+x0*sx]), sw, value);
    if (x1 >= 0 && x1 < w && y1 >= 0 && y1 < h)
        value = fmaf(float(src[c*sc+y1*sy+x1*sx]), se, value);
    dst[p] = value;
}
'''
_kernel = None


def prewarm():
    global _kernel
    if _kernel is None:
        _kernel = CudaModule(SOURCE, ('u8_sample',))


def sample(source, grid):
    import torch
    prewarm()
    if source.ndim == 4:
        source = source[0]
    channels, h, w = source.shape
    _, oh, ow, _ = grid.shape
    output = torch.empty((1, channels, oh, ow), dtype=torch.float32, device=source.device)
    args = [ct.c_void_p(t.data_ptr()) for t in (source, grid, output)]
    args += [ct.c_int(v) for v in (h, w, channels, oh, ow, *source.stride())]
    _kernel.launch('u8_sample', output.numel(), args, (source, grid, output))
    return output


def install():
    from rope import VideoManager as module
    original = module.VideoManager._warp_grid_sample
    source = textwrap.dedent(inspect.getsource(original))
    start = source.index('    if src_4d.dtype != torch.float32:')
    end = source.index('    sampled = sampled.squeeze(0)', start)
    block = source[start:end]
    replacement = """    if (src_4d.dtype == torch.uint8 and src_4d.is_cuda
            and src_4d.device.index == 0 and src_4d.shape[0] == 1
            and padding_mode == 'zeros' and grid.is_cuda
            and grid.device == src_4d.device and grid.dtype == torch.float32
            and grid.ndim == 4 and grid.shape[0] == 1
            and grid.shape[-1] == 2 and grid.is_contiguous()):
        sampled = self._isolated_u8_grid_sample(src_4d, grid)
    else:
""" + textwrap.indent(block, '    ')
    scope = {}
    exec(compile(source[:start] + replacement + source[end:], module.__file__, 'exec'), module.__dict__, scope)
    module.VideoManager._isolated_u8_grid_sample = staticmethod(sample)
    module.VideoManager._warp_grid_sample = scope[original.__name__]


if __name__ == '__main__':
    import torch
    torch.manual_seed(730)
    for h, w in ((3, 3), (64, 72), (1080, 1920)):
        source = torch.randint(0, 256, (h, w, 3), device='cuda:0', dtype=torch.uint8).permute(2, 0, 1)
        for contiguous in (False, True):
            image = source.contiguous() if contiguous else source
            grid = torch.rand((1, 256, 256, 2), device='cuda:0') * 2.4 - 1.2
            grid[0, 0, :5] = torch.tensor([[-1, -1], [1, 1], [0, 0], [-1.0/w, -1.0/h], [float('nan'), 0]], device='cuda:0')
            expected = torch.nn.functional.grid_sample(image[None].float(), grid, align_corners=False)
            actual = sample(image, grid)
            bad = (expected.view(torch.int32) != actual.view(torch.int32)).sum().item()
            print(h, w, contiguous, 'differing=', bad, 'max=', (expected-actual).abs().max().item(), flush=True)
            if bad:
                raise AssertionError('uint8 sampler is not bit exact')
    print('Primitive sampler parity passed')
