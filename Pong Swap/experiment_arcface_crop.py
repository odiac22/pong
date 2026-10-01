"""Isolated exact ArcFace crop: pinned affine upload and direct uint8 sampling."""
from collections import OrderedDict
import inspect
import textwrap


def install():
    import numpy as np
    import torch
    from rope import Models as module
    from experiment_u8_grid_sample import sample
    cls = module.Models
    original = cls._arcface_aligned_crop
    source = textwrap.dedent(inspect.getsource(original))
    old_upload = '    matrix = torch.as_tensor(inverse, dtype=torch.float32, device=device)'
    old_sample = """    aligned = torch.nn.functional.grid_sample(
        img.to(torch.float32).unsqueeze(0),
        grid,
        mode='bilinear',
        padding_mode='zeros',
        align_corners=False,
    )[0]"""
    if source.count(old_upload) != 1 or source.count(old_sample) != 1:
        raise RuntimeError('ArcFace crop source changed')
    source = source.replace(old_upload, '    matrix = self._isolated_arcface_upload(inverse, device)', 1)
    source = source.replace(old_sample, """    if (img.dtype == torch.uint8 and img.is_cuda and img.device.index == 0
            and img.ndim == 3 and grid.is_contiguous()):
        aligned = self._isolated_arcface_sample(img, grid)[0]
    else:
""" + textwrap.indent(old_sample, '    '), 1)
    scope = {}
    exec(compile(source, module.__file__, 'exec'), module.__dict__, scope)

    def upload(self, inverse, device):
        if device.type != 'cuda':
            return torch.as_tensor(inverse, dtype=torch.float32, device=device)
        stream = torch.cuda.current_stream(device)
        key = (str(device), int(stream.cuda_stream))
        cache = getattr(self, '_isolated_arcface_uploads', None)
        if cache is None:
            cache = self._isolated_arcface_uploads = OrderedDict()
        state = cache.get(key)
        if state is None:
            state = {'host': torch.empty((2, 3), dtype=torch.float32, pin_memory=True), 'done': None}
            cache[key] = state
        cache.move_to_end(key)
        while len(cache) > 3:
            _, prior = cache.popitem(last=False)
            if prior['done'] is not None:
                prior['done'].synchronize()
        if state['done'] is not None:
            state['done'].synchronize()
        np.copyto(state['host'].numpy(), inverse)
        matrix = torch.empty((2, 3), device=device, dtype=torch.float32)
        matrix.copy_(state['host'], non_blocking=True)
        state['done'] = torch.cuda.Event()
        state['done'].record(stream)
        return matrix

    old_delete = cls.delete_models
    def delete(self):
        cache = getattr(self, '_isolated_arcface_uploads', None)
        if cache:
            for state in cache.values():
                if state['done'] is not None:
                    state['done'].synchronize()
            cache.clear()
        return old_delete(self)

    cls._isolated_arcface_upload = upload
    cls._isolated_arcface_sample = staticmethod(sample)
    cls._arcface_aligned_crop = scope[original.__name__]
    cls.delete_models = delete
