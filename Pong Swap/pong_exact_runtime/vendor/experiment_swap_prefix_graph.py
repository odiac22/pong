"""Isolated exact baseline 128-swap prefix graph, never a production import.

Requires experiment_native_swapper.install(graph=False): one qualified TRT
engine execution is captured inside this larger graph, not replayed as a nested
child graph. The first matching call warms that native state through the
original path; shape-specific captures occur only after repeated use. All
other settings and tensor layouts use the source-original branch.
"""

from collections import OrderedDict
import inspect
import sys
import textwrap
import weakref


_START = "    swap_face_input = pipeline_input_face"
_END = "    mark_stage('swapModel')"


def install():
    import torch
    from rope import VideoManager as module
    from rope.Models import Models

    vm = module.VideoManager
    owners = weakref.WeakSet()
    original = vm.swap_core
    source = textwrap.dedent(
        getattr(original, '_isolated_source', None) or inspect.getsource(original)
    )
    if source.count(_START) != 1 or source.count(_END) != 1:
        raise RuntimeError("Swap prefix source contract changed")
    start = source.index(_START)
    end = source.index(_END, start) + len(_END)
    original_block = source[start:end]
    # Baseline-only path. The original block remains verbatim as fallback,
    # including its model/strength/high-fidelity logic and stage marker.
    replacement = """    if self._isolated_swap_prefix_eligible(
            pipeline_input_face, latent, parameters, swap_size, dim,
            pipeline_size, hf_switch_on):
        swap = self._isolated_swap_prefix_graph(
            pipeline_input_face, latent, pipeline_size, parameters)
        mark_stage('swapModel')
    else:
""" + textwrap.indent(original_block, "    ")
    patched = source[:start] + replacement + source[end:]
    scope = {}
    exec(compile(patched, module.__file__, "exec"), module.__dict__, scope)

    def eligible(self, crop, latent, parameters, swap_size, dim,
                 pipeline_size, hf_switch_on):
        if (str(parameters.get('SwapperTypeTextSel')) != '128'
                or int(swap_size) != 128 or int(dim) != 1
                or bool(parameters.get('StrengthSwitch'))
                or float(parameters.get('StrengthSlider', 0)) != 100.0
                or bool(hf_switch_on)
                or bool(parameters.get('FaceAdjSwitch'))
                or not isinstance(crop, torch.Tensor)
                or not crop.is_cuda or crop.device.index != 0
                or crop.dtype != torch.uint8 or crop.ndim != 3
                or crop.shape[0] != 3 or min(crop.shape[1:]) <= 0
                or not isinstance(latent, torch.Tensor)
                or not latent.is_cuda or latent.device != crop.device
                or latent.dtype != torch.float32
                or tuple(latent.shape) != (1, 512)
                or int(pipeline_size) != int(crop.shape[1])
                or crop.shape[1] != crop.shape[2]):
            return False
        state = getattr(self.models, '_isolated_native_swapper', None)
        if state is None or state.get('graph') is not None:
            return False
        # A graph replay bypasses Models.run_swapper, hence its normal lazy
        # session/backend rebinding checks. Perform the same binding check at
        # the prefix boundary, and drain captures before old TRT state drops.
        session = self.models._get_swapper_session()
        binding = (id(session), str(self.models.models_folder),
                   self.models.get_backend_preference('swapper_model'),
                   str(self.models._swapper_io_dtype),
                   bool(self.models._swapper_uses_trt),
                   tuple(torch.cuda.get_device_capability(crop.device)))
        if (not self.models._persistent_shared_io_enabled()
                or not self.models._swapper_uses_trt
                or state.get('binding') != binding):
            drain(self)
            return False
        stream = torch.cuda.current_stream(crop.device)
        return int(state['stream'].cuda_stream) == int(stream.cuda_stream)

    def drain(self):
        cache = getattr(self, '_experimental_swap_prefix_graphs', None)
        if cache is not None:
            for entry in cache.values():
                if entry.get('lastUse') is not None:
                    entry['lastUse'].synchronize()
            cache.clear()

    def operations(self, crop, latent, pipeline_size, parameters):
        # Exactly the baseline branch of the preserved swap_core block.
        swap_face_input = module.v2.functional.resize(
            crop, [128, 128], interpolation=module.v2.InterpolationMode.BILINEAR,
            antialias=False,
        )
        swap_face_input = swap_face_input.permute(1, 2, 0)
        swap_face_input = torch.div(swap_face_input, 255.0)
        swap_face_output = self._polyphase_pass_v1(
            swap_face_input, latent, 1, 128, parameters, source_frame=None,
        )
        swap_face_output = torch.mul(swap_face_output, 255)
        swap_face_output = torch.clamp(swap_face_output, 0, 255)
        swap = swap_face_output.permute(2, 0, 1)
        swap = module.v2.Resize(
            (pipeline_size, pipeline_size),
            interpolation=module.v2.InterpolationMode.BICUBIC,
            antialias=False,
        )(swap.type(torch.float32))
        return swap.clamp(0, 255).type(torch.uint8)

    def prefix(self, crop, latent, pipeline_size, parameters):
        owners.add(self)
        stream = torch.cuda.current_stream(crop.device)
        key = (tuple(crop.shape), tuple(crop.stride()), crop.dtype,
               tuple(latent.shape), tuple(latent.stride()), latent.dtype,
               str(crop.device), int(stream.cuda_stream), int(pipeline_size),
               id(self.models._isolated_native_swapper['context']))
        cache = getattr(self, '_experimental_swap_prefix_graphs', None)
        if cache is None:
            cache = self._experimental_swap_prefix_graphs = OrderedDict()
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
            return operations(self, crop, latent, pipeline_size, parameters)
        if 'graph' not in state:
            static_crop = torch.empty(crop.shape, device=crop.device, dtype=crop.dtype)
            static_latent = torch.empty(latent.shape, device=latent.device,
                                        dtype=latent.dtype)
            static_crop.copy_(crop)
            static_latent.copy_(latent)
            operations(self, static_crop, static_latent, pipeline_size, parameters)
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream,
                                  capture_error_mode='thread_local'):
                output = operations(
                    self, static_crop, static_latent, pipeline_size, parameters,
                )
            state.update(graph=graph, crop=static_crop, latent=static_latent,
                         output=output)
        state['crop'].copy_(crop)
        state['latent'].copy_(latent)
        state['graph'].replay()
        owned = state['output'].clone()
        done = torch.cuda.Event()
        done.record(stream)
        state['lastUse'] = done
        return owned

    vm._isolated_swap_prefix_eligible = eligible
    vm._isolated_swap_prefix_graph = prefix
    vm.swap_core = scope[original.__name__]
    vm.swap_core._isolated_source = patched
    old_shutdown = vm.shutdown_background_workers

    def shutdown(self):
        try:
            return old_shutdown(self)
        finally:
            drain(self)

    vm.shutdown_background_workers = shutdown
    old_delete = Models.delete_models

    def delete(self):
        for owner in tuple(owners):
            if getattr(owner, 'models', None) is self:
                drain(owner)
        return old_delete(self)

    Models.delete_models = delete
    return vm
