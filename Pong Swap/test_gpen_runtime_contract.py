"""Source/fake-only GPEN contracts. Run directly with python -B.

Never import Models, pong_swap_engine, torch, ORT, or the production ENGINE.
Only named source declarations are compiled; all hardware and I/O are fakes.
"""

import ast
import builtins
from contextlib import contextmanager
from copy import deepcopy
import importlib.util
import io
import math
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent
ROPE = ROOT / 'engine' / 'Rope' / 'rope'
spec = importlib.util.spec_from_file_location('gpen_contract_runtime', ROPE / 'gpen_runtime.py')
runtime_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_module)
GPENRuntime = runtime_module.GPENRuntime


def extract(path, class_name, names, namespace):
    """Execute explicitly selected declarations, never module-level imports/I/O."""
    source = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    container = source if class_name is None else next(
        node for node in source.body if isinstance(node, ast.ClassDef) and node.name == class_name
    )
    nodes = []
    for node in container.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = node.name
        elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
        else:
            continue
        if name in names:
            nodes.append(node)
    if len(nodes) != len(names):
        raise AssertionError('Missing or duplicate source declarations')
    if class_name is not None:
        container.body = nodes
        nodes = [container]
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    code = ast.fix_missing_locations(ast.Module(body=[future] + nodes, type_ignores=[]))
    exec(compile(code, str(path), 'exec'), namespace)
    return namespace if class_name is None else namespace[class_name]


class FakeStream:
    def __init__(self, stream_id=123):
        self.cuda_stream = stream_id
        self.syncs = 0
        self.fail_sync = False

    def synchronize(self):
        self.syncs += 1
        if self.fail_sync:
            raise RuntimeError('synthetic fence failure')


class FakeTensor:
    def __init__(self, torch, shape, dtype, device, value=0):
        self.shape = tuple(shape)
        self.dtype = dtype
        self.device = SimpleNamespace(type=device.split(':')[0], index=0)
        self.value = value
        self.contiguous = True
        torch.pointers[id(self)] = self

    def is_contiguous(self):
        return self.contiguous

    def data_ptr(self):
        return id(self)

    def fill_(self, value):
        self.value = value
        return self

    def copy_(self, other):
        self.value = other.value
        return self

    def record_stream(self, stream):
        self.recorded_stream = stream


class FakeTorch:
    float32 = 'float32'
    version = SimpleNamespace(cuda='synthetic-cuda')

    def __init__(self):
        self.pointers = {}
        self.current = FakeStream()
        self.cuda = SimpleNamespace(
            current_stream=lambda: self.current, stream=self.stream,
            is_available=lambda: False,
            synchronize=lambda: self.current.synchronize(), Stream=lambda **kw: FakeStream(),
            get_device_name=lambda device: 'synthetic-device',
            get_device_capability=lambda device: (8, 9), empty_cache=lambda: None,
        )

    @contextmanager
    def stream(self, stream):
        previous = self.current
        self.current = stream
        try:
            yield
        finally:
            self.current = previous

    def empty(self, shape, *, dtype, device):
        return FakeTensor(self, shape, dtype, device, float('nan'))

    def zeros(self, shape, *, dtype, device):
        return FakeTensor(self, shape, dtype, device)

    def isfinite(self, tensor):
        return SimpleNamespace(all=lambda: SimpleNamespace(item=lambda: math.isfinite(tensor.value)))


class FakeBinding:
    def bind_input(self, **kwargs):
        self.input = kwargs

    def bind_output(self, **kwargs):
        self.output = kwargs


class FakeSession:
    def __init__(self, ort, edge, providers):
        self.ort = ort
        self.edge = edge
        self.providers = providers
        self.bindings = []
        self.runs = 0
        self.fallback_disabled = False
        self.fail_run = False

    def disable_fallback(self):
        self.fallback_disabled = True

    def get_providers(self):
        if self.ort.cpu_only:
            return ['CPUExecutionProvider']
        return [name for name, _ in self.providers
                if name != 'TensorrtExecutionProvider' or not self.ort.missing_trt]

    def get_inputs(self):
        return [SimpleNamespace(name='input', type=self.ort.input_type,
                                shape=[1, 3, self.edge, self.edge])]

    def get_outputs(self):
        edge = self.edge + int(self.ort.bad_shape)
        return [SimpleNamespace(name='output', type='tensor(float)', shape=[1, 3, edge, edge])]

    def io_binding(self):
        binding = FakeBinding()
        self.bindings.append(binding)
        return binding

    def run_with_iobinding(self, binding):
        self.runs += 1
        if self.fail_run or self.ort.fail_warm:
            raise RuntimeError('synthetic Run failure')
        pointers = self.ort.torch.pointers
        pointers[binding.output['buffer_ptr']].value = (
            float('nan') if self.ort.nonfinite else pointers[binding.input['buffer_ptr']].value + 0.125
        )


