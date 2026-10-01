"""Disposable, source-hash-qualified TikTok decode-ahead service trial.

No frozen engine/model file or saved preset is edited. A single cold source at
time zero may decode three frames during model preparation; all other sessions
use the original path. This entrypoint is opt-in and never started by normal
Pong Swap service launch.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8812)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--live-trial', action='store_true',
                        help='Explicit guarded replacement of idle port 8792')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('choose a valid TCP port')
    if args.live_trial:
        if args.port != 8792 or args.cache_dir is not None:
            parser.error('--live-trial requires port 8792 and forbids --cache-dir')
    elif args.port == 8792:
        parser.error('port 8792 requires explicit --live-trial')
    if os.environ.get('PONG_REMOTE_FULL_PATH_WARMUP') == '1':
        parser.error('disable the separate full-path warmup trial for decode-ahead attribution')

    import pong_swap_config as cfg
    production_cache = cfg.CACHE_DIR.resolve()
    cache = (production_cache if args.live_trial else
             (args.cache_dir or args.output_dir / 'cache').resolve())
    if not args.live_trial and cache == production_cache:
        parser.error('trial cache cannot be the production cache')
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if not args.live_trial:
        cache.mkdir(parents=True, exist_ok=True)
    preset = cfg.load_config()
    cfg.CACHE_DIR = cache
    cfg.load_config = lambda: copy.deepcopy(preset)
    cfg.save_config = lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError('decode-ahead trial cannot write the saved preset')
    )
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    os.environ['PONG_EXACT_ACCELERATION'] = '1'

    import pong_swap_service as service
    from pong_exact_runtime.service_adapter import bootstrap_cold
    from experiment_tiktok_decode_ahead import install, trial_status

    # Qualify immutable exact code/models first, then modify only this cold
    # process's producer method. ASGI startup sees the existing qualification
    # handle and keeps the ordinary warm/admission policy.
    bootstrap_cold(service.ENGINE)
    install(service.ENGINE)
    original_health = service.ENGINE.health
    service.ENGINE.health = lambda: {**original_health(), 'decodeAheadTrial': trial_status()}
    (output / 'experiment.json').write_text(json.dumps({
        'kind': 'tiktok-decode-ahead',
        'port': args.port,
        'cacheDir': str(cache),
        'liveTrial': bool(args.live_trial),
        'sourceHashQualified': True,
        'maxQueuedFrames': 3,
    }, indent=2), encoding='utf-8')
    import uvicorn
    try:
        uvicorn.run(service.app, host='127.0.0.1', port=args.port, log_level='warning')
    finally:
        service.ENGINE.unload()
        service.ENGINE.shutdown_gpu_worker()


if __name__ == '__main__':
    main()
