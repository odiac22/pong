from __future__ import annotations

import json
import threading
import time
import urllib.parse
from pathlib import Path

import av

from benchmark_identity_compatibility import (
    QuietFileHandler,
    QuietThreadingHTTPServer,
    face_id_by_name,
    request_json,
    run_case,
)


ROOT = Path(__file__).resolve().parent
VIDEO_ROOT = ROOT / "benchmarks" / "identity-gate" / "generated"
REPORT_ROOT = ROOT / "reports"
SERVICE = "http://127.0.0.1:8792"


def video_has_audio(path: Path) -> bool:
    with av.open(str(path)) as container:
        return any(stream.type == "audio" for stream in container.streams)


def main() -> int:
    videos = {
        "same": VIDEO_ROOT / "approved-2-silent.mp4",
        "different_female": VIDEO_ROOT / "approved-3-silent.mp4",
        "different_male": VIDEO_ROOT / "adult-male-silent.mp4",
    }
    for path in videos.values():
        if not path.is_file() or path.stat().st_size <= 0:
            raise FileNotFoundError(path)
        if video_has_audio(path):
            raise RuntimeError(f"strictness fixture unexpectedly contains audio: {path}")

    health = request_json(SERVICE, "/health")
    if health.get("runtime", {}).get("swapAudioEnabled") is not False:
        raise RuntimeError("benchmark requires swapAudioEnabled=false")
    settings = request_json(SERVICE, "/settings")["config"]
    original_strictness = int(settings["parameters"]["DetectScoreSlider"])
    faces = request_json(SERVICE, "/faces")["faces"]
    approved_2 = face_id_by_name(faces, "Approved 2")

    handler = lambda *args, **kwargs: QuietFileHandler(
        *args, directory=str(VIDEO_ROOT), **kwargs
    )
    server = QuietThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])

    cases = (
        ("male-rejected-even-permissive", 0, "different_male", "no-compatible-face"),
        ("different-woman-accepted-permissive", 0, "different_female", "locked"),
        ("same-face-accepted-normal", 45, "same", "locked"),
        ("different-woman-rejected-normal", 45, "different_female", "no-compatible-face"),
        ("same-face-accepted-high", 90, "same", "locked"),
        ("different-woman-rejected-high", 90, "different_female", "no-compatible-face"),
    )
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "serviceInstanceId": health.get("instanceId"),
        "audioEnabled": health.get("runtime", {}).get("swapAudioEnabled"),
        "fixtureAudioStreams": 0,
        "originalStrictness": original_strictness,
        "cases": [],
    }
    try:
        for name, strictness, video_key, expected_status in cases:
            request_json(
                SERVICE,
                "/settings/preview",
                method="PUT",
                payload={"parameters": {"DetectScoreSlider": strictness}},
            )
            video_name = videos[video_key].name
            source_url = (
                f"http://127.0.0.1:{port}/"
                f"{urllib.parse.quote(video_name)}"
            )
            result = run_case(
                SERVICE,
                source_url,
                [approved_2],
                expected_status=expected_status,
                timeout_seconds=30.0,
            )
            result.update(
                {
                    "name": name,
                    "strictness": strictness,
                    "video": video_name,
                    "expectedStatus": expected_status,
                }
            )
            report["cases"].append(result)
    finally:
        request_json(
            SERVICE,
            "/settings/preview",
            method="PUT",
            payload={"parameters": {"DetectScoreSlider": original_strictness}},
        )
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)

    report["restoredStrictness"] = request_json(SERVICE, "/settings")["config"][
        "parameters"
    ]["DetectScoreSlider"]
    report["passed"] = bool(
        report["restoredStrictness"] == original_strictness
        and len(report["cases"]) == len(cases)
        and all(case.get("ok") for case in report["cases"])
    )
    REPORT_ROOT.mkdir(parents=True, exist_ok=True)
    timestamped = REPORT_ROOT / f"identity-strictness-{time.strftime('%Y%m%d-%H%M%S')}.json"
    latest = REPORT_ROOT / "identity-strictness-latest.json"
    encoded = json.dumps(report, indent=2)
    timestamped.write_text(encoded, encoding="utf-8")
    latest.write_text(encoded, encoding="utf-8")
    print(encoded)
    print(f"REPORT={timestamped}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
