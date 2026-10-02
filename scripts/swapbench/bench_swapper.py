"""InSwapper 128 (fp16 ONNX) speed for the 256 mode's 4 polyphase passes:
ORT TensorRT EP (current) vs a native TensorRT engine (+ CUDA graph).

python bench_swapper.py <models_dir> <out_dir> [batch]
"""
import os
import sys
import time

import numpy as np
import tensorrt as trt
import torch

models, out_dir = sys.argv[1], sys.argv[2]
batch = int(sys.argv[3]) if len(sys.argv) > 3 else 4
onnx_path = os.path.join(models, "inswapper_128.fp16.onnx")
os.makedirs(out_dir, exist_ok=True)
dev = torch.device("cuda")
target = torch.rand((batch, 3, 128, 128), device=dev, dtype=torch.float16)
source = torch.randn((1, 512), device=dev, dtype=torch.float16)


def timeit(fn, n=60, warm=10):
    for _ in range(warm):
        fn()
    torch.cuda.synchronize()
    t = time.perf_counter()
    for _ in range(n):
        fn()
    torch.cuda.synchronize()
    return (time.perf_counter() - t) / n * 1000


# --- current path: ORT TensorRT EP with io binding ---------------------------
import onnxruntime as ort  # noqa: E402

sess = ort.InferenceSession(onnx_path, providers=[
    ("TensorrtExecutionProvider", {"trt_fp16_enable": True, "trt_engine_cache_enable": True,
                                   "trt_engine_cache_path": os.path.join(out_dir, "ort_cache")}),
    "CUDAExecutionProvider"])
out_ort = torch.empty((batch, 3, 128, 128), device=dev, dtype=torch.float16)
binding = sess.io_binding()
binding.bind_input("target", "cuda", 0, np.float16, tuple(target.shape), target.data_ptr())
binding.bind_input("source", "cuda", 0, np.float16, (1, 512), source.data_ptr())
binding.bind_output("output", "cuda", 0, np.float16, tuple(out_ort.shape), out_ort.data_ptr())
ort_ms = timeit(lambda: sess.run_with_iobinding(binding))
print(f"ORT TRT-EP   batch {batch}: {ort_ms:6.2f} ms  ({ort_ms / batch:.2f} ms/pass)")

# --- native TensorRT engine ------------------------------------------------
logger = trt.Logger(trt.Logger.WARNING)
engine_path = os.path.join(out_dir, f"inswapper128_b{batch}_fp16.plan")
if not os.path.exists(engine_path):
    builder = trt.Builder(logger)
    network = builder.create_network(0)
    parser = trt.OnnxParser(network, logger)
    with open(onnx_path, "rb") as f:
        if not parser.parse(f.read()):
            raise SystemExit("\n".join(str(parser.get_error(i)) for i in range(parser.num_errors)))
    config = builder.create_builder_config()
    config.set_flag(trt.BuilderFlag.FP16)
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 2 << 30)
    config.builder_optimization_level = 5
    profile = builder.create_optimization_profile()
    for i in range(network.num_inputs):
        tensor = network.get_input(i)
        shape = (batch, 3, 128, 128) if tensor.name == "target" else (1, 512)
        profile.set_shape(tensor.name, shape, shape, shape)
    config.add_optimization_profile(profile)
    t = time.time()
    plan = builder.build_serialized_network(network, config)
    print(f"built native engine in {time.time() - t:.0f} s")
    with open(engine_path, "wb") as f:
        f.write(plan)
runtime = trt.Runtime(logger)
with open(engine_path, "rb") as f:
    engine = runtime.deserialize_cuda_engine(f.read())
ctx = engine.create_execution_context()
out_trt = torch.empty((batch, 3, 128, 128), device=dev, dtype=torch.float16)
names = [engine.get_tensor_name(i) for i in range(engine.num_io_tensors)]
for name in names:
    buf = {"target": target, "source": source}.get(name, out_trt)
    if engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT:
        ctx.set_input_shape(name, tuple(buf.shape))
    ctx.set_tensor_address(name, buf.data_ptr())
stream = torch.cuda.Stream()
native_ms = timeit(lambda: (ctx.execute_async_v3(stream.cuda_stream), stream.synchronize()))
print(f"native TRT   batch {batch}: {native_ms:6.2f} ms  ({native_ms / batch:.2f} ms/pass)")

# CUDA graph replay of the same engine
with torch.cuda.stream(stream):
    ctx.execute_async_v3(stream.cuda_stream)
    stream.synchronize()
    graph = torch.cuda.CUDAGraph()
    with torch.cuda.graph(graph, stream=stream):
        ctx.execute_async_v3(stream.cuda_stream)
graph_ms = timeit(lambda: (graph.replay(), stream.synchronize()))
print(f"native+graph batch {batch}: {graph_ms:6.2f} ms  ({graph_ms / batch:.2f} ms/pass)")
diff = (out_trt.float() - out_ort.float()).abs().max().item()
print(f"max |native - ORT| output difference: {diff:.4f}")
