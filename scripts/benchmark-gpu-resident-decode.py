"""Read-only NVDEC feasibility test: no service, settings, or media changes.

Compare decode-to-device throughput and sampled RGB values against the exact
PyAV RGB24 input currently consumed by Pong. Not an end-to-end FPS benchmark.
"""
import argparse
import gc
import json
import os
from pathlib import Path
import time

import av
import numpy as np
import torch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    root = Path(__file__).resolve().parents[1]
    site = root / 'Pong Swap/runtime/venv/Lib/site-packages'
    dll_handles = [os.add_dll_directory(str(p)) for p in
                   (site / 'PyNvVideoCodec', site / 'torch/lib') if p.exists()]
    import PyNvVideoCodec as nvc
    corpus = root / 'Pong Swap/benchmarks/realtime-stock-corpus/input'
    stream = torch.cuda.Stream()
    report = {'scope': 'Isolated decode-to-GPU experiment; not live playback',
              'codecVersion': nvc.__version__, 'clips': []}
    try:
        for ordinal in range(1, 6):
            source = corpus / f'clip-{ordinal:02}.mp4'
            row = {'clip': ordinal}
            report['clips'].append(row)
            # Read the same local files, retaining only a few reference frames.
            references = {}
            start = time.perf_counter()
            frames = 0
            with av.open(str(source)) as container, torch.cuda.stream(stream):
                for frame in container.decode(video=0):
                    rgb = frame.to_ndarray(format='rgb24')
                    uploaded = torch.from_numpy(rgb).to('cuda')
                    if frames in (0, 30, 60, 100):
                        references[frames] = rgb.copy()
                    frames += 1
                stream.synchronize()
            row['cpuDecodeUpload'] = {'frames': frames,
                                     'elapsedMs': (time.perf_counter() - start) * 1000}
            # The shipping renderer has pinned upload already. The pageable
            # .to() comparator above is not its baseline and must not be used
            # to advertise an end-to-end acceleration factor.
            pinned = torch.empty(rgb.shape, dtype=torch.uint8, pin_memory=True)
            start = time.perf_counter()
            frames = 0
            copy_done = None
            with av.open(str(source)) as container, torch.cuda.stream(stream):
                for frame in container.decode(video=0):
                    rgb = frame.to_ndarray(format='rgb24')
                    if copy_done is not None:
                        copy_done.synchronize()
                    np.copyto(pinned.numpy(), rgb)
                    uploaded = torch.empty(rgb.shape, dtype=torch.uint8, device='cuda')
                    uploaded.copy_(pinned, non_blocking=True)
                    copy_done = torch.cuda.Event()
                    copy_done.record(stream)
                    frames += 1
                stream.synchronize()
            row['cpuDecodePinnedUpload'] = {'frames': frames,
                'elapsedMs': (time.perf_counter() - start) * 1000,
                'note': 'Live upload mechanism, but no concurrent face-inference workload.'}
            start = time.perf_counter()
            decoder = nvc.SimpleDecoder(str(source), cuda_stream=stream.cuda_stream,
                use_device_memory=True, output_color_type=nvc.OutputColorType.RGB)
            row['nvdecOpenMs'] = (time.perf_counter() - start) * 1000
            frames = 0
            comparisons = []
            while True:
                batch = decoder.get_batch_frames(1)
                if not batch:
                    break
                with torch.cuda.stream(stream):
                    tensor = torch.from_dlpack(batch[0])
                    if frames in references:
                        actual = tensor.cpu().numpy()
                        expected = references[frames]
                        error = np.abs(actual.astype(np.int16) - expected.astype(np.int16))
                        comparisons.append({'frame': frames, 'shape': list(actual.shape),
                            'exact': bool(np.array_equal(actual, expected)),
                            'meanAbsoluteError': float(error.mean()),
                            'maximumError': int(error.max())})
                frames += 1
            stream.synchronize()
            row['nvdecRgb'] = {'frames': frames,
                              'elapsedMs': (time.perf_counter() - start) * 1000,
                              'comparisons': comparisons}
            # 2.1's Python wrapper advertises stop(), but its shipped Windows
            # native SimpleDecoder does not implement it. Exhaustion + owner
            # destruction is the supported lifetime in this installed build.
            if callable(getattr(decoder.simple_decoder, 'stop', None)):
                decoder.stop()
            del decoder, tensor, batch, uploaded
            gc.collect()
            # Conservative gate: retaining CPU tracking would add another
            # full-frame download, so this optimistic result alone cannot pass.
            row['byteExactInput'] = all(c['exact'] for c in comparisons)
            print(json.dumps(row), flush=True)
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
        for handle in dll_handles:
            handle.close()


if __name__ == '__main__':
    main()
