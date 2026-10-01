"""Re-run temporal quality analysis on already rendered silent benchmark outputs.

This diagnostic never renders media or changes runtime settings.  It adds the
per-sampled-frame metric record used to identify tail failures without paying
for another GPEN pass.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path

from benchmark_temporal_attachment import DEFAULT_CLIPS, analyze_pair
from pong_swap_engine import PongSwapEngine


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("reports", type=Path, nargs="+")
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--sample-fps", type=float, default=10.0)
    args = parser.parse_args()

    reports = [
        json.loads(path.resolve().read_text(encoding="utf-8"))
        for path in args.reports
    ]
    engine = PongSwapEngine()
    config = deepcopy(reports[0]["configuration"])
    config["runtime"]["swapAudioEnabled"] = False
    engine._config = config
    engine.warm(config=config, allow_create_selected=True)
    source_by_name = {path.name: path for path in DEFAULT_CLIPS}
    try:
        for report_path, report in zip(args.reports, reports):
            report_sources = dict(source_by_name)
            fixture_output = (report.get("occlusionFixture") or {}).get("output")
            if fixture_output:
                fixture_path = Path(fixture_output)
                report_sources[fixture_path.name] = fixture_path
            analyses = []
            for clip in report.get("clips", []):
                source = report_sources[str(clip["clip"])]
                output = Path(clip["output"])
                result = analyze_pair(
                    engine,
                    source,
                    output,
                    max_seconds=float(args.seconds),
                    sample_fps=float(args.sample_fps),
                    occlusion_fixture="popsicle-occlusion" in source.name,
                    frame_provenance=(
                        clip.get("transformation", {}).get("frameProvenance", [])
                    ),
                )
                analyses.append({"clip": source.name, "quality": result})
            destination = report_path.resolve().parent / "frame-analysis.json"
            destination.write_text(
                json.dumps({"silent": True, "clips": analyses}, indent=2),
                encoding="utf-8",
            )
            print(destination, flush=True)
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()


if __name__ == "__main__":
    main()