class FakeOrt:
    __version__ = 'synthetic-ort'

    def __init__(self, torch):
        self.torch = torch
        self.calls = []
        self.sessions = []
        self.fail_trt = self.missing_trt = self.cpu_only = False
        self.fail_warm = self.nonfinite = self.bad_shape = False
        self.input_type = 'tensor(float)'

    def InferenceSession(self, path, *, sess_options, providers):
        self.calls.append(deepcopy(providers))
        if self.fail_trt and providers[0][0] == 'TensorrtExecutionProvider':
            raise RuntimeError('synthetic unsupported TRT graph')
        session = FakeSession(self, 1024 if '1024' in path else 512 if '512' in path else 256, providers)
        self.sessions.append(session)
        return session


def model_fixture():
    torch = FakeTorch()
    ort = FakeOrt(torch)
    namespace = {'threading': threading, 'torch': torch}
    model_class = extract(ROPE / 'Models.py', 'Models', {
        '_VRAM_TRACKED_ATTRS', '_BACKEND_PREF_ATTRS', 'get_backend_preference',
        'set_backend_preference', 'set_shared_compute_stream', '_set_shared_compute_stream_inner',
        '_cuda_stream_id', 'set_model_session_mode', 'unload_model', 'delete_models',
        '_set_model_session_mode_inner', '_delete_models_inner',
        'warm_restorer', 'restorer_status', 'run_GPEN_256', 'run_GPEN_512', 'run_GPEN_1024',
    }, namespace)
    owner = model_class.__new__(model_class)
    owner._backend_pref = {'swapper_model': 'onnx', 'retinaface_model': 'onnx'}
    owner._model_session_mode = 'Shared'
    owner._shared_compute_stream = torch.current
    owner._shared_compute_stream_id = torch.current.cuda_stream
    owner._sessions_lock = threading.RLock()
    owner._all_sessions = {}
    owner._mp = lambda name: '/synthetic/' + name
    owner._make_session_options = lambda: object()
    owner._cuda_ep_provider_options = lambda search: {
        'cudnn_conv_algo_search': search, 'user_compute_stream': 'wrong-unless-overridden',
    }
    owner.syncvec = SimpleNamespace(cpu=mock.Mock())
    owner._should_drain_syncvec = lambda: (
        int(torch.current.cuda_stream) != int(owner._shared_compute_stream_id)
    )
    owner._drop_persistent_io = mock.Mock()
    owner._gpen_runtime = GPENRuntime(owner, torch, ort, 'numpy-float32')
    owner._gpen_runtime._cache_directory = mock.Mock(return_value='/synthetic/cache')
    owner.GPEN_256_model = []
    owner.GPEN_512_model = []
    owner.GPEN_1024_model = []
    return owner, torch, ort


