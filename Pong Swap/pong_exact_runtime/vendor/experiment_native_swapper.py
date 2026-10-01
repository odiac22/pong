"""Isolated direct execution of the *same bytes* as the cached ORT swapper.

No rebuild, precision change, settings change or production import hook.
Run this file with normal exact profiler arguments. Compare all frame hashes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parent
PLAN_NAME = 'TensorrtExecutionProvider_TRTKernel_graph_torch_jit_16043652725959116708_0_0_fp16_sm89.engine'
PLAN_HASH = '471c54071f3976ea2c7b864047e40c0e635a1cf774ba70661214ee682f971d6d'


def install(graph=False):
    import torch
    import tensorrt as trt
    from rope.Models import Models
    original = Models.run_swapper
    old_delete = Models.delete_models

    def direct(self, image, embedding, output):
        if (tuple(image.shape) != (1, 3, 128, 128)
                or not self._persistent_shared_io_enabled()
                or not all(t.is_cuda and t.device.index == 0
                           for t in (image, embedding, output))):
            return original(self, image, embedding, output)
        stream = torch.cuda.current_stream(image.device)
        session = self._get_swapper_session()
        binding = (id(session), str(self.models_folder),
                   self.get_backend_preference('swapper_model'),
                   str(self._swapper_io_dtype), bool(self._swapper_uses_trt),
                   tuple(torch.cuda.get_device_capability(image.device)))
        state = getattr(self, '_isolated_native_swapper', None)
        if state is not None and state['binding'] != binding:
            # A backend preference, model folder, or lazy ORT session can
            # change without delete_models(). Never replay an old TRT context.
            state['stream'].synchronize()
            self._isolated_native_swapper = None
            state = None
        if not self._swapper_uses_trt:
            return original(self, image, embedding, output)
        if state is None:
            # Load the normal session first so provider/backend selection is
            # validated by production before selecting its frozen engine.
            payload = (Path(self.models_folder) / 'ort_trt_cache' / PLAN_NAME).read_bytes()
            if hashlib.sha256(payload).hexdigest() != PLAN_HASH:
                raise RuntimeError('Baseline swapper engine bytes changed')
            logger = trt.Logger(trt.Logger.WARNING)
            runtime = trt.Runtime(logger)
            engine = runtime.deserialize_cuda_engine(payload)
            if engine is None:
                raise RuntimeError('Native swapper deserialization failed')
            context = engine.create_execution_context()
            if not context.set_input_shape('target', (1, 3, 128, 128)):
                raise RuntimeError('Native swapper shape rejected')
            buffers = {
                'target': torch.empty_like(image, dtype=torch.float16).contiguous(),
                'source': torch.empty_like(embedding, dtype=torch.float16).contiguous(),
                'output': torch.empty_like(output, dtype=torch.float16).contiguous(),
            }
            if {engine.get_tensor_name(i) for i in range(engine.num_io_tensors)} != set(buffers):
                raise RuntimeError('Native swapper IO names changed')
            for name, buffer in buffers.items():
                if engine.get_tensor_dtype(name) != trt.DataType.HALF:
                    raise RuntimeError('Native swapper IO precision changed')
                if tuple(context.get_tensor_shape(name)) != tuple(buffer.shape):
                    raise RuntimeError('Native swapper IO shape mismatch')
                if not context.set_tensor_address(name, buffer.data_ptr()):
                    raise RuntimeError('Native swapper IO binding failed')
            state = {'logger': logger, 'runtime': runtime, 'engine': engine,
                     'context': context, 'buffers': buffers, 'stream': stream,
                     'graph': None, 'calls': 0, 'binding': binding}
            self._isolated_native_swapper = state
        if int(state['stream'].cuda_stream) != int(stream.cuda_stream):
            raise RuntimeError('Native swapper owner stream changed')
        buffers = state['buffers']
        buffers['target'].copy_(image)
        buffers['source'].copy_(embedding)
        if graph and state['graph'] is None:
            if not state['context'].execute_async_v3(stream.cuda_stream):
                raise RuntimeError('Native swapper warmup failed')
            stream.synchronize()
            captured = torch.cuda.CUDAGraph()
            with torch.cuda.graph(captured, stream=stream, capture_error_mode='thread_local'):
                if not state['context'].execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('Native swapper capture failed')
            state['graph'] = captured
        if state['graph'] is not None:
            state['graph'].replay()
        elif not state['context'].execute_async_v3(stream.cuda_stream):
            raise RuntimeError('Native swapper execute failed')
        output.copy_(buffers['output'])
        state['calls'] += 1

    def delete(self):
        state = getattr(self, '_isolated_native_swapper', None)
        if state:
            state['stream'].synchronize()
            print('[native-swapper]', {'calls': state['calls'], 'graph': graph,
                                       'planSha256': PLAN_HASH}, flush=True)
            self._isolated_native_swapper = None
            del state
        return old_delete(self)

    Models.run_swapper = direct
    Models.delete_models = delete


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cuda-graph', action='store_true')
    parser.add_argument('--mask-overlap', action='store_true')
    args, rest = parser.parse_known_args()
    sys.path.insert(0, str(ROOT))
    import pong_swap_config as cfg
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    from rope import _native_dlls  # noqa: F401
    install(graph=args.cuda_graph)
    if args.mask_overlap:
        from pong_exact_runtime.vendor.experiment_mask_overlap import install as install_masks
        install_masks()
    sys.argv = ['profile_exact_stages.py', *rest]
    runpy.run_path('E:/Pong Benchmarks/v3030-exact-stage-profile/profile_exact_stages.py', run_name='__main__')
    report_path = Path(rest[rest.index('--output-dir') + 1]) / 'report.json'
    report = json.loads(report_path.read_text(encoding='utf-8'))
    report['experiment'] = 'native-swapper-graph' if args.cuda_graph else 'native-swapper'
    if args.mask_overlap:
        report['experiment'] += '+mask-guards'
    report['nativeSwapperEngineSha256'] = PLAN_HASH
    report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
