"""Offline serial-vs-two-context benchmark of the existing qualified GPEN512 plan.

This measures an inference-only throughput ceiling, not playback FPS. It does
not build a TensorRT engine, edit a model/preset, or admit a production session.
GPU execution requires an explicit flag and a separate handoff from the owner.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import time

import numpy as np

from profile_qualified_gpen512_layers import (
    EXPECTED_SHA256, ROOT, check_idle, verify_plan,
)


CAPTURE_DIR = ROOT / 'benchmarks' / 'gpen512-calibration-inputs'
CAPTURE_NAMES = (
    'pexels-18400987-popsicle-occlusion-silent-720p-gpen-inputs-f32.npy',
    'pexels-18400987-silent-720p-gpen-inputs-f32.npy',
    'pexels-3761547-silent-720p-gpen-inputs-f32.npy',
)
SHAPE = (1, 3, 512, 512)
SAMPLES = 64
MIN_FREE_MIB = 6144
ORDER = ('serial', 'parallel', 'parallel', 'serial')


def capture_refs() -> list[tuple[str, int]]:
    """64 jobs, interleaving 36 distinct existing local Pexels face crops."""
    base = [(name, index) for index in range(12) for name in CAPTURE_NAMES]
    return [base[index % len(base)] for index in range(SAMPLES)]


def load_captures() -> tuple[np.ndarray, list[dict]]:
    arrays: dict[str, np.ndarray] = {}
    hashes: dict[str, str] = {}
    for name in CAPTURE_NAMES:
        path = CAPTURE_DIR / name
        if not path.is_file():
            raise FileNotFoundError(f'Missing local calibration capture: {path}')
        payload = path.read_bytes()
        hashes[name] = hashlib.sha256(payload).hexdigest()
        array = np.load(path, mmap_mode='r', allow_pickle=False)
        if array.dtype != np.float32 or array.shape != (12, 3, 512, 512):
            raise RuntimeError(f'Unexpected FP32 crop shape/dtype: {name}')
        if not np.isfinite(array).all() or array.min() < -1.00001 or array.max() > 1.00001:
            raise RuntimeError(f'Invalid normalized FP32 crop: {name}')
        arrays[name] = array
    refs = capture_refs()
    crops = np.stack([arrays[name][index] for name, index in refs], axis=0)
    provenance = [
        {'capture': name, 'captureSha256': hashes[name], 'cropIndex': index}
        for name, index in refs
    ]
    return crops, provenance


def parse_free_mib(output: str, *, expected_gpu: str) -> tuple[int, int]:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError('Expected exactly one selected GPU from nvidia-smi')
    parts = [part.strip() for part in lines[0].split(',')]
    if len(parts) != 3 or parts[0] != expected_gpu:
        raise RuntimeError('GPU identity differs from the qualified plan')
    try:
        free, total = int(parts[1]), int(parts[2])
    except ValueError as exc:
        raise RuntimeError('Invalid nvidia-smi memory result') from exc
    if not 0 < free <= total:
        raise RuntimeError('Invalid GPU free/total memory')
    return free, total


def require_gpu_headroom(manifest: dict, *, min_free_mib: int = MIN_FREE_MIB) -> dict:
    result = subprocess.run(
        ['nvidia-smi', '--id=0', '--query-gpu=name,memory.free,memory.total',
         '--format=csv,noheader,nounits'],
        check=True, text=True, capture_output=True, timeout=5,
    )
    free, total = parse_free_mib(result.stdout, expected_gpu=manifest['gpu'])
    if free < min_free_mib:
        raise RuntimeError(
            f'Only {free} MiB GPU memory free; require {min_free_mib} MiB before loading plan'
        )
    return {'freeMiB': free, 'totalMiB': total, 'minimumMiB': min_free_mib}


def percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    lo, hi = math.floor(position), math.ceil(position)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo)


def summarize_rounds(rows: list[dict]) -> dict:
    result = {}
    for mode in ORDER[:2]:
        selected = [row for row in rows if row['mode'] == mode]
        gpu = [row['gpuMakespanMs'] for row in selected]
        wall = [row['hostMakespanMs'] for row in selected]
        latencies = [value for row in selected for value in row['gpuJobLatencyMs']]
        result[mode] = {
            'gpuMakespanMedianMs': statistics.median(gpu),
            'hostMakespanMedianMs': statistics.median(wall),
            'gpuThroughputFps': SAMPLES * 1000.0 / statistics.median(gpu),
            'hostThroughputFps': SAMPLES * 1000.0 / statistics.median(wall),
            'gpuJobLatencyP50Ms': statistics.median(latencies),
            'gpuJobLatencyP95Ms': percentile(latencies, 95),
        }
    result['parallelOverSerialGpuThroughput'] = (
        result['parallel']['gpuThroughputFps'] / result['serial']['gpuThroughputFps']
    )
    result['parallelOverSerialHostThroughput'] = (
        result['parallel']['hostThroughputFps'] / result['serial']['hostThroughputFps']
    )
    return result


def run_gpu(plan_bytes: bytes, manifest: dict, crops: np.ndarray, provenance: list[dict],
            *, idle_check: str, headroom: dict, warmup: int) -> dict:
    sys.path.insert(0, str(ROOT / 'engine' / 'Rope'))
    from rope import _native_dlls  # noqa: F401 -- Windows TensorRT DLL paths
    import torch
    import tensorrt as trt

    if not torch.cuda.is_available() or torch.cuda.get_device_name(0) != manifest['gpu']:
        raise RuntimeError('Qualified GPU unavailable or changed')
    if list(torch.cuda.get_device_capability(0)) != manifest['capability']:
        raise RuntimeError('Qualified SM capability changed')
    if str(trt.__version__) != manifest['tensorrt'] or str(torch.version.cuda) != manifest['cuda']:
        raise RuntimeError('Qualified TensorRT/CUDA runtime changed')
    before_free, _ = torch.cuda.mem_get_info(0)
    if before_free < MIN_FREE_MIB * 1024 * 1024:
        raise RuntimeError('GPU memory fell below the preflight threshold before deserialization')
    runtime = trt.Runtime(trt.Logger(trt.Logger.WARNING))
    engine = runtime.deserialize_cuda_engine(plan_bytes)
    if engine is None:
        raise RuntimeError('Failed to deserialize existing qualified plan')
    modes = {'input': trt.TensorIOMode.INPUT, 'output': trt.TensorIOMode.OUTPUT}
    actual = {engine.get_tensor_name(i): engine.get_tensor_mode(engine.get_tensor_name(i))
              for i in range(engine.num_io_tensors)}
    if actual != modes or any(tuple(engine.get_tensor_shape(name)) != SHAPE or
                              engine.get_tensor_dtype(name) != trt.float32 for name in modes):
        raise RuntimeError('Qualified plan I/O contract changed')
    context_bytes = int(getattr(engine, 'device_memory_size_v2', 0))
    free_after_plan, _ = torch.cuda.mem_get_info(0)
    if free_after_plan < 2 * context_bytes + 768 * 1024 * 1024:
        raise RuntimeError('Two TensorRT contexts exceed bounded free-memory estimate')

    device_inputs = torch.from_numpy(crops).to(device='cuda:0', non_blocking=False)
    contexts = []
    streams = []
    buffers = []
    for _ in range(2):
        stream = torch.cuda.Stream(device=0)
        stream.wait_stream(torch.cuda.current_stream(0))
        context = engine.create_execution_context()
        if context is None:
            raise RuntimeError('Failed to create second independent TensorRT context')
        x = torch.empty(SHAPE, dtype=torch.float32, device='cuda:0')
        y = torch.empty_like(x)
        if not context.set_tensor_address('input', x.data_ptr()) or not context.set_tensor_address('output', y.data_ptr()):
            raise RuntimeError('TensorRT rejected owned persistent I/O')
        contexts.append(context)
        streams.append(stream)
        buffers.append((x, y))

    def submit(owner: int, index: int) -> None:
        stream = streams[owner]
        x, _ = buffers[owner]
        with torch.cuda.stream(stream):
            x.copy_(device_inputs[index:index + 1])
            if not contexts[owner].execute_async_v3(int(stream.cuda_stream)):
                raise RuntimeError('Qualified TensorRT inference submission failed')

    for owner in (0, 1):
        for index in range(warmup):
            submit(owner, index % SAMPLES)
        streams[owner].synchronize()

    def timed(mode: str) -> dict:
        control = torch.cuda.current_stream(0)
        start = torch.cuda.Event(enable_timing=True)
        finish = torch.cuda.Event(enable_timing=True)
        per_job = []
        host_started = time.perf_counter()
        start.record(control)
        active = (0,) if mode == 'serial' else (0, 1)
        for owner in active:
            streams[owner].wait_event(start)
        for index in range(SAMPLES):
            owner = 0 if mode == 'serial' else index % 2
            stream = streams[owner]
            a, b = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            with torch.cuda.stream(stream):
                a.record(stream)
                submit(owner, index)
                b.record(stream)
            per_job.append((a, b))
        ends = []
        for owner in active:
            end = torch.cuda.Event(enable_timing=True)
            end.record(streams[owner])
            control.wait_event(end)
            ends.append(end)
        finish.record(control)
        finish.synchronize()
        host_ms = (time.perf_counter() - host_started) * 1000
        return {'mode': mode, 'gpuMakespanMs': float(start.elapsed_time(finish)),
                'hostMakespanMs': host_ms,
                'gpuJobLatencyMs': [float(a.elapsed_time(b)) for a, b in per_job]}

    rounds = [timed(mode) for mode in ORDER]
    for stream in streams:
        stream.synchronize()

    # Validation is intentionally outside measured blocks. Each crop has an
    # individual reference output and a separate concurrently executed output.
    reference = []
    for index in range(SAMPLES):
        submit(0, index)
        streams[0].synchronize()
        reference.append(buffers[0][1].cpu().numpy().copy())
    comparisons = []
    for index in range(0, SAMPLES, 2):
        submit(0, index)
        submit(1, index + 1)
        for stream in streams:
            stream.synchronize()
        for offset in (0, 1):
            sample = index + offset
            actual_output = buffers[offset][1].cpu().numpy()
            delta = np.abs(actual_output.astype(np.float64) - reference[sample].astype(np.float64))
            comparisons.append({**provenance[sample], 'job': sample,
                                'bitwiseEqual': bool(np.array_equal(actual_output, reference[sample])),
                                'mae': float(delta.mean()), 'maxAbs': float(delta.max())})

    return {
        'scope': 'offline qualified-plan GPEN512 inference-only dual-context ceiling; not playback FPS',
        'planSha256': EXPECTED_SHA256,
        'modelSha256': manifest['modelSha256'],
        'idleCheck': idle_check,
        'preloadHeadroom': headroom,
        'warmupPerContext': warmup,
        'jobsPerRound': SAMPLES,
        'uniqueCapturedCrops': len(set(capture_refs())),
        'roundOrder': list(ORDER),
        'input': 'existing local normalized FP32 [1,3,512,512] Pexels captures; GPU resident before timing',
        'timingIncludes': 'device input copy, TRT enqueue/inference, owned output; excludes H2D and CPU output validation',
        'rounds': rounds,
        'summary': summarize_rounds(rounds),
        'parityPass': all(row['bitwiseEqual'] for row in comparisons),
        'comparisons': comparisons,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New JSON report, never overwritten')
    parser.add_argument('--idle-url', default='http://127.0.0.1:8792')
    parser.add_argument('--warmup', type=int, default=10)
    parser.add_argument('--verify-only', action='store_true', help='CPU-only plan/input checks')
    parser.add_argument('--gpu-authorized', action='store_true', help='Explicit GPU-owner handoff required')
    args = parser.parse_args(argv)
    if args.output.exists():
        raise FileExistsError(args.output)
    if not 1 <= args.warmup <= 20:
        raise ValueError('warmup must be in 1..20')
    plan_bytes, manifest = verify_plan()
    crops, provenance = load_captures()
    if args.verify_only:
        print(json.dumps({'planSha256': EXPECTED_SHA256, 'jobs': len(provenance),
                          'uniqueCrops': len(set(capture_refs())), 'gpuWork': False}))
        return 0
    if not args.gpu_authorized:
        raise RuntimeError('GPU run requires --gpu-authorized after owner handoff')
    idle = check_idle(args.idle_url)
    headroom = require_gpu_headroom(manifest)
    report = run_gpu(plan_bytes, manifest, crops, provenance,
                     idle_check=idle, headroom=headroom, warmup=args.warmup)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'output': str(args.output), 'parityPass': report['parityPass'],
                      'summary': report['summary']}, indent=2))
    return 0 if report['parityPass'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
