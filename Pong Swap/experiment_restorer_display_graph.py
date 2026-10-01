"""Process-local graph of the unchanged restorer display-history operations."""
from collections import OrderedDict
import threading
import weakref


_OWNER_KEY = '_isolated_restorer_display_graph_owner'


class _Owner:
    pass


class _GraphRegistry:
    """Keep captured buffers alive only for their temporal-context owner."""

    def __init__(self):
        self.lock = threading.RLock()
        self.caches = weakref.WeakKeyDictionary()

    def cache_for(self, context):
        with self.lock:
            owner = context.get(_OWNER_KEY)
            if not isinstance(owner, _Owner):
                owner = _Owner()
                context[_OWNER_KEY] = owner
            cache = self.caches.get(owner)
            if cache is None:
                cache = OrderedDict()
                self.caches[owner] = cache
                weakref.finalize(owner, self._drain_cache, cache)
            return cache

    def _drain_cache(self, cache):
        with self.lock:
            for item in cache.values():
                done = item.get('done')
                if done is not None:
                    done.synchronize()
            cache.clear()

    def drain_all(self):
        with self.lock:
            for cache in list(self.caches.values()):
                self._drain_cache(cache)


def install():
    import torch
    from rope import VideoManager as module
    original = module._stabilize_restorer_correction
    if getattr(original, '_isolated_display_graph_registry', None) is not None:
        return original._isolated_display_graph_registry
    registry = _GraphRegistry()

    def _stabilized(current, correction, context, signature, reuse_confidence=None):
        state = context.get('restorerDisplayHistory')
        elapsed = module._temporal_elapsed_seconds(context, state)
        compatible = bool(state and state.get('signature') == signature
                          and not module._history_reset_requested(context) and 0 < elapsed <= .25
                          and state['input'].shape == current.shape)
        tensors = (current, correction, state['input'], state['correction']) if compatible else ()
        if (not tensors or not all(t.is_cuda and t.dtype == torch.float32 for t in tensors)
                or not all(t.shape == current.shape and t.device == current.device for t in tensors)):
            return original(current, correction, context, signature, reuse_confidence)
        if reuse_confidence is not None and (not reuse_confidence.is_cuda
                or reuse_confidence.dtype != torch.float32 or reuse_confidence.device != current.device):
            return original(current, correction, context, signature, reuse_confidence)
        stream = torch.cuda.current_stream(current.device)
        key = (tuple((tuple(t.shape), tuple(t.stride())) for t in tensors),
               str(current.device), int(stream.cuda_stream),
               None if reuse_confidence is None else tuple(reuse_confidence.shape))
        cache = registry.cache_for(context)
        item = cache.get(key)
        if item is None:
            item = {'seen': 0, 'done': None}
            cache[key] = item
        cache.move_to_end(key)
        while len(cache) > 4:
            _, old = cache.popitem(last=False)
            if old['done'] is not None:
                old['done'].synchronize()
        item['seen'] += 1
        if item['seen'] < 3:
            return original(current, correction, context, signature, reuse_confidence)
        if 'graph' not in item:
            a, b, previous, previous_correction = [t.clone() for t in tensors]
            reuse = reuse_confidence.clone() if reuse_confidence is not None else None
            weight = torch.empty((), device=current.device, dtype=torch.float32).fill_(0.5 ** (elapsed / .04))

            def ops():
                confidence = module._correction_confidence(a, previous)
                if reuse is not None:
                    confidence = torch.minimum(confidence, reuse)
                return b + (previous_correction - b) * (weight * confidence)

            ops()
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                output = ops()
            item.update(graph=graph, inputs=(a, b, previous, previous_correction),
                        reuse=reuse, weight=weight, output=output)
        for destination, source in zip(item['inputs'], tensors):
            destination.copy_(source)
        if reuse_confidence is not None:
            item['reuse'].copy_(reuse_confidence)
        # PyTorch's original Python scalar is converted to the tensor's FP32
        # dtype. fill_ performs exactly that conversion; no elapsed-time policy changes.
        item['weight'].fill_(0.5 ** (elapsed / .04))
        item['graph'].replay()
        result = item['output'].clone()
        context['restorerDisplayHistory'] = {
            'signature': signature, 'mediaTimeSeconds': context.get('mediaTimeSeconds'),
            'frameIndex': context.get('frameIndex', 0), 'input': current.detach().clone(),
            'correction': result.detach().clone(),
        }
        done = torch.cuda.Event()
        done.record(stream)
        item['done'] = done
        return result

    def stabilized(current, correction, context, signature, reuse_confidence=None):
        with registry.lock:
            return _stabilized(current, correction, context, signature, reuse_confidence)

    stabilized._isolated_display_graph_registry = registry
    module._stabilize_restorer_correction = stabilized
    video_manager_class = module.VideoManager
    old_shutdown = video_manager_class.shutdown_background_workers

    def shutdown(self, *args, **kwargs):
        registry.drain_all()
        return old_shutdown(self, *args, **kwargs)

    video_manager_class.shutdown_background_workers = shutdown
    return registry
