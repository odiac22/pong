"""Cold installer for the frozen exact candidate, never a live hot patch.

The generated functions are ordinary Python code. The development-only
``build_frozen.py`` performs source rewriting in a disposable process; this
module neither inspects source nor compiles/executes generated text. Caller
must install before engine/model warm-up and must quiesce/drain the engine
before changing model directories or backend preferences.
"""

import hashlib
import importlib
import json
from pathlib import Path
import sys
import threading
import gc

from pong_exact_acceleration import ExactAcceleration, bind_static_method


PACKAGE = Path(__file__).resolve().parent
_INSTALL_LOCK = threading.RLock()
_ACTIVE_HANDLE = None
REQUIRED_FEATURES = (
    'native_swapper', 'native_detection', 'mask_identity_overlap',
    'swap_prefix_graph', 'restorer_graphs', 'mask_tail_graph',
    'input_warp_graph', 'u8_grid_sample', 'color_lut_lab',
    'confidence_twopass', 'pasteback_matrix', 'identity_delta',
    'pinned_frame_upload', 'async_readback',
)


def verify_bundle():
    """Return a diagnostic, not an exception, for an altered frozen artifact."""
    try:
        record = json.loads((PACKAGE / 'bundle_integrity.json').read_text(encoding='utf-8'))
        if record.get('algorithm') != 'sha256' or not record.get('files'):
            return 'integrity-manifest-invalid'
        for name, expected in record['files'].items():
            path = (PACKAGE / name).resolve()
            if PACKAGE.resolve() not in path.parents or not path.is_file():
                return f'bundle-file-missing:{name}'
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                return f'bundle-file-mismatch:{name}'
        return 'qualified'
    except (OSError, ValueError, TypeError, KeyError):
        return 'integrity-manifest-unreadable'


def model_binding_token(config, model_dir):
    """Exclude quality sliders; bind only model/provider and stream policy."""
    runtime = config.get('runtime') or {}
    parameters = config.get('parameters') or {}
    return (
        str(Path(model_dir).resolve()),
        str(runtime.get('backend', 'cuda')).lower(),
        str(runtime.get('restorerBackendPreference', 'legacy')).lower(),
        str(runtime.get('maskBackendPreference', 'cuda')).lower(),
        bool(runtime.get('restorerCudaGraph', False)),
        bool(runtime.get('maskCudaGraph', False)),
        bool(runtime.get('orderedGpuSubmission', False)),
        str(parameters.get('ModelSessionsTextSel', 'Shared')),
    )


