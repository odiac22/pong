"""Isolated exact input-crop graph replay; no sampler or geometry changes."""
from collections import OrderedDict


def install():
    import numpy as np
    import torch
    from rope.VideoManager import VideoManager
    original = VideoManager._warp_grid_sample

    def warp(self, src, matrix, output_size, padding_mode='zeros', *, return_valid_mask=False):
        if not src.is_cuda or src.dtype != torch.uint8 or src.ndim != 3:
            return original(self, src, matrix, output_size, padding_mode, return_valid_mask=return_valid_mask)
        if isinstance(matrix, torch.Tensor):
            return original(self, src, matrix, output_size, padding_mode, return_valid_mask=return_valid_mask)
        stream = torch.cuda.current_stream(src.device)
        key = (tuple(src.shape), tuple(src.stride()), str(src.device), int(stream.cuda_stream),
               tuple(output_size), padding_mode, bool(return_valid_mask))
        cache = getattr(self, '_experimental_input_warp_graphs', None)
        if cache is None:
            cache = self._experimental_input_warp_graphs = OrderedDict()
        state = cache.get(key)
        if state is None:
            state = {'seen': 0}
            cache[key] = state
        cache.move_to_end(key)
        while len(cache) > 3:
            _, evicted = cache.popitem(last=False)
            # A replay and its returned clones may still be queued when a
            # different shape displaces this graph's static storage.
            if evicted.get('lastUse') is not None:
                evicted['lastUse'].synchronize()
        state['seen'] += 1
        if state['seen'] < 3:
            return original(self, src, matrix, output_size, padding_mode, return_valid_mask=return_valid_mask)
        values = np.ascontiguousarray(matrix, dtype=np.float32)
        if values.shape != (2, 3):
            return original(self, src, matrix, output_size, padding_mode, return_valid_mask=return_valid_mask)
        if 'graph' not in state:
            source = src.clone()
            transform = torch.from_numpy(values).to(src.device)
            original(self, source, transform, output_size, padding_mode, return_valid_mask=return_valid_mask)
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                output = original(self, source, transform, output_size, padding_mode, return_valid_mask=return_valid_mask)
            host_transform = torch.empty((2, 3), dtype=torch.float32, pin_memory=True)
            state.update(graph=graph, source=source, transform=transform, output=output,
                         hostTransform=host_transform, uploadDone=None)
        state['source'].copy_(src)
        # Only the tiny matrix changes on the CPU. A pageable, blocking copy
        # here waited for preceding work on the stream on every video frame.
        # Preserve pinned-buffer ownership until the previous upload ends.
        if state['uploadDone'] is not None:
            state['uploadDone'].synchronize()
        np.copyto(state['hostTransform'].numpy(), values)
        state['transform'].copy_(state['hostTransform'], non_blocking=True)
        done = torch.cuda.Event()
        done.record(stream)
        state['uploadDone'] = done
        state['graph'].replay()
        # Return independent owned storage, not a later replay's mutable output.
        result = state['output']
        owned = tuple(x.clone() for x in result) if isinstance(result, tuple) else result.clone()
        last_use = torch.cuda.Event()
        last_use.record(stream)
        state['lastUse'] = last_use
        return owned

    VideoManager._warp_grid_sample = warp
