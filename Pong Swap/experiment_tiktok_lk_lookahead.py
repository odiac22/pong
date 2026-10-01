"""Offline, exact-output trial of CPU LK lookahead on sub-1.5 MP video.

This file changes no model, quality setting, frame selection, or production
source. It uses the existing production-producer benchmark in two fresh child
processes and changes only TrackingLookahead's minimum pixel gate in the trial
arm. The lookahead's provenance checks and ordinary synchronous fallback stay
unchanged. Both arms use the same TikTok restoration profile and cached file.

Example (GPU owner approval required before execution)::

    python experiment_tiktok_lk_lookahead.py --source C:/cached/input.mp4 \
        --output-dir E:/Pong Benchmarks/tiktok-lk-trial-1
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import time


HERE = Path(__file__).resolve().parent
BENCHMARK = HERE / "run_production_performance_experiment.py"


def _child(mode: str, source: Path, output: Path) -> None:
    import numpy as np
    import pong_swap_lookahead
    import pong_swap_engine

    if mode not in {"baseline", "submegapixel"}:
        raise ValueError(mode)
    original_init = pong_swap_lookahead.TrackingLookahead.__init__
    original_prepare = pong_swap_lookahead.TrackingLookahead.prepare
    original_consume = pong_swap_lookahead.TrackingLookahead.consume
    original_create = pong_swap_engine.PongSwapEngine.create_session
    stats = {
        "mode": mode,
        "offeredNextFrames": 0,
        "subMegapixelOffers": 0,
        "pendingCreated": 0,
        "lookaheadHits": 0,
        "consumeWaitMs": 0.0,
    }

    def initialize(self, track, *, minimum_pixels=1_500_000):
        # The only treatment: enable already-existing exact LK speculation for
        # decoded TikTok frames below the conservative 1.5 MP performance gate.
        if mode == "submegapixel":
            minimum_pixels = 0
        return original_init(self, track, minimum_pixels=minimum_pixels)

    def prepare(self, state, next_frame):
        if isinstance(next_frame, np.ndarray):
            stats["offeredNextFrames"] += 1
            if next_frame.ndim == 3 and next_frame.shape[0] * next_frame.shape[1] < 1_500_000:
                stats["subMegapixelOffers"] += 1
        before = self._pending
        result = original_prepare(self, state, next_frame)
        if self._pending is not None and self._pending is not before:
            stats["pendingCreated"] += 1
        return result

    def consume(self, frame, state):
        before = self.hits
        started = time.perf_counter()
        result = original_consume(self, frame, state)
        stats["consumeWaitMs"] += (time.perf_counter() - started) * 1000.0
        stats["lookaheadHits"] += self.hits - before
        return result

    def create_session(self, *args, **kwargs):
        if "restoration_profile" in kwargs:
            raise RuntimeError("Benchmark unexpectedly supplied a different restoration profile")
        kwargs["restoration_profile"] = "tiktok-face-size"
        return original_create(self, *args, **kwargs)

    pong_swap_lookahead.TrackingLookahead.__init__ = initialize
    pong_swap_lookahead.TrackingLookahead.prepare = prepare
    pong_swap_lookahead.TrackingLookahead.consume = consume
    pong_swap_engine.PongSwapEngine.create_session = create_session
    saved_argv = sys.argv
    sys.argv = [str(BENCHMARK), "--source", str(source), "--output-dir", str(output),
                "--experiment", "frozen-exact", "--no-frame-diagnostics",
                "--capture-frame-hashes"]
    try:
        runpy.run_path(str(BENCHMARK), run_name="__main__")
    finally:
        sys.argv = saved_argv
        output.mkdir(parents=True, exist_ok=True)
        (output / "lookahead.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")


def _summary(output: Path) -> dict:
    base = json.loads((output / "baseline" / "report.json").read_text(encoding="utf-8"))
    trial = json.loads((output / "submegapixel" / "report.json").read_text(encoding="utf-8"))
    b_frames = base["frames"]
    t_frames = trial["frames"]
    same_pixels = b_frames == t_frames
    same_temporal = base["temporal"] == trial["temporal"]
    same_source = base["sourceSha256"] == trial["sourceSha256"]
    result = {
        "sourceSha256": base["sourceSha256"],
        "sourceSame": same_source,
        "frameCount": len(b_frames),
        "outputCrcSame": same_pixels,
        "temporalSame": same_temporal,
        "baselineCompletedFps": base["endToEndFps"],
        "trialCompletedFps": trial["endToEndFps"],
        "baselineWorkFps": base["workFps"],
        "trialWorkFps": trial["workFps"],
        "baselineLookahead": json.loads((output / "baseline" / "lookahead.json").read_text(encoding="utf-8")),
        "trialLookahead": json.loads((output / "submegapixel" / "lookahead.json").read_text(encoding="utf-8")),
    }
    (output / "comparison.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    if not (same_source and same_pixels and same_temporal):
        raise RuntimeError("Exact source/output/temporal parity failed; reject experiment")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--child", choices=("baseline", "submegapixel"))
    parser.add_argument("--reverse", action="store_true", help="Run the threshold trial before baseline")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if source.suffix.lower() != ".mp4":
        raise ValueError("Only an existing local MP4 is supported")
    output = args.output_dir.resolve()
    if args.child:
        _child(args.child, source, output)
        return
    if output.exists():
        raise FileExistsError(f"Use a fresh output directory: {output}")
    output.mkdir(parents=True)
    # The source is never copied or modified. Child benchmark serves it on a
    # process-local loopback endpoint, exactly like its existing parity harness.
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    print(f"sourceSha256={source_hash} byteCount={source.stat().st_size}", flush=True)
    order = ("submegapixel", "baseline") if args.reverse else ("baseline", "submegapixel")
    for mode in order:
        subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--source", str(source),
             "--output-dir", str(output / mode), "--child", mode],
            check=True, timeout=110,
        )
    print(json.dumps(_summary(output), indent=2), flush=True)


if __name__ == "__main__":
    main()
