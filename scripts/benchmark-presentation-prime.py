"""Isolated synthetic classifier timing. No service/preset/identity writes."""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'Pong Swap'))
import numpy as np
from pong_swap_identity import ARC_FACE_112_V2, FairFacePresentationClassifier

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    import urllib.request
    with urllib.request.urlopen('http://127.0.0.1:8792/sessions', timeout=5) as response:
        if any(not s.get('complete') and not s.get('playbackPaused') for s in json.load(response)['sessions']):
            raise RuntimeError('Active renderer session; no concurrent GPU test')
    import torch
    torch.zeros(1, device='cuda')
    torch.cuda.synchronize()
    classifier = FairFacePresentationClassifier(ROOT / 'Pong Swap/vendor/facefusion-benchmark/.assets/models/fairface.onnx', backend='cuda')
    started = time.perf_counter()
    classifier.warm()
    prime_ms = (time.perf_counter() - started) * 1000
    frame = np.full((224, 224, 3), 127, dtype=np.uint8)
    points = ARC_FACE_112_V2 * 224
    samples = []
    outputs = []
    for _ in range(8):
        started = time.perf_counter()
        result = classifier.classify(frame, points)
        samples.append((time.perf_counter() - started) * 1000)
        outputs.append((result.label, result.confidence, result.appearance))
    report = {'scope': 'Synthetic isolated model prime; not end-to-end playback or visual quality proof',
        'backend': classifier.backend, 'primeMs': prime_ms, 'classifyMs': samples,
        'outputsStable': all(o == outputs[0] for o in outputs), 'ready': classifier.ready}
    Path(args.out).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)
    classifier.unload()

if __name__ == '__main__':
    main()
