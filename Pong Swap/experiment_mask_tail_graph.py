"""Isolated capture of the exact post-policy mask tail in swap_core.

No mask policy, temporal history, parser, or restorer work is moved. The
source-original block remains the fallback for every unsupported input.
"""

from collections import OrderedDict
import inspect
import textwrap


_START = "        # Add blur to swap_mask results"
_END = "        swap = torch.mul(swap, swap_mask)"


def install():
    import torch
    from rope import VideoManager as module

    vm = module.VideoManager
    original = vm.swap_core
    source = textwrap.dedent(
        getattr(original, '_isolated_source', None) or inspect.getsource(original)
    )
    if source.count(_START) != 1 or source.count(_END) != 1:
        raise RuntimeError('Mask-tail source contract changed')
    start = source.index(_START)
    end = source.index(_END, start) + len(_END)
    original_block = source[start:end]
    replacement = """        if self._isolated_mask_tail_eligible(
            swap, swap_mask, border_mask, pipeline_valid_mask,
            pipeline_size, parameters):
            swap, swap_mask = self._isolated_mask_tail_graph(
            swap, swap_mask, border_mask, pipeline_valid_mask,
            pipeline_size, parameters)
        else:
""" + textwrap.indent(original_block, '    ')
    patched = source[:start] + replacement + source[end:]
    scope = {}
    exec(compile(patched, module.__file__, 'exec'), module.__dict__, scope)

    def eligible(self, swap, mask, border, valid, size, parameters):
        if (not isinstance(parameters, dict)
                or 'BlendSlider' not in parameters
                or not isinstance(size, int) or size <= 0):
            return False
        if type(parameters['BlendSlider']) is not int:
            return False
        tensors = (swap, mask, border) + (() if valid is None else (valid,))
        if any(not isinstance(t, torch.Tensor) or not t.is_cuda
               or t.device.index != 0 or t.dtype != torch.float32
               or not t.is_contiguous() for t in tensors):
            return False
        if (swap.ndim != 3 or tuple(swap.shape) != (3, size, size)
                or mask.ndim != 3 or border.ndim != 3
                or tuple(mask.shape) != tuple(border.shape)
                or mask.shape[0] != 1 or mask.shape[1] <= 0
                or mask.shape[2] <= 0
                or valid is not None and tuple(valid.shape) != (1, size, size)):
            return False
        slider = parameters['BlendSlider']
        if slider < 0 or slider > 100:
            return False
        return not torch.cuda.is_current_stream_capturing()

    def operations(self, swap, mask, border, valid, size, slider):
        mask = self._get_gaussian_blur(
            slider * 2 + 1, (slider + 1) * 0.2,
        )(mask)
        mask = torch.mul(mask, border)
        mask = module.v2.Resize((size, size))(mask)
        if valid is not None:
            mask = torch.mul(mask, valid)
        swap = torch.mul(swap, mask)
        return swap, mask

    def graph_tail(self, swap, mask, border, valid, size, parameters):
        slider = int(parameters['BlendSlider'])
        stream = torch.cuda.current_stream(swap.device)
        descriptors = tuple((tuple(t.shape), tuple(t.stride()), t.dtype)
                            for t in (swap, mask, border))
        valid_descriptor = (None if valid is None else
                            (tuple(valid.shape), tuple(valid.stride()), valid.dtype))
        key = (descriptors, valid_descriptor, slider, int(size),
               int(stream.cuda_stream), str(swap.device))
        cache = getattr(self, '_experimental_mask_tail_graphs', None)
        if cache is None:
            cache = self._experimental_mask_tail_graphs = OrderedDict()
        state = cache.get(key)
        if state is None:
            state = {'seen': 0, 'lastUse': None}
            cache[key] = state
        cache.move_to_end(key)
        while len(cache) > 3:
            _, evicted = cache.popitem(last=False)
            if evicted['lastUse'] is not None:
                evicted['lastUse'].synchronize()
        state['seen'] += 1
        if state['seen'] < 3:
            return operations(self, swap, mask, border, valid, size, slider)
        if 'graph' not in state:
            static_swap = torch.empty_like(swap)
            static_mask = torch.empty_like(mask)
            static_border = torch.empty_like(border)
            static_valid = None if valid is None else torch.empty_like(valid)
            static_swap.copy_(swap)
            static_mask.copy_(mask)
            static_border.copy_(border)
            if static_valid is not None:
                static_valid.copy_(valid)
            operations(self, static_swap, static_mask, static_border,
                       static_valid, size, slider)
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream,
                                  capture_error_mode='thread_local'):
                output_swap, output_mask = operations(
                    self, static_swap, static_mask, static_border,
                    static_valid, size, slider,
                )
            state.update(graph=graph, swap=static_swap, mask=static_mask,
                         border=static_border, valid=static_valid,
                         output_swap=output_swap, output_mask=output_mask)
        state['swap'].copy_(swap)
        state['mask'].copy_(mask)
        state['border'].copy_(border)
        if valid is not None:
            state['valid'].copy_(valid)
        state['graph'].replay()
        owned_swap = state['output_swap'].clone()
        owned_mask = state['output_mask'].clone()
        done = torch.cuda.Event()
        done.record(stream)
        state['lastUse'] = done
        return owned_swap, owned_mask

    vm._isolated_mask_tail_eligible = eligible
    vm._isolated_mask_tail_graph = graph_tail
    vm.swap_core = scope[original.__name__]
    vm.swap_core._isolated_source = patched
    old_shutdown = vm.shutdown_background_workers

    def shutdown(self):
        try:
            return old_shutdown(self)
        finally:
            cache = getattr(self, '_experimental_mask_tail_graphs', None)
            if cache is not None:
                for state in cache.values():
                    if state['lastUse'] is not None:
                        state['lastUse'].synchronize()
                cache.clear()

    vm.shutdown_background_workers = shutdown
    return vm
