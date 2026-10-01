"""Bounded, idle-only same-precision candidate build. Never installs a plan.

The benchmark runs in a kill-on-close Windows Job. Any newly active Pong
session, low GPU headroom, timeout or supervisor exit terminates only that job.
Saved presets and production plan bytes are read-only throughout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import secrets
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent


def health():
    with urlopen('http://127.0.0.1:8792/health', timeout=3) as response:
        result = json.load(response)
    if result.get('activeSessions') != 0 or result.get('embeddingPrimerActive'):
        raise RuntimeError('Pong is active; candidate worker must not compete')
    return result


def gpu():
    health()
    values = subprocess.check_output([
        'nvidia-smi', '--id=0', '--query-gpu=memory.free,memory.used',
        '--format=csv,noheader,nounits'], text=True, timeout=3,
        creationflags=subprocess.CREATE_NO_WINDOW).strip().split(',')
    return {'freeMiB': float(values[0]), 'usedMiB': float(values[1])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        expected = os.environ.pop('PONG_GPEN_CANDIDATE_START_TOKEN', '')
        if not expected or sys.stdin.readline().strip() != expected:
            raise RuntimeError('Candidate worker was not assigned to its owner job')
        health()
        sys.argv = [str(ROOT / 'benchmark_gpen512_native_trt.py'),
                    '--output-dir', str(args.output_dir), '--edge', '512',
                    '--allow-tf32', '--workspace-bytes', str(4 * 1024**3),
                    '--builder-optimization-level', '5', '--tactic-profile', 'all',
                    '--iterations', '64', '--warmup', '12', '--fixture-steps', '3']
        runpy.run_path(sys.argv[0], run_name='__main__')
        return

    health()
    if gpu()['freeMiB'] < 8 * 1024:
        raise RuntimeError('Need 8 GiB free GPU memory; no worker started')
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    preset = ROOT / 'presets/current.json'
    baseline_bytes = preset.read_bytes()
    plan = Path(json.loads(baseline_bytes)['runtime']['restorerNativeTrtQualifiedPlan'])
    plan_hash = hashlib.sha256(plan.read_bytes()).hexdigest()
    from gpen_benchmark_guard import run_guarded_child, HardDeadline
    token = secrets.token_hex(32)
    environment = {**os.environ, 'PONG_GPEN_CANDIDATE_START_TOKEN': token}
    report = {'scope': 'isolated same-model FP32/TF32 all-tactics build',
              'productionChanged': False, 'promoted': False,
              'baselinePlanSha256': plan_hash}
    try:
        with HardDeadline(1860), (output / 'build.log').open('w', encoding='utf-8') as log:
            report['worker'] = run_guarded_child(
                [sys.executable, str(Path(__file__).resolve()), '--worker',
                 '--output-dir', str(output / 'candidate')],
                log=log, environment=environment, token=token, timeout=1800,
                minimum_free_mib=512, query_gpu=gpu)
    except Exception as exc:
        report['error'] = str(exc)
        raise
    finally:
        report['savedPresetUnchanged'] = preset.read_bytes() == baseline_bytes
        report['productionPlanUnchanged'] = hashlib.sha256(plan.read_bytes()).hexdigest() == plan_hash
        (output / 'supervisor.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report), flush=True)
    if report['worker']['exitCode'] or not report['savedPresetUnchanged'] or not report['productionPlanUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
