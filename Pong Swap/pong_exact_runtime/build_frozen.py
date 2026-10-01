"""Development-only capture of the qualified experimental method sources.

Run in a disposable Python process with ``--write`` after deliberate review.
The generated module contains ordinary Python function definitions; neither
the runtime package nor its installer calls inspect/compile/exec at startup.
This generator performs no CUDA work, model load, service start, or preset IO.
"""

import argparse
import ast
import builtins
import hashlib
import json
from pathlib import Path
import re
import sys
import textwrap
import types


ROOT = Path(__file__).resolve().parents[1]
ROPE_ROOT = ROOT / 'engine' / 'Rope'
TARGETS = (
    ('rope.VideoManager', 'VideoManager', 'swap_core'),
    ('rope.VideoManager', 'VideoManager', '_temporal_mask_result'),
    ('rope.VideoManager', 'VideoManager', '_temporal_identity_residual'),
    ('rope.VideoManager', 'VideoManager', '_warp_grid_sample'),
    ('rope.VideoManager', 'VideoManager', '_apply_restorer_inner'),
    ('rope.VideoManager', 'VideoManager', '_match_color'),
    ('rope.Models', 'Models', '_detect_retinaface_inner'),
    ('rope.gpen_runtime', 'GPENRuntime', 'prepare'),
    ('pong_swap_engine', 'PongSwapEngine', 'process_frame'),
    ('pong_swap_engine', 'PongSwapEngine', '_produce_session'),
    ('rope.VideoManager', None, '_match_lab_color'),
)
VENDOR_MODULES = (
    'experiment_async_readback', 'experiment_confidence_twopass',
    'experiment_native_detection', 'experiment_native_swapper',
    'experiment_identity_guard_overlap', 'experiment_mask_overlap',
    'experiment_swap_prefix_graph', 'experiment_identity_blend',
    'experiment_identity_graph', 'experiment_identity_delta_kernel',
    'experiment_u8_grid_sample', 'experiment_input_warp_graph',
    'experiment_retinaface_postprocess', 'experiment_restorer_prepare_graph',
    'experiment_restorer_guard_graph', 'experiment_pasteback_matrix',
    'experiment_restorer_display_graph', 'experiment_color_lut',
    'experiment_mask_tail_graph', 'experiment_lab_inverse',
    'experiment_frame_transfers', 'experiment_capture_ownership',
    'experiment_cuda_module',
)
FACTORIES = {
    'color_lut': ('experiment_color_lut', ('lookup',),
                  """    from rope import VideoManager as vm
    import torch
    from pong_exact_runtime.vendor import experiment_color_lut as color
    _original = vm._rgb_chw_to_lab
    _coverage = color._coverage
    _launch_lookup = color._launch_lookup
"""),
    'prefix': ('experiment_swap_prefix_graph',
               ('eligible', 'drain', 'operations', 'prefix', 'shutdown', 'delete'),
               """    from collections import OrderedDict
    import weakref
    import torch
    from rope import VideoManager as module
    from rope.Models import Models
    vm = module.VideoManager
    owners = weakref.WeakSet()
    old_shutdown = vm.shutdown_background_workers
    old_delete = Models.delete_models
"""),
    'mask_tail': ('experiment_mask_tail_graph',
                  ('eligible', 'operations', 'graph_tail', 'shutdown'),
                  """    from collections import OrderedDict
    import torch
    from rope import VideoManager as module
    vm = module.VideoManager
    old_shutdown = vm.shutdown_background_workers
"""),
    'restorer_prepare': ('experiment_restorer_prepare_graph', ('prepare',),
                         """    from collections import OrderedDict
    import numpy as np
    import torch
    from rope import VideoManager as module
    from torchvision.transforms.v2.functional import _geometry as geometry
    v2 = module.v2
    borrow_outputs = True
"""),
    'mask_overlap': ('experiment_mask_overlap', ('policy', 'shutdown'),
                     """    from pong_exact_runtime.vendor import experiment_mask_overlap as overlap
    video_manager_class = vm.VideoManager
    _consume = overlap._consume
    _account_guided_discard = overlap._account_guided_discard
    original_shutdown = video_manager_class.shutdown_background_workers
"""),
    'identity_guard': ('experiment_identity_guard_overlap',
                       ('reductions', 'compute', 'launch', 'guard', 'shutdown'),
                       """    import torch
    from pong_exact_runtime.vendor import experiment_mask_overlap as overlap
    from pong_exact_runtime.vendor.experiment_identity_delta_kernel import mean_abs_delta
    from rope.VideoManager import VideoManager, _read_guard_scalars
    fused_delta = True
    old_compute = overlap._compute_guards
    old_launch = overlap._launch
    old_shutdown = VideoManager.shutdown_background_workers
"""),
    'async_readback': ('experiment_async_readback', ('_eligible', 'rgb', 'shutdown'),
                       """    import queue
    import time
    import numpy as np
    import torch
    from pong_exact_runtime.vendor.experiment_async_readback import AsyncReadbackLease
    original_rgb = engine._process_frame_to_rgb
    original_shutdown = engine.shutdown_gpu_worker
"""),
    'lab_inverse': ('experiment_lab_inverse', ('call', 'guarded'),
                    """    import torch
    from rope import VideoManager as module
    from pong_exact_runtime.vendor.experiment_lab_inverse import inverse, transfer
    original = module._lab_to_rgb_chw_uint8
"""),
}


