"""Disposable service for the TikTok prefetch GPU-priority scheduling trial.

The frozen exact runtime, quality settings, stream protocol and source cache
remain unchanged. This entrypoint only installs the process-local priority
adapter before normal ASGI startup; stopping it and starting the ordinary
renderer restores baseline behavior.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys

from experiment_tiktok_prefetch_priority import install


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8812)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path,
                        help='Dedicated isolated cache; never production cache')
    parser.add_argument('--live-priority', action='store_true',
                        help='Explicit replacement on port 8792 with read-only current settings')
    parser.add_argument('--max-wait-seconds', type=float, default=4.0)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('choose a valid TCP port')
    if args.live_priority:
        if args.port != 8792 or args.cache_dir is not None:
            parser.error('--live-priority requires port 8792 and forbids --cache-dir')
    elif args.port == 8792:
        parser.error('port 8792 requires explicit --live-priority')
    if not 0.1 <= args.max_wait_seconds <= 10.0:
        parser.error('--max-wait-seconds must be in 0.1..10')

    import pong_swap_config as cfg
    production_cache = cfg.CACHE_DIR.resolve()
    cache = (production_cache if args.live_priority else
             (args.cache_dir or (args.output_dir / 'cache')).resolve())
    if not args.live_priority and cache == production_cache:
        parser.error('isolated priority trial cannot use the production cache')
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if not args.live_priority:
        cache.mkdir(parents=True, exist_ok=True)
    config = cfg.load_config()
    cfg.CACHE_DIR = cache
    cfg.load_config = lambda: copy.deepcopy(config)
    cfg.save_config = lambda *a, **kw: (_ for _ in ()).throw(
        RuntimeError('priority trial cannot write the production preset')
    )
    sys.path.insert(0, str(cfg.ROPE_ROOT))
    os.environ['PONG_EXACT_ACCELERATION'] = '1'

    import pong_swap_service
    trial = install(pong_swap_service.ENGINE,
                    max_wait_seconds=args.max_wait_seconds)
    (output / 'experiment.json').write_text(json.dumps({
        'kind': 'tiktok-prefetch-gpu-priority',
        'port': args.port,
        'cacheDir': str(cache),
        'livePriority': bool(args.live_priority),
        'normalAsgiBootstrap': True,
        'prefetchPriorityTrial': trial.status(),
    }, indent=2), encoding='utf-8')
    import uvicorn
    try:
        uvicorn.run(pong_swap_service.app, host='127.0.0.1',
                    port=args.port, log_level='warning')
    finally:
        pong_swap_service.ENGINE.unload()
        pong_swap_service.ENGINE.shutdown_gpu_worker()


if __name__ == '__main__':
    main()