class RuntimeContracts(unittest.TestCase):
    def setUp(self):
        self.owner, self.torch, self.ort = model_fixture()
        self.runtime = self.owner._gpen_runtime

    def tensors(self, edge=512, value=0):
        shape = (1, 3, edge, edge)
        image = self.torch.zeros(shape, dtype='float32', device='cuda:0').fill_(value)
        return image, self.torch.empty(shape, dtype='float32', device='cuda:0')

    def test_qualified_plan_is_resolution_scoped(self):
        self.owner._gpen_native_trt_qualified_plan = 'qualified-512.plan'
        self.owner._gpen_native_trt_qualified_plan_1024 = 'qualified-1024.plan'
        self.assertEqual(self.runtime._qualified_plan_path(256), '')
        self.assertEqual(self.runtime._qualified_plan_path(512), 'qualified-512.plan')
        self.assertEqual(self.runtime._qualified_plan_path(1024), 'qualified-1024.plan')
        self.owner._gpen_native_trt_qualified_plan_1024 = ''
        self.assertEqual(self.runtime._qualified_plan_path(1024), '')

    def native_graph_fixture(self):
        self.owner.warm_restorer('GPEN1024')
        state = self.runtime._states[1024]
        context = SimpleNamespace(set_tensor_address=mock.Mock(), execute_async_v3=mock.Mock())
        state['native'] = {'context': context, 'engine': object()}
        graph = SimpleNamespace(replay=mock.Mock(side_effect=lambda: state['output'].fill_(state['input'].value + 2)))
        state['nativeGraph'] = graph
        return state, context, graph

    def test_native_graph_replay_uses_fresh_pixels_and_stable_owned_addresses(self):
        state, context, graph = self.native_graph_fixture()
        owned = (state['input'].data_ptr(), state['output'].data_ptr())
        for value in (1, -7, 42):
            image, output = self.tensors(edge=1024, value=value)
            self.runtime.run(1024, image, output)
            self.assertEqual(output.value, value + 2)
            self.assertIs(image.recorded_stream, state['stream'])
            self.assertIs(output.recorded_stream, state['stream'])
            self.assertEqual(owned, (state['input'].data_ptr(), state['output'].data_ptr()))
        context.set_tensor_address.assert_not_called()
        context.execute_async_v3.assert_not_called()
        self.assertEqual(graph.replay.call_count, 3)

    def test_native_graph_failure_poisons_state_until_fenced_unload(self):
        state, _, graph = self.native_graph_fixture()
        graph.replay.side_effect = RuntimeError('synthetic replay failure')
        with self.assertRaisesRegex(RuntimeError, 'replay failure'):
            self.runtime.run(1024, *self.tensors(edge=1024))
        self.assertFalse(state['ready'])
        with self.assertRaisesRegex(RuntimeError, 'unload before retrying'):
            self.runtime.run(1024, *self.tensors(edge=1024))
        self.assertIs(state['nativeGraph'], graph)
        self.runtime.clear()
        self.assertNotIn('nativeGraph', state)

    def test_native_graph_failed_fence_retains_all_ownership(self):
        state, _, graph = self.native_graph_fixture()
        state['stream'].fail_sync = True
        with self.assertRaisesRegex(RuntimeError, 'fence failure'):
            self.runtime.clear()
        self.assertIs(self.runtime._states[1024], state)
        self.assertIs(state['nativeGraph'], graph)
        self.assertIsNotNone(state['input'])
        state['stream'].fail_sync = False
        self.runtime.clear()
        self.assertNotIn('nativeGraph', state)

    def test_1024_cuda_warm_preserves_full_resolution_without_build(self):
        self.owner.warm_restorer('GPEN1024')
        self.assertEqual(self.runtime.status()['1024']['shape'], [1, 3, 1024, 1024])
        self.runtime._cache_directory.assert_not_called()
        self.assertEqual([name for name, _ in self.ort.calls[0]], ['CUDAExecutionProvider'])

    def test_legacy_uses_cuda_without_implicit_trt_compilation(self):
        self.owner.warm_restorer('GPEN256')
        self.owner.warm_restorer('GPEN512')
        self.assertEqual(self.ort.calls[0][0][0], 'CUDAExecutionProvider')
        self.assertEqual(self.ort.calls[1][0][0], 'CUDAExecutionProvider')
        self.runtime._cache_directory.assert_not_called()
        self.assertEqual(set(self.runtime.status()), {'256', '512'})

    def test_explicit_cuda_never_attempts_trt_or_cache_access(self):
        self.owner.set_backend_preference('GPEN_256_model', 'onnx', unload=False)
        self.owner.warm_restorer('GPEN256')
        self.runtime._cache_directory.assert_not_called()
        self.assertEqual([name for name, _ in self.ort.calls[0]], ['CUDAExecutionProvider'])

    def test_cuda_graph_owns_stable_io_when_direct_io_is_also_requested(self):
        self.owner._gpen_cuda_direct_io = True
        self.owner._gpen_cuda_graph = True
        self.owner.set_backend_preference('GPEN_512_model', 'onnx', unload=False)
        self.owner.warm_restorer('GPEN512')
        state = self.runtime._states[512]
        status = self.runtime.status()['512']
        self.assertTrue(status['cudaDirectIoRequested'])
        self.assertFalse(status['cudaDirectIo'])
        self.assertTrue(status['cudaGraph'])
        self.assertIsNotNone(state['input'])
        self.assertIsNotNone(state['output'])
        self.assertIsNotNone(state['binding'])

    def test_trt_and_cuda_receive_same_stream_and_keep_fp32_io(self):
        self.owner.set_backend_preference('GPEN_512_model', 'trt', unload=False)
        self.owner.warm_restorer('GPEN512')
        trt, cuda = self.ort.calls[0]
        self.assertEqual(trt[1]['user_compute_stream'], '123')
        self.assertEqual(cuda[1]['user_compute_stream'], '123')
        self.assertEqual(trt[1]['trt_max_workspace_size'], 1 << 30)
        self.assertIs(trt[1]['trt_fp16_enable'], True)
        self.assertEqual(self.ort.sessions[0].bindings[0].input['element_type'], 'numpy-float32')
        self.assertTrue(self.ort.sessions[0].fallback_disabled)
        self.assertFalse(self.runtime.status()['512']['partitionPlacementVerified'])

    def test_constructor_failure_creates_fresh_bound_cuda_session(self):
        self.owner.set_backend_preference('GPEN_512_model', 'trt', unload=False)
        self.ort.fail_trt = True
        self.owner.warm_restorer('GPEN512')
        state = self.runtime.status()['512']
        self.assertEqual(state['effectiveBackend'], 'cuda')
        self.assertIn('initialization failed', state['fallbackReason'])
        self.assertEqual(len(self.ort.calls), 2)
        self.assertEqual(self.ort.calls[-1][0][1]['user_compute_stream'], '123')

    def test_fatal_cuda_initialization_error_does_not_retry(self):
        self.owner.set_backend_preference('GPEN_512_model', 'trt', unload=False)
        with mock.patch.object(self.ort, 'InferenceSession',
                               side_effect=RuntimeError('CUDA failure 700: illegal memory access')) as factory:
            with self.assertRaisesRegex(RuntimeError, 'illegal memory access'):
                self.owner.warm_restorer('GPEN512')
        self.assertEqual(factory.call_count, 1)

    def test_missing_trt_provider_is_explicit_fallback_with_fresh_session(self):
        self.owner.set_backend_preference('GPEN_256_model', 'trt', unload=False)
        self.ort.missing_trt = True
        self.owner.warm_restorer('GPEN256')
        self.assertEqual(len(self.ort.sessions), 2)
        self.assertEqual(self.ort.sessions[0].runs, 0)
        self.assertIs(self.owner.GPEN_256_model, self.ort.sessions[1])
        self.assertIn('not activated', self.runtime.status()['256']['fallbackReason'])

    def test_cpu_only_and_wrong_model_contract_are_rejected(self):
        for setting, value in [('cpu_only', True), ('bad_shape', True), ('input_type', 'tensor(float16)')]:
            with self.subTest(setting=setting):
                owner, _, ort = model_fixture()
                setattr(ort, setting, value)
                with self.assertRaises((RuntimeError, ValueError)):
                    owner.warm_restorer('GPEN512')
                self.assertFalse(owner.GPEN_512_model)

    def test_binding_reused_but_every_generated_input_is_copied(self):
        image, output = self.tensors()
        values = [((13 * index + 29) % 256) / 255 for index in range(32)]
        for value in values:
            image.fill_(value)
            self.owner.run_GPEN_512(image, output)
            self.assertEqual(output.value, value + 0.125)
        self.assertEqual(len(self.ort.sessions), 1)
        self.assertEqual(len(self.ort.sessions[0].bindings), 1)
        self.assertEqual(self.ort.sessions[0].runs, 33)  # generated warm-up + inputs
        state = self.runtime._states[512]
        self.assertIsNot(state['input'], image)
        self.assertIsNot(state['output'], output)
        self.assertEqual(self.owner.syncvec.cpu.call_count, 0)

    def test_run_failure_poisons_state_without_retry_or_rebinding(self):
        self.owner.warm_restorer('GPEN512')
        self.ort.sessions[0].fail_run = True
        image, output = self.tensors(value=0.5)
        with self.assertRaisesRegex(RuntimeError, 'Run failure'):
            self.owner.run_GPEN_512(image, output)
        with self.assertRaisesRegex(RuntimeError, 'unload before retrying'):
            self.owner.run_GPEN_512(image, output)
        self.assertEqual(len(self.ort.sessions), 1)
        self.assertFalse(self.runtime.status()['512']['ready'])

    def test_failed_or_nonfinite_warmup_is_not_published_or_retried(self):
        for flag in ('fail_warm', 'nonfinite'):
            with self.subTest(flag=flag):
                owner, _, ort = model_fixture()
                setattr(ort, flag, True)
                with self.assertRaises(RuntimeError):
                    owner.warm_restorer('GPEN512')
                self.assertFalse(owner.GPEN_512_model)
                self.assertTrue(owner._gpen_runtime.has_states())
                self.assertFalse(owner.restorer_status()['512']['ready'])
                with self.assertRaises(RuntimeError):
                    owner.set_shared_compute_stream(FakeStream(999))
                self.assertEqual(len(ort.sessions), 1)

    def test_wrong_stream_rejected_before_loading_and_after_warmup(self):
        self.torch.current = FakeStream(999)
        with self.assertRaisesRegex(RuntimeError, 'bound compute stream'):
            self.owner.warm_restorer('GPEN512')
        self.assertFalse(self.ort.calls)
        self.torch.current = self.owner._shared_compute_stream
        self.owner.warm_restorer('GPEN512')
        self.torch.current = FakeStream(999)
        with self.assertRaisesRegex(RuntimeError, 'bound compute stream'):
            self.owner.run_GPEN_512(*self.tensors())
        self.assertEqual(self.ort.sessions[0].runs, 1)

    def test_rebind_requires_retirement_and_new_state_has_new_buffers(self):
        self.owner.warm_restorer('GPEN512')
        prior = self.runtime._states[512]
        with self.assertRaisesRegex(RuntimeError, 'Unload Shared'):
            self.owner.set_shared_compute_stream(FakeStream(999))
        self.owner.set_shared_compute_stream(self.torch.current)
        self.owner.unload_model('GPEN_512_model')
        stream = FakeStream(999)
        self.owner.set_shared_compute_stream(stream)
        with self.torch.stream(stream):
            self.owner.warm_restorer('GPEN512')
        current = self.runtime._states[512]
        self.assertIsNot(current['input'], prior['input'])
        self.assertGreater(current['metadata']['generation'], prior['metadata']['generation'])
        self.assertIs(current['stream'], stream)

    def test_failed_retirement_fence_keeps_all_ownership(self):
        self.owner.warm_restorer('GPEN512')
        state = self.runtime._states[512]
        self.torch.current.fail_sync = True
        with self.assertRaisesRegex(RuntimeError, 'fence failure'):
            self.owner.delete_models()
        self.assertIs(self.runtime._states[512], state)
        self.assertIs(self.owner.GPEN_512_model, state['session'])
        self.owner._drop_persistent_io.assert_not_called()

    def test_mode_change_invalidates_both_and_disables_shared_buffers(self):
        self.owner.warm_restorer('GPEN256')
        self.owner.warm_restorer('GPEN512')
        self.owner.set_model_session_mode('Per-Thread')
        self.assertEqual(self.runtime.status(), {})
        self.assertFalse(self.owner.GPEN_256_model)
        self.assertFalse(self.owner.GPEN_512_model)
        self.owner.run_GPEN_512(*self.tensors())
        self.assertFalse(self.runtime.status()['512']['persistentIO'])
        self.assertNotIn('user_compute_stream', self.ort.calls[-1][0][1])
        self.assertIsNone(self.runtime._states[512]['binding'])

    def test_lifecycle_retains_exclusive_ownership_after_retirement(self):
        # A competing factory must not slip between clear() and the owner's
        # mode/attribute changes, otherwise it could republish an old-mode state.
        original_clear = self.runtime.clear
        lock_results = []
        def clear_and_probe(*args, **kwargs):
            original_clear(*args, **kwargs)
            def contender():
                acquired = self.runtime.lock.acquire(blocking=False)
                lock_results.append(acquired)
                if acquired:
                    self.runtime.lock.release()
            thread = threading.Thread(target=contender)
            thread.start()
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
        with mock.patch.object(self.runtime, 'clear', side_effect=clear_and_probe):
            self.owner.set_model_session_mode('Per-Thread')
            self.owner.delete_models()
        self.assertEqual(lock_results, [False, False])

    def test_preference_change_isolated_idempotent_and_retires_old_state(self):
        unrelated = dict(self.owner._backend_pref)
        self.owner.warm_restorer('GPEN512')
        old_session = self.owner.GPEN_512_model
        self.owner.set_backend_preference('GPEN_512_model', None, unload=False)
        self.assertIs(self.owner.GPEN_512_model, old_session)
        with self.assertRaises(RuntimeError):
            self.owner.set_backend_preference('GPEN_512_model', 'trt', unload=False)
        self.owner.set_backend_preference('GPEN_512_model', 'trt')
        self.assertFalse(self.runtime.has_states())
        for key, value in unrelated.items():
            self.assertEqual(self.owner._backend_pref[key], value)

    def test_unprepared_live_request_does_not_create_session(self):
        with self.assertRaisesRegex(RuntimeError, 'warm the selected restorer while idle'):
            self.owner.warm_restorer('GPEN512', allow_create=False)
        self.assertFalse(self.ort.calls)

    def test_status_is_detached_from_owned_metadata(self):
        self.owner.warm_restorer('GPEN512')
        snapshot = self.owner.restorer_status()
        snapshot['512']['shape'][0] = 99
        self.assertEqual(self.owner.restorer_status()['512']['shape'][0], 1)

    def test_invalid_input_shape_dtype_device_or_layout_is_rejected(self):
        for field, value in [('shape', (1, 3, 256, 256)), ('dtype', 'float16'),
                             ('device', SimpleNamespace(type='cpu', index=0)), ('contiguous', False)]:
            with self.subTest(field=field):
                image, output = self.tensors()
                setattr(image, field, value)
                with self.assertRaises(ValueError):
                    self.owner.run_GPEN_512(image, output)
        self.assertFalse(self.ort.calls)

    def test_cache_namespace_changes_with_graph_and_build_identity_without_disk_io(self):
        with mock.patch.object(runtime_module, 'open', create=True) as opener, \
             mock.patch.object(runtime_module.os, 'makedirs') as mkdir, \
             mock.patch.object(runtime_module.importlib.metadata, 'version', return_value='fake-trt'):
            opener.side_effect = [io.BytesIO(b'graph-a'), io.BytesIO(b'graph-b'), io.BytesIO(b'graph-a')]
            first = GPENRuntime._cache_directory(self.runtime, 512, 1 << 30)
            changed_graph = GPENRuntime._cache_directory(self.runtime, 512, 1 << 30)
            changed_workspace = GPENRuntime._cache_directory(self.runtime, 512, 2 << 30)
        self.assertEqual(len({first, changed_graph, changed_workspace}), 3)
        self.assertEqual(mkdir.call_count, 3)


