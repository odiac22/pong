"""Isolated byte-preserving pinned frame upload/download experiment."""
from collections import OrderedDict


def install(engine_class, *, upload_only=False):
    import numpy as np
    original_download = engine_class._process_frame_to_rgb
    original_unload = engine_class.unload

    def upload(self, rgb):
        torch = self._torch
        values = np.ascontiguousarray(rgb, dtype=np.uint8)
        stream = torch.cuda.current_stream()
        key = (tuple(values.shape), int(stream.cuda_stream))
        cache = getattr(self, '_experimental_frame_uploads', None)
        if cache is None:
            cache = self._experimental_frame_uploads = OrderedDict()
        pending = cache.get(key)
        if pending is None:
            host = torch.empty(tuple(values.shape), dtype=torch.uint8, pin_memory=True)
            pending = {'host': host, 'event': None}
            cache[key] = pending
        if pending['event'] is not None:
            pending['event'].synchronize()
        np.copyto(pending['host'].numpy(), values)
        # Allocate a distinct output per call: callers may retain the original
        # frame or invoke another upload before the prior tensor is consumed.
        device = torch.empty(tuple(values.shape), dtype=torch.uint8, device=stream.device)
        device.copy_(pending['host'], non_blocking=True)
        done = torch.cuda.Event()
        done.record(stream)
        pending['event'] = done
        cache.move_to_end(key)
        while len(cache) > 3:
            _, old = cache.popitem(last=False)
            old['event'].synchronize()
        return device.permute(2, 0, 1)

    def download(self, frame, source_embedding, anchor, **kwargs):
        swapped, updated = self.process_frame(frame, source_embedding, anchor, **kwargs)
        if swapped is None:
            return None, updated
        torch = self._torch
        if not swapped.is_cuda:
            return swapped.numpy(), updated
        # Never recycle this host allocation: ndarray ownership preserves the
        # storage while encoding/history may still hold it after this call.
        host = torch.empty(tuple(swapped.shape), dtype=swapped.dtype, pin_memory=True)
        stream = torch.cuda.current_stream(swapped.device)
        host.copy_(swapped, non_blocking=True)
        done = torch.cuda.Event()
        done.record(stream)
        done.synchronize()
        return host.numpy(), updated

    def unload(self, *args, **kwargs):
        try:
            return original_unload(self, *args, **kwargs)
        finally:
            cache = getattr(self, '_experimental_frame_uploads', None)
            if cache:
                for item in cache.values():
                    if item['event'] is not None:
                        item['event'].synchronize()
                cache.clear()

    engine_class._frame_tensor = upload
    if not upload_only:
        engine_class._process_frame_to_rgb = download
    engine_class.unload = unload
