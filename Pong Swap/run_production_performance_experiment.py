"""Silent disposable production-producer experiment; never changes live settings."""
import argparse
import copy
import functools
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import statistics
import re
import sys
import threading
import time
import zlib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--experiment', choices=('baseline', 'native-mask', 'native-identity', 'frozen-exact'), default='baseline')
    parser.add_argument('--capture-frame-hashes', action='store_true')
    parser.add_argument('--pinned-frame-transfers', action='store_true')
    parser.add_argument('--pinned-frame-upload', action='store_true')
    parser.add_argument('--execution-graphs', action='store_true')
    parser.add_argument('--u8-grid-sample', action='store_true')
    parser.add_argument('--color-lut', action='store_true')
    parser.add_argument('--swap-prefix-graph', action='store_true')
    parser.add_argument('--borrow-restorer-outputs', action='store_true')
    parser.add_argument('--mask-tail-graph', action='store_true')
    parser.add_argument('--async-readback', action='store_true')
    parser.add_argument('--no-frame-diagnostics', action='store_true')
    parser.add_argument('--pasteback-matrix', action='store_true')
    parser.add_argument('--restorer-guard-graph', action='store_true')
    parser.add_argument('--restorer-display-graph', action='store_true')
    parser.add_argument('--native-detection', action='store_true')
    parser.add_argument('--confidence-twopass', action='store_true')
    parser.add_argument('--lab-inverse', action='store_true')
    parser.add_argument('--lab-transfer', action='store_true')
    parser.add_argument('--lab-forward', action='store_true')
    parser.add_argument('--identity-delta', action='store_true')
    parser.add_argument('--identity-blend', action='store_true')
    parser.add_argument('--arcface-crop', action='store_true')
    args = parser.parse_args()
    frozen = args.experiment == 'frozen-exact'
    if frozen and any(value for key, value in vars(args).items()
                      if isinstance(value, bool) and key not in ('capture_frame_hashes', 'no_frame_diagnostics')):
        raise ValueError('Frozen exact bundle cannot be mixed with prototype flags')
    if frozen and not args.no_frame_diagnostics:
        raise ValueError('Frozen exact benchmark requires diagnostics disabled')
    if args.lab_forward and args.color_lut:
        raise ValueError('Select exact color forward kernel or lookup, not both')
    if args.async_readback and args.pinned_frame_transfers:
        raise ValueError('Pinned synchronous transfers replace the async lease path; select only one')
    source = args.source.resolve(strict=True)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    import pong_swap_config as cfg
    config = cfg.load_config()
    if config['runtime'].get('swapAudioEnabled') is not False:
        raise RuntimeError('The frozen baseline must already disable audio')
    cfg.CACHE_DIR = output / 'cache'
    cfg.CACHE_DIR.mkdir()
    cfg.load_config = lambda: copy.deepcopy(config)
    cfg.save_config = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError('No preset writes allowed'))
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    frozen_handle = None
    if frozen:
        os.environ['PONG_MASK_OVERLAP_POLICY'] = 'guarded'
        from pong_exact_runtime.install import install_cold, model_binding_token
        frozen_handle = install_cold(
            cfg.MODELS_DIR, binding_token=model_binding_token(config, cfg.MODELS_DIR),
            requested=True,
        )
        if not frozen_handle.installed:
            raise RuntimeError(f'Frozen bundle not qualified: {frozen_handle.status()}')
    if args.lab_forward:
        from experiment_lab_forward import install
        install()
    if args.arcface_crop:
        from experiment_arcface_crop import install
        install()
    if args.lab_inverse or args.lab_transfer:
        from experiment_lab_inverse import install
        install(fuse_transfer=args.lab_transfer)
    if args.confidence_twopass:
        from experiment_confidence_twopass import install
        install()
    if args.native_detection:
        from experiment_native_detection import install
        install()
    if args.experiment in ('native-mask', 'native-identity'):
        from experiment_native_swapper import install
        install(graph=not args.swap_prefix_graph)
        if args.experiment == 'native-identity':
            from experiment_identity_guard_overlap import install
            install(fused_delta=args.identity_delta)
        else:
            from experiment_mask_overlap import install
            install()
    if args.swap_prefix_graph:
        if args.experiment == 'baseline':
            raise ValueError('Prefix experiment requires native swapper')
        from experiment_swap_prefix_graph import install
        install()
    if args.identity_blend:
        if args.experiment != 'native-identity':
            raise ValueError('Identity blend requires identity guard experiment')
        from experiment_identity_blend import install
        install()
    if args.u8_grid_sample:
        from experiment_u8_grid_sample import install
        install()
    if args.execution_graphs:
        from experiment_input_warp_graph import install
        install()
        from experiment_retinaface_postprocess import install
        install()
        from experiment_restorer_prepare_graph import install
        install(borrow_outputs=args.borrow_restorer_outputs, guard_graph=args.restorer_guard_graph)
    if args.pasteback_matrix:
        from experiment_pasteback_matrix import install
        install()
    if args.restorer_display_graph:
        from experiment_restorer_display_graph import install
        install()
    if args.color_lut:
        from experiment_color_lut import install
        install()
    if args.mask_tail_graph:
        from experiment_mask_tail_graph import install
        install()
    from pong_swap_engine import PongSwapEngine
    if args.pinned_frame_upload:
        from experiment_frame_transfers import install
        install(PongSwapEngine, upload_only=True)
    if args.async_readback:
        if not args.no_frame_diagnostics:
            raise ValueError('Async experiment requires diagnostics disabled; compare completion FPS')
        from experiment_async_readback import install
        install()
    if args.pinned_frame_transfers:
        from experiment_frame_transfers import install
        install(PongSwapEngine)
    engine = PongSwapEngine()
    original_process = engine.process_frame
    frames = []
    context_stats = {}
    inner_times = []
    original_rgb = engine._process_frame_to_rgb

    def process(frame, *a, **kw):
        result = original_process(frame, *a, **kw)
        context = kw.get('temporal_context') or {}
        context_stats.clear()
        context_stats.update({k: copy.deepcopy(v) for k, v in context.items()
                              if k.endswith('Frames') or k == 'stageDecisionCounts'})
        return result

    def rgb(frame, *a, **kw):
        started = time.perf_counter()
        result, anchor = original_rgb(frame, *a, **kw)
        inner_times.append(time.perf_counter() - started)
        if result is not None and args.capture_frame_hashes:
            import numpy as np
            if frozen:
                from pong_exact_runtime.vendor.experiment_async_readback import AsyncReadbackLease
            else:
                from experiment_async_readback import AsyncReadbackLease
            row = {'source': zlib.crc32(memoryview(np.ascontiguousarray(frame)).cast('B')), 'output': None}
            frames.append(row)
            def record_output(values):
                row['output'] = zlib.crc32(memoryview(np.ascontiguousarray(values)).cast('B'))
            if isinstance(result, AsyncReadbackLease):
                result.output_observer = lambda values, lease: record_output(values)
            else:
                record_output(result)
        return result, anchor

    engine.process_frame = process
    engine._process_frame_to_rgb = rgb

    class Quiet(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_HEAD(self):
            self.send_media(False)

        def do_GET(self):
            self.send_media(True)

        def send_media(self, body):
            if self.path != '/' + source.name:
                self.send_error(404)
                return
            size = source.stat().st_size
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
            start = int(match[1]) if match else 0
            end = min(size-1, int(match[2])) if match and match[2] else size-1
            if start > end:
                self.send_error(416)
                return
            self.send_response(206 if match else 200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end-start+1))
            if match:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if body:
                try:
                    with source.open('rb') as stream:
                        stream.seek(start)
                        remaining = end-start+1
                        while remaining:
                            chunk = stream.read(min(remaining, 256*1024))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stop = threading.Event()
    session = None
    report = {'experiment': args.experiment, 'settings': config, 'source': str(source),
              'executionGraphs': args.execution_graphs, 'u8GridSample': args.u8_grid_sample,
              'colorLut': args.color_lut,
              'swapPrefixGraph': args.swap_prefix_graph,
              'borrowRestorerOutputs': args.borrow_restorer_outputs,
              'maskTailGraph': args.mask_tail_graph,
              'asyncReadback': args.async_readback,
              'pinnedFrameUpload': args.pinned_frame_upload,
              'pastebackMatrix': args.pasteback_matrix,
              'restorerGuardGraph': args.restorer_guard_graph,
              'restorerDisplayGraph': args.restorer_display_graph,
              'nativeDetection': args.native_detection,
              'confidenceTwopass': args.confidence_twopass,
              'labInverse': args.lab_inverse,
              'labTransfer': args.lab_transfer,
              'labForward': args.lab_forward,
              'identityDelta': args.identity_delta,
              'identityBlend': args.identity_blend,
              'arcfaceCrop': args.arcface_crop,
              'frameDiagnosticsEnabled': not args.no_frame_diagnostics,
              'authoritativeRate': 'completed stream wall throughput; early-return work accounting is not throughput' if args.async_readback else 'work and completed stream rates',
              'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'scope': 'real producer, queue, encoder and streaming; unpaced consumption, not browser playback',
              'frameHashesEnabled': args.capture_frame_hashes,
              'cudaDeviceMaxConnections': os.environ.get('CUDA_DEVICE_MAX_CONNECTIONS', 'driver-default'),
              'silent': True}
    if frozen:
        report['frozenBundleIntegrity'] = json.loads(
            (Path(__file__).resolve().parent / 'pong_exact_runtime' /
             'bundle_integrity.json').read_text(encoding='utf-8'))
        # Record the effective package, not the prototype CLI flags (which are
        # intentionally all false for this mutually exclusive experiment).
        for feature in ('executionGraphs', 'u8GridSample', 'colorLut',
                        'swapPrefixGraph', 'borrowRestorerOutputs',
                        'maskTailGraph', 'asyncReadback', 'pinnedFrameUpload',
                        'pastebackMatrix', 'restorerGuardGraph',
                        'restorerDisplayGraph', 'nativeDetection',
                        'confidenceTwopass', 'labInverse', 'labTransfer',
                        'identityDelta', 'identityBlend'):
            report[feature] = True
        report['authoritativeRate'] = 'completed stream wall throughput; early-return work accounting is not throughput'
    try:
        if frozen_handle is not None:
            frozen_handle.mark_started()
            report['frozenBundle'] = frozen_handle.status()
        engine.warm(config=config, allow_create_selected=True)
        if frozen:
            from pong_exact_runtime.vendor import (
                experiment_identity_blend as frozen_blend,
                experiment_identity_delta_kernel as frozen_delta,
                experiment_u8_grid_sample as frozen_sampler,
                experiment_color_lut as frozen_color,
                experiment_mask_overlap as frozen_overlap,
            )
            for name, module in [('blend', frozen_blend), ('delta', frozen_delta),
                                 ('sampler', frozen_sampler), ('color', frozen_color)]:
                engine._run_gpu_work(module.prewarm, work_label=f'frozen-{name}-prewarm')
            report['maskPrewarm'] = frozen_overlap.prewarm(
                engine._vm, engine._vm.parameters, adaptive=False)
        if args.identity_blend:
            from experiment_identity_blend import prewarm
            engine._run_gpu_work(prewarm, work_label='identity-blend-prewarm')
        if args.identity_delta:
            from experiment_identity_delta_kernel import prewarm
            report['identityDeltaPrewarm'] = engine._run_gpu_work(
                prewarm, work_label='identity-delta-prewarm')
        if args.u8_grid_sample:
            from experiment_u8_grid_sample import prewarm
            engine._run_gpu_work(prewarm, work_label='sampler-prewarm')
        if args.color_lut:
            from experiment_color_lut import prewarm
            engine._run_gpu_work(prewarm, work_label='color-lut-prewarm')
        if args.experiment in ('native-mask', 'native-identity'):
            from experiment_mask_overlap import prewarm
            report['maskPrewarm'] = prewarm(engine._vm, engine._vm.parameters, adaptive=False)
        face = next(face for face in engine.scan_faces() if face.name == 'Approved 3')
        engine.embedding_for_face(face.id)
        report['faceId'] = face.id
        started = time.perf_counter()
        session = engine.create_session(channel='test', source_url=f'http://127.0.0.1:{server.server_port}/{source.name}',
                                        face_id=face.id, face_ids=[face.id], start_seconds=0, prefetch=False,
                                        prebuffer_seconds=.5, navigation_class='foreground', diagnostics_enabled=not args.no_frame_diagnostics)

        def credit():
            while not stop.wait(.08):
                engine.update_playback(session.id, position_seconds=session.frames / max(1, session.fps), paused=False)

        threading.Thread(target=credit, daemon=True).start()
        byte_count = 0
        for chunk in engine.stream_session(session.id, activate=True):
            byte_count += len(chunk)
            if time.perf_counter() - started > 600:
                raise TimeoutError('Experiment exceeded bounded run time')
        elapsed = time.perf_counter() - started
        report['final'] = session.public()
        report['asyncReadbackStats'] = getattr(session, '_isolated_async_readback_stats', None)
        if session.error or not session.complete or not inner_times:
            raise RuntimeError(session.error or 'Incomplete production render')
        report.update(final=session.public(), frames=frames, temporal=context_stats, bytes=byte_count,
                      wallSeconds=elapsed, innerSeconds=sum(inner_times), innerMedianMs=1000*statistics.median(inner_times),
                      workFps=session.frames/session.frame_work_seconds, endToEndFps=session.frames/elapsed)
        if session.error or not session.complete:
            raise RuntimeError(session.error or 'Incomplete production render')
        print(json.dumps({k: report[k] for k in ('experiment', 'workFps', 'endToEndFps', 'wallSeconds', 'innerSeconds', 'temporal')}, indent=2), flush=True)
    finally:
        stop.set()
        if session is not None:
            engine.stop_session(session.id, deferred=False)
        engine.unload()
        engine.shutdown_gpu_worker()
        server.shutdown()
        server.server_close()
        (output/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
