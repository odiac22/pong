"""Isolated same-engine native graph submission for detector/recognizer."""
from collections import OrderedDict
import hashlib
from pathlib import Path


PLANS = {
    'retinaface': ('TensorrtExecutionProvider_TRTKernel_graph_torch-jit-export_2446903033560239399_0_0_fp16_sm89.engine',
                  'c82d0046bb26a37dcc0686cf2dc8d3a9c2fa1e6faf6ea9688fa5dd40c8fe2242',
                  ('input.1', '448', '471', '494', '451', '474', '497', '454', '477', '500')),
    'recognition': ('TensorrtExecutionProvider_TRTKernel_graph_torch-jit-export_13433965202042488077_0_0_fp16_sm89.engine',
                    '9cf2e8b62960887983666e84cd1b3c8f51f64095a48f29e526b663858128da7b',
                    ('input.1', '683')),
}


def install():
    import torch
    import tensorrt as trt
    from rope.Models import Models
    original = Models._run_owned_gpu_binding
    old_delete = Models.delete_models
    old_unload = Models.unload_model

    def drain(self, family=None):
        cache = getattr(self, '_isolated_native_detection', None)
        if not cache:
            return
        for key, state in tuple(cache.items()):
            if family is not None and key[0] != family:
                continue
            # A submission may have failed before `done` was recorded. Fence
            # the owner stream itself before dropping any graph/context/I/O.
            state['stream'].synchronize()
            if state['done'] is not None:
                state['done'].synchronize()
            cache.pop(key, None)

    def run(self, session, binding, *buffers):
        family = ('retinaface' if session is self.retinaface_model else
                  'recognition' if session is self.recognition_model else None)
        if (family is None or not self._persistent_shared_io_enabled()
                or not getattr(self, '_ordered_gpu_submission', False)
                or not getattr(self, '_' + family + '_uses_trt', False)
                or torch.cuda.get_device_capability(0) != (8, 9)
                or any(not t.is_cuda or t.device.index != 0 or not t.is_contiguous()
                       or t.dtype != torch.float32 for t in buffers)):
            return original(self, session, binding, *buffers)
        plan_name, digest, names = PLANS[family]
        if len(buffers) != len(names):
            return original(self, session, binding, *buffers)
        expected_input = ((1, 3, 640, 640) if family == 'retinaface'
                          else (1, 3, 112, 112))
        if tuple(buffers[0].shape) != expected_input:
            return original(self, session, binding, *buffers)
        stream = torch.cuda.current_stream(buffers[0].device)
        if stream.cuda_stream != self._shared_compute_stream_id:
            return original(self, session, binding, *buffers)
        cache = getattr(self, '_isolated_native_detection', None)
        if cache is None:
            cache = self._isolated_native_detection = OrderedDict()
        key = (family, id(session), str(self.models_folder), int(stream.cuda_stream),
               self.get_backend_preference(family + '_model'),
               tuple(tuple(t.shape) for t in buffers))
        state = cache.get(key)
        if state is not None and state['session'] is not session:
            # An id-based key must never replay a graph against a replacement
            # ORT session, even if Python eventually reuses the old id.
            drain(self, family)
            state = None
        if state is None:
            payload = (Path(self.models_folder) / 'ort_trt_cache' / plan_name).read_bytes()
            if hashlib.sha256(payload).hexdigest() != digest:
                raise RuntimeError('Frozen detector engine changed')
            logger = trt.Logger(trt.Logger.WARNING)
            runtime = trt.Runtime(logger)
            engine = runtime.deserialize_cuda_engine(payload)
            if {engine.get_tensor_name(i) for i in range(engine.num_io_tensors)} != set(names):
                raise RuntimeError('Detector engine IO contract differs from complete model')
            context = engine.create_execution_context()
            if not context.set_input_shape(names[0], tuple(buffers[0].shape)):
                raise RuntimeError('Detector input shape rejected')
            static = []
            for name, tensor in zip(names, buffers):
                dtype = {trt.DataType.HALF: torch.float16, trt.DataType.FLOAT: torch.float32}.get(engine.get_tensor_dtype(name))
                if dtype is None or tuple(context.get_tensor_shape(name)) != tuple(tensor.shape):
                    raise RuntimeError('Detector IO shape/type mismatch')
                value = torch.empty_like(tensor, dtype=dtype)
                if not context.set_tensor_address(name, value.data_ptr()):
                    raise RuntimeError('Detector IO binding rejected')
                static.append(value)
            state = {'logger': logger, 'runtime': runtime, 'engine': engine, 'context': context,
                     'static': static, 'graph': None, 'calls': 0, 'done': None,
                     'session': session, 'stream': stream}
            cache[key] = state
        cache.move_to_end(key)
        while len(cache) > 4:
            _, old = cache.popitem(last=False)
            if old['done'] is not None:
                old['done'].synchronize()
        state['static'][0].copy_(buffers[0])
        if state['graph'] is None:
            if not state['context'].execute_async_v3(stream.cuda_stream):
                raise RuntimeError('Detector warmup failed')
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                if not state['context'].execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('Detector capture failed')
            state['graph'] = graph
        state['graph'].replay()
        for output, value in zip(buffers[1:], state['static'][1:]):
            output.copy_(value)
        done = torch.cuda.Event()
        done.record(stream)
        state['done'] = done
        state['calls'] += 1

    def delete(self):
        cache = getattr(self, '_isolated_native_detection', None)
        if cache:
            for key, state in cache.items():
                print('[native-detection]', key[0], state['calls'], flush=True)
            drain(self)
        return old_delete(self)

    def unload(self, attr_name):
        family = {
            'retinaface_model': 'retinaface',
            'recognition_model': 'recognition',
        }.get(attr_name)
        if family is not None:
            drain(self, family)
        return old_unload(self, attr_name)

    Models._run_owned_gpu_binding = run
    Models.delete_models = delete
    Models.unload_model = unload
