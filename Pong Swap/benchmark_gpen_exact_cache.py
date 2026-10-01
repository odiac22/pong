"""Silent same-engine GPEN1024 L2 activation-cache sweep, FP32 bit parity."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--reserve-maximum', action='store_true')
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    sys.path.insert(0, str(Path(__file__).parent / 'engine' / 'Rope'))
    from rope import _native_dlls  # noqa: F401
    import torch
    import tensorrt as trt
    from cuda.bindings import driver
    torch.cuda.set_device(0)
    torch.empty(1, device='cuda')
    status, maximum = driver.cuDeviceGetAttribute(
        driver.CUdevice_attribute.CU_DEVICE_ATTRIBUTE_MAX_PERSISTING_L2_CACHE_SIZE, 0)
    if status != driver.CUresult.CUDA_SUCCESS:
        raise RuntimeError(status)
    if args.reserve_maximum:
        status, = driver.cuCtxSetLimit(driver.CUlimit.CU_LIMIT_PERSISTING_L2_CACHE_SIZE, maximum)
        if status != driver.CUresult.CUDA_SUCCESS:
            raise RuntimeError(status)
    status, reserved = driver.cuCtxGetLimit(driver.CUlimit.CU_LIMIT_PERSISTING_L2_CACHE_SIZE)
    if status != driver.CUresult.CUDA_SUCCESS:
        raise RuntimeError(status)
    plan = Path('E:/Pong Benchmarks/v2904-diner/models/qualified-1024/gpen1024-fp32-notf32-837ad5c891cc4705225f.plan')
    payload = plan.read_bytes()
    logger = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(payload)
    stream = torch.cuda.Stream()
    torch.manual_seed(62890)
    image = torch.rand((1, 3, 1024, 1024), dtype=torch.float32, device='cuda') * 2 - 1
    stream.wait_stream(torch.cuda.current_stream())
    result = {'scope': 'Same frozen engine, persistent L2 policy only; no playback',
              'planSha256': hashlib.sha256(payload).hexdigest(), 'maximumPersistingBytes': maximum,
              'precision': 'FP32/noTF32 unchanged serialized engine',
              'reservedBytes': reserved, 'rows': []}
    reference = None
    for mib in (0, 1, 4, 8, 16, 24, 0):
        limit = mib * 1024 * 1024
        if limit > maximum:
            continue
        context = engine.create_execution_context()
        context.persistent_cache_limit = limit
        output = torch.empty_like(image)
        context.set_tensor_address('input', image.data_ptr())
        context.set_tensor_address('output', output.data_ptr())
        with torch.cuda.stream(stream):
            for _ in range(3):
                if not context.execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('GPEN submission failed')
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                if not context.execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('GPEN capture failed')
            pairs = []
            for _ in range(24):
                a, b = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
                a.record(stream)
                graph.replay()
                b.record(stream)
                pairs.append((a, b))
            stream.synchronize()
            if reference is None:
                reference = output.clone()
            difference = output - reference
            row = {'cacheMiB': mib, 'actualBytes': context.persistent_cache_limit,
                   'medianMs': statistics.median(a.elapsed_time(b) for a, b in pairs),
                   'bitExact': bool(torch.equal(output, reference)),
                   'maxAbsError': float(difference.abs().max().item())}
            result['rows'].append(row)
            print(json.dumps(row), flush=True)
        stream.synchronize()
        del graph, context, output
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