def _vendor_modules():
    folder = Path(__file__).with_name('vendor')
    folder.mkdir(exist_ok=True)
    (folder / '__init__.py').write_text('"""Frozen selected exact-candidate helpers."""\n', encoding='utf-8')
    for name in VENDOR_MODULES:
        source = (ROOT / (name + '.py')).read_text(encoding='utf-8')
        source = re.sub(r'\bfrom (experiment_[A-Za-z0-9_]+) import ',
                        r'from pong_exact_runtime.vendor.\1 import ', source)
        source = re.sub(r'\bimport (experiment_[A-Za-z0-9_]+) as ([A-Za-z_]+)',
                        r'from pong_exact_runtime.vendor import \1 as \2', source)
        compile(source, str(folder / (name + '.py')), 'exec')
        (folder / (name + '.py')).write_text(source, encoding='utf-8')


def _frozen_factories():
    pieces = ['"""Generated helper closure factories; no runtime source rewriting."""\n'
              'from pong_exact_runtime.vendor.experiment_identity_guard_overlap '
              'import _retire_identity_pending\n']
    for factory_name, (module_name, nested_names, header) in FACTORIES.items():
        source = (ROOT / (module_name + '.py')).read_text(encoding='utf-8')
        tree = ast.parse(source)
        install = next(node for node in tree.body
                       if isinstance(node, ast.FunctionDef) and node.name == 'install')
        pieces.append(f'\ndef make_{factory_name}(' +
                      ('vm, original_policy' if factory_name == 'mask_overlap' else
                       'engine' if factory_name == 'async_readback' else '') + '):\n')
        pieces.append(header)
        for name in nested_names:
            matches = [node for node in ast.walk(install)
                       if isinstance(node, ast.FunctionDef) and node.name == name]
            if len(matches) != 1:
                raise RuntimeError(f'Expected one {module_name}.install.{name}')
            segment = ast.get_source_segment(source, matches[0])
            pieces.append(textwrap.indent(textwrap.dedent(segment), '    ') + '\n\n')
        pieces.append('    return {' + ', '.join(f"'{name}': {name}" for name in nested_names) + '}\n')
    content = ''.join(pieces)
    compile(content, str(Path(__file__).with_name('frozen_factories.py')), 'exec')
    Path(__file__).with_name('frozen_factories.py').write_text(content, encoding='utf-8')


def _bundle_integrity():
    package = Path(__file__).resolve().parent
    names = ['__init__.py', 'install.py', 'service_adapter.py', 'frozen_methods.py',
             'frozen_factories.py', 'frozen_manifest.json']
    names.extend(f'vendor/{name}.py' for name in VENDOR_MODULES)
    names.append('vendor/__init__.py')
    paths = {name: hashlib.sha256((package / name).read_bytes()).hexdigest()
             for name in sorted(names)}
    (package / 'bundle_integrity.json').write_text(
        json.dumps({'algorithm': 'sha256', 'files': paths}, indent=2) + '\n',
        encoding='utf-8',
    )


