"""Isolated five-clip review. Numeric differences are recorded, not vetoed.

No production settings, model bytes, qualification manifest or service is patched.
The optional loader exists only in this disposable process and is explicitly
unqualified. Tensor shape, finite warmup, resource lifetime and audio guards remain.
"""
import argparse
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent


def live_idle():
    with urlopen('http://127.0.0.1:8792/health', timeout=4) as response:
        value = json.load(response)
    if value.get('activeSessions') or value.get('embeddingPrimerActive'):
        raise RuntimeError('Live Pong became active; review must not compete')
    return value


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output-dir', type=Path, required=True)
    p.add_argument('--edge', type=int, choices=(256, 512, 1024), required=True)
    p.add_argument('--face-id', required=True)
    p.add_argument('--label', default='Isolated visual review')
    p.add_argument('--runtime-overrides', type=Path)
    p.add_argument('--decode-ahead', action='store_true')
    p.add_argument('--decode-ahead-rgb', action='store_true', help='Refined decode-owner RGB conversion; requires --decode-ahead')
    p.add_argument('--diagnostics', action='store_true', help='Separate instrumented profiling run, not headline timing')
    p.add_argument('--prime-pipeline', action='store_true', help='Explicitly timed idle full-path warmup on holdout clip 6')
    p.add_argument('--primer-start', type=float, default=0, help='Holdout primer seek only; scored clips always start at zero')
    p.add_argument('--prewarm-side-masks', action='store_true', help='Finish secondary model initialization before graph capture')
    p.add_argument('--restoration-profile', choices=('default','tiktok-face-size','tiktok-face-size-motion-trial'), default='default')
    p.add_argument('--candidate-plan', type=Path)
    p.add_argument('--acknowledge-unqualified-visual-review', action='store_true')
    args = p.parse_args()
    if args.decode_ahead_rgb and not args.decode_ahead:
        p.error('--decode-ahead-rgb requires --decode-ahead')
    if not 0 <= args.primer_start <= 5 or (args.primer_start and not args.prime_pipeline):
        p.error('Primer seek must be 0..5 seconds and requires --prime-pipeline')
    if args.candidate_plan and not args.acknowledge_unqualified_visual_review:
        p.error('Candidate requires explicit visual-review acknowledgement')
    live_idle()
    out = args.output_dir.resolve()
    parent = Path('E:/Pong Benchmarks/user-quality-review-2026-09-30').resolve()
    if not out.is_relative_to(parent) or out == parent:
        raise ValueError('Review output must be a fresh child of the review folder')
    out.mkdir(parents=True, exist_ok=False)
    import pong_swap_config as cfg
    preset_bytes = cfg.CURRENT_PRESET.read_bytes()
    config = copy.deepcopy(cfg.load_config())
    if config['runtime'].get('swapAudioEnabled') is not False:
        raise RuntimeError('No audio is permitted')
    config['parameters']['RestorerTypeTextSel'] = f'GPEN{args.edge}'
    if args.runtime_overrides:
        changes = json.loads(args.runtime_overrides.read_text(encoding='utf-8'))
        if not isinstance(changes, dict) or any(k not in config['runtime'] for k in changes):
            raise ValueError('Runtime overrides must contain existing setting names only')
        if changes.get('swapAudioEnabled', False) is not False:
            raise ValueError('Audio cannot be enabled')
        config['runtime'].update(changes)
    cfg.CACHE_DIR = out/'cache'
    cfg.CACHE_DIR.mkdir()
    cfg.load_config = lambda: copy.deepcopy(config)
    cfg.save_config = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('No production preset writes'))
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    plan_info = None
    if args.candidate_plan:
        plan = args.candidate_plan.resolve(strict=True)
        allowed = (Path('E:/Pong Benchmarks').resolve(), ROOT/'benchmarks', ROOT/'runtime')
        if plan.suffix != '.plan' or not any(plan.is_relative_to(d) for d in allowed):
            raise ValueError('Unexpected candidate artifact location/type')
        plan_bytes = plan.read_bytes()
        plan_info = {'path': str(plan), 'sha256': hashlib.sha256(plan_bytes).hexdigest(), 'qualified': False}
        from rope.gpen_runtime import GPENRuntime
        original_native = GPENRuntime._native_trt_state

        def review_native(self, edge, stream, workspace, *, allow_tf32):
            if edge != args.edge:
                return original_native(self, edge, stream, workspace, allow_tf32=allow_tf32)
            if stream is None:
                raise RuntimeError('Owned CUDA stream is required')
            import tensorrt as trt
            runtime = trt.Runtime(trt.Logger(trt.Logger.WARNING))
            engine = runtime.deserialize_cuda_engine(plan_bytes)
            if engine is None:
                raise RuntimeError('Candidate plan could not deserialize')
            names = [engine.get_tensor_name(i) for i in range(engine.num_io_tensors)]
            if set(names) != {'input', 'output'} or len(names) != 2:
                raise RuntimeError('Unexpected plan bindings')
            for name, mode in [('input', trt.TensorIOMode.INPUT), ('output', trt.TensorIOMode.OUTPUT)]:
                if (engine.get_tensor_mode(name) != mode or
                    tuple(engine.get_tensor_shape(name)) != (1, 3, edge, edge) or
                    engine.get_tensor_dtype(name) != trt.float32):
                    raise RuntimeError('Candidate I/O contract mismatch')
            context = engine.create_execution_context()
            if context is None:
                raise RuntimeError('Could not allocate candidate execution context')
            return {'runtime': runtime, 'engine': engine, 'context': context,
                    'planPath': str(plan), 'planSha256': plan_info['sha256'],
                    'qualifiedPlan': False, 'qualifiedPlanManifest': None,
                    'precisionPolicy': 'USER-VISUAL-REVIEW-UNQUALIFIED', 'pluginModule': None,
                    'identity': self._native_trt_identity(edge, workspace, trt, allow_tf32=allow_tf32), 'kind': 'full'}
        GPENRuntime._native_trt_state = review_native
    os.environ['PONG_MASK_OVERLAP_POLICY'] = 'guarded'
    from pong_exact_runtime.install import install_cold, model_binding_token
    handle = install_cold(cfg.MODELS_DIR, binding_token=model_binding_token(config, cfg.MODELS_DIR), requested=True)
    if not handle.installed:
        raise RuntimeError('Existing acceleration bundle integrity failed')
    from pong_swap_engine import PongSwapEngine
    engine = PongSwapEngine()
    if args.decode_ahead_rgb:
        from experiment_review_rgb_ahead import install
        install(engine)
    elif args.decode_ahead:
        from experiment_tiktok_decode_ahead import install
        install(engine, review_allow_default=args.restoration_profile=='default')
    corpus = ROOT/'benchmarks/realtime-stock-corpus/input'
    sources = {f'/clip-{i:02d}.mp4': corpus/f'clip-{i:02d}.mp4' for i in range(1, 7)}
    # Low-overhead wall measurements are identical in before and after runs.
    # CUDA-event profiling is separate because it can change synchronization.
    frame_times = []
    original_process_frame = engine.process_frame
    def measured_process_frame(*a, **kw):
        started = time.perf_counter()
        try:
            return original_process_frame(*a, **kw)
        finally:
            frame_times.append((time.perf_counter()-started)*1000)
    engine.process_frame = measured_process_frame

    class Media(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_media(True)

        def do_HEAD(self):
            self.send_media(False)

        def send_media(self, body):
            source = sources.get(self.path)
            if source is None:
                self.send_error(404)
                return
            size = source.stat().st_size
            start, end = 0, size-1
            value = self.headers.get('Range')
            if value:
                import re
                m = re.fullmatch(r'bytes=(\d+)-(\d*)', value)
                if not m:
                    self.send_error(416)
                    return
                start = int(m[1])
                if m[2]:
                    end = min(end, int(m[2]))
            if start > end or start >= size:
                self.send_error(416)
                return
            self.send_response(206 if value else 200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end-start+1))
            if value:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if body:
                try:
                    with source.open('rb') as f:
                        f.seek(start)
                        remaining = end-start+1
                        while remaining:
                            chunk = f.read(min(remaining, 256*1024))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Media)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {'schema': 'user-visual-review-v1', 'scope': 'Full renderer/encoder, unpaced local consumption; not phone load latency or display FPS',
              'label': args.label, 'faceId': args.face_id, 'restorer': f'GPEN{args.edge}', 'candidatePlan': plan_info,
              'decodeAhead': args.decode_ahead,
              'decodeAheadRgb': args.decode_ahead_rgb,
              'diagnosticsEnabled': args.diagnostics, 'pipelinePrimerRequested': args.prime_pipeline,
              'sideMaskPrewarmRequested': args.prewarm_side_masks,
              'primerStartSeconds': args.primer_start,
              'restorationProfile': args.restoration_profile,
              'harnessSha256': digest(Path(__file__)),
              'frozenRuntimeSha256': digest(ROOT/'pong_exact_runtime/frozen_methods.py'),
              'startedAtUtc': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
              'qualityDecision': 'awaiting user', 'productionChanged': False,
              'silent': True, 'settings': config, 'clips': []}
    session = None
    stop = threading.Event()
    def checkpoint():
        (out/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    try:
        handle.mark_started()
        warm_start = time.perf_counter()
        engine.warm(config=config, allow_create_selected=True)
        report['warmupMs'] = (time.perf_counter()-warm_start)*1000
        face = next((f for f in engine.scan_faces() if f.id == args.face_id), None)
        if face is None:
            raise RuntimeError('Requested approved face is missing or has changed')
        report['face'] = face.name
        report['faceSourceHashes'] = [digest(path) for path in face.files]
        engine.embedding_for_face(face.id)
        if args.prewarm_side_masks:
            from pong_exact_runtime.vendor.experiment_mask_overlap import prewarm
            report['sideMaskPrewarm'] = prewarm(engine._vm, config['parameters'], adaptive=bool(config['runtime'].get('maskAdaptiveBackendEnabled',False)))
        report['faceId'] = face.id
        report['warmHealth'] = engine.health()
        checkpoint()
        for i in ([6] if args.prime_pipeline else []) + list(range(1, 6)):
            live_idle()
            frame_times.clear()
            source = sources[f'/clip-{i:02d}.mp4']
            started = time.perf_counter()
            session = engine.create_session(channel='test', source_url=f'http://127.0.0.1:{server.server_port}/clip-{i:02d}.mp4',
                face_id=face.id, face_ids=[face.id], start_seconds=args.primer_start if i==6 else 0, prefetch=False, prebuffer_seconds=.5,
                navigation_class='foreground', diagnostics_enabled=args.diagnostics,
                restoration_profile=args.restoration_profile)
            stop.clear()
            monitor_errors = []
            def credit(owned_session):
                check_at = 0
                while not stop.wait(.08):
                    engine.update_playback(owned_session.id, position_seconds=owned_session.frames/max(1, owned_session.fps), paused=False)
                    if time.monotonic()-check_at > 1:
                        check_at = time.monotonic()
                        try:
                            live_idle()
                        except Exception as exc:
                            monitor_errors.append(str(exc))
                            engine.stop_session(owned_session.id, deferred=True)
                            return
            thread = threading.Thread(target=credit, args=(session,), daemon=True)
            thread.start()
            first_byte = None
            target = out/f'clip-{i}.mp4'
            with target.open('xb') as f:
                for chunk in engine.stream_session(session.id, activate=True):
                    if first_byte is None:
                        first_byte = (time.perf_counter()-started)*1000
                    f.write(chunk)
                    if time.perf_counter()-started > 180:
                        raise TimeoutError('Clip exceeded three-minute bound')
            elapsed = time.perf_counter()-started
            stop.set();thread.join(timeout=3)
            if monitor_errors:
                raise RuntimeError(monitor_errors[0])
            if session.error or not session.complete:
                raise RuntimeError(session.error or 'Incomplete clip')
            row = {'clip': i, 'sourceSha256': digest(source), 'file': str(target), 'sha256': digest(target),
                   'wallSeconds': elapsed, 'firstEncodedByteMs': first_byte,
                   'renderWorkFps': session.frames/max(.000001, session.frame_work_seconds),
                   'endToEndProducerFps': session.frames/elapsed, 'final': session.public()}
            import numpy as np
            row['frameWallMs'] = list(frame_times)
            row['frameWallSummary'] = {k:float(np.percentile(frame_times,v)) for k,v in [('median',50),('p95',95),('p99',99),('worst',100)]} if frame_times else {}
            row['phaseMs'] = {k:(row['final'][k]-row['final']['createdAt'])*1000 for k in (
                'modelsReadyAt','embeddingReadyAt','sourceOpenedAt','encoderStartedAt',
                'firstSourceFrameAt','firstTransformedFrameAt','firstRenderedFrameReadyAt','playableAt')
                if row['final'].get(k,0)>0}
            if i == 6:
                report['pipelinePrimer'] = row
            else:
                report['clips'].append(row)
            checkpoint()
            print(json.dumps({k:row[k] for k in ('clip','wallSeconds','firstEncodedByteMs','renderWorkFps','endToEndProducerFps')}), flush=True)
            engine.stop_session(session.id, deferred=False)
            session = None
        report['completed'] = True
        if args.decode_ahead_rgb:
            from experiment_review_rgb_ahead import status
            report['decodeAheadStatus'] = status()
        elif args.decode_ahead:
            from experiment_tiktok_decode_ahead import trial_status
            report['decodeAheadStatus'] = trial_status()
    except Exception as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        stop.set()
        if session is not None:
            engine.stop_session(session.id, deferred=False)
        engine.unload();engine.shutdown_gpu_worker();server.shutdown();server.server_close()
        report['savedPresetUnchanged'] = cfg.CURRENT_PRESET.read_bytes() == preset_bytes
        checkpoint()
        if not report['savedPresetUnchanged']:
            raise RuntimeError('Preset changed while test was running')


if __name__ == '__main__':
    main()
