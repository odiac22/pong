"""Silent, configuration-frozen rendering audit for explicitly supplied local footage.

No downloads, UI, audio decode, preset writes, or implicit media discovery.
The benchmark-only landmark post-warp is disabled to match the live renderer.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import time

import av

from benchmark_realtime_corpus import benchmark_clip, sha256_file
from benchmark_temporal_attachment import analyze_pair
from pong_swap_engine import PongSwapEngine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preset', type=Path, required=True)
    parser.add_argument('--identity', type=Path, required=True)
    parser.add_argument('--clips', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--strengths', type=int, nargs='+', default=[55])
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--sample-fps', type=float, default=60)
    parser.add_argument('--overrides', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    base = json.loads(args.preset.read_text(encoding='utf-8-sig'))
    if args.overrides:
        for section, values in json.loads(args.overrides.read_text(encoding='utf-8')).items():
            base[section].update(values)
    base['runtime']['swapAudioEnabled'] = False
    base['runtime']['temporalExactLandmarkLockEnabled'] = False
    engine = PongSwapEngine()
    engine._config = deepcopy(base)
    engine.warm(config=base, allow_create_selected=True)
    identity_images = tuple(sorted(args.identity.glob('*.jpg')))
    if not identity_images:
        raise ValueError('No explicit identity JPGs')
    embedding = engine.embedding_from_images(identity_images, base)
    report = {'preset': base, 'identityImages': {p.name: sha256_file(p) for p in identity_images},
              'codeSha256': {name: sha256_file(Path(__file__).parent / name) for name in
                             ('pong_swap_engine.py', 'engine/Rope/rope/VideoManager.py', 'benchmark_realtime_corpus.py')},
              'liveParityNotes': ['Benchmark-only landmark post-warp disabled',
                                  'Workload gate mirrors live full-output reuse gate',
                                  'Offline harness does not reproduce live session acquisition or networking'],
              'clips': []}
    try:
        for strength in args.strengths:
            for clip in args.clips:
                config = deepcopy(base)
                config['parameters']['RestorerSlider'] = strength
                engine._config = config
                with av.open(str(clip)) as container:
                    stream = container.streams.video[0]
                    fps = float(stream.average_rate or 30)
                    workload = stream.width * stream.height * fps
                runtime = config['runtime']
                reuse = bool(runtime.get('temporalForegroundReuseEnabled', False))
                if runtime.get('temporalForegroundReuseHighLoadOnly', False):
                    reuse = reuse and workload >= float(runtime.get('temporalForegroundReuseMinimumPixelRate', 16000000))
                output = args.output / f'{clip.stem}-gpen{strength}-silent.mp4'
                started = time.perf_counter()
                result = benchmark_clip(engine, embedding, clip, output, args.seconds,
                    temporal_anchor_hz=float(runtime.get('temporalFullAnchorHz', 3)) if reuse else 0,
                    temporal_restorer_hz=float(runtime.get('temporalRestorerAnchorHz', 2)),
                    pipelined_decode=True, baseline_evidence={'eligible': True},
                    whole_output_reuse_enabled=reuse, capture_frame_hashes=True)
                result['auditStrength'] = strength
                result['sourceSha256'] = sha256_file(clip)
                result['sourcePath'] = str(clip.resolve())
                result['effectiveConfig'] = deepcopy(engine.config)
                result['effectiveConfigSha256'] = hashlib.sha256(json.dumps(engine.config, sort_keys=True).encode()).hexdigest()
                if output.exists() and not result.get('error'):
                    result['temporalQuality'] = analyze_pair(engine, clip, output,
                        max_seconds=args.seconds, sample_fps=args.sample_fps,
                        occlusion_fixture=False,
                        associate_faces=True,
                        frame_provenance=result.get('transformation', {}).get('frameProvenance'))
                result['auditSeconds'] = time.perf_counter() - started
                report['clips'].append(result)
                (args.output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
                print(json.dumps({'clip': clip.name, 'strength': strength,
                                  'fps': result.get('timing', {}).get('processingFps'),
                                  'quality': {k: v for k,v in result.get('temporalQuality', {}).items() if k.endswith('P95')},
                                  'error': result.get('error')}), flush=True)
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()


if __name__ == '__main__':
    main()