config_namespace = extract(ROOT / 'pong_swap_config.py', None,
                           {
                               'RUNTIME_DEFAULTS',
                               'PRODUCTION_SWAPPER_OPTIONS',
                               'PRODUCTION_RESTORER_OPTIONS',
                               'normalize_production_model_choices',
                               'validate_restorer_backend_preference',
                           }, {})
validate_backend = config_namespace['validate_restorer_backend_preference']
normalize_production_model_choices = config_namespace['normalize_production_model_choices']


def generated_config():
    return {
        'runtime': deepcopy(config_namespace['RUNTIME_DEFAULTS']),
        'parameters': {
            'RestorerSwitch': True, 'RestorerTypeTextSel': 'GPEN512',
            'RestorerSlider': 83, 'StrengthSwitch': True, 'StrengthSlider': 143,
            'LikenessSlider': 91, 'EmbExtrapSlider': 12, 'ThresholdSlider': 63,
            'DetectScoreSlider': 47, 'ModelSessionsTextSel': 'Shared',
            'BorderTopSlider': 3, 'BorderSidesSlider': 4, 'BorderBottomSlider': 5,
            'BorderBlurSlider': 6, 'BlendSlider': 7, 'DiffSwitch': True, 'DiffSlider': 8,
            'OccluderSwitch': True, 'OccluderSlider': 9, 'DFLXSegSwitch': True,
            'DFLXSegSizeSlider': 10, 'DFLXSegBlurSlider': 11,
            'FaceParserSwitch': True, 'FaceParserSlider': 12, 'MouthParserSlider': 13,
        },
    }