class FrozenInstallation:
    """Owns one cold stack and its original callables for audit/rollback.

    The installer never hot-disables code: after ``mark_started`` the only
    supported model/backend change is drain, unload, and new engine creation.
    All original implementations remain strongly referenced here. Any
    per-call unsupported tensor/config contract inside a helper falls back to
    its original callable; a changed global model binding is not supported.
    """

    def __init__(self, gate, *, binding_token):
        self.gate = gate
        self.binding_token = binding_token
        self.installed = False
        self.reason = 'not-installed'
        self._snapshots = []
        self._engine_id = None
        self._warm_vm_id = None

    def status(self):
        return {
            'installed': self.installed,
            'reason': self.reason,
            'bindingToken': repr(self.binding_token),
            'gate': self.gate.status(),
        }

    def binding_matches(self, token):
        """Call before admitting a session; mismatch requires quiesce/unload."""
        return self.installed and token == self.binding_token

    def mark_started(self):
        if not self.installed:
            raise RuntimeError('Cannot start an uninstalled frozen candidate')
        self.gate.start()

    def note_warm_binding(self, engine):
        """Record the actual VM whose side resources must later be drained."""
        if not self.installed or engine._vm is None or engine._models is None:
            raise RuntimeError('Cannot record an unwarmed accelerated engine')
        if self._engine_id is not None and id(engine) != self._engine_id:
            raise RuntimeError('Accelerated engine identity changed')
        self._engine_id = id(engine)
        self._warm_vm_id = id(engine._vm)

    def rollback_cold(self):
        global _ACTIVE_HANDLE
        if self.gate.status()['started']:
            raise RuntimeError('Frozen candidate cannot hot-rollback')
        self._restore_originals()
        self.installed = False
        self.reason = 'cold-rollback'
        with _INSTALL_LOCK:
            if _ACTIVE_HANDLE is self:
                _ACTIVE_HANDLE = None

    def _restore_originals(self):
        for owner, original in reversed(self._snapshots):
            current = vars(owner)
            for key in tuple(current):
                if key not in original:
                    delattr(owner, key)
            for key, value in original.items():
                if current.get(key) is not value:
                    setattr(owner, key, value)
        self._snapshots.clear()

    def deactivate_after_unload(self, engine, *, retired_vm):
        """Terminal original fallback after a model/backend lifecycle change.

        Caller first blocks new admissions, stops all sessions, retains the old
        VM, calls the normal engine unload, and stops the persistent GPU worker.
        No live class method is changed until those ownership proofs pass.
        This is intentionally terminal for this process; re-acceleration needs
        a fresh engine/process and cold qualification.
        """
        with _INSTALL_LOCK:
            if not self.installed or not self.gate.status()['started']:
                raise RuntimeError('Only a started frozen installation can deactivate')
            if self._engine_id is not None and id(engine) != self._engine_id:
                raise RuntimeError('Accelerated engine identity changed')
            if retired_vm is None:
                raise RuntimeError('A strong reference to the retired VM is required')
            if self._warm_vm_id is None or id(retired_vm) != self._warm_vm_id:
                raise RuntimeError('Retired VM does not match the accelerated binding')
            if any(getattr(engine, name, None) is not None for name in (
                    '_models', '_vm', '_compute_stream', '_warming_models',
                    '_warming_stream', '_pipeline_warm_signature')):
                raise RuntimeError('Engine still owns model or stream resources')
            worker = getattr(engine, '_gpu_worker_thread', None)
            if (worker is not None and worker.is_alive()
                    or getattr(engine, '_gpu_worker_inflight', 0)
                    or not engine._gpu_worker_queue.empty()):
                raise RuntimeError('GPU worker must be fully stopped and drained')
            sessions = tuple(getattr(engine, '_sessions', {}).values())
            if any(not getattr(session, 'complete', False)
                   or engine._session_has_live_resources(session)
                   for session in sessions):
                raise RuntimeError('Live session resources remain')
            if (getattr(retired_vm, '_isolated_mask_overlap', None) is not None
                    or getattr(retired_vm, '_experimental_swap_prefix_graphs', None)
                    or getattr(retired_vm, '_experimental_mask_tail_graphs', None)):
                raise RuntimeError('Retired VM still owns side workers or graph cache')
            for obj in gc.get_objects():
                if type(obj) is type(engine) and obj is not engine:
                    if (getattr(obj, '_vm', None) is not None
                            or getattr(obj, '_models', None) is not None
                            or any(not getattr(s, 'complete', False)
                                   for s in getattr(obj, '_sessions', {}).values())):
                        raise RuntimeError('Another engine still uses frozen methods')
            if not self.gate.close():
                raise RuntimeError('Acceleration resource fence did not drain')
            self._restore_originals()
            self.installed = False
            self.reason = 'original-fallback-after-quiescent-unload'
            self._warm_vm_id = None
            # Keep _ACTIVE_HANDLE terminal so no hot reinstallation is possible.


def _bind(owner, name, candidate, *, extra=()):
    original = getattr(owner, name)
    setattr(owner, name, bind_static_method(original, candidate,
                                            extra_global_names=extra))


