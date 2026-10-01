"""Silent layer-timing diagnostic for the unchanged GPEN1024 engine."""
import argparse
import json
from pathlib import Path
import statistics
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if args.output.exists():
    raise FileExistsError(args.output)
sys.path.insert(0, str(Path(__file__).parent / 'engine' / 'Rope'))
from rope import _native_dlls  # noqa: F401
import torch
import tensorrt as trt


class Profiler(trt.IProfiler):
    def __init__(self):
        super().__init__()
        self.rows = {}

    def report_layer_time(self, name, ms):
        self.rows.setdefault(name, []).append(ms)


runtime = trt.Runtime(trt.Logger(trt.Logger.WARNING))
engine = runtime.deserialize_cuda_engine(Path('E:/Pong Benchmarks/v2904-diner/models/qualified-1024/gpen1024-fp32-notf32-837ad5c891cc4705225f.plan').read_bytes())
context = engine.create_execution_context()
profiler = Profiler()
context.profiler = profiler
stream = torch.cuda.Stream()
with torch.cuda.stream(stream):
    x = torch.randn((1, 3, 1024, 1024), device='cuda')
    y = torch.empty_like(x)
    context.set_tensor_address('input', x.data_ptr())
    context.set_tensor_address('output', y.data_ptr())
    for _ in range(10):
        if not context.execute_async_v3(stream.cuda_stream):
            raise RuntimeError('Submission failed')
    stream.synchronize()
inspector = engine.create_engine_inspector()
report = {'scope': 'Unchanged engine eager diagnostic, not playback throughput',
          'layers': sorted([{'name': k, 'medianMs': statistics.median(v[2:]), 'count': len(v)}
                            for k, v in profiler.rows.items()], key=lambda r: r['medianMs'], reverse=True),
          'engine': json.loads(inspector.get_engine_information(trt.LayerInformationFormat.JSON))}
args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report['layers'][:30], indent=2))
