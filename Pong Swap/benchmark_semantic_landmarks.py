"""Silent diagnostic for Pong's sparse semantic landmark refresh."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import statistics
import time

import av
import cv2
import numpy as np

from pong_swap_engine import PongSwapEngine
from semantic_landmarks import SemanticLandmarkEstimator


ROOT = Path(__file__).resolve().parent
DEFAULT_CLIPS = (
    ROOT / "benchmarks" / "temporal-attachment-20260919" / "input" / "pexels-3761547-silent-720p.mp4",
    ROOT / "benchmarks" / "temporal-attachment-20260919" / "input" / "pexels-18400987-silent-720p.mp4",
)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = max(0.0, min(1.0, fraction)) * (len(ordered) - 1)
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    blend = position - lower
    return ordered[lower] * (1.0 - blend) + ordered[upper] * blend


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clips", nargs="+", type=Path, default=list(DEFAULT_CLIPS))
    parser.add_argument("--seconds", type=float, default=5.0)
    parser.add_argument("--sample-hz", type=float, default=1.0)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "benchmarks" / "semantic-landmarks-20260920",
    )
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    engine = PongSwapEngine()
    config = deepcopy(engine.config)
    config["runtime"]["swapAudioEnabled"] = False
    engine._config = config
    engine.warm(config=config, allow_create_selected=True)
    estimator = SemanticLandmarkEstimator(
        stream_id=int(engine._compute_stream.cuda_stream),
        use_cuda=True,
    )
    results = []
    try:
        for clip in args.clips:
            container = av.open(str(clip))
            stream = container.streams.video[0]
            fps = float(stream.average_rate or 30.0)
            stride = max(1, int(round(fps / max(0.1, args.sample_hz))))
            sampled = 0
            for frame_index, decoded in enumerate(container.decode(stream)):
                if frame_index >= int(round(args.seconds * fps)):
                    break
                if frame_index % stride:
                    continue
                rgb = decoded.to_ndarray(format="rgb24")

                def detect_on_gpu():
                    with engine._lock:
                        with engine._torch.cuda.stream(engine._compute_stream):
                            rows = engine._detect(
                                engine._frame_tensor(rgb),
                                recognize=False,
                                config=config,
                            )
                        engine._compute_stream.synchronize()
                        return rows

                detected = engine._run_gpu_work(
                    detect_on_gpu,
                    priority=0,
                    work_label="semantic-landmark-diagnostic-detect",
                )
                if not detected:
                    results.append({"clip": clip.name, "frame": frame_index, "detected": False})
                    continue
                points5 = np.asarray(detected[0][1], dtype=np.float32)
                estimated = estimator.estimate_from_five(points5)
                semantic = estimator.detect(rgb, points5)
                span = max(1.0, float(np.linalg.norm(points5[1] - points5[0])))
                deviation = np.linalg.norm(semantic.points - estimated, axis=1) / span
                record = {
                    "clip": clip.name,
                    "frame": frame_index,
                    "timeSeconds": frame_index / fps,
                    "detected": True,
                    "provider": semantic.provider,
                    "score": semantic.score,
                    "inferenceMs": semantic.inference_ms,
                    "fanToVisualMedianRatio": float(np.median(deviation)),
                    "fanToVisualP95Ratio": percentile(deviation.tolist(), 0.95),
                }
                results.append(record)
                canvas = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                for point in estimated:
                    cv2.circle(canvas, tuple(np.rint(point).astype(int)), 2, (0, 180, 255), -1)
                for point in semantic.points:
                    cv2.circle(canvas, tuple(np.rint(point).astype(int)), 2, (0, 255, 0), -1)
                for point in points5:
                    cv2.circle(canvas, tuple(np.rint(point).astype(int)), 4, (255, 0, 255), -1)
                cv2.imwrite(
                    str(args.output_dir / f"{clip.stem}-{frame_index:04d}.jpg"),
                    canvas,
                )
                sampled += 1
            container.close()
        latencies = [item["inferenceMs"] for item in results if item.get("detected")]
        scores = [item["score"] for item in results if item.get("detected")]
        report = {
            "silent": True,
            "samples": results,
            "summary": {
                "sampleCount": len(latencies),
                "provider": estimator.provider,
                "inferenceMedianMs": statistics.median(latencies) if latencies else 0.0,
                "inferenceP95Ms": percentile(latencies, 0.95),
                "minimumScore": min(scores) if scores else 0.0,
            },
        }
        report_path = args.output_dir / "report.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({"report": str(report_path), **report["summary"]}, indent=2))
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()


if __name__ == "__main__":
    main()