def _capture_install():
    """Run only process-local installers while recording their compiled code."""
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROPE_ROOT))
    import pong_swap_config as cfg

    # Merely loading the config selects no GPU path and writes nothing.
    cfg.load_config()
    captured = {}
    original_compile = builtins.compile

    def recording_compile(source, filename, mode, *args, **kwargs):
        code = original_compile(source, filename, mode, *args, **kwargs)
        if (isinstance(code, types.CodeType) and isinstance(source, str)
                and mode == 'exec' and source.lstrip().startswith('def ')):
            parsed = original_compile(source, filename, 'exec', flags=ast.PyCF_ONLY_AST)
            functions = [node for node in parsed.body if isinstance(node, ast.FunctionDef)]
            if len(functions) == 1:
                for constant in code.co_consts:
                    if isinstance(constant, types.CodeType) and constant.co_name == functions[0].name:
                        captured[constant] = textwrap.dedent(source).rstrip() + '\n'
        return code

    builtins.compile = recording_compile
    try:
        from experiment_lab_inverse import install as lab_inverse
        lab_inverse(fuse_transfer=True)
        from experiment_confidence_twopass import install as confidence
        confidence()
        from experiment_native_detection import install as native_detection
        native_detection()
        from experiment_native_swapper import install as native_swapper
        native_swapper(graph=False)
        from experiment_identity_guard_overlap import install as identity_guard
        identity_guard(fused_delta=True)
        from experiment_swap_prefix_graph import install as swap_prefix
        swap_prefix()
        from experiment_identity_blend import install as identity_blend
        identity_blend()
        from experiment_u8_grid_sample import install as u8_sample
        u8_sample()
        from experiment_input_warp_graph import install as input_warp
        input_warp()
        from experiment_retinaface_postprocess import install as retinaface
        retinaface()
        from experiment_restorer_prepare_graph import install as restorer_prepare
        restorer_prepare(borrow_outputs=True, guard_graph=True)
        from experiment_pasteback_matrix import install as pasteback
        pasteback()
        from experiment_restorer_display_graph import install as restorer_display
        restorer_display()
        from experiment_color_lut import install as color_lut
        color_lut()
        from experiment_mask_tail_graph import install as mask_tail
        mask_tail()
        from pong_swap_engine import PongSwapEngine
        from experiment_frame_transfers import install as frame_transfers
        frame_transfers(PongSwapEngine, upload_only=True)
        from experiment_async_readback import install as async_readback
        async_readback()
    finally:
        builtins.compile = original_compile
    return captured


def _snapshot(captured):
    records = []
    for module_name, owner_name, method_name in TARGETS:
        module = sys.modules[module_name]
        owner = getattr(module, owner_name) if owner_name else module
        function = getattr(owner, method_name)
        source = captured.get(function.__code__)
        if source is None:
            # A normal closure wrapper may be the final function; its helper
            # installer is copied separately and is not a static source.
            records.append({'module': module_name, 'owner': owner_name,
                            'method': method_name, 'captured': False})
            continue
        parsed = ast.parse(source)
        if len(parsed.body) != 1 or parsed.body[0].name != method_name:
            raise RuntimeError(f'Captured source mismatch: {module_name}.{method_name}')
        records.append({'module': module_name, 'owner': owner_name,
                        'method': method_name, 'captured': True,
                        'source': source,
                        'sha256': hashlib.sha256(source.encode()).hexdigest()})
    for method_name in ('_temporal_mask_result', '_warp_grid_sample'):
        earlier = [source for source in captured.values()
                   if source.startswith(f'def {method_name}(')]
        if len(earlier) != 1:
            raise RuntimeError(f'Expected one intermediate {method_name}, found {len(earlier)}')
        alias = method_name + '_core'
        source = earlier[0].replace(f'def {method_name}(', f'def {alias}(', 1)
        records.append({'module': 'rope.VideoManager', 'owner': 'VideoManager',
                        'method': alias, 'captured': True, 'source': source,
                        'sha256': hashlib.sha256(source.encode()).hexdigest()})
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='Mechanically refresh frozen_methods.py')
    parser.add_argument('--check', action='store_true', help='Fail if captured methods differ from the shipping snapshot')
    args = parser.parse_args()
    records = _snapshot(_capture_install())
    if args.check:
        if args.write:
            parser.error('--check and --write are mutually exclusive')
        expected = json.loads(Path(__file__).with_name('frozen_manifest.json').read_text(encoding='utf-8'))
        actual = [{key: value for key, value in row.items() if key != 'source'} for row in records]
        if actual != expected:
            raise RuntimeError('Frozen methods are stale; review and regenerate before activation')
    print(json.dumps([{key: value for key, value in row.items() if key != 'source'}
                      for row in records], indent=2), flush=True)
    if not args.write:
        return
    selected = [row for row in records if row['captured']]
    if len(selected) < 7:
        raise RuntimeError('Too few transformed methods captured; refusing partial snapshot')
    header = ('"""Generated exact-candidate methods; edit build_frozen.py, not this file.\n'
              'Development-time source snapshot only. No runtime source execution.\n"""\n'
              'from __future__ import annotations\n\n')
    content = header + '\n\n'.join(
        f"# Source: {row['module']}.{row['owner'] or '<module>'}.{row['method']}\n"
        f"# SHA256: {row['sha256']}\n{row['source']}"
        for row in selected)
    compile(content, str(Path(__file__).with_name('frozen_methods.py')), 'exec')
    Path(__file__).with_name('frozen_methods.py').write_text(content, encoding='utf-8')
    Path(__file__).with_name('frozen_manifest.json').write_text(json.dumps(
        [{key: value for key, value in row.items() if key != 'source'}
         for row in records], indent=2), encoding='utf-8')
    _vendor_modules()
    _frozen_factories()
    _bundle_integrity()


if __name__ == '__main__':
    main()