def engine_fixture():
    owner, torch, ort = model_fixture()
    owner._shared_compute_stream = None
    owner._shared_compute_stream_id = None
    owner.set_models_folder = mock.Mock()
    owner.preload_pipeline_sessions = mock.Mock()
    owner.reconcile_production_residency = mock.Mock(return_value={})
    vm = SimpleNamespace(shutdown_background_workers=mock.Mock())
    modules = {
        'torch': torch,
        'rope.Models': SimpleNamespace(Models=lambda: owner),
        'rope.VideoManager': SimpleNamespace(VideoManager=lambda models: vm),
        'rope.qt.parameters': SimpleNamespace(seed_control_dict=lambda: {}),
        'pong_swap_config': SimpleNamespace(save_config=mock.Mock(side_effect=AssertionError('persistence'))),
    }
    def fake_import(name, *args, **kwargs):
        if name not in modules:
            raise AssertionError(f'Forbidden production import: {name}')
        return modules[name]
    namespace = {
        'deepcopy': deepcopy, 'time': time,
        'sys': SimpleNamespace(path=['/synthetic/rope']),
        'ROPE_ROOT': Path('/synthetic/rope'), 'MODELS_DIR': Path('/synthetic/models'),
        'validate_restorer_backend_preference': validate_backend,
        'normalize_production_model_choices': normalize_production_model_choices,
        'default_config': generated_config, 'ConfigUpdateConflict': RuntimeError,
    }
    # Intercept every import performed by the extracted methods. No production
    # imports or module-level ENGINE construction are executed.
    namespace['__builtins__'] = dict(vars(builtins), __import__=fake_import)
    # Future import in extract is the only extra import needed during compile.
    modules['__future__'] = __import__('__future__')
    engine_class = extract(ROOT / 'pong_swap_engine.py', 'PongSwapEngine', {
        '_MODEL_LIFECYCLE_CONFIG_PATHS', '_model_lifecycle_changed', '_normalized_config',
        '_cancel_embedding_prime', '_warm_selected_restorer', '_pipeline_signature',
        'warm', 'update_config',
        'unload', 'health',
    }, namespace)
    engine = engine_class.__new__(engine_class)
    engine._config = generated_config()
    engine._config_revision = 1
    engine._lock = threading.RLock()
    engine._config_lock = threading.RLock()
    engine._sessions_lock = threading.RLock()
    engine._embedding_prime_lock = threading.Lock()
    engine._embedding_priority_condition = threading.Condition(threading.Lock())
    engine._embedding_prime_cancel = threading.Event()
    engine._embedding_prime_started = False
    engine._embedding_prime_thread = None
    engine._embedding_cache = {}
    engine._source_frame_cache = {}
    engine._faces = {}
    engine._warm_error = engine._embedding_prime_error = ''
    engine._last_used = 0
    engine._models = engine._vm = engine._torch = engine._compute_stream = None
    engine._warming_models = engine._warming_stream = None
    engine._pipeline_warm_signature = None
    engine._model_residency = {}
    engine._instance_id = 'synthetic-engine'
    engine._last_gpu_oom = {}
    engine._enhancer_session = None
    engine._semantic_landmark_estimator = None
    engine._presentation_classifier = SimpleNamespace(
        backend='cpu', ready=False, set_backend=mock.Mock(), unload=mock.Mock(),
        warm=mock.Mock(), _session=SimpleNamespace(get_providers=lambda: ['CPUExecutionProvider']),
    )
    engine._presentation_classifier.health_snapshot = lambda: (
        engine._presentation_classifier.ready,
        engine._presentation_classifier.backend,
        ('CPUExecutionProvider',) if engine._presentation_classifier.ready else (),
    )
    engine._presentation_classifier.warm.side_effect = lambda: setattr(engine._presentation_classifier, 'ready', True)
    engine._active_session_count = lambda: 0
    engine._thread_is_alive = lambda thread: False
    engine._model_configuration_in_use = lambda: False
    engine.health = lambda: {'ready': engine._models is not None}
    engine.inspect_health = lambda: engine_class.health(engine)
    return engine, owner, torch, ort


