"""Isolated exact restorer guard graph; no thresholds or history-policy changes.

Combines the original reduction and local-confidence computation into one
readback. Captures the same torch operators, not an approximate reduction.
"""
from collections import OrderedDict
import textwrap


def install(module):
    import torch

    def evaluate(self, current, previous, out_size, need_confidence):
        stream = torch.cuda.current_stream(current.device)
        key = (tuple(current.shape), tuple(current.stride()), tuple(previous.stride()),
               current.dtype, previous.dtype, str(current.device),
               int(stream.cuda_stream), int(out_size), bool(need_confidence))
        cache = getattr(self, '_experimental_restorer_guards', None)
        if cache is None:
            cache = self._experimental_restorer_guards = OrderedDict()
        state = cache.get(key)

        def operations(a, b):
            delta = torch.abs(a - b)
            local_delta = torch.mean(delta, dim=0, keepdim=True).unsqueeze(0)
            kernel = max(8, int(out_size // 16))
            grid = torch.nn.functional.avg_pool2d(local_delta, kernel, kernel)
            maximum, index = torch.max(grid.reshape(-1), dim=0)
            scores = [torch.isfinite(delta).all(), torch.mean(delta), maximum, index]
            confidence = None
            if need_confidence:
                confidence = module._correction_confidence(a, b)
                scores.append((confidence < 0.25).float().mean())
            return grid, torch.stack(scores), confidence

        if state is None:
            state = {'seen': 0, 'done': None}
            cache[key] = state
        cache.move_to_end(key)
        while len(cache) > 3:
            _, old = cache.popitem(last=False)
            if old['done'] is not None:
                old['done'].synchronize()
        state['seen'] += 1
        if state['seen'] < 3:
            grid, scores, confidence = operations(current, previous)
            # cpu() fences these original operations, including confidence.
            values = scores.cpu().tolist()
            return grid, values[:4], confidence, values[4] if need_confidence else None
        if 'graph' not in state:
            a, b = current.clone(), previous.clone()
            operations(a, b)
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                grid, scores, confidence = operations(a, b)
            state.update(graph=graph, current=a, previous=b, grid=grid,
                         scores=scores, confidence=confidence,
                         host=torch.empty(scores.shape, dtype=scores.dtype, pin_memory=True))
        state['current'].copy_(current)
        state['previous'].copy_(previous)
        state['graph'].replay()
        state['host'].copy_(state['scores'], non_blocking=True)
        # This confidence can outlive this invocation as display history, so
        # never expose the graph's reusable static output to the caller.
        confidence = state['confidence'].clone() if need_confidence else None
        done = torch.cuda.Event()
        done.record(stream)
        state['done'] = done
        done.synchronize()
        values = state['host'].tolist()
        return state['grid'], values[:4], confidence, values[4] if need_confidence else None

    module.VideoManager._isolated_restorer_guard_graph = evaluate


def transform_source(source):
    old = """                delta = torch.abs(current_input_pixels - anchor_input)
                metrics_evaluated = True
                local_delta = torch.mean(delta, dim=0, keepdim=True).unsqueeze(0)
                patch_kernel = max(8, int(out_size // 16))
                patch_grid = torch.nn.functional.avg_pool2d(
                    local_delta, kernel_size=patch_kernel, stride=patch_kernel,
                )
                patch_value, patch_index = torch.max(patch_grid.reshape(-1), dim=0)
                finite, mean_value, max_value, index_value = _read_guard_scalars(
                    torch.isfinite(delta).all(), torch.mean(delta), patch_value, patch_index,
                )"""
    old = textwrap.indent(textwrap.dedent(old), '            ')
    new = """            metrics_evaluated = True
            patch_grid, guard_values, prepared_confidence, prepared_uncertain = (
                self._isolated_restorer_guard_graph(
                    current_input_pixels, anchor_input, out_size,
                    temporal_context.get('correctionLocalGuardEnabled', False)))
            finite, mean_value, max_value, index_value = guard_values"""
    # inspect.getsource() is dedented by the surrounding experiment installer.
    if source.count(old) != 1:
        raise RuntimeError('Restorer guard reduction contract changed')
    source = source.replace(old, new)
    source = source.replace('    metrics_evaluated = False',
                            '    metrics_evaluated = False\n    prepared_confidence = None\n    prepared_uncertain = None')
    old_conf = """        confidence = _correction_confidence(current_input_pixels, anchor_state['inputPixels'])
        uncertain_fraction = float((confidence < 0.25).float().mean().item())"""
    new_conf = """        confidence = (prepared_confidence if prepared_confidence is not None else
                      _correction_confidence(current_input_pixels, anchor_state['inputPixels']))
        uncertain_fraction = (float(prepared_uncertain) if prepared_uncertain is not None else
                              float((confidence < 0.25).float().mean().item()))"""
    if source.count(old_conf) != 1:
        raise RuntimeError('Restorer confidence contract changed')
    source = source.replace(old_conf, new_conf)
    old_reuse = "            reuse_confidence = _correction_confidence(current_input_pixels, anchor_state['inputPixels'])"
    if source.count(old_reuse) != 1:
        raise RuntimeError('Restorer reuse confidence contract changed')
    source = source.replace(old_reuse,
                            "            reuse_confidence = (prepared_confidence if prepared_confidence is not None else\n"
                            "                                _correction_confidence(current_input_pixels, anchor_state['inputPixels']))")
    return source
