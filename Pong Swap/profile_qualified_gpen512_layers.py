"""Offline layer attribution for the immutable, qualified GPEN512 TRT plan.

This is a synthetic-input microbenchmark, not a playback/quality qualification.
It never builds an engine, changes a preset, or imports the production service.
Run only after the live renderer is idle or stopped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
PLAN = ROOT / 'runtime/models/ort_trt_cache_gpen512/native-fp32-tf32-v1/gpen512-f5b1b141086ab85ba280.plan'
EXPECTED_SHA256 = 'b8c4ac5cd6e87b8bea24881b6204da953a95914ceb2092be73bb07b550906dd9'
EXPECTED_MODEL_SHA256 = '0960f836488735444d508b588e44fb5dfd19c68fde9163ad7878aa24d1d5115e'


def verify_plan() -> tuple[bytes, dict]:
    manifest = json.loads(Path(str(PLAN) + '.manifest.json').read_text(encoding='utf-8'))
    plan_bytes = PLAN.read_bytes()
    actual = hashlib.sha256(plan_bytes).hexdigest()
    expected = {
        'schema': 'pong-gpen-qualified-plan-v2',
        'qualificationStatus': 'pass',
        'planSha256': EXPECTED_SHA256,
        'modelSha256': EXPECTED_MODEL_SHA256,
        'edge': 512,
        'fp16': False,
        'int8': False,
        'tf32': True,
        'precisionPolicy': 'fp32-builder-default-v1',
    }
    errors = [f'{key}: {manifest.get(key)!r} != {value!r}'
              for key, value in expected.items() if manifest.get(key) != value]
    if actual != EXPECTED_SHA256:
        errors.append(f'plan SHA256 {actual} != {EXPECTED_SHA256}')
    if errors:
        raise RuntimeError('Qualified GPEN512 plan mismatch: ' + '; '.join(errors))
    return plan_bytes, manifest


def check_idle(base_url: str) -> str:
    """Fail closed if a reachable Pong service has any active sessions."""
    try:
        with urlopen(base_url.rstrip('/') + '/sessions', timeout=2) as response:
            payload = json.load(response)
    except (URLError, HTTPError, TimeoutError, OSError) as exc:
        # The intended offline case is a stopped renderer. A reachable service
        # with an unexpected response must not be mistaken for a stopped one.
        if isinstance(exc, HTTPError):
            raise RuntimeError(f'Pong idle check failed: HTTP {exc.code}') from exc
        return f'unreachable ({type(exc).__name__})'
    sessions = payload.get('sessions')
    if not isinstance(sessions, list):
        raise RuntimeError('Pong idle check returned no session list')
    if sessions:
        raise RuntimeError(f'Pong has {len(sessions)} sessions; stop before GPU profiling')
    return 'reachable, zero sessions'


def percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    x = (len(ordered) - 1) * percent / 100.0
    lo, hi = math.floor(x), math.ceil(x)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (x - lo)


def run(plan_bytes: bytes, manifest: dict, *, warmup: int, iterations: int,
        idle_check: str) -> dict:
    sys.path.insert(0, str(ROOT / 'engine' / 'Rope'))
    from rope import _native_dlls  # noqa: F401 -- registers Windows DLL paths
    import torch
    import tensorrt as trt

    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable')
    if torch.cuda.get_device_name(0) != manifest['gpu']:
        raise RuntimeError('Current GPU does not match the qualified plan')
    if list(torch.cuda.get_device_capability(0)) != manifest['capability']:
        raise RuntimeError('Current SM capability does not match the qualified plan')
    if str(trt.__version__) != manifest['tensorrt']:
        raise RuntimeError('TensorRT version does not match the qualified plan')
    if str(torch.version.cuda) != manifest['cuda']:
        raise RuntimeError('CUDA version does not match the qualified plan')

    class LayerProfiler(trt.IProfiler):
        def __init__(self):
            super().__init__()
            self.rows: dict[str, list[float]] = {}

        def report_layer_time(self, name, ms):
            self.rows.setdefault(str(name), []).append(float(ms))

    logger = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(plan_bytes)
    if engine is None:
        raise RuntimeError('TensorRT did not deserialize the qualified plan')
    context = engine.create_execution_context()
    if context is None:
        raise RuntimeError('TensorRT did not create an execution context')
    expected_io = {'input': trt.TensorIOMode.INPUT, 'output': trt.TensorIOMode.OUTPUT}
    actual_io = {engine.get_tensor_name(i): engine.get_tensor_mode(engine.get_tensor_name(i))
                 for i in range(engine.num_io_tensors)}
    if actual_io != expected_io:
        raise RuntimeError(f'Unexpected GPEN512 I/O names/modes: {actual_io}')
    for name in expected_io:
        if tuple(engine.get_tensor_shape(name)) != (1, 3, 512, 512):
            raise RuntimeError(f'Unexpected GPEN512 {name} shape')
        if engine.get_tensor_dtype(name) != trt.float32:
            raise RuntimeError(f'Unexpected GPEN512 {name} dtype')

    stream = torch.cuda.Stream(device=0)
    baseline_elapsed: list[float] = []
    profiled_elapsed: list[float] = []
    profiler = LayerProfiler()
    with torch.cuda.stream(stream):
        # Deterministic synthetic pixels in the input's documented [-1, 1]
        # normalization range. Nothing personal or downloaded is read.
        x = torch.linspace(-1.0, 1.0, 3 * 512 * 512,
                           dtype=torch.float32, device='cuda:0').reshape(1, 3, 512, 512)
        y = torch.empty_like(x)
        if not context.set_tensor_address('input', x.data_ptr()):
            raise RuntimeError('TensorRT rejected input address')
        if not context.set_tensor_address('output', y.data_ptr()):
            raise RuntimeError('TensorRT rejected output address')
        for _ in range(warmup):
            if not context.execute_async_v3(int(stream.cuda_stream)):
                raise RuntimeError('TensorRT warmup submission failed')
        stream.synchronize()
        for _ in range(iterations):
            start = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            start.record(stream)
            if not context.execute_async_v3(int(stream.cuda_stream)):
                raise RuntimeError('TensorRT baseline submission failed')
            end.record(stream)
            end.synchronize()
            baseline_elapsed.append(float(start.elapsed_time(end)))
        context.profiler = profiler
        if hasattr(context, 'enqueue_emits_profile'):
            context.enqueue_emits_profile = True
        for _ in range(iterations):
            start = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            start.record(stream)
            if not context.execute_async_v3(int(stream.cuda_stream)):
                raise RuntimeError('TensorRT profiling submission failed')
            end.record(stream)
            end.synchronize()
            profiled_elapsed.append(float(start.elapsed_time(end)))
    if not profiler.rows:
        raise RuntimeError('TensorRT emitted no layer timing callbacks')
    layers = sorted(({
        'name': name,
        'callbacks': len(values),
        'meanMs': statistics.fmean(values),
        'medianMs': statistics.median(values),
        'p95Ms': percentile(values, 95),
    } for name, values in profiler.rows.items()),
        key=lambda row: row['medianMs'], reverse=True)
    return {
        'scope': 'synthetic GPEN512 eager TRT layer microbenchmark; not video throughput or quality proof',
        'planSha256': EXPECTED_SHA256,
        'modelSha256': EXPECTED_MODEL_SHA256,
        'idleCheck': idle_check,
        'warmup': warmup,
        'baselineIterations': iterations,
        'profiledIterations': iterations,
        'input': 'deterministic normalized FP32 [-1,1], [1,3,512,512]',
        'baselineInferenceMs': {
            'mean': statistics.fmean(baseline_elapsed),
            'median': statistics.median(baseline_elapsed),
            'p95': percentile(baseline_elapsed, 95),
        },
        'profiledInferenceMs': {
            'mean': statistics.fmean(profiled_elapsed),
            'median': statistics.median(profiled_elapsed),
            'p95': percentile(profiled_elapsed, 95),
        },
        'layerMedianSumMs': sum(row['medianMs'] for row in layers),
        'layerMedianSumCaveat': 'Per-layer callback times may overlap; not a playback latency sum.',
        'layers': layers,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New JSON report; never overwritten')
    parser.add_argument('--idle-url', default='http://127.0.0.1:8792')
    parser.add_argument('--warmup', type=int, default=10)
    parser.add_argument('--iterations', type=int, default=20)
    parser.add_argument('--verify-only', action='store_true', help='CPU-only plan and manifest check')
    args = parser.parse_args(argv)
    if args.output.exists():
        raise FileExistsError(args.output)
    if args.warmup < 1 or args.iterations < 1 or args.warmup > 50 or args.iterations > 50:
        raise ValueError('Warmup/iterations must be in 1..50')
    plan_bytes, manifest = verify_plan()
    if args.verify_only:
        print(json.dumps({'verifiedPlanSha256': EXPECTED_SHA256, 'gpuWork': False}))
        return 0
    idle = check_idle(args.idle_url)
    report = run(plan_bytes, manifest, warmup=args.warmup,
                 iterations=args.iterations, idle_check=idle)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'output': str(args.output),
                      'baselineInferenceMedianMs': report['baselineInferenceMs']['median'],
                      'profiledInferenceMedianMs': report['profiledInferenceMs']['median'],
                      'topLayers': report['layers'][:15]}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
