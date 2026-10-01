"""Disposable, stage-attribution-only TikTok service.

Only this entrypoint opts in. The ordinary ASGI startup still performs the
qualified cold install and normal admission/scheduling. CUDA event diagnostics
add measurement overhead, so results are attribution, not FPS qualification.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys
import threading
import weakref
from typing import Any

TIKTOK_PROFILES = ('tiktok-face-size', 'tiktok-gpen512')


def diagnostic_create_session(original, *args: Any, **kwargs: Any) -> Any:
    """Same existing stage-event admission hook, without departure imports."""
    if kwargs.get('restoration_profile') not in TIKTOK_PROFILES:
        return original(*args, **kwargs)
    enabled = dict(kwargs)
    enabled['diagnostics_enabled'] = True
    return original(*args, **enabled)


class StageDiagnosticsTrial:
    """Scope existing engine stage events to newly created TikTok sessions."""

    def __init__(self, engine: Any):
        self._engine = weakref.ref(engine)
        self._lock = threading.Lock()
        self._tiktok_sessions = 0
        self._other_sessions = 0

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                'active': True,
                'profiles': list(TIKTOK_PROFILES),
                'tiktokSessions': self._tiktok_sessions,
                'otherSessions': self._other_sessions,
                'performanceQualification': False,
            }


def install(engine: Any) -> StageDiagnosticsTrial:
    """Install before ASGI startup; no departure endpoints or scheduler hooks."""
    previous = getattr(engine, '_tiktok_stage_diagnostics_trial', None)
    if previous is not None:
        return previous
    with engine._sessions_lock:
        if engine._sessions:
            raise RuntimeError('stage diagnostics require a cold engine with no sessions')
    worker = getattr(engine, '_gpu_worker_thread', None)
    if worker is not None and worker.is_alive():
        raise RuntimeError('stage diagnostics require an idle GPU worker')
    if 'create_session' in engine.__dict__ or 'health' in engine.__dict__:
        raise RuntimeError('stage diagnostics must install before other engine adapters')

    original_create = type(engine).create_session
    original_health = type(engine).health
    engine_ref = weakref.ref(engine)
    trial = StageDiagnosticsTrial(engine)

    def create_session(*args: Any, **kwargs: Any) -> Any:
        current = engine_ref()
        if current is None:
            raise RuntimeError('stage diagnostics engine was released')
        is_tiktok = kwargs.get('restoration_profile') in TIKTOK_PROFILES
        result = diagnostic_create_session(
            lambda *a, **kw: original_create(current, *a, **kw),
            *args, **kwargs,
        )
        with trial._lock:
            if is_tiktok:
                trial._tiktok_sessions += 1
            else:
                trial._other_sessions += 1
        return result

    def health(*args: Any, **kwargs: Any) -> dict[str, Any]:
        current = engine_ref()
        if current is None:
            raise RuntimeError('stage diagnostics engine was released')
        result = original_health(current, *args, **kwargs)
        return {**result, 'stageDiagnosticsTrial': trial.status()}

    # Assignment is last: a failed cold check leaves every engine method intact.
    engine.create_session = create_session
    engine.health = health
    engine._tiktok_stage_diagnostics_trial = trial
    return trial


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8812)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path,
                        help='Dedicated, optionally pre-seeded test cache; never the production cache')
    parser.add_argument('--live-attribution', action='store_true',
                        help='Explicit 8792 replacement using the current cache and read-only settings')
    parser.add_argument('--encoder-handoff-trace', action='store_true',
                        help='Diagnostic-only first 15 stdin handoffs and first complete fMP4 fragment')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('choose a valid TCP port')
    if args.live_attribution:
        if args.port != 8792 or args.cache_dir is not None:
            parser.error('--live-attribution requires port 8792 and forbids --cache-dir')
    elif args.port == 8792:
        parser.error('port 8792 requires explicit --live-attribution')

    import pong_swap_config as cfg
    production_cache = cfg.CACHE_DIR.resolve()
    cache = (production_cache if args.live_attribution else
             (args.cache_dir or (args.output_dir / 'cache')).resolve())
    if not args.live_attribution and cache == production_cache:
        parser.error('the production cache cannot be used for this trial')
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if not args.live_attribution:
        cache.mkdir(parents=True, exist_ok=True)
    config = cfg.load_config()
    cfg.CACHE_DIR = cache
    cfg.load_config = lambda: copy.deepcopy(config)
    cfg.save_config = lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError('stage trial cannot write the production preset')
    )
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    os.environ['PONG_EXACT_ACCELERATION'] = '1'

    # Import constructs an idle ENGINE. Install only the diagnostics admission
    # wrapper now; pong_swap_service's startup hook owns the normal bootstrap.
    import pong_swap_service
    trial = install(pong_swap_service.ENGINE)
    encoder_trace = None
    if args.encoder_handoff_trace:
        import pong_swap_engine
        from experiment_tiktok_encoder_trace import install as install_encoder_trace
        encoder_trace = install_encoder_trace(
            pong_swap_service.ENGINE,
            pong_swap_engine._FragmentedMp4TransportWriter,
        )
    (output / 'experiment.json').write_text(json.dumps({
        'kind': 'tiktok-stage-attribution-only',
        'port': args.port,
        'cacheDir': str(cache),
        'stageDiagnosticsTrial': trial.status(),
        'encoderHandoffTrace': bool(encoder_trace),
        'normalAsgiBootstrap': True,
        'liveAttribution': bool(args.live_attribution),
    }, indent=2), encoding='utf-8')
    import uvicorn
    try:
        uvicorn.run(pong_swap_service.app, host='127.0.0.1',
                    port=args.port, log_level='warning')
    finally:
        try:
            pong_swap_service.ENGINE.unload()
            pong_swap_service.ENGINE.shutdown_gpu_worker()
        finally:
            if encoder_trace is not None:
                encoder_trace.close()


if __name__ == '__main__':
    main()
