from __future__ import annotations

import argparse
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
VIDEO_ROOT = ROOT / "benchmarks" / "identity-gate" / "videos"
REPORT_ROOT = ROOT / "reports"

VIDEO_NAMES = (
    "women-holding-hands-while-sitting-on-sofa-4796469.mp4",
    "women-wearing-coat-staring-8477530.mp4",
    "women-posing-at-the-camera-6466912.mp4",
)


class QuietFileHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: Any) -> None:
        return


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, _request: Any, _client_address: Any) -> None:
        # PyAV intentionally closes the HTTP reader as soon as a test session is
        # retired. That normal cancellation must not pollute benchmark output.
        return


def request_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    body = None
    headers: dict[str, str] = {}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=body,
        method=method,
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_session(
    base_url: str,
    session_id: str,
    *,
    expected_status: str,
    timeout_seconds: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    deadline = time.monotonic() + timeout_seconds
    observations: list[dict[str, Any]] = []
    lock_frame = -1
    locked_face_id = ""
    while time.monotonic() < deadline:
        session = request_json(base_url, f"/sessions/{session_id}")["session"]
        observation = {
            "state": session.get("state"),
            "frames": int(session.get("frames") or 0),
            "inferenceFrames": int(session.get("inferenceFrames") or 0),
            "compatibilityStatus": session.get("compatibilityStatus"),
            "selectedFaceId": session.get("selectedFaceId") or "",
            "selectedFaceSimilarity": session.get("selectedFaceSimilarity"),
            "selectedTargetPresentation": session.get("selectedTargetPresentation") or "",
            "compatibilityChecks": int(session.get("compatibilityChecks") or 0),
            "compatibilityRejections": int(session.get("compatibilityRejections") or 0),
            "error": session.get("error") or "",
        }
        if not observations or observations[-1] != observation:
            observations.append(observation)
        if observation["error"]:
            raise RuntimeError(observation["error"])
        if expected_status == "no-compatible-face":
            if (
                observation["compatibilityStatus"] == expected_status
                and observation["frames"] >= 5
                and not observation["selectedFaceId"]
                and observation["inferenceFrames"] == 0
            ):
                return session, observations
        elif observation["compatibilityStatus"] == expected_status:
            current_face_id = str(observation["selectedFaceId"])
            if not current_face_id:
                raise AssertionError("locked session did not expose its selected face")
            if not locked_face_id:
                locked_face_id = current_face_id
                lock_frame = observation["frames"]
            elif current_face_id != locked_face_id:
                raise AssertionError(
                    f"selected face switched from {locked_face_id} to {current_face_id}"
                )
            if (
                observation["frames"] >= lock_frame + 5
                and observation["inferenceFrames"] > 0
            ):
                return session, observations
        time.sleep(0.20)
    raise TimeoutError(
        f"session {session_id} did not reach {expected_status}: "
        f"{observations[-1] if observations else 'no status'}"
    )


def run_case(
    base_url: str,
    source_url: str,
    face_ids: list[str],
    *,
    expected_status: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    started = time.perf_counter()
    created = request_json(
        base_url,
        "/sessions",
        method="POST",
        payload={
            "channel": "test",
            "sourceUrl": source_url,
            "faceId": face_ids[0],
            "faceIds": face_ids,
            "startSeconds": 0,
            "prefetch": False,
            "prebufferSeconds": 0.5,
            "navigationClass": "foreground",
            "clientEpoch": f"identity-gate-{time.time_ns()}",
            "activationSequence": 1,
        },
    )
    session_id = str(created["session"]["id"])
    try:
        session, observations = wait_for_session(
            base_url,
            session_id,
            expected_status=expected_status,
            timeout_seconds=timeout_seconds,
        )
        return {
            "ok": True,
            "sessionId": session_id,
            "elapsedSeconds": round(time.perf_counter() - started, 3),
            "candidateFaceIds": face_ids,
            "final": {
                "frames": session.get("frames"),
                "inferenceFrames": session.get("inferenceFrames"),
                "compatibilityStatus": session.get("compatibilityStatus"),
                "selectedFaceId": session.get("selectedFaceId"),
                "selectedFaceSimilarity": session.get("selectedFaceSimilarity"),
                "selectedTargetPresentation": session.get(
                    "selectedTargetPresentation"
                ),
                "compatibilityChecks": session.get("compatibilityChecks"),
                "compatibilityRejections": session.get(
                    "compatibilityRejections"
                ),
            },
            "observations": observations,
        }
    finally:
        try:
            # Every isolated identity case intentionally reuses the dedicated
            # ``test`` channel.  Wait for native teardown before creating the
            # next case so deferred retirement from the prior producer cannot
            # race the following session's first status poll.
            request_json(base_url, f"/sessions/{session_id}?defer=false", method="DELETE")
        except (OSError, urllib.error.URLError):
            pass


def face_id_by_name(faces: list[dict[str, Any]], name: str) -> str:
    lowered = name.casefold()
    for face in faces:
        if str(face.get("name") or "").casefold() == lowered:
            return str(face["id"])
    raise KeyError(f"approved face not found: {name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", default="http://127.0.0.1:8792")
    parser.add_argument("--male-name", default="Benchmark Adult Male")
    parser.add_argument(
        "--candidate-names",
        nargs=5,
        default=["Approved 4", "Approved 8", "Approved 21", "Approved 2", "Approved 3"],
    )
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    for name in VIDEO_NAMES:
        path = VIDEO_ROOT / name
        if not path.is_file() or path.stat().st_size <= 0:
            raise FileNotFoundError(path)

    health = request_json(args.service, "/health")
    if health.get("runtime", {}).get("swapAudioEnabled") is not False:
        raise RuntimeError("benchmark requires swapAudioEnabled=false")
    faces = request_json(args.service, "/faces")["faces"]
    male_id = face_id_by_name(faces, args.male_name)
    candidate_ids = [face_id_by_name(faces, name) for name in args.candidate_names]
    if len(set(candidate_ids)) != 5:
        raise AssertionError("five distinct approved candidate identities are required")

    handler = lambda *handler_args, **handler_kwargs: QuietFileHandler(
        *handler_args, directory=str(VIDEO_ROOT), **handler_kwargs
    )
    server = QuietThreadingHTTPServer(("127.0.0.1", 0), handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    media_port = server.server_address[1]
    report: dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "serviceInstanceId": health.get("instanceId"),
        "audioEnabled": health.get("runtime", {}).get("swapAudioEnabled"),
        "adultMaleNegative": [],
        "fiveCandidateSelection": [],
    }
    try:
        for video_name in VIDEO_NAMES:
            source_url = (
                f"http://127.0.0.1:{media_port}/"
                f"{urllib.parse.quote(video_name)}"
            )
            negative = run_case(
                args.service,
                source_url,
                [male_id],
                expected_status="no-compatible-face",
                timeout_seconds=args.timeout,
            )
            negative["video"] = video_name
            report["adultMaleNegative"].append(negative)

            multi = run_case(
                args.service,
                source_url,
                candidate_ids,
                expected_status="locked",
                timeout_seconds=args.timeout,
            )
            multi["video"] = video_name
            report["fiveCandidateSelection"].append(multi)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2.0)

    report["passed"] = all(
        item.get("ok")
        for group in ("adultMaleNegative", "fiveCandidateSelection")
        for item in report[group]
    )
    REPORT_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = REPORT_ROOT / "identity-compatibility-latest.json"
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"REPORT={output_path}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
