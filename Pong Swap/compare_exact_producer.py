"""Compare complete producer reports, with settings/identity/pixel gates."""
import argparse
import json
from pathlib import Path


def compare(base, candidate):
    checks = {
        'silent': base.get('silent') is True and candidate.get('silent') is True,
        'settings': base['settings'] == candidate['settings'],
        'sourceSha256': base['sourceSha256'] == candidate['sourceSha256'],
        'face': base['faceId'] == candidate['faceId'],
        'temporal': base['temporal'] == candidate['temporal'],
        'complete': all(r['final']['complete'] and not r['final'].get('error') for r in (base,candidate)),
        'frameCounts': base['final']['frames'] == candidate['final']['frames'],
        'transformedCounts': base['final']['transformedFrames'] == candidate['final']['transformedFrames'],
        'encodedFps': base['final']['fps'] == candidate['final']['fps'],
        'hashCount': len(base['frames']) == len(candidate['frames']) == base['final']['frames'],
        'sourceAndOutputHashes': base['frames'] == candidate['frames'],
        'nonemptyHashes': bool(base['frames']) and all(f['output'] is not None for r in (base,candidate) for f in r['frames']),
    }
    result = {'checks': checks, 'passed': all(checks.values()), 'frames':len(candidate['frames']),
              'baselineInnerSeconds':base['innerSeconds'], 'candidateInnerSeconds':candidate['innerSeconds'],
              'scope':'Full pixel/temporal parity; CRC instrumentation means these are not rate-only benchmarks'}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline',type=Path)
    parser.add_argument('candidate',type=Path)
    parser.add_argument('--output',type=Path)
    args = parser.parse_args()
    result = compare(json.loads(args.baseline.read_text()),json.loads(args.candidate.read_text()))
    result.update(baseline=str(args.baseline),candidate=str(args.candidate))
    if args.output:
        args.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))
    raise SystemExit(0 if result['passed'] else 1)
