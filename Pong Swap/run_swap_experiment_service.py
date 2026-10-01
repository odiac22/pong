"""Disposable loopback-only swap service for exact UI benchmark A/B tests.

Keeps the production preset, Recall and cache untouched. No external media
discovery, no audio enablement, and no replacement of the production service.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8812)
    parser.add_argument('--experiment', choices=('baseline', 'identity-guards'), default='baseline')
    parser.add_argument('--opencv-threads', type=int)
    parser.add_argument('--execution-graphs', action='store_true')
    parser.add_argument('--u8-grid-sample', action='store_true')
    parser.add_argument('--color-lut', action='store_true')
    parser.add_argument('--swap-prefix-graph', action='store_true')
    parser.add_argument('--borrow-restorer-outputs', action='store_true')
    parser.add_argument('--mask-tail-graph', action='store_true')
    parser.add_argument('--native-detection', action='store_true')
    parser.add_argument('--confidence-twopass', action='store_true')
    parser.add_argument('--lab-inverse', action='store_true')
    parser.add_argument('--lab-transfer', action='store_true')
    parser.add_argument('--lab-forward', action='store_true')
    parser.add_argument('--identity-delta', action='store_true')
    parser.add_argument('--identity-blend', action='store_true')
    parser.add_argument('--pinned-frame-upload', action='store_true')
    parser.add_argument('--async-readback', action='store_true')
    parser.add_argument('--restorer-guard-graph', action='store_true')
    parser.add_argument('--restorer-display-graph', action='store_true')
    parser.add_argument('--pasteback-matrix', action='store_true')
    parser.add_argument('--thread-diagnostics', action='store_true',
                        help='Expose stacks without locals on the loopback-only test service')
    args = parser.parse_args()
    # This runner owns the baseline/prototype method stack. Never silently
    # activate the production exact bundle on either side of an A/B test.
    os.environ['PONG_EXACT_ACCELERATION'] = '0'
    if args.lab_forward and args.color_lut:
        raise ValueError('Select exact color forward kernel or lookup, not both')
    if args.port == 8792:
        raise ValueError('The production port is not allowed')
    root = args.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'experiment.json').write_text(json.dumps({
        'kind': 'isolated-swap-service', 'port': args.port,
        'experiment': args.experiment,
        'enabledFlags': sorted(key for key, value in vars(args).items()
                               if isinstance(value, bool) and value),
        'sessionDiagnosticsEnabled': False,
        'asyncReadbackRate': ('completed stream wall throughput' if args.async_readback
                              else None),
    }, indent=2), encoding='utf-8')
    import pong_swap_config as cfg
    config = cfg.load_config()
    if config['runtime'].get('swapAudioEnabled') is not False:
        raise RuntimeError('Baseline must already have audio disabled')
    cfg.CACHE_DIR = root / 'cache'
    cfg.CACHE_DIR.mkdir()
    cfg.load_config = lambda: copy.deepcopy(config)
    cfg.save_config = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError('No production preset writes'))
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    if args.lab_forward:
        from experiment_lab_forward import install
        install()
    if args.opencv_threads is not None:
        import cv2
        cv2.setNumThreads(args.opencv_threads)
    if args.lab_inverse or args.lab_transfer:
        from experiment_lab_inverse import install
        install(fuse_transfer=args.lab_transfer)
    if args.confidence_twopass:
        from experiment_confidence_twopass import install
        install()
    if args.native_detection:
        from experiment_native_detection import install
        install()
    if args.experiment == 'identity-guards':
        from experiment_native_swapper import install
        install(graph=not args.swap_prefix_graph)
        from experiment_identity_guard_overlap import install
        install(fused_delta=args.identity_delta)
    if args.swap_prefix_graph:
        if args.experiment != 'identity-guards':
            raise ValueError('Prefix experiment requires native swapper')
        from experiment_swap_prefix_graph import install
        install()
    if args.identity_blend:
        if args.experiment != 'identity-guards':
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
        install(borrow_outputs=args.borrow_restorer_outputs,
                guard_graph=args.restorer_guard_graph)
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
        from experiment_async_readback import install
        install()
        original_create_session = PongSwapEngine.create_session

        def create_session_without_diagnostics(self, *a, **kw):
            kw['diagnostics_enabled'] = False
            return original_create_session(self, *a, **kw)

        PongSwapEngine.create_session = create_session_without_diagnostics
    if args.experiment == 'identity-guards':
        original_warm = PongSwapEngine.warm

        def warm(self, *a, **kw):
            result = original_warm(self, *a, **kw)
            if args.identity_blend:
                from experiment_identity_blend import prewarm
                self._run_gpu_work(prewarm, work_label='identity-blend-prewarm')
            if args.identity_delta:
                from experiment_identity_delta_kernel import prewarm
                self._run_gpu_work(prewarm, work_label='identity-delta-prewarm')
            if args.u8_grid_sample:
                from experiment_u8_grid_sample import prewarm
                self._run_gpu_work(prewarm, work_label='sampler-prewarm')
            if args.color_lut:
                from experiment_color_lut import prewarm
                self._run_gpu_work(prewarm, work_label='color-lut-prewarm')
            with self._lock:
                if self._vm is not None and not getattr(self._vm, '_experiment_overlap_warmed', False):
                    from experiment_mask_overlap import prewarm
                    prewarm(self._vm, self._vm.parameters, adaptive=False)
                    self._vm._experiment_overlap_warmed = True
                return result

        PongSwapEngine.warm = warm
    import pong_swap_service
    import uvicorn
    if args.thread_diagnostics:
        import threading
        import traceback

        @pong_swap_service.app.get('/test/thread-stacks')
        def test_thread_stacks():
            names = {thread.ident: thread.name for thread in threading.enumerate()}
            engine = pong_swap_service.ENGINE
            pool = getattr(engine, '_isolated_async_readback_pool', None)
            return {'readbackPoolSize': pool.qsize() if pool is not None else None,
                    'abandonedLeases': len(getattr(engine, '_isolated_async_abandoned_leases', [])),
                    'threads': [
                {'name': names.get(ident, 'unknown'), 'stack': traceback.format_stack(frame)}
                for ident, frame in sys._current_frames().items()
            ]}
    try:
        uvicorn.run(pong_swap_service.app, host='127.0.0.1', port=args.port, log_level='warning')
    finally:
        pong_swap_service.ENGINE.unload()
        pong_swap_service.ENGINE.shutdown_gpu_worker()


if __name__ == '__main__':
    main()
