from __future__ import annotations

import argparse
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class QuietHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._range: tuple[int, int] | None = None
        super().__init__(*args, **kwargs)

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def send_head(self):  # type: ignore[no-untyped-def]
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            source = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        try:
            size = os.fstat(source.fileno()).st_size
            start, end = 0, max(0, size - 1)
            request_range = self.headers.get("Range", "")
            if request_range.startswith("bytes="):
                first, _, last = request_range[6:].partition("-")
                if first:
                    start = min(max(0, int(first)), max(0, size - 1))
                if last:
                    end = min(max(start, int(last)), max(0, size - 1))
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self._range = (start, end)
            else:
                self.send_response(200)
                self._range = (0, end)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Connection", "close")
            self.end_headers()
            source.seek(start)
            return source
        except Exception:
            source.close()
            raise

    def copyfile(self, source, outputfile) -> None:  # type: ignore[no-untyped-def]
        start, end = self._range or (0, -1)
        remaining = max(0, end - start + 1)
        while remaining:
            block = source.read(min(64 * 1024, remaining))
            if not block:
                break
            outputfile.write(block)
            remaining -= len(block)


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, _request: Any, _client_address: Any) -> None:
        return


def request_json(
    base: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def run_case(base: str, source_url: str, face_id: str, start_seconds: float) -> dict[str, Any]:
    started = time.perf_counter()
    created = request_json(
        base,
        "/sessions",
        method="POST",
        payload={
            "channel": "test",
            "sourceUrl": source_url,
            "faceId": face_id,
            "faceIds": [face_id],
            "startSeconds": start_seconds,
            "prefetch": False,
            "prebufferSeconds": 0.5,
            "navigationClass": "seek" if start_seconds > 0 else "foreground",
            "clientEpoch": f"v2899-live-{time.time_ns()}",
            "activationSequence": 1,
        },
    )
    session_id = str(created["session"]["id"])
    stop = threading.Event()
    stream_error: list[str] = []

    def consume() -> None:
        try:
            with urllib.request.urlopen(
                f"{base.rstrip('/')}/sessions/{session_id}/stream",
                timeout=20.0,
            ) as response:
                while not stop.is_set() and response.read(65536):
                    pass
        except Exception as error:
            if not stop.is_set():
                stream_error.append(f"{type(error).__name__}: {error}")

    reader = threading.Thread(target=consume, daemon=True)
    reader.start()
    first_frame_ms = None
    first_playable_ms = None
    first_swapped_frame_ms = None
    final: dict[str, Any] = {}
    deadline = time.monotonic() + 20.0
    try:
        while time.monotonic() < deadline:
            final = request_json(base, f"/sessions/{session_id}", timeout=5.0)["session"]
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            if first_frame_ms is None and int(final.get("frames") or 0) >= 1:
                first_frame_ms = elapsed_ms
            if (
                first_swapped_frame_ms is None
                and float(final.get("firstTransformedFrameAt") or 0.0) > 0.0
            ):
                first_swapped_frame_ms = elapsed_ms
            if first_playable_ms is None and bool(final.get("browserStartupReady")):
                first_playable_ms = elapsed_ms
            if (
                int(final.get("frames") or 0) >= 15
                and bool(final.get("browserStartupReady"))
                and int(final.get("inferenceFrames") or 0) >= 1
            ) or final.get("error"):
                break
            time.sleep(0.05)
    finally:
        stop.set()
        try:
            request_json(base, f"/sessions/{session_id}?defer=false", method="DELETE")
        except OSError:
            pass
        reader.join(timeout=2.0)
    return {
        "startSeconds": start_seconds,
        "firstFrameMs": None if first_frame_ms is None else round(first_frame_ms, 1),
        "firstSwappedFrameMs": (
            None if first_swapped_frame_ms is None else round(first_swapped_frame_ms, 1)
        ),
        "firstPlayableHalfSecondMs": (
            None if first_playable_ms is None else round(first_playable_ms, 1)
        ),
        "fifteenFramesMs": round((time.perf_counter() - started) * 1000.0, 1),
        "frames": int(final.get("frames") or 0),
        "inferenceFrames": int(final.get("inferenceFrames") or 0),
        "reusedFrames": int(final.get("temporalReuseFrames") or 0),
        "muxedMediaSeconds": final.get("muxedMediaSeconds"),
        "frameWorkSeconds": (final.get("timingTotals") or {}).get("frameWorkSeconds"),
        "error": final.get("error") or (stream_error[0] if stream_error else ""),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", default="http://127.0.0.1:8792")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--face-name", default="Approved 23")
    parser.add_argument("--repeats", type=int, default=1)
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    health = request_json(args.service, "/health")
    if health.get("runtime", {}).get("swapAudioEnabled") is not False:
        raise RuntimeError("Live timing benchmark requires swapAudioEnabled=false")
    faces = request_json(args.service, "/faces")["faces"]
    face = next(item for item in faces if item.get("name") == args.face_name)
    handler = lambda *values, **kwargs: QuietHandler(
        *values,
        directory=str(source.parent),
        **kwargs,
    )
    server = QuietServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        source_url = (
            f"http://127.0.0.1:{server.server_address[1]}/"
            f"{urllib.parse.quote(source.name)}"
        )
        cases = [
            {**run_case(args.service, source_url, str(face["id"]), start), "repetition": repetition + 1}
            for repetition in range(max(1, args.repeats))
            for start in (0.0, 5.0)
        ]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
    report = {
        "schema": "pong-live-startup-seek-v1",
        "silent": True,
        "serviceInstanceId": health.get("instanceId"),
        "faceId": face["id"],
        "imageCount": face.get("imageCount"),
        "source": str(source),
        "cases": cases,
    }
    print(json.dumps(report, indent=2))
    return 1 if any(case["error"] for case in cases) else 0


if __name__ == "__main__":
    raise SystemExit(main())