class EngineContracts(unittest.TestCase):
    def test_cached_pipeline_still_primes_target_classifier_before_readiness(self):
        engine, _, torch, _ = engine_fixture()
        engine.warm()
        engine._presentation_classifier.ready = False
        engine._presentation_classifier.warm.reset_mock()
        engine.warm()
        engine._presentation_classifier.warm.assert_called_once()
        with mock.patch.dict(sys.modules, {'torch': torch}):
            self.assertTrue(engine.inspect_health()['identityClassifier']['ready'])

    def test_classifier_prime_failure_never_reports_ready(self):
        engine, _, torch, _ = engine_fixture()
        engine._presentation_classifier.warm.side_effect = RuntimeError('classifier prime failed')
        with self.assertRaisesRegex(RuntimeError, 'classifier prime failed'):
            engine.warm()
        with mock.patch.dict(sys.modules, {'torch': torch}):
            self.assertFalse(engine.inspect_health()['ready'])
        self.assertIn('classifier prime failed', engine._warm_error)

    def test_health_uses_one_classifier_snapshot_without_dereferencing_live_session(self):
        engine, _, torch, _ = engine_fixture()
        engine.warm()
        engine._presentation_classifier._session = SimpleNamespace(
            get_providers=mock.Mock(side_effect=RuntimeError('session unloaded'))
        )
        with mock.patch.dict(sys.modules, {'torch': torch}):
            health = engine.inspect_health()
        self.assertTrue(health['ready'])
        self.assertEqual(health['identityClassifier']['providers'], ['CPUExecutionProvider'])

    def test_production_modules_are_never_imported(self):
        for name in ('pong_swap_engine', 'pong_swap_config', 'rope.Models', 'torch', 'onnxruntime'):
            self.assertNotIn(name, sys.modules)

    def test_default_is_legacy_and_invalid_preference_is_rejected(self):
        self.assertEqual(config_namespace['RUNTIME_DEFAULTS']['restorerBackendPreference'], 'legacy')
        for value in ('auto', '', None, 1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_backend(value)

    def test_warm_routes_restorer_independently_and_preserves_entire_configuration(self):
        engine, owner, _, ort = engine_fixture()
        engine._config['runtime']['restorerBackendPreference'] = 'trt'
        before = deepcopy(engine._config)
        engine._config_lock = mock.MagicMock()
        engine._config_lock.__enter__.side_effect = AssertionError('inverted config lock')
        self.assertTrue(engine.warm()['ready'])
        self.assertEqual(engine._config, before)
        self.assertEqual(owner._backend_pref['swapper_model'], 'onnx')
        self.assertEqual(owner._backend_pref['retinaface_model'], 'onnx')
        self.assertEqual(owner._backend_pref['GPEN_512_model'], 'trt')
        self.assertEqual(len(ort.sessions), 1)
        self.assertEqual(owner.restorer_status()['512']['streamId'], engine._compute_stream.cuda_stream)
        self.assertGreater(engine._compute_stream.syncs, 0)

    def test_disabled_restorer_does_not_load_and_explicit_idle_warm_can_enable_it(self):
        engine, owner, _, ort = engine_fixture()
        engine._config['parameters']['RestorerSwitch'] = False
        engine.warm()
        self.assertFalse(ort.calls)
        engine._config['parameters']['RestorerSwitch'] = True
        engine.warm()
        engine.warm()
        self.assertEqual(len(ort.sessions), 1)
        self.assertEqual(ort.sessions[0].runs, 1)

    def test_health_reports_selected_restorer_readiness_without_gpu_access(self):
        engine, owner, _, _ = engine_fixture()
        engine._config['parameters']['RestorerSwitch'] = False
        engine.warm()
        self.assertTrue(engine.inspect_health()['ready'])
        engine._config['parameters']['RestorerSwitch'] = True
        self.assertFalse(engine.inspect_health()['ready'])
        engine.warm()
        health = engine.inspect_health()
        self.assertTrue(health['ready'])
        self.assertTrue(health['restorers']['512']['ready'])

    def test_active_request_cannot_compile_new_type_but_can_use_prepared_type(self):
        engine, owner, _, ort = engine_fixture()
        engine.warm()
        engine._active_session_count = lambda: 1
        engine.warm()
        candidate = deepcopy(engine._config)
        candidate['parameters']['RestorerTypeTextSel'] = 'GPEN256'
        with self.assertRaisesRegex(RuntimeError, 'not ready'):
            engine.warm(config=candidate)
        self.assertEqual(len(ort.sessions), 1)
        self.assertEqual(engine._config['parameters']['RestorerTypeTextSel'], 'GPEN512')

    def test_failed_warm_never_publishes_engine_models(self):
        engine, owner, _, ort = engine_fixture()
        ort.nonfinite = True
        with self.assertRaisesRegex(RuntimeError, 'nonfinite'):
            engine.warm()
        self.assertIsNone(engine._models)
        self.assertIsNone(engine._compute_stream)
        self.assertIs(engine._warming_models, owner)
        with self.assertRaisesRegex(RuntimeError, 'Unload the failed warm-up'):
            engine.warm()
        engine.unload()
        self.assertIsNone(engine._warming_models)
        self.assertIsNone(engine._warming_stream)
        self.assertEqual(owner.restorer_status(), {})

    def test_backend_update_is_lifecycle_change_visual_selection_is_not(self):
        engine, _, _, _ = engine_fixture()
        candidate = deepcopy(engine._config)
        candidate['runtime']['restorerBackendPreference'] = 'trt'
        self.assertTrue(engine._model_lifecycle_changed(engine._config, candidate))
        engine._model_configuration_in_use = lambda: True
        with self.assertRaisesRegex(RuntimeError, 'Stop active'):
            engine.update_config(candidate, persist=False)
        self.assertEqual(engine._config['runtime']['restorerBackendPreference'], 'legacy')
        candidate = deepcopy(engine._config)
        candidate['parameters'].update(RestorerSwitch=False, RestorerTypeTextSel='GPEN256')
        self.assertFalse(engine._model_lifecycle_changed(engine._config, candidate))

    def test_idle_backend_update_unloads_without_modifying_visual_values(self):
        engine, owner, _, _ = engine_fixture()
        engine.warm()
        visual = deepcopy(engine._config['parameters'])
        candidate = deepcopy(engine._config)
        candidate['runtime']['restorerBackendPreference'] = 'trt'
        engine.update_config(candidate, persist=False)
        self.assertIsNone(engine._models)
        self.assertEqual(owner.restorer_status(), {})
        self.assertEqual(engine._config['parameters'], visual)

    def test_unload_fence_failure_keeps_engine_stream_and_models_owned(self):
        engine, owner, _, _ = engine_fixture()
        engine.warm()
        stream = engine._compute_stream
        stream.fail_sync = True
        engine.unload()
        self.assertIs(engine._models, owner)
        self.assertIs(engine._compute_stream, stream)
        self.assertIn('teardown failed', engine._warm_error)

    def test_failed_backend_retirement_does_not_publish_or_persist_new_config(self):
        engine, owner, _, _ = engine_fixture()
        engine.warm()
        before = deepcopy(engine._config)
        candidate = deepcopy(before)
        candidate['runtime']['restorerBackendPreference'] = 'trt'
        engine._compute_stream.fail_sync = True
        with self.assertRaisesRegex(RuntimeError, 'retirement failed'):
            engine.update_config(candidate, persist=True)
        self.assertEqual(engine._config, before)
        self.assertEqual(engine._config_revision, 1)
        self.assertIs(engine._models, owner)

    def test_failed_warmup_fence_retains_private_ownership_until_safe_unload(self):
        engine, owner, _, ort = engine_fixture()
        ort.nonfinite = True
        with self.assertRaises(RuntimeError):
            engine.warm()
        stream = engine._warming_stream
        stream.fail_sync = True
        engine.unload()
        self.assertIs(engine._warming_models, owner)
        self.assertIs(engine._warming_stream, stream)
        stream.fail_sync = False
        engine.unload()
        self.assertIsNone(engine._warming_models)


if __name__ == '__main__':
    unittest.main()
