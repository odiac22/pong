"""Bounded full-path preparation before ASGI admits playback requests.

Only enabled for the explicitly approved 1024 release. Uses a hash-checked
licensed local holdout, never the user's Recall list or a network website.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import threading
import time

PLAN_SHA = '830adda04355c958f5fe7c36b1230ea7bb10c03aa88a7a7abd1414fdf764d98b'
FIXTURE_SHA = '2a9c1994e66a212f8cb6009aaf02cab38603a247cefcaf81d53cea63d09e309b'


def enabled(config):
    import json
    path = str((config.get('runtime') or {}).get('restorerNativeTrtQualifiedPlan1024', ''))
    if not path or (config.get('parameters') or {}).get('RestorerTypeTextSel') != 'GPEN1024':
        return False
    try:
        manifest = json.loads(Path(path + '.manifest.json').read_text(encoding='utf-8'))
        return (manifest.get('schema') == 'pong-gpen-user-reviewed-plan-v1'
                and manifest.get('planSha256') == PLAN_SHA)
    except (OSError, ValueError):
        return False


def prepare(engine):
    began = time.perf_counter()
    baseline, revision = engine._config_snapshot()
    if not enabled(baseline) or engine._active_session_count():
        raise RuntimeError('Approved idle startup preparation is unavailable')
    if baseline['runtime'].get('swapAudioEnabled') is not False:
        raise RuntimeError('Startup preparation must be silent')
    fixture = Path(__file__).resolve().parent / 'benchmarks/realtime-stock-corpus/input/clip-06.mp4'
    payload = fixture.read_bytes()
    if hashlib.sha256(payload).hexdigest() != FIXTURE_SHA:
        raise RuntimeError('Startup holdout bytes changed')
    engine.warm()
    warm_ms = (time.perf_counter() - began) * 1000
    from pong_exact_runtime.vendor.experiment_mask_overlap import prewarm
    # Finish secondary ORT initialization before any full-path CUDA capture.
    side = prewarm(engine._vm, baseline['parameters'],
                   adaptive=bool(baseline['runtime'].get('maskAdaptiveBackendEnabled', False)))
    faces = list(engine.scan_faces())
    face = next((f for f in faces if f.id == 'approved-8-f7bf754ac81f'), None)
    if face is None:
        raise RuntimeError('Approved warmup identity is unavailable')
    engine.embedding_for_face(face.id)
    if engine._config_snapshot()[1] != revision or engine._active_session_count():
        raise RuntimeError('State changed before startup preparation')

    class Media(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_HEAD(self):
            self.media(False)

        def do_GET(self):
            self.media(True)

        def media(self, body):
            if self.path != '/preroll.mp4':
                self.send_error(404)
                return
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
            start = int(match[1]) if match else 0
            end = min(int(match[2]), len(payload)-1) if match and match[2] else len(payload)-1
            if start > end:
                self.send_error(416)
                return
            self.send_response(206 if match else 200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end-start+1))
            if match:
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(payload)}')
            self.end_headers()
            if body:
                try:
                    self.wfile.write(payload[start:end+1])
                except (BrokenPipeError, ConnectionResetError):
                    pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Media)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    session = None
    stop = threading.Event()
    worker = None
    primer_at = time.perf_counter()
    try:
        session = engine.create_session(channel='test',
            source_url=f'http://127.0.0.1:{server.server_port}/preroll.mp4',
            face_id=face.id, face_ids=[face.id], start_seconds=4.5,
            prefetch=False, prebuffer_seconds=.5, navigation_class='foreground')

        def credit():
            while not stop.wait(.08):
                if time.perf_counter()-primer_at > 20:
                    engine.stop_session(session.id, deferred=True)
                    return
                engine.update_playback(session.id,
                    position_seconds=session.frames/max(1, session.fps), paused=False)

        worker = threading.Thread(target=credit, daemon=True)
        worker.start()
        first = None
        for chunk in engine.stream_session(session.id, activate=True):
            if chunk and first is None:
                first = (time.perf_counter()-primer_at)*1000
        if (session.error or not session.complete or session.transformed_frames <= 0):
            raise RuntimeError('Startup full-path primer did not complete a transformed frame')
        return dict(enabled=True, ready=True, warmMs=round(warm_ms, 3),
                    sideWarmMs=round(side['seconds']*1000, 3),
                    primerMs=round((time.perf_counter()-primer_at)*1000, 3),
                    elapsedMs=round((time.perf_counter()-began)*1000, 3),
                    firstEncodedByteMs=round(first or 0, 3),
                    frames=session.frames, silent=True, beforeRequestAdmission=True)
    finally:
        stop.set()
        if worker:
            worker.join(timeout=2)
        if session is not None:
            engine.stop_session(session.id, deferred=False)
        server.shutdown()
        server.server_close()
