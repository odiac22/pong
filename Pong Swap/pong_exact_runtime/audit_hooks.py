"""Development-only CPU audit of static vs process-local hook composition.

Each variant installs in a separate process. No model loads, CUDA work,
service startup, or production preset writes occur.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'engine' / 'Rope'))


def _closure(function):
    return {name: cell.cell_contents
            for name, cell in zip(function.__code__.co_freevars,
                                  function.__closure__ or ())}


def _record(variant):
    import pong_swap_config as cfg

    cfg.load_config()
    if variant == 'prototype':
        from pong_exact_runtime.build_frozen import _capture_install
        _capture_install()
        import experiment_mask_overlap as overlap
    else:
        from pong_exact_acceleration import QUALIFIED_SM, RUNTIME_VERSIONS
        from pong_exact_runtime.install import install_cold, model_binding_token
        config = cfg.load_config()
        handle = install_cold(
            cfg.MODELS_DIR,
            binding_token=model_binding_token(config, cfg.MODELS_DIR),
            requested=True,
            capability_provider=lambda: QUALIFIED_SM,
            version_provider=lambda: RUNTIME_VERSIONS,
        )
        if not handle.installed:
            raise RuntimeError(handle.status())
        from pong_exact_runtime.vendor import experiment_mask_overlap as overlap
    from rope.VideoManager import VideoManager

    launch = VideoManager._isolated_mask_overlap_launch
    compute = overlap._compute_guards
    guard = VideoManager._isolated_identity_guard
    reductions = _closure(guard)['reductions']
    result = {
        'variant': variant,
        'vmLaunchIsModuleLaunch': launch is overlap._launch,
        'launchCodeSha256': hashlib.sha256(launch.__code__.co_code).hexdigest(),
        'launchNames': list(launch.__code__.co_names),
        'launchFreevars': list(launch.__code__.co_freevars),
        'launchOldBase': _closure(launch)['old_launch'].__name__,
        'computeCodeSha256': hashlib.sha256(compute.__code__.co_code).hexdigest(),
        'computeFreevars': list(compute.__code__.co_freevars),
        'computeOldBase': _closure(compute)['old_compute'].__name__,
        'guardCodeSha256': hashlib.sha256(guard.__code__.co_code).hexdigest(),
        'guardFreevars': list(guard.__code__.co_freevars),
        'reductionCodeSha256': hashlib.sha256(reductions.__code__.co_code).hexdigest(),
        'fusedDelta': _closure(reductions)['fused_delta'],
        'swapCoreCallsLaunch': '_isolated_mask_overlap_launch' in
                               VideoManager.swap_core.__code__.co_names,
        'identityResidualCallsGuard': '_isolated_identity_guard' in
                                      VideoManager._temporal_identity_residual.__code__.co_names,
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', choices=('prototype', 'frozen'))
    args = parser.parse_args()
    if args.variant:
        print('AUDIT_JSON:' + json.dumps(_record(args.variant), sort_keys=True))
        return
    reports = []
    for variant in ('prototype', 'frozen'):
        process = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), '--variant', variant],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        payload = next(line[len('AUDIT_JSON:'):]
                       for line in process.stdout.splitlines()
                       if line.startswith('AUDIT_JSON:'))
        reports.append(json.loads(payload))
    prototype, frozen = reports
    if not prototype['vmLaunchIsModuleLaunch'] or not frozen['vmLaunchIsModuleLaunch']:
        raise AssertionError('VM launch does not point to identity-wrapped module launch')
    mismatches = {
        key: (prototype[key], frozen[key])
        for key in prototype if key != 'variant' and prototype[key] != frozen[key]
    }
    print(json.dumps({'prototype': prototype, 'frozen': frozen,
                      'mismatches': mismatches}, indent=2))
    if mismatches:
        raise AssertionError(f'Frozen hook composition differs: {sorted(mismatches)}')


if __name__ == '__main__':
    main()