def _install_cold_impl(model_dir, *, binding_token, requested=None,
                       capability_provider=None, version_provider=None,
                       gate=None):
    """Install the qualified full stack before warm, or leave originals intact.

    ``binding_token`` is an immutable snapshot supplied by the integrating
    service of model directory, backend preferences and provider/session
    policy. It is deliberately required: this stack does not support hot
    backend or model switches while side workers and captured graphs exist.
    The caller must also recheck the token before each new session and create
    a new engine if it changes. No GPU operation is performed here.
    """
    if binding_token is None:
        raise ValueError('An immutable model/backend binding token is required')
    import pong_swap_engine as engine_probe
    engines = [obj for obj in gc.get_objects()
               if type(obj) is engine_probe.PongSwapEngine]
    if any(
        getattr(obj, '_vm', None) is not None
        or getattr(obj, '_models', None) is not None
        or getattr(obj, '_compute_stream', None) is not None
        or getattr(obj, '_warming_models', None) is not None
        or getattr(obj, '_warming_stream', None) is not None
        or getattr(obj, '_gpu_worker_thread', None) is not None
        or getattr(obj, '_gpu_worker_inflight', 0)
        or getattr(obj, '_sessions', None)
        or getattr(obj, '_active_by_channel', None)
        or getattr(obj, '_pipeline_warm_signature', None) is not None
        or getattr(obj, '_model_residency', None)
        for obj in engines
    ):
        raise RuntimeError('Frozen install requires cold engines with no sessions, models or GPU worker')
    gate = gate or ExactAcceleration(
        Path(model_dir), requested=requested,
        capability_provider=capability_provider,
        version_provider=version_provider,
    )
    handle = FrozenInstallation(gate, binding_token=binding_token)
    integrity = verify_bundle()
    if integrity != 'qualified':
        handle.reason = integrity
        return handle
    qualified = gate.qualify_cold()
    if any(qualified['features'].get(name) != 'qualified'
           for name in REQUIRED_FEATURES):
        handle.reason = 'qualification-mismatch'
        return handle

    root = PACKAGE.parent
    rope_root = root / 'engine' / 'Rope'
    if str(rope_root) not in sys.path:
        # This is import-path setup, not source execution. It is normally
        # already present in the service before the cold installer is called.
        sys.path.insert(0, str(rope_root))
    from pong_exact_runtime import frozen_factories as f, frozen_methods as m
    from pong_exact_runtime.vendor import (
        experiment_async_readback as async_mod,
        experiment_color_lut as color,
        experiment_confidence_twopass as confidence,
        experiment_frame_transfers as transfers,
        experiment_identity_blend as blend,
        experiment_identity_guard_overlap as identity,
        experiment_input_warp_graph as input_warp,
        experiment_lab_inverse as lab,
        experiment_mask_overlap as overlap,
        experiment_mask_tail_graph as tail,
        experiment_native_detection as detection,
        experiment_native_swapper as swapper,
        experiment_pasteback_matrix as pasteback,
        experiment_restorer_display_graph as display,
        experiment_restorer_guard_graph as restorer_guard,
        experiment_retinaface_postprocess as retinaface,
        experiment_u8_grid_sample as sampler,
    )
    import pong_swap_engine as engine_module
    from rope import VideoManager as vm_module
    from rope import Models as models_module
    from rope import gpen_runtime as gpen_module
    vm = vm_module.VideoManager
    models = models_module.Models
    engine = engine_module.PongSwapEngine
    gpen = gpen_module.GPENRuntime
    owners = (vm_module, models_module, gpen_module, engine_module,
              vm, models, gpen, engine, overlap, color)
    handle._snapshots = [(owner, dict(vars(owner))) for owner in owners]
    try:
        # This order is the qualified service-identity-blend-r1 sequence.
        lab_parts = f.make_lab_inverse()
        vm_module._lab_to_rgb_chw_uint8 = lab_parts['call']
        vm_module._isolated_lab_transfer = lab_parts['guarded']
        _bind(vm_module, '_match_lab_color', m._match_lab_color,
              extra=('_isolated_lab_transfer',))

        confidence.install()
        detection.install()
        swapper.install(graph=False)

        vm._isolated_mask_overlap_launch = overlap._launch
        vm._isolated_mask_overlap_consume = overlap._consume
        vm._isolated_mask_overlap_probe = overlap._probe
        vm._isolated_mask_overlap_guard_values = overlap._guard_values
        original_policy = bind_static_method(vm._temporal_mask_result,
                                             m._temporal_mask_result_core)
        mask_parts = f.make_mask_overlap(vm_module, original_policy)
        vm._temporal_mask_result = mask_parts['policy']
        vm.shutdown_background_workers = mask_parts['shutdown']

        identity_parts = f.make_identity_guard()
        overlap._compute_guards = identity_parts['compute']
        overlap._launch = identity_parts['launch']
        # Prototype identity install wraps the module launch *before* mask
        # install copies it onto VM. Keep the same callable here, otherwise
        # every frame falls back to post-GPEN identity guard readbacks.
        vm._isolated_mask_overlap_launch = identity_parts['launch']
        vm._isolated_identity_guard = identity_parts['guard']
        vm.shutdown_background_workers = identity_parts['shutdown']

        prefix_parts = f.make_prefix()
        vm._isolated_swap_prefix_eligible = prefix_parts['eligible']
        vm._isolated_swap_prefix_drain = prefix_parts['drain']
        vm._isolated_swap_prefix_graph = prefix_parts['prefix']
        vm.shutdown_background_workers = prefix_parts['shutdown']
        models.delete_models = prefix_parts['delete']
        vm._isolated_identity_graph_apply = lambda self, *args: blend.apply(*args)
        _bind(vm, '_temporal_identity_residual', m._temporal_identity_residual)

        vm._isolated_u8_grid_sample = staticmethod(sampler.sample)
        _bind(vm, '_warp_grid_sample', m._warp_grid_sample_core)
        input_warp.install()
        pasteback.install()
        models_module._isolated_retinaface_compact = retinaface._compact_outputs
        _bind(models, '_detect_retinaface_inner', m._detect_retinaface_inner,
              extra=('_isolated_retinaface_compact',))

        prep_parts = f.make_restorer_prepare()
        vm._isolated_restorer_prepare = prep_parts['prepare']
        restorer_guard.install(vm_module)
        _bind(vm, '_apply_restorer_inner', m._apply_restorer_inner)
        display.install()
        # The lookup closure and table prewarmer share this original forward
        # conversion. The experimental install() established both; static
        # binding must seed its module owner without source inspection.
        color._original = vm_module._rgb_chw_to_lab
        vm_module._rgb_chw_to_lab = f.make_color_lut()['lookup']
        tail_parts = f.make_mask_tail()
        vm._isolated_mask_tail_eligible = tail_parts['eligible']
        vm._isolated_mask_tail_graph = tail_parts['graph_tail']
        vm.shutdown_background_workers = tail_parts['shutdown']

        _bind(vm, 'swap_core', m.swap_core)
        _bind(vm, '_match_color', m._match_color)
        _bind(gpen, 'prepare', m.prepare)
        transfers.install(engine, upload_only=True)
        async_parts = f.make_async_readback(engine)
        engine._process_frame_to_rgb = async_parts['rgb']
        engine.shutdown_gpu_worker = async_parts['shutdown']
        engine_module.AsyncReadbackLease = async_mod.AsyncReadbackLease
        engine_module._account_output_segments = async_mod._account_output_segments
        engine_module._drain_abandoned_outputs = async_mod._drain_abandoned_outputs
        _bind(engine, 'process_frame', m.process_frame)
        _bind(engine, '_produce_session', m._produce_session,
              extra=('AsyncReadbackLease', '_account_output_segments',
                     '_drain_abandoned_outputs'))

        handle.installed = True
        handle.reason = 'installed-cold'
        return handle
    except BaseException:
        handle.rollback_cold()
        raise


def install_cold(model_dir, *, binding_token, requested=None,
                 capability_provider=None, version_provider=None,
                 gate=None):
    """One process-local cold installation; call before importing service."""
    global _ACTIVE_HANDLE
    with _INSTALL_LOCK:
        if _ACTIVE_HANDLE is not None:
            raise RuntimeError('Frozen exact bundle was already installed in this process')
        handle = _install_cold_impl(
            model_dir, binding_token=binding_token, requested=requested,
            capability_provider=capability_provider,
            version_provider=version_provider, gate=gate,
        )
        if handle.installed:
            _ACTIVE_HANDLE = handle
        return handle


def install_cold_for_engine(engine, *, requested=None):
    """Production adapter entry point; no production callsite is wired yet."""
    import pong_swap_config as cfg
    import pong_swap_engine as engine_module

    if type(engine) is not engine_module.PongSwapEngine:
        raise TypeError('Expected the production PongSwapEngine singleton')
    token = model_binding_token(engine.config, cfg.MODELS_DIR)
    handle = install_cold(cfg.MODELS_DIR, binding_token=token,
                          requested=requested)
    if handle.installed:
        handle._engine_id = id(engine)
    return handle
