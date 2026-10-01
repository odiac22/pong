"""Standalone GPEN benchmark: generated tensors only, never production ENGINE.

Example (use the GPU venv's Python):
  python -I -B benchmark_gpen_generated.py --mode smoke --output-dir <report-dir>
  python -I -B benchmark_gpen_generated.py --mode full --output-dir <report-dir>

The default is CUDA-only arms B/C. TensorRT arms A/D are never selected unless
they are named with --arms and --enable-tensorrt-build is also supplied. Every
worker is launched by the coordinator's timeout/VRAM supervisor; the hidden
worker entry point rejects direct invocation.

A/B freeze the pre-patch Models.run_GPEN_256/512 headless Shared policies,
including the unconditional syncvec.cpu(), FP32 direct binding, CUDA option
helper, and session thread settings. Only cache paths move into benchmark-owned
storage. Inputs/output allocations and preprocessing are outside timed calls.
C/D exercise the unmodified GPENRuntime, plus same-session binding ablations.
Each arm/round is a fresh subprocess: sessions never compete for VRAM. Cold
construction/build and warm-up are separate from completed-call latency.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import csv
import ctypes
import hashlib
import importlib.util
import importlib.metadata
import json
import math
import os
from pathlib import Path
import statistics
import stat
import subprocess
import sys
import time
import uuid


ROOT = Path(__file__).resolve().parent
RUNTIME_SOURCE = ROOT / 'engine' / 'Rope' / 'rope' / 'gpen_runtime.py'
ARMS = ('A', 'B', 'C', 'D', 'E', 'F')
CUDA_ONLY_ARMS = ('B', 'C')
TENSORRT_ARMS = frozenset(('A', 'D'))
MAX_WORKER_TIMEOUT_SECONDS = 300.0
MAX_RUN_TIMEOUT_SECONDS = 1800.0
_DLL_HANDLES = []  # Retain registrations and loaded libraries for process lifetime.
SUPERVISOR_TOKEN_ENV = 'PONG_GGEN_BENCH_SUPERVISOR_TOKEN'
TENSORRT_OPT_IN_ENV = 'PONG_GGEN_BENCH_ALLOW_TENSORRT'
LABELS = {
    'A': 'prepatch GPEN256 TRT-first direct binding',
    'B': 'prepatch GPEN512 CUDA direct binding',
    'C': 'new GPEN512 CUDA runtime',
    'D': 'new GPEN512 TensorRT runtime',
    'E': 'new GPEN512 CUDA runtime with CUDA Graph replay',
    'F': 'new GPEN256 CUDA runtime diagnostic',
}
GATES = {'mae': 0.10, 'p99Abs': 1.0, 'maxAbs': 4.0,
         'psnrDb': 50.0, 'ssim': 0.999, 'temporalMae': 0.20}
PROFILES = {
    'smoke': {'rounds': 2, 'iterations': 8, 'warmup': 2, 'fixtureSteps': 2},
    'full': {'rounds': 8, 'iterations': 128, 'warmup': 20, 'fixtureSteps': 4},
}
KINDS = ('ramp', 'checker', 'bars', 'noise', 'impulse', 'constant')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False), encoding='utf-8')


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def percentile(values, percent):
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def summarize(values):
    if not values:
        return None
    mean = statistics.fmean(values)
    return {'count': len(values), 'meanMs': mean, 'p50Ms': percentile(values, 50),
            'p95Ms': percentile(values, 95), 'p99Ms': percentile(values, 99),
            'sequentialCallsPerSecond': 1000 / mean if mean > 0 else None}


def arm_order(round_index, arms=ARMS):
    arms = tuple(arms)
    if not arms:
        raise ValueError('At least one benchmark arm is required')
    shift = (round_index // 2) % len(arms)
    order = list(arms[shift:] + arms[:shift])
    return order if round_index % 2 == 0 else list(reversed(order))


def generated_fixture(np, kind, step, edge=512):
    """Integer-defined RGB; no random-state, files, face detector or model needed."""
    y, x = np.indices((edge, edge), dtype=np.uint32)
    c = np.arange(3, dtype=np.uint32)[:, None, None]
    if kind == 'ramp':
        values = (13 * x + 7 * y + 29 * c + 17 * step) % 256
    elif kind == 'checker':
        values = np.broadcast_to(((x // 8 + y // 8 + step) % 2) * 255, (3, edge, edge))
    elif kind == 'bars':
        values = ((x[None] // 32 + c + step) % 3) * 127
        values = np.broadcast_to(values, (3, edge, edge))
    elif kind == 'noise':
        values = x[None] + y[None] * np.uint32(edge) + c * np.uint32(edge * edge)
        values = values * np.uint32(1664525) + np.uint32(1013904223 + step * 101)
        values = (values ^ (values >> np.uint32(13))) & np.uint32(255)
    elif kind == 'impulse':
        values = np.zeros((3, edge, edge), dtype=np.uint32)
        values[:, (edge // 2 + step * 3) % edge, (edge // 2 + step * 5) % edge] = 255
        values[step % 3, 0, 0] = 255
    elif kind == 'constant':
        values = np.full((3, edge, edge), (step * 85) % 256, dtype=np.uint32)
    else:
        raise ValueError(kind)
    return np.ascontiguousarray(values, dtype=np.float32)[None] / np.float32(127.5) - np.float32(1)


def fixture_keys(steps):
    return [(kind, step) for kind in KINDS for step in range(steps)]


def gaussian_mean(np, values):
    # Standard local SSIM: 11x11 Gaussian, sigma=1.5, valid interior, RGB
    # channels evaluated separately. No image libraries or pretrained metrics.
    offsets = np.arange(-5, 6, dtype=np.float64)
    weights = np.exp(-(offsets * offsets) / (2 * 1.5 ** 2))
    weights /= weights.sum()
    windows = np.lib.stride_tricks.sliding_window_view(values, 11, axis=-1)
    horizontal = np.einsum('...k,k->...', windows, weights, optimize=False)
    windows = np.lib.stride_tricks.sliding_window_view(horizontal, 11, axis=-2)
    return np.einsum('...k,k->...', windows, weights, optimize=False)


def numerical_metrics(np, reference, candidate):
    if reference.shape != candidate.shape or not np.isfinite(candidate).all() or not np.isfinite(reference).all():
        return {'pass': False, 'error': 'shape mismatch or nonfinite output'}
    # Match existing clamp/denormalization. Compare unencoded floating RGB.
    ref = (np.clip(reference.astype(np.float64), -1, 1) + 1) * 127.5
    cand = (np.clip(candidate.astype(np.float64), -1, 1) + 1) * 127.5
    delta = np.abs(cand - ref)
    mse = float(np.mean((cand - ref) ** 2))
    mx, my = gaussian_mean(np, ref), gaussian_mean(np, cand)
    vx = np.maximum(0, gaussian_mean(np, ref * ref) - mx * mx)
    vy = np.maximum(0, gaussian_mean(np, cand * cand) - my * my)
    covariance = gaussian_mean(np, ref * cand) - mx * my
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ssim = float(np.mean(((2 * mx * my + c1) * (2 * covariance + c2)) /
                         ((mx * mx + my * my + c1) * (vx + vy + c2))))
    result = {'mae': float(delta.mean()), 'p99Abs': float(np.percentile(delta, 99)),
              'maxAbs': float(delta.max()), 'psnrDb': None if mse == 0 else 10 * math.log10(255 ** 2 / mse),
              'ssim': ssim, 'exactMatch': bool(mse == 0)}
    result['pass'] = (result['mae'] <= GATES['mae'] and result['p99Abs'] <= GATES['p99Abs']
                      and result['maxAbs'] <= GATES['maxAbs']
                      and (result['exactMatch'] or result['psnrDb'] >= GATES['psnrDb'])
                      and result['ssim'] >= GATES['ssim'])
    return result


def temporal_mae(np, ref_previous, ref_current, cand_previous, cand_current):
    arrays = [(np.clip(value.astype(np.float64), -1, 1) + 1) * 127.5
              for value in (ref_previous, ref_current, cand_previous, cand_current)]
    return float(np.abs((arrays[3] - arrays[2]) - (arrays[1] - arrays[0])).mean())


def query_gpu():
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    result = subprocess.run(
        ['nvidia-smi', '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu',
         '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=10, creationflags=flags,
    )
    result.check_returncode()
    rows = list(csv.reader(result.stdout.splitlines(), skipinitialspace=True))
    row = next(row for row in rows if int(row[0]) == 0)
    sample = {'index': 0, 'name': row[1], 'totalMiB': float(row[2]), 'usedMiB': float(row[3]),
              'freeMiB': float(row[4]), 'utilizationPercent': float(row[5])}
    if sample['name'] != 'NVIDIA GeForce RTX 4070':
        raise RuntimeError('This benchmark safety profile requires an RTX 4070 at GPU index 0')
    if (any(not math.isfinite(sample[key]) or sample[key] < 0 for key in
            ('totalMiB', 'usedMiB', 'freeMiB', 'utilizationPercent'))
            or sample['totalMiB'] <= 0 or sample['freeMiB'] > sample['totalMiB']
            or sample['usedMiB'] > sample['totalMiB'] or sample['utilizationPercent'] > 100):
        raise RuntimeError('GPU telemetry invalid')
    return sample


def process_gpu_memory(pid):
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        result.check_returncode()
        for row in csv.reader(result.stdout.splitlines(), skipinitialspace=True):
            if int(row[0]) == pid:
                try:
                    return float(row[1])
                except ValueError:
                    return None  # WDDM commonly reports N/A: never call this zero.
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def process_memory():
    if os.name == 'nt':
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('faults', wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ('peakRss', 'rss', 'peakPaged', 'paged',
                                                    'peakNonPaged', 'nonPaged', 'pagefile', 'peakPagefile')]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return {'rssMiB': counters.rss / 2 ** 20, 'peakRssMiB': counters.peakRss / 2 ** 20}
    else:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {'rssMiB': None, 'peakRssMiB': peak / (2 ** 20 if sys.platform == 'darwin' else 1024)}
    return {'rssMiB': None, 'peakRssMiB': None}


def safety_reason(samples, minimum_free_mib=8192):
    if not samples:
        return 'GPU telemetry unavailable'
    if any(not math.isfinite(sample[key]) or sample[key] < 0
           for sample in samples for key in ('freeMiB', 'utilizationPercent')):
        return 'GPU telemetry invalid'
    if min(sample['freeMiB'] for sample in samples) < minimum_free_mib:
        return f'Less than {minimum_free_mib:g} MiB free before benchmark'
    if max(sample['utilizationPercent'] for sample in samples) > 5:
        return 'GPU is busy; isolate the benchmark before retrying'
    return None


def load_runtime():
    spec = importlib.util.spec_from_file_location('generated_benchmark_gpen_runtime', RUNTIME_SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.GPENRuntime


def load_guard():
    spec = importlib.util.spec_from_file_location(
        'gpen_benchmark_guard', ROOT / 'gpen_benchmark_guard.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bootstrap_libraries(*, enable_tensorrt=False):
    # Equivalent Windows TRT search path, but retain DLL directory handles.
    # Never import rope/__init__, Models, service, config, or production ENGINE.
    handles = _DLL_HANDLES
    os.environ['ORT_LOG_SEVERITY_LEVEL'] = '3'
    if enable_tensorrt and os.name == 'nt':
        spec = importlib.util.find_spec('tensorrt_libs')
        if spec is not None:
            directories = ([str(Path(spec.origin).parent)] if spec.origin
                           else list(spec.submodule_search_locations or []))
            handles.extend(os.add_dll_directory(directory) for directory in directories)
            # ORT's TensorRT provider loads its plugin bridge after ORT itself
            # is already resident.  On Windows, merely extending the DLL search
            # path is not reliable for that delayed load.  Load the three public
            # TensorRT runtime DLLs explicitly and retain their handles for the
            # worker lifetime.  This is benchmark-local and touches no service.
            for directory in directories:
                root = Path(directory)
                for name in ('nvinfer_10.dll', 'nvinfer_plugin_10.dll', 'nvonnxparser_10.dll'):
                    candidate = root / name
                    if candidate.is_file():
                        handles.append(ctypes.WinDLL(str(candidate)))
    import numpy as np
    import torch
    import onnxruntime as ort
    ort.set_default_logger_severity(4)
    return np, torch, ort, handles


class Owner:
    """Only the pure GPEN dependencies; never constructs a production Models."""
    def __init__(self, torch, ort, models_dir, cache_dir, preference, *, enable_cuda_graph=False):
        self.torch, self.ort = torch, ort
        self.models_dir, self.cache_dir = models_dir, cache_dir
        self._backend_pref = {f'GPEN_{edge}_model': preference for edge in (256, 512)}
        self._model_session_mode = 'Shared'
        self._enable_cuda_graph = bool(enable_cuda_graph)
        self.syncvec = torch.empty((1, 1), dtype=torch.float32, device='cuda:0')
        self._shared_compute_stream = torch.cuda.Stream(device=0)

    def _mp(self, name):
        if name in ('GPEN-BFR-256.onnx', 'GPEN-BFR-512.onnx'):
            return str(self.models_dir / name)
        if name.startswith('ort_trt_cache_gpen') and '..' not in Path(name).parts:
            return str(self.cache_dir / name)
        raise ValueError('Benchmark may access only GPEN models and its own caches')

    def get_backend_preference(self, attr):
        return self._backend_pref.get(attr)

    def _cuda_ep_provider_options(self, search='EXHAUSTIVE'):
        options = {'arena_extend_strategy': 'kSameAsRequested', 'cudnn_conv_algo_search': search,
                   'user_compute_stream': str(int(self._shared_compute_stream.cuda_stream))}
        if self._enable_cuda_graph:
            options['enable_cuda_graph'] = '1'
        return options

    def _make_session_options(self):
        options = self.ort.SessionOptions()
        options.log_severity_level = 3
        options.execution_mode = self.ort.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = max(2, min(8, (os.cpu_count() or 4) // 2))
        return options


def legacy_trt_options(cache):
    # Frozen pre-patch GPEN256 options: deliberately NO TRT user_compute_stream.
    return {'trt_max_workspace_size': 3 << 30,
            'trt_engine_cache_enable': True, 'trt_engine_cache_path': str(cache),
            'trt_timing_cache_enable': True, 'trt_timing_cache_path': str(cache),
            'trt_fp16_enable': True, 'trt_builder_optimization_level': 5}


def legacy_session(owner, edge):
    fallback = None
    path = owner._mp(f'GPEN-BFR-{edge}.onnx')
    if edge == 512:
        # Frozen pre-patch BFR512: no SessionOptions, no CUDA options/stream.
        session = owner.ort.InferenceSession(path, providers=['CUDAExecutionProvider'])
    else:
        cache = Path(owner._mp('ort_trt_cache_gpen256')).resolve()
        try:
            cache.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        cuda = owner._cuda_ep_provider_options('EXHAUSTIVE')
        try:
            session = owner.ort.InferenceSession(path, sess_options=owner._make_session_options(), providers=[
                ('TensorrtExecutionProvider', legacy_trt_options(cache)), ('CUDAExecutionProvider', cuda)])
        except Exception as exc:
            fallback = f'{type(exc).__name__}: {exc}'
            session = owner.ort.InferenceSession(path, sess_options=owner._make_session_options(),
                                                providers=[('CUDAExecutionProvider', cuda)])
        if 'TensorrtExecutionProvider' not in session.get_providers() and fallback is None:
            fallback = 'TensorRT was not activated by ORT'
    return session, fallback


def binding(np, session, image, output):
    result = session.io_binding()
    result.bind_input(name='input', device_type='cuda', device_id=0, element_type=np.float32,
                      shape=tuple(image.shape), buffer_ptr=image.data_ptr())
    result.bind_output(name='output', device_type='cuda', device_id=0, element_type=np.float32,
                       shape=tuple(output.shape), buffer_ptr=output.data_ptr())
    return result


class TimedOrt:
    """Observe factory duration without changing the runtime implementation."""
    def __init__(self, ort, *, allow_tensorrt=False):
        self.ort = ort
        self.allow_tensorrt = allow_tensorrt
        self.creation_ms = []

    def __getattr__(self, name):
        return getattr(self.ort, name)

    def InferenceSession(self, *args, **kwargs):
        providers = [p[0] if isinstance(p, tuple) else p for p in kwargs.get('providers', [])]
        if not providers or ('TensorrtExecutionProvider' in providers and not self.allow_tensorrt):
            raise RuntimeError('Session factory rejected an implicit or unapproved TensorRT backend')
        started = time.perf_counter_ns()
        try:
            return self.ort.InferenceSession(*args, **kwargs)
        finally:
            self.creation_ms.append((time.perf_counter_ns() - started) / 1e6)


def completed_call(torch, operation):
    # A/B do not execute on the caller stream: same-stream CUDA events would
    # miss work. All arms use the same host timer + context completion boundary.
    torch.cuda.synchronize()
    started = time.perf_counter_ns()
    operation()
    submitted = time.perf_counter_ns()
    torch.cuda.synchronize()
    ended = time.perf_counter_ns()
    return {'completedMs': (ended - started) / 1e6, 'submittedMs': (submitted - started) / 1e6}


def worker(args):
    run_dir = args.work_dir / f'round-{args.round:02d}-{args.worker_arm}'
    run_dir.mkdir(parents=True, exist_ok=True)
    arm, profile = args.worker_arm, PROFILES[args.mode]
    if arm in TENSORRT_ARMS and not args.enable_tensorrt_build:
        raise RuntimeError('TensorRT benchmark arm requires --enable-tensorrt-build')
    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=arm in TENSORRT_ARMS)
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable; CPU benchmarking is not accepted')
    if os.environ.get('CUDA_VISIBLE_DEVICES') not in (None, '', '0'):
        raise RuntimeError('GPU remapping is unsupported: telemetry must match CUDA:0')
    torch.cuda.set_device(0)
    timed_ort = TimedOrt(ort, allow_tensorrt=arm in TENSORRT_ARMS and args.enable_tensorrt_build)
    owner = Owner(torch, timed_ort, args.models_dir, args.work_dir / 'cache' / arm,
                  'trt' if arm == 'D' else 'onnx', enable_cuda_graph=arm == 'E')
    edge = 256 if arm in ('A', 'F') else 512
    keys = fixture_keys(profile['fixtureSteps'])
    model_digest = sha256(args.models_dir / f'GPEN-BFR-{edge}.onnx')
    torch.cuda.reset_peak_memory_stats()
    runtime = None
    with torch.cuda.stream(owner._shared_compute_stream), torch.inference_mode():
        fixtures = []
        fixture_hashes = []
        for kind, step in keys:
            # A preserves the historical 512->256 pre-processing policy. F is
            # the fair native-input GPEN256 diagnostic requested by the paired
            # model comparison; all preparation remains outside timed calls.
            generated = generated_fixture(np, kind, step, edge=edge if arm == 'F' else 512)
            fixture_hashes.append(hashlib.sha256(generated.tobytes()).hexdigest())
            value = torch.from_numpy(generated).to(device='cuda:0')
            if edge == 256:
                value = torch.nn.functional.interpolate(value, size=(256, 256), mode='bilinear',
                                                        align_corners=False, antialias=False)
            fixtures.append(value.contiguous())
        image = torch.empty((1, 3, edge, edge), dtype=torch.float32, device='cuda:0')
        output = torch.empty_like(image)
        image.copy_(fixtures[0])
        torch.cuda.synchronize()
        cache = args.work_dir / 'cache' / arm
        cache_files_before = sum(1 for path in cache.rglob('*') if path.is_file()) if cache.exists() else 0
        print(f'{arm}: constructing session; cache files before={cache_files_before}', flush=True)
        started = time.perf_counter_ns()
        if arm in ('A', 'B'):
            session, fallback = legacy_session(owner, edge)
            metadata = {'requestedBackend': 'trt' if arm == 'A' else 'cuda',
                        'effectiveBackend': 'trt' if 'TensorrtExecutionProvider' in session.get_providers() else 'cuda',
                        'sessionProviders': list(session.get_providers()), 'fallbackReason': fallback,
                        'partitionPlacementVerified': False, 'ioDtype': 'float32'}
        else:
            runtime = load_runtime()(owner, torch, timed_ort, np.float32)
            runtime.prepare(edge)
            session = runtime._states[edge]['session']
            metadata = runtime.status()[str(edge)]
            metadata['cudaGraphRequested'] = arm == 'E'
        construction_ready_ms = (time.perf_counter_ns() - started) / 1e6
        if 'CUDAExecutionProvider' not in session.get_providers():
            raise RuntimeError('No CUDA provider; refuse misleading CPU result')

        def per_call_direct():
            io = binding(np, session, image, output)
            owner.syncvec.cpu()
            session.run_with_iobinding(io)

        fixed_binding = binding(np, session, image, output)
        def persistent_direct():
            owner.syncvec.cpu()
            session.run_with_iobinding(fixed_binding)

        operations = {'primary': per_call_direct}
        if runtime is not None:
            state = runtime._states[edge]
            def persistent_copy():
                state['input'].copy_(image)
                owner.syncvec.cpu()
                session.run_with_iobinding(state['binding'])
                output.copy_(state['output'])
            operations = {'primary': lambda: runtime.run(edge, image, output)}
            # CUDA Graph replay is address-stable by contract. Never invoke the
            # same captured session with the benchmark's alternate bindings.
            if arm != 'E':
                operations.update(per_call_direct=per_call_direct,
                                  persistent_direct=persistent_direct,
                                  persistent_copy=persistent_copy)
        first_call = completed_call(torch, operations['primary'])
        warm_started = time.perf_counter_ns()
        for operation in operations.values():
            for _ in range(profile['warmup']):
                completed_call(torch, operation)
        warm_ms = (time.perf_counter_ns() - warm_started) / 1e6
        print(f'{arm}: warm; collecting {profile["iterations"]} calls/variant', flush=True)
        samples = []
        variants = list(operations)
        for iteration in range(profile['iterations']):
            fixture_index = (iteration + args.round * profile['iterations']) % len(fixtures)
            image.copy_(fixtures[fixture_index])
            order = variants[iteration % len(variants):] + variants[:iteration % len(variants)]
            for variant in order:
                timing = completed_call(torch, operations[variant])
                samples.append({'iteration': iteration, 'fixture': fixture_index, 'variant': variant, **timing})
        # Quality and CPU downloads are entirely outside the measured interval.
        quality_outputs = []
        ablations_exact = True
        output_hashes = []
        for fixture in fixtures:
            image.copy_(fixture)
            output.fill_(float('nan'))
            if runtime is not None:
                state['output'].fill_(float('nan'))
            completed_call(torch, operations['primary'])
            primary = output.cpu().numpy().copy()
            if not np.isfinite(primary).all():
                raise RuntimeError('Nonfinite generated-fixture output')
            output_hashes.append(hashlib.sha256(primary.tobytes()).hexdigest())
            if edge == 512:
                quality_outputs.append(primary[0])
            for variant in variants[1:]:
                output.fill_(float('nan'))
                if variant == 'persistent_copy':
                    state['output'].fill_(float('nan'))
                completed_call(torch, operations[variant])
                ablations_exact = ablations_exact and bool(np.array_equal(primary, output.cpu().numpy()))
        if quality_outputs:
            np.save(run_dir / 'generated-output.npy', np.stack(quality_outputs), allow_pickle=False)
        memory = process_memory()
        memory.update(torchPeakAllocatedMiB=torch.cuda.max_memory_allocated() / 2 ** 20,
                      torchPeakReservedMiB=torch.cuda.max_memory_reserved() / 2 ** 20,
                      processGpuMiB=process_gpu_memory(os.getpid()))
        result = {
            'arm': arm, 'label': LABELS[arm], 'round': args.round,
            'policy': 'prepatch-headless-Shared' if arm in ('A', 'B') else 'current-GPENRuntime',
            'modelSha256': model_digest, 'runtimeSourceSha256': sha256(RUNTIME_SOURCE),
            'fixtureKeys': keys, 'fixtureSha256': fixture_hashes,
            'outputSha256': output_hashes,
            'distinctFixtureOutputs': len(set(output_hashes)),
            'sdk': {'python': sys.version, 'torch': torch.__version__, 'cuda': torch.version.cuda,
                    'onnxruntime': ort.__version__, 'numpy': np.__version__,
                    'tensorrt': importlib.metadata.version('tensorrt') if arm in TENSORRT_ARMS else None},
            'cold': {'cacheFilesBefore': cache_files_before,
                     'sessionCreationAttemptsMs': timed_ort.creation_ms,
                     'sessionCreationTotalMs': sum(timed_ort.creation_ms),
                     'constructionAndRuntimePrepareMs': construction_ready_ms,
                     'runtimeIncludesGeneratedWarmup': runtime is not None,
                     'firstCallerInvocationMs': first_call['completedMs'], 'additionalWarmupMs': warm_ms},
            'provider': metadata, 'effectiveProviderOptions': session.get_provider_options(),
            'samples': samples, 'memory': memory, 'bindingAblationsBitExact': ablations_exact,
        }
        write_json(run_dir / 'result.json', result)
        if runtime is not None:
            runtime.clear()
        torch.cuda.synchronize()
    print(f'{arm}: complete', flush=True)
    return 0


def paired_ablation(results, arm):
    pairs = []
    details = defaultdict(list)
    for result in results:
        if result['arm'] != arm:
            continue
        iterations = defaultdict(dict)
        for sample in result['samples']:
            iterations[sample['iteration']][sample['variant']] = sample['completedMs']
        for row in iterations.values():
            pairs.append(row['primary'] - row['per_call_direct'])
            details['twoDeviceCopiesMs'].append(row['persistent_copy'] - row['persistent_direct'])
            details['bindingCreationMs'].append(row['per_call_direct'] - row['persistent_direct'])
            details['runtimeWrapperMs'].append(row['primary'] - row['persistent_copy'])
    if not pairs:
        return None
    delta = statistics.fmean(pairs)
    return {'runtimeMinusPerCallDirectMeanMs': delta,
            'measuredFaster': delta < 0,
            'decision': 'persistent runtime slower in this sample; do not retain on speed grounds'
                        if delta > 0 else 'sample favors persistent runtime; confirm in full run',
            'isolatedMeanDeltasMs': {key: statistics.fmean(value) for key, value in details.items()},
            'note': 'Same session and paired fixture/iteration; deltas include timing noise.'}


def aggregate(np, work_dir, results, mode):
    summary = {}
    for arm in ARMS:
        rows = [result for result in results if result['arm'] == arm]
        timings = defaultdict(list)
        for row in rows:
            for sample in row['samples']:
                timings[sample['variant']].append(sample['completedMs'])
        summary[arm] = {'label': LABELS[arm], 'variants': {key: summarize(value) for key, value in timings.items()},
                        'coldPerRound': [row['cold'] for row in rows],
                        'providerPerRound': [row['provider'] for row in rows],
                        'memoryPerRound': [row['memory'] for row in rows],
                        'bindingAblationsBitExact': bool(rows) and all(row['bindingAblationsBitExact'] for row in rows),
                        'bindingAblation': paired_ablation(rows, arm) if arm in ('C', 'D') else None}
    quality = {}
    for arm in ('C', 'D', 'E'):
        comparisons = []
        errors = []
        candidates = [result for result in results if result['arm'] == arm]
        if sorted(row['round'] for row in candidates) != list(range(PROFILES[mode]['rounds'])):
            errors.append('Missing or duplicate candidate rounds')
        for row in candidates:
            reference_arm = 'C' if arm == 'E' else 'B'
            references = [r for r in results if r['arm'] == reference_arm and r['round'] == row['round']]
            if len(references) != 1 or any(row[key] != references[0][key] for key in
                    ('modelSha256', 'fixtureKeys', 'fixtureSha256')):
                errors.append(f'Round {row["round"]}: reference identity mismatch or missing')
                continue
            reference_path = work_dir / f'round-{row["round"]:02d}-{reference_arm}' / 'generated-output.npy'
            candidate_path = work_dir / f'round-{row["round"]:02d}-{arm}' / 'generated-output.npy'
            if not reference_path.is_file() or not candidate_path.is_file():
                errors.append(f'Round {row["round"]}: generated output missing')
                continue
            reference = np.load(reference_path, mmap_mode='r', allow_pickle=False)
            candidate = np.load(candidate_path, mmap_mode='r', allow_pickle=False)
            expected_shape = (len(fixture_keys(PROFILES[mode]['fixtureSteps'])), 3, 512, 512)
            if (reference.shape != expected_shape or candidate.shape != expected_shape
                    or not np.isfinite(reference).all() or not np.isfinite(candidate).all()):
                errors.append(f'Round {row["round"]}: invalid shape or nonfinite generated output')
                continue
            for index, (kind, step) in enumerate(row['fixtureKeys']):
                metrics = numerical_metrics(np, reference[index], candidate[index])
                if step > 0:
                    temporal = temporal_mae(np, reference[index - 1], reference[index],
                                             candidate[index - 1], candidate[index])
                    metrics['temporalMae'] = temporal
                    metrics['pass'] = metrics['pass'] and temporal <= GATES['temporalMae']
                comparisons.append({'round': row['round'], 'kind': kind, 'step': step, **metrics})
        quality[arm] = {'reference': 'C' if arm == 'E' else 'B',
                        'scope': 'native restored floating RGB only; no compositing',
                        'pass': not errors and bool(comparisons) and all(row['pass'] for row in comparisons)
                                and summary[arm]['bindingAblationsBitExact'],
                        'errors': errors,
                        'comparisons': comparisons}
    latency = {}
    baseline = summary['A']['variants'].get('primary')
    for arm in ('C', 'D'):
        candidate = summary[arm]['variants'].get('primary')
        if not baseline or not candidate:
            latency[arm] = {'status': 'incomplete'}
            continue
        ratios = {key: candidate[key] / baseline[key] for key in ('meanMs', 'p50Ms', 'p95Ms', 'p99Ms')}
        round_ratios = []
        for index in range(PROFILES[mode]['rounds']):
            a = [s['completedMs'] for r in results if r['arm'] == 'A' and r['round'] == index
                 for s in r['samples'] if s['variant'] == 'primary']
            b = [s['completedMs'] for r in results if r['arm'] == arm and r['round'] == index
                 for s in r['samples'] if s['variant'] == 'primary']
            if a and b:
                round_ratios.append(statistics.fmean(b) / statistics.fmean(a))
        rng = np.random.default_rng(20260918)
        upper = None
        if len(round_ratios) >= 4:
            bootstrap = rng.choice(round_ratios, size=(4000, len(round_ratios)), replace=True).mean(axis=1)
            upper = float(np.percentile(bootstrap, 95))
        enough = mode == 'full' and candidate['count'] >= 1000 and len(round_ratios) == PROFILES[mode]['rounds']
        passes = enough and ratios['p50Ms'] <= 1 and ratios['p95Ms'] <= 1 and upper is not None and upper <= 1
        latency[arm] = {'reference': 'A', 'ratios': ratios, 'pairedRoundMeanRatioUpper95': upper,
                        'status': 'pass' if passes else ('fail' if enough else 'insufficient samples; smoke only')}
    graph_gate = {'status': 'incomplete'}
    baseline_graph = summary['C']['variants'].get('primary')
    candidate_graph = summary['E']['variants'].get('primary')
    if baseline_graph and candidate_graph:
        round_improvements = []
        for index in range(PROFILES[mode]['rounds']):
            baseline_rows = [s['completedMs'] for r in results if r['arm'] == 'C' and r['round'] == index
                             for s in r['samples'] if s['variant'] == 'primary']
            candidate_rows = [s['completedMs'] for r in results if r['arm'] == 'E' and r['round'] == index
                              for s in r['samples'] if s['variant'] == 'primary']
            if baseline_rows and candidate_rows:
                baseline_mean = statistics.fmean(baseline_rows)
                round_improvements.append((baseline_mean - statistics.fmean(candidate_rows)) / baseline_mean)
        interval = None
        if len(round_improvements) == PROFILES[mode]['rounds']:
            rng = np.random.default_rng(20260918)
            bootstrap = rng.choice(round_improvements, size=(4000, len(round_improvements)), replace=True).mean(axis=1)
            interval = {'lower95': float(np.percentile(bootstrap, 2.5)),
                        'upper95': float(np.percentile(bootstrap, 97.5))}
        mean_improvement = (baseline_graph['meanMs'] - candidate_graph['meanMs']) / baseline_graph['meanMs']
        enough = mode == 'full' and candidate_graph['count'] >= 1000 and interval is not None
        passes = (enough and mean_improvement >= 0.02 and interval['lower95'] > 0
                  and candidate_graph['p95Ms'] <= baseline_graph['p95Ms']
                  and candidate_graph['p99Ms'] <= baseline_graph['p99Ms']
                  and quality['E']['pass'])
        graph_gate = {
            'status': 'pass' if passes else ('fail' if enough else 'insufficient samples; smoke only'),
            'reference': 'C', 'candidate': 'E', 'requiredMeanImprovement': 0.02,
            'meanImprovement': mean_improvement, 'pairedRoundImprovement95': interval,
            'noP95Regression': candidate_graph['p95Ms'] <= baseline_graph['p95Ms'],
            'noP99Regression': candidate_graph['p99Ms'] <= baseline_graph['p99Ms'],
            'bitExactQualityPass': quality['E']['pass'],
        }
    size_comparison = {'status': 'incomplete'}
    gpen256 = summary['F']['variants'].get('primary')
    gpen512 = summary['C']['variants'].get('primary')
    if gpen256 and gpen512:
        paired_ratios = []
        for index in range(PROFILES[mode]['rounds']):
            rows256 = [s['completedMs'] for r in results if r['arm'] == 'F' and r['round'] == index
                       for s in r['samples'] if s['variant'] == 'primary']
            rows512 = [s['completedMs'] for r in results if r['arm'] == 'C' and r['round'] == index
                       for s in r['samples'] if s['variant'] == 'primary']
            if rows256 and rows512:
                paired_ratios.append(statistics.fmean(rows512) / statistics.fmean(rows256))
        interval = None
        if len(paired_ratios) == PROFILES[mode]['rounds']:
            rng = np.random.default_rng(20260918)
            bootstrap = rng.choice(paired_ratios, size=(4000, len(paired_ratios)), replace=True).mean(axis=1)
            interval = {'lower95': float(np.percentile(bootstrap, 2.5)),
                        'upper95': float(np.percentile(bootstrap, 97.5))}
        size_comparison = {
            'status': 'measured' if mode == 'full' and gpen256['count'] >= 1000 and interval else 'smoke only',
            'scope': 'model-and-native-resolution comparison; not resolution alone',
            'gpen256Arm': 'F', 'gpen512Arm': 'C',
            'meanAbsoluteDifferenceMs': gpen512['meanMs'] - gpen256['meanMs'],
            'meanLatencyRatio512To256': gpen512['meanMs'] / gpen256['meanMs'],
            'pairedRoundMeanRatio95': interval,
            'gpen256': gpen256, 'gpen512': gpen512,
        }
    return {'arms': summary, 'quality': quality, 'latencyGate': latency,
            'cudaGraphGate': graph_gate, 'gpenSizeComparison': size_comparison}


def coordinator(args):
    profile = PROFILES[args.mode]
    selected_arms = tuple(args.arms)
    if not selected_arms:
        raise ValueError('At least one benchmark arm is required')
    if len(set(selected_arms)) != len(selected_arms):
        raise ValueError('Benchmark arms must be unique')
    requested_trt_arms = [arm for arm in selected_arms if arm in TENSORRT_ARMS]
    if requested_trt_arms and not args.enable_tensorrt_build:
        raise ValueError(
            'TensorRT arms ' + ', '.join(requested_trt_arms)
            + ' require the explicit --enable-tensorrt-build opt-in'
        )
    if (not math.isfinite(args.worker_timeout) or args.worker_timeout <= 0
            or args.worker_timeout > MAX_WORKER_TIMEOUT_SECONDS):
        raise ValueError(
            f'--worker-timeout must be greater than zero and no more than '
            f'{MAX_WORKER_TIMEOUT_SECONDS:g} seconds'
        )
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise ValueError('Use a new/empty output directory; reports are never overwritten')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.output_dir / 'report.json'
    report = {'mode': args.mode, 'profile': profile, 'gates': GATES, 'status': 'preflight',
              'limitations': ['Generated tensors cannot prove perceptual face quality.',
                              'Completed-call latency excludes preprocessing, compositing and video transport.',
                              'Provider registration does not prove node placement or realized FP16 precision.',
                              'Device memory peaks are sampled; Torch allocator excludes ORT/TRT allocations.',
                              'Per-process GPU memory is null when WDDM does not expose it.'],
              'selectedArms': list(selected_arms),
              'tensorRtBuildOptIn': bool(args.enable_tensorrt_build),
              'workerTimeoutSeconds': args.worker_timeout, 'runTimeoutSeconds': args.run_timeout,
              'containment': 'Windows kill-on-close Job Object; release over stdin after assignment',
              'order': [arm_order(index, selected_arms) for index in range(profile['rounds'])], 'workers': [],
              'benchmarkWorkDirectory': str(args.work_dir),
              'command': [sys.executable, *sys.orig_argv[1:]],
              'harnessSourceSha256': sha256(Path(__file__).resolve())}
    write_json(report_path, report)  # Survives hard exit 124 as an incomplete report.
    try:
        if os.environ.get('CUDA_VISIBLE_DEVICES') not in (None, '', '0'):
            raise RuntimeError('GPU remapping is unsupported: telemetry must match CUDA:0')
        samples = []
        for _ in range(3):
            samples.append(query_gpu())
            time.sleep(0.25)
        report['preflight'] = samples
        reason = safety_reason(samples)
        if reason:
            report.update(status='blocked', reason=reason)
            write_json(report_path, report)
            print(reason, flush=True)
            return 2
        required_models = set()
        if 'A' in selected_arms:
            required_models.add('GPEN-BFR-256.onnx')
        if any(arm in selected_arms for arm in ('B', 'C', 'D', 'E')):
            required_models.add('GPEN-BFR-512.onnx')
        if 'F' in selected_arms:
            required_models.add('GPEN-BFR-256.onnx')
        for filename in sorted(required_models):
            if not (args.models_dir / filename).is_file():
                raise FileNotFoundError(f'Required GPEN model missing: {filename}')
        if args.work_dir.exists() and any(args.work_dir.iterdir()):
            raise ValueError('Use an empty/new benchmark work directory; existing files are never reused')
        args.work_dir.mkdir(parents=True, exist_ok=True)
        minimum_headroom = max(2048, samples[-1]['totalMiB'] * 0.20)
        report['minimumFreeMiBWhileRunning'] = minimum_headroom
        report['runtimeSourceSha256'] = sha256(RUNTIME_SOURCE)
        report['guardSourceSha256'] = sha256(ROOT / 'gpen_benchmark_guard.py')
        results = []
        for round_index in range(profile['rounds']):
            for arm in arm_order(round_index, selected_arms):
                if (sha256(RUNTIME_SOURCE) != report['runtimeSourceSha256']
                        or sha256(Path(__file__).resolve()) != report['harnessSourceSha256']
                        or sha256(ROOT / 'gpen_benchmark_guard.py') != report['guardSourceSha256']):
                    raise RuntimeError('Benchmark source changed during execution')
                # Give the previous CUDA context a bounded interval to retire.
                latest = query_gpu()
                for _ in range(8):
                    if safety_reason([latest]) is None:
                        break
                    time.sleep(0.5)
                    latest = query_gpu()
                reason = safety_reason([latest])
                if reason:
                    raise RuntimeError(reason)
                run_dir = args.work_dir / f'round-{round_index:02d}-{arm}'
                run_dir.mkdir(parents=True, exist_ok=True)
                supervisor_token = uuid.uuid4().hex
                command = [sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--mode', args.mode,
                           '--worker-arm', arm, '--round', str(round_index), '--models-dir', str(args.models_dir),
                           '--work-dir', str(args.work_dir), '--output-dir', str(args.output_dir),
                           '--worker-timeout', str(args.worker_timeout),
                           '--run-timeout', str(args.run_timeout), '--arms', arm,
                           '--supervisor-token', supervisor_token]
                if args.enable_tensorrt_build:
                    command.append('--enable-tensorrt-build')
                print(f'Round {round_index + 1}/{profile["rounds"]}: {arm} {LABELS[arm]}', flush=True)
                worker_record = {'arm': arm, 'round': round_index, 'status': 'running',
                                 'log': str(run_dir / 'worker.log')}
                report['workers'].append(worker_record)
                report['status'] = 'running'
                write_json(report_path, report)
                with (run_dir / 'worker.log').open('w', encoding='utf-8') as log:
                    child_env = os.environ.copy()
                    child_env[SUPERVISOR_TOKEN_ENV] = supervisor_token
                    child_env[TENSORRT_OPT_IN_ENV] = '1' if args.enable_tensorrt_build else '0'
                    try:
                        worker_record.update(load_guard().run_guarded_child(
                            command, log=log, environment=child_env, token=supervisor_token,
                            timeout=args.worker_timeout, minimum_free_mib=minimum_headroom,
                            query_gpu=query_gpu))
                        worker_record['status'] = 'exited'
                    except BaseException as exc:
                        worker_record.update(status='aborted', reason=f'{type(exc).__name__}: {exc}')
                        raise
                if worker_record['exitCode']:
                    raise RuntimeError(f'Worker {arm} failed; inspect benchmark-owned {run_dir / "worker.log"}')
                result = json.loads((run_dir / 'result.json').read_text(encoding='utf-8'))
                results.append(result)
                worker_record.update(provider=result['provider'], cold=result['cold'], memory=result['memory'],
                                     primary=summarize([s['completedMs'] for s in result['samples']
                                                        if s['variant'] == 'primary']))
                print(f'  completed; backend={result["provider"]["effectiveBackend"]}; '
                      f'cold session={result["cold"]["sessionCreationTotalMs"]:.1f} ms', flush=True)
                write_json(report_path, report)
        import numpy as np
        report.update(aggregate(np, args.work_dir, results, args.mode))
        report['status'] = 'complete'
        trt_results = [r for r in results if r['arm'] in TENSORRT_ARMS]
        report['requestedTrtActivated'] = bool(trt_results) and all(
            r['provider']['effectiveBackend'] == 'trt' for r in trt_results)
        report['benchmarkWorkDirectory'] = str(args.work_dir)
        report['sdk'] = results[0]['sdk']
        report['modelSha256'] = {r['arm']: r['modelSha256'] for r in results}
        report['candidateGate'] = {
            arm: ('pass' if args.mode == 'full' and report['quality'][arm]['pass']
                  and report['latencyGate'][arm]['status'] == 'pass'
                  and all(r['provider']['effectiveBackend'] == ('trt' if arm == 'D' else 'cuda')
                          and not r['provider']['fallbackReason'] for r in results if r['arm'] == arm)
                  else 'not established' if args.mode == 'smoke' else 'fail') for arm in ('C', 'D')}
        report['candidateGate']['E'] = report['cudaGraphGate']['status']
        print(f'Report: {report_path}', flush=True)
        return 0
    except (Exception, KeyboardInterrupt) as exc:
        report.update(status='aborted', reason=f'{type(exc).__name__}: {exc}')
        print(report['reason'], flush=True)
        return 2
    finally:
        write_json(report_path, report)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--mode', choices=PROFILES, default='smoke')
    result.add_argument('--models-dir', type=Path, default=ROOT / 'runtime' / 'models')
    result.add_argument('--output-dir', type=Path, required=True)
    result.add_argument('--work-dir', type=Path)
    result.add_argument('--arms', nargs='+', choices=ARMS, default=list(CUDA_ONLY_ARMS),
                        help='benchmark arms; defaults to CUDA-only B C')
    result.add_argument('--enable-tensorrt-build', action='store_true',
                        help='explicitly allow TensorRT arms A/D; still subject to safety limits')
    result.add_argument('--worker-timeout', type=float, default=120.0,
                        help=f'hard per-worker limit in seconds (maximum {MAX_WORKER_TIMEOUT_SECONDS:g})')
    result.add_argument('--run-timeout', type=float, default=300.0,
                        help='hard total limit, including telemetry and metrics (maximum 1800 seconds)')
    result.add_argument('--worker-arm', choices=ARMS, help=argparse.SUPPRESS)
    result.add_argument('--round', type=int, default=0, help=argparse.SUPPRESS)
    result.add_argument('--supervisor-token', help=argparse.SUPPRESS)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    guard = load_guard()
    guard.bounded_seconds(args.run_timeout, MAX_RUN_TIMEOUT_SECONDS)
    if (not math.isfinite(args.worker_timeout) or not 0 < args.worker_timeout <= MAX_WORKER_TIMEOUT_SECONDS):
        raise ValueError('--worker-timeout must be positive and no more than 300 seconds')
    args.models_dir = args.models_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.work_dir = (args.work_dir or ROOT / 'work' / f'gpen-generated-{uuid.uuid4().hex[:12]}').resolve()
    if args.worker_arm:
        expected_token = os.environ.pop(SUPERVISOR_TOKEN_ENV, None)
        if not expected_token or not args.supervisor_token or args.supervisor_token != expected_token:
            raise RuntimeError('Benchmark workers may run only under the safety supervisor')
        if args.worker_arm in TENSORRT_ARMS:
            if (not args.enable_tensorrt_build
                    or os.environ.pop(TENSORRT_OPT_IN_ENV, '0') != '1'):
                raise RuntimeError('TensorRT worker lacks explicit supervised build opt-in')
        if not stat.S_ISFIFO(os.fstat(sys.stdin.fileno()).st_mode):
            raise RuntimeError('Benchmark worker requires a supervisor pipe')
        if sys.stdin.readline(128).strip() != expected_token:
            raise RuntimeError('Supervisor did not release contained worker')
        return worker(args)
    with guard.HardDeadline(args.run_timeout):
        return coordinator(args)


if __name__ == '__main__':
    raise SystemExit(main())
