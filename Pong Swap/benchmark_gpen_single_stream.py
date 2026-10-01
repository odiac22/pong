"""Isolated strict-FP32/no-TF32 GPEN build with serial tactic selection."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=False)
sys.path.insert(0, str(Path(__file__).parent / 'engine' / 'Rope'))
from rope import _native_dlls  # noqa: F401
import torch
import tensorrt as trt
from benchmark_gpen512_native_trt import build_plan

model = Path('E:/Pong Benchmarks/v2904-diner/models/gpen_bfr_1024.onnx')
original = Path('E:/Pong Benchmarks/v2904-diner/models/qualified-1024/gpen1024-fp32-notf32-837ad5c891cc4705225f.plan')
candidate = args.output_dir / 'strict-fp32-aux0.plan'
build = build_plan(trt, model, candidate, 2 * 1024**3, strict_math=True,
                   allow_tf32=False, max_aux_streams=0,
                   timing_cache_out=args.output_dir / 'timing.cache')
report = {'scope': 'Scheduling/tactic build experiment only, not production', 'build': build,
          'modelSha256': hashlib.sha256(model.read_bytes()).hexdigest(), 'rows': []}
(args.output_dir / 'build.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
torch.cuda.set_device(0)
torch.manual_seed(62890)
stream = torch.cuda.Stream()
image = torch.rand((1, 3, 1024, 1024), dtype=torch.float32, device='cuda') * 2 - 1
stream.wait_stream(torch.cuda.current_stream())
reference = None
for label, plan in (('original', original), ('serial', candidate), ('original-repeat', original)):
    runtime = trt.Runtime(trt.Logger(trt.Logger.WARNING))
    engine = runtime.deserialize_cuda_engine(plan.read_bytes())
    context = engine.create_execution_context()
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
        for _ in range(32):
            a, b = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            a.record(stream)
            graph.replay()
            b.record(stream)
            pairs.append((a, b))
        stream.synchronize()
        if reference is None:
            reference = output.clone()
        error = (output - reference).abs()
        row = {'label': label, 'auxStreams': engine.num_aux_streams,
               'planSha256': hashlib.sha256(plan.read_bytes()).hexdigest(),
               'medianMs': statistics.median(a.elapsed_time(b) for a, b in pairs),
               'bitExact': bool(torch.equal(output, reference)),
               'maxAbsNormalizedError': float(error.max().item()),
               'meanAbsNormalizedError': float(error.mean().item())}
        report['rows'].append(row)
        print(json.dumps(row), flush=True)
    stream.synchronize()
    del graph, context, engine, runtime, output
(args.output_dir / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
