"""Remove the pageable host fence for float paste-back's six affine values."""
from collections import OrderedDict


def install():
    import numpy as np
    import torch
    from rope.VideoManager import VideoManager
    original = VideoManager._warp_grid_sample

    def warp(self, src, matrix, output_size, padding_mode='zeros', *, return_valid_mask=False):
        if (not src.is_cuda or src.dtype != torch.float32 or src.ndim != 3
                or isinstance(matrix, torch.Tensor)):
            return original(self, src, matrix, output_size, padding_mode,
                            return_valid_mask=return_valid_mask)
        values = np.ascontiguousarray(matrix, dtype=np.float32)
        if values.shape != (2, 3):
            return original(self, src, matrix, output_size, padding_mode,
                            return_valid_mask=return_valid_mask)
        stream = torch.cuda.current_stream(src.device)
        key = (str(src.device), int(stream.cuda_stream))
        cache = getattr(self, '_experimental_pasteback_uploads', None)
        if cache is None:
            cache = self._experimental_pasteback_uploads = OrderedDict()
        state = cache.get(key)
        if state is None:
            state = {'host': torch.empty((2, 3), dtype=torch.float32, pin_memory=True), 'done': None}
            cache[key] = state
        cache.move_to_end(key)
        while len(cache) > 4:
            _, old = cache.popitem(last=False)
            if old['done'] is not None:
                old['done'].synchronize()
        if state['done'] is not None:
            state['done'].synchronize()
        np.copyto(state['host'].numpy(), values)
        device_matrix = torch.empty((2, 3), device=src.device, dtype=torch.float32)
        device_matrix.copy_(state['host'], non_blocking=True)
        done = torch.cuda.Event()
        done.record(stream)
        state['done'] = done
        return original(self, src, device_matrix, output_size, padding_mode,
                        return_valid_mask=return_valid_mask)

    VideoManager._warp_grid_sample = warp
