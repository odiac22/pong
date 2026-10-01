"""Disposable loopback-only service for the frozen exact candidate.

No production endpoint, preset, model file, or cache is modified. This is a
qualification runner, not the production activation path. Use a fresh output
directory and the same UI/CRC harness as the source-rewritten experiment.
"""

import argparse
import copy
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8812)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--review-approved-plan', type=Path,
                        help='Isolated validation of a user-reviewed release through the normal loader')
    parser.add_argument('--service-adapter', action='store_true',
                        help='Qualify the prospective cold production admission adapter')
    parser.add_argument('--service-startup', action='store_true',
                        help='Qualify the actual ASGI startup bootstrap without runner installation')
    args = parser.parse_args()
    if args.service_adapter and args.service_startup:
        parser.error('--service-adapter and --service-startup are mutually exclusive')
    if args.port == 8792:
        raise ValueError('The production port is not allowed')
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)

    import pong_swap_config as cfg
    config = cfg.load_config()
    if args.review_approved_plan:
        config['runtime']['restorerNativeTrtQualifiedPlan1024'] = str(args.review_approved_plan.resolve(strict=True))
    if config['runtime'].get('swapAudioEnabled') is not False:
        raise RuntimeError('Qualified baseline requires audio disabled')
    cfg.CACHE_DIR = output / 'cache'
    cfg.CACHE_DIR.mkdir()
    cfg.load_config = lambda: copy.deepcopy(config)
    cfg.save_config = lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError('Isolated exact service cannot write the production preset')
    )
    os.environ['PONG_MASK_OVERLAP_POLICY'] = 'guarded'
    sys.path.insert(0, str(cfg.ROPE_ROOT))

    if args.service_startup:
        # This branch deliberately performs no cold install, class wrapping,
        # or engine attachment. pong_swap_service's ASGI startup event owns
        # qualification before it starts warm/idle threads or admits traffic.
        os.environ['PONG_EXACT_ACCELERATION'] = '1'
        from pong_exact_runtime.install import model_binding_token, verify_bundle
        token = model_binding_token(config, cfg.MODELS_DIR)
        (output / 'experiment.json').write_text(json.dumps({
            'kind': 'frozen-exact-service-asgi-startup', 'port': args.port,
            'bundleIntegrity': verify_bundle(),
            'bindingToken': repr(token),
            'coldStatus': 'deferred-to-ASGI-startup',
            'sessionDiagnosticsEnabled': False,
            'maskOverlapPolicy': 'guarded',
            'serviceStartup': True,
        }, indent=2), encoding='utf-8')
        import pong_swap_service
        import uvicorn
        try:
            uvicorn.run(pong_swap_service.app, host='127.0.0.1',
                        port=args.port, log_level='warning')
        finally:
            pong_swap_service.ENGINE.unload()
            pong_swap_service.ENGINE.shutdown_gpu_worker()
        return

    from pong_exact_runtime.install import install_cold, model_binding_token, verify_bundle
    token = model_binding_token(config, cfg.MODELS_DIR)
    if args.service_adapter:
        # pong_swap_engine constructs ENGINE on import, but does not start its
        # service warm-up. Attach before importing pong_swap_service, whose
        # startup thread may call ENGINE.warm immediately.
        from pong_swap_engine import ENGINE
        from pong_exact_runtime.service_adapter import bootstrap_cold
        handle, adapter = bootstrap_cold(ENGINE, requested=True)
        if adapter is None:
            raise RuntimeError('Service adapter did not attach to the cold engine')
    else:
        handle = install_cold(cfg.MODELS_DIR, binding_token=token, requested=True)
    if not handle.installed:
        raise RuntimeError(f'Frozen exact candidate not qualified: {handle.status()}')
    (output / 'experiment.json').write_text(json.dumps({
        'kind': 'frozen-exact-swap-service', 'port': args.port,
        'bundleIntegrity': verify_bundle(),
        'bindingToken': repr(token),
        'coldStatus': handle.status(),
        'sessionDiagnosticsEnabled': False,
        'maskOverlapPolicy': 'guarded',
        'serviceAdapter': bool(args.service_adapter),
    }, indent=2), encoding='utf-8')

    if args.service_adapter:
        import pong_swap_service
        import uvicorn
        try:
            uvicorn.run(pong_swap_service.app, host='127.0.0.1',
                        port=args.port, log_level='warning')
        finally:
            pong_swap_service.ENGINE.unload()
            pong_swap_service.ENGINE.shutdown_gpu_worker()
        return

    from pong_swap_engine import PongSwapEngine, ConfigUpdateConflict
    from pong_exact_runtime.vendor import (
        experiment_color_lut as color,
        experiment_identity_blend as blend,
        experiment_identity_delta_kernel as identity_delta,
        experiment_mask_overlap as overlap,
        experiment_u8_grid_sample as sampler,
    )

    def require_binding(current_config):
        current = model_binding_token(current_config, cfg.MODELS_DIR)
        if not handle.binding_matches(current):
            handle.reason = 'model-backend-change-requires-cold-rebuild'
            raise ConfigUpdateConflict(
                'Stop the isolated service and cold-rebuild before changing '
                'model/backend/session policy; ordinary quality sliders remain editable'
            )

    original_update = PongSwapEngine.update_config

    def update_config(self, candidate, *args, **kwargs):
        normalized = self._normalized_config(candidate)
        require_binding(normalized)
        return original_update(self, candidate, *args, **kwargs)

    PongSwapEngine.update_config = update_config
    original_create = PongSwapEngine.create_session

    def create_session(self, *args, **kwargs):
        require_binding(self.config)
        kwargs['diagnostics_enabled'] = False
        return original_create(self, *args, **kwargs)

    PongSwapEngine.create_session = create_session
    original_warm = PongSwapEngine.warm

    def warm(self, *args, **kwargs):
        require_binding(self.config)
        if not handle.gate.status()['started']:
            handle.mark_started()
        result = original_warm(self, *args, **kwargs)
        handle.note_warm_binding(self)
        self._run_gpu_work(blend.prewarm, work_label='identity-blend-prewarm')
        self._run_gpu_work(identity_delta.prewarm, work_label='identity-delta-prewarm')
        self._run_gpu_work(sampler.prewarm, work_label='sampler-prewarm')
        self._run_gpu_work(color.prewarm, work_label='color-lut-prewarm')
        with self._lock:
            if self._vm is not None and not getattr(self._vm, '_experiment_overlap_warmed', False):
                overlap.prewarm(self._vm, self._vm.parameters, adaptive=False)
                self._vm._experiment_overlap_warmed = True
        return result

    PongSwapEngine.warm = warm
    original_health = PongSwapEngine.health

    def health(self, *args, **kwargs):
        result = original_health(self, *args, **kwargs)
        result['exactAcceleration'] = handle.status()
        return result

    PongSwapEngine.health = health

    import pong_swap_service
    import uvicorn
    try:
        uvicorn.run(pong_swap_service.app, host='127.0.0.1',
                    port=args.port, log_level='warning')
    finally:
        pong_swap_service.ENGINE.unload()
        pong_swap_service.ENGINE.shutdown_gpu_worker()


if __name__ == '__main__':
    main()
