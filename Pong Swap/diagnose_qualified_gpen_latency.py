"""Idle-only kernel baseline for the existing qualified GPEN512 plan.

Synthetic inputs; no source media, settings writes, builds, model changes or
production runtime imports. Separates model execution from pipeline overhead.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    with urlopen('http://127.0.0.1:8792/health', timeout=3) as response:
        health = json.load(response)
    if not health.get('ready') or health.get('activeSessions') != 0 or health.get('embeddingPrimerActive'):
        raise RuntimeError('Renderer is not idle; no GPU diagnostic started')
    root = Path(__file__).resolve().parent
    preset_bytes = (root / 'presets/current.json').read_bytes()
    config = json.loads(preset_bytes)
    plan = Path(config['runtime']['restorerNativeTrtQualifiedPlan'])
    manifest = json.loads(plan.with_suffix('.plan.manifest.json').read_text(encoding='utf-8'))
    data = plan.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != manifest.get('planSha256') or manifest.get('edge') != 512:
        raise RuntimeError('Qualified GPEN512 plan identity mismatch')
    sys.path.insert(0, str(root / 'engine/Rope'))
    from rope import _native_dlls  # noqa: F401
    import torch
    import tensorrt as trt
    torch.cuda.set_device(0)
    free, total = torch.cuda.mem_get_info()
    if free < 3 * 1024**3:
        raise RuntimeError('Less than 3 GiB GPU headroom; no plan loaded')
    if manifest.get('tensorrt') != trt.__version__:
        raise RuntimeError('Qualified TensorRT version changed')
    runtime = trt.Runtime(trt.Logger(trt.Logger.WARNING))
    engine = runtime.deserialize_cuda_engine(data)
    context = engine.create_execution_context()
    shape = (1, 3, 512, 512)
    if tuple(engine.get_tensor_shape('input')) != shape or tuple(engine.get_tensor_shape('output')) != shape:
        raise RuntimeError('Plan shape changed')
    stream = torch.cuda.Stream()
    torch.manual_seed(9030)
    image = torch.rand(shape, dtype=torch.float32, device='cuda') * 2 - 1
    output = torch.empty_like(image)
    context.set_tensor_address('input', image.data_ptr())
    context.set_tensor_address('output', output.data_ptr())
    stream.wait_stream(torch.cuda.current_stream())
    report = {'diagnosticOnly': True, 'syntheticInput': True, 'model': 'GPEN512',
              'planSha256': digest, 'unchangedPrecision': True, 'device': torch.cuda.get_device_name(),
              'freeVramBefore': free, 'totalVram': total, 'auxStreams': engine.num_aux_streams, 'runs': []}
    with torch.cuda.stream(stream):
        for _ in range(4):
            if not context.execute_async_v3(stream.cuda_stream):
                raise RuntimeError('GPEN submission failed')
        stream.synchronize()
        reference = output.clone()
        stream.synchronize()
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
            if not context.execute_async_v3(stream.cuda_stream):
                raise RuntimeError('GPEN graph capture failed')
        for mode in ('serial-submit', 'graph', 'graph-repeat'):
            durations, wall = [], []
            for _ in range(32):
                begin, end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
                start = time.perf_counter()
                begin.record(stream)
                if mode == 'serial-submit':
                    if not context.execute_async_v3(stream.cuda_stream):
                        raise RuntimeError('GPEN submission failed')
                else:
                    graph.replay()
                end.record(stream)
                end.synchronize()
                durations.append(begin.elapsed_time(end))
                wall.append((time.perf_counter() - start) * 1000)
            row = {'mode': mode, 'frames': len(durations),
                   'gpuMedianMs': statistics.median(durations), 'gpuMaximumMs': max(durations),
                   'wallMedianMs': statistics.median(wall), 'wallMaximumMs': max(wall),
                   'bitExact': bool(torch.equal(output, reference)),
                   'maxAbsError': float((output - reference).abs().max().item())}
            report['runs'].append(row)
            print(json.dumps(row), flush=True)
        stream.synchronize()
    report['savedPresetUnchanged'] = (root / 'presets/current.json').read_bytes() == preset_bytes
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(args.output)}), flush=True)


if __name__ == '__main__':
    main()
