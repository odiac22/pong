"""Two-process A/B of discard-only TikTok full-path cold preflight.

Run once with --mode control and once with --mode preflight, each in a fresh
process while the ordinary renderer is stopped.  This is stage attribution,
not FPS qualification.  Output JSON contains hashes/timings only, no face ID,
image path, embedding vector, or image pixels.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def require_renderer_stopped(url: str = "http://127.0.0.1:8792/health") -> None:
    try:
        with urlopen(url, timeout=1):
            pass
    except HTTPError as exc:
        raise RuntimeError(f"Renderer endpoint responded HTTP {exc.code}; stop it") from exc
    except (URLError, TimeoutError, OSError):
        return
    raise RuntimeError("Renderer is reachable; stop it before offline GPU testing")


def select_approved_frame(engine, config, face_index: int, max_edge: int):
    """Use the approved catalog/API without exposing an ID or source path."""
    import cv2
    import numpy as np

    faces = engine.scan_faces()
    if face_index < 0 or face_index >= len(faces):
        raise ValueError("Approved-face index is out of range")
    face = faces[face_index]
    image = None
    for path in face.files:
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is not None and min(image.shape[:2]) >= 128:
            break
    if image is None or min(image.shape[:2]) < 128:
        raise RuntimeError("Selected approved face has no usable local image")
    height, width = image.shape[:2]
    if max(height, width) > max_edge:
        scale = max_edge / max(height, width)
        image = cv2.resize(
            image, (max(128, round(width * scale)), max(128, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    frame = np.ascontiguousarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    embedding = np.asarray(engine.embedding_for_face(face.id, config), dtype=np.float32)
    return frame, embedding, hashlib.sha256(face.id.encode("utf-8")).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("control", "preflight"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--face-index", type=int, default=0)
    parser.add_argument("--max-edge", type=int, default=480)
    args = parser.parse_args(argv)
    if args.max_edge < 256 or args.max_edge > 1920:
        parser.error("--max-edge must be between 256 and 1920")
    require_renderer_stopped()
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError("Refusing to overwrite an earlier experiment")
    output.parent.mkdir(parents=True, exist_ok=True)

    import pong_swap_config as cfg
    saved_config = cfg.load_config()
    cfg.CACHE_DIR = output.parent / (output.stem + "-cache")
    cfg.CACHE_DIR.mkdir(exist_ok=False)
    cfg.load_config = lambda: copy.deepcopy(saved_config)
    cfg.save_config = lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError("Experiment forbids preset writes")
    )
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    os.environ.setdefault("PONG_MASK_OVERLAP_POLICY", "guarded")
    from pong_swap_engine import PongSwapEngine
    from pong_tiktok_restorer import PROFILE, session_config_for_profile
    from pong_exact_runtime.service_adapter import bootstrap_cold
    from experiment_tiktok_full_preflight import run_on_owner

    engine = PongSwapEngine()
    try:
        handle, adapter = bootstrap_cold(engine, requested=True)
        if not handle.installed or adapter is None:
            raise RuntimeError("Qualified frozen exact stack did not install")
        profile = session_config_for_profile(saved_config, PROFILE)
        warm_started = time.perf_counter()
        engine.warm(config=profile, allow_create_selected=True)
        warm_ms = (time.perf_counter() - warm_started) * 1000.0
        source_started = time.perf_counter()
        frame, embedding, face_hash = select_approved_frame(
            engine, profile, args.face_index, args.max_edge,
        )
        source_ms = (time.perf_counter() - source_started) * 1000.0
        preflight_result = None
        if args.mode == "preflight":
            preflight_result = engine._run_gpu_work(
                run_on_owner, engine, frame, embedding, profile,
                priority=0, work_label="offline-full-preflight",
            )
        measured = engine._run_gpu_work(
            run_on_owner, engine, frame, embedding, profile,
            priority=0, work_label="offline-first-frame",
        )
        if preflight_result is not None and (
                preflight_result["outputSha256"] != measured["outputSha256"]):
            raise RuntimeError("Preflight changed the exact output pixels")
        report = {
            "mode": args.mode,
            "diagnosticOnly": True,
            "faceIdSha256": face_hash,
            "profile": PROFILE,
            "warmMs": warm_ms,
            "sourcePrepMs": source_ms,
            "preflight": preflight_result,
            "measured": measured,
        }
        with output.open("x", encoding="utf-8") as target:
            json.dump(report, target, indent=2, sort_keys=True)
            target.write("\n")
        print(json.dumps({
            "mode": args.mode,
            "output": str(output),
            "preflightMs": None if preflight_result is None else preflight_result["elapsedMs"],
            "measuredMs": measured["elapsedMs"],
            "restorerMs": measured["restorerCudaMs"],
            "outputSha256": measured["outputSha256"],
        }, sort_keys=True))
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()


if __name__ == "__main__":
    main()
