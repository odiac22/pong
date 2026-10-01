from __future__ import annotations

import json

import cv2
import numpy as np

from benchmark_stock import (
    SOURCE_PATH,
    VIDEO_PATH,
    _duration,
    _probe,
    _recognized_embedding,
    _similarity,
)
from pong_swap_config import CACHE_DIR
from pong_swap_engine import PongSwapEngine


OUTPUT_PATH = CACHE_DIR / "benchmark" / "proxied-stream.mp4"


def run() -> dict:
    engine = PongSwapEngine()
    engine.warm()
    source_embedding = engine.embedding_from_images([SOURCE_PATH])
    before_capture = cv2.VideoCapture(str(VIDEO_PATH))
    after_capture = cv2.VideoCapture(str(OUTPUT_PATH))
    fps = float(before_capture.get(cv2.CAP_PROP_FPS) or 24.0)
    every = max(1, round(fps))
    frame_index = 0
    samples = []
    try:
        while True:
            before_ok, before_bgr = before_capture.read()
            after_ok, after_bgr = after_capture.read()
            if not before_ok or not after_ok:
                break
            if frame_index % every == 0:
                before = cv2.cvtColor(before_bgr, cv2.COLOR_BGR2RGB)
                after = cv2.cvtColor(after_bgr, cv2.COLOR_BGR2RGB)
                before_embedding = _recognized_embedding(engine, before)
                after_embedding = _recognized_embedding(engine, after)
                if before_embedding is not None and after_embedding is not None:
                    samples.append(
                        {
                            "frame": frame_index,
                            "before": _similarity(engine, before_embedding, source_embedding),
                            "after": _similarity(engine, after_embedding, source_embedding),
                            "pixelDelta": float(
                                np.mean(
                                    np.abs(after.astype(np.int16) - before.astype(np.int16))
                                )
                            ),
                        }
                    )
            frame_index += 1
    finally:
        before_capture.release()
        after_capture.release()
    input_duration = _duration(_probe(VIDEO_PATH))
    output_duration = _duration(_probe(OUTPUT_PATH))
    mean_before = float(np.mean([sample["before"] for sample in samples]))
    mean_after = float(np.mean([sample["after"] for sample in samples]))
    report = {
        "ok": (
            len(samples) >= 5
            and mean_after - mean_before >= 3.0
            and abs(input_duration - output_duration) <= 1.0 / fps + 0.005
        ),
        "sampleCount": len(samples),
        "meanSourceSimilarityBefore": round(mean_before, 3),
        "meanSourceSimilarityAfter": round(mean_after, 3),
        "identityGain": round(mean_after - mean_before, 3),
        "inputDuration": input_duration,
        "outputDuration": output_duration,
        "durationDelta": round(abs(input_duration - output_duration), 6),
        "samples": samples,
    }
    print(json.dumps(report, indent=2))
    if not report["ok"]:
        raise SystemExit(2)
    return report


if __name__ == "__main__":
    run()
