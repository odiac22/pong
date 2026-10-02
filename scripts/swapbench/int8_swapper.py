"""Build an INT8 (+FP16 fallback) TensorRT engine for InSwapper 128 with
real calibration data, then compare speed and output against FP16.

python int8_swapper.py <pong_swap_dir> <out_dir> [batch]
"""
import glob
import os
import sys
import time

import cv2
import numpy as np
import tensorrt as trt
import torch

root, out_dir = sys.argv[1], sys.argv[2]
batch = int(sys.argv[3]) if len(sys.argv) > 3 else 4
models = os.path.join(root, "runtime", "models")
onnx_path = os.path.join(models, "inswapper_128.fp16.onnx")
dev = torch.device("cuda")
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                     [41.5493, 92.3655], [70.7299, 92.2041]], np.float32) * (128 / 112)

# --- real aligned face crops from the recorded clips -------------------------
crops = []
for npz in sorted(glob.glob(r"F:\pong-claude-bench\landmarks\*.npz")):
    data = np.load(npz)
    clip = r"F:\pong-claude-bench\stock\%s.mp4" % os.path.basename(npz)[:-4]
    cap = cv2.VideoCapture(clip)
    idx = 0
    while len(crops) < 400:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % 15 == 0 and data["score"][idx] > 0.6:
            m, _ = cv2.estimateAffinePartial2D(data["kps"][idx], TEMPLATE)
            face = cv2.warpAffine(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), m, (128, 128), flags=cv2.INTER_LINEAR)
            crops.append(face.transpose(2, 0, 1).astype(np.float32) / 255.0)
        idx += 1
crops = np.stack(crops)
rng = np.random.default_rng(0)
rng.shuffle(crops)
calib, held = crops[:250], crops[250:]
print(f"{len(calib)} calibration crops, {len(held)} held-out")

# --- source latent the way Pong builds it (emap projection of an embedding) --
emap = np.load(onnx_path + ".buff2fs.fp16.npy").astype(np.float32)
embs = [np.load(p).reshape(-1)[:512] for p in glob.glob(os.path.join(root, "cache", "embeddings-v2", "approved-8-*.npy"))]
latents = []
for e in embs or [rng.standard_normal(512)]:
    lat = (e / np.linalg.norm(e)).reshape(1, -1) @ emap
    latents.append((lat / np.linalg.norm(lat)).astype(np.float32))
latent = latents[0]


class Calibrator(trt.IInt8EntropyCalibrator2):
    def __init__(self):
        super().__init__()
        self.i = 0
        self.t = torch.empty((batch, 3, 128, 128), device=dev, dtype=torch.float32)
        self.s = torch.from_numpy(np.repeat(latent, 1, 0)).to(dev)
        self.cache = os.path.join(out_dir, f"int8_b{batch}.cache")

    def get_batch_size(self):
        return batch

    def get_batch(self, names):
        if self.i + batch > len(calib):
            return None
        self.t.copy_(torch.from_numpy(calib[self.i:self.i + batch]))
        self.i += batch
        return [self.t.data_ptr() if n == "target" else self.s.data_ptr() for n in names]

    def read_calibration_cache(self):
        return open(self.cache, "rb").read() if os.path.exists(self.cache) else None

    def write_calibration_cache(self, cache):
        open(self.cache, "wb").write(cache)


logger = trt.Logger(trt.Logger.WARNING)


def build(int8: bool):
    path = os.path.join(out_dir, f"inswapper128_b{batch}_{'int8' if int8 else 'fp16'}.plan")
    if os.path.exists(path):
        return path
    builder = trt.Builder(logger)
    network = builder.create_network(0)
    parser = trt.OnnxParser(network, logger)
    if not parser.parse(open(onnx_path, "rb").read()):
        raise SystemExit("parse failed")
    config = builder.create_builder_config()
    config.set_flag(trt.BuilderFlag.FP16)
    if int8:
        config.set_flag(trt.BuilderFlag.INT8)
        config.int8_calibrator = Calibrator()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 2 << 30)
    profile = builder.create_optimization_profile()
    for i in range(network.num_inputs):
        t = network.get_input(i)
        shape = (batch, 3, 128, 128) if t.name == "target" else (1, 512)
        profile.set_shape(t.name, shape, shape, shape)
    config.add_optimization_profile(profile)
    if int8:
        config.set_calibration_profile(profile)
    t0 = time.time()
    plan = builder.build_serialized_network(network, config)
    if plan is None:
        raise SystemExit("build failed")
    open(path, "wb").write(plan)
    print(f"built {os.path.basename(path)} in {time.time() - t0:.0f} s")
    return path


def runner(path):
    engine = trt.Runtime(logger).deserialize_cuda_engine(open(path, "rb").read())
    ctx = engine.create_execution_context()
    dtype = {trt.DataType.HALF: torch.float16, trt.DataType.FLOAT: torch.float32}
    names = [engine.get_tensor_name(i) for i in range(engine.num_io_tensors)]
    bufs = {n: torch.empty(tuple(engine.get_tensor_shape(n)), device=dev,
                           dtype=dtype[engine.get_tensor_dtype(n)]) for n in names}
    for n in names:
        ctx.set_tensor_address(n, bufs[n].data_ptr())
    stream = torch.cuda.Stream()

    def run(target):
        bufs["target"].copy_(torch.from_numpy(target))
        bufs["source"].copy_(torch.from_numpy(latent))
        ctx.execute_async_v3(stream.cuda_stream)
        stream.synchronize()
        return bufs["output"].float().clone()

    def bench(n=60):
        for _ in range(10):
            ctx.execute_async_v3(stream.cuda_stream)
        stream.synchronize()
        t0 = time.perf_counter()
        for _ in range(n):
            ctx.execute_async_v3(stream.cuda_stream)
        stream.synchronize()
        return (time.perf_counter() - t0) / n * 1000
    return run, bench


os.makedirs(out_dir, exist_ok=True)
fp16_run, fp16_bench = runner(build(False))
int8_run, int8_bench = runner(build(True))
f_ms, i_ms = fp16_bench(), int8_bench()
print(f"FP16 batch {batch}: {f_ms:6.2f} ms   INT8 batch {batch}: {i_ms:6.2f} ms   speed-up x{f_ms / i_ms:.2f}")
psnrs = []
for k in range(0, len(held) - batch + 1, batch):
    a, b = fp16_run(held[k:k + batch]), int8_run(held[k:k + batch])
    mse = float(((a - b) ** 2).mean())
    psnrs.append(10 * np.log10(1.0 / max(mse, 1e-12)))
print(f"INT8 vs FP16 on held-out faces: PSNR median {np.median(psnrs):.1f} dB, worst {np.min(psnrs):.1f} dB")
