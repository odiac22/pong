"""Unwired service adapter for a cold frozen exact engine.

This adapter is intentionally not imported by production. It serializes a
model/backend settings transition with new admissions, drains already-admitted
GPU calls without holding engine locks, and switches permanently to original
methods only after the normal engine unload and worker shutdown succeed.
"""

from collections import Counter
import os
import threading
import time
from types import MethodType

from pong_exact_runtime.install import model_binding_token


_QUALIFIED_MODEL_CHOICES = (
    ('parameters', 'SwapperTypeTextSel'),
    ('parameters', 'RestorerTypeTextSel'),
)


def _model_choice_changed(before, after):
    # These are intentionally hot in the original engine, but a newly chosen
    # model is outside this frozen bundle's qualification. Retire the bundle
    # and let the original methods serve the user's selection unchanged.
    return any(
        before.get(section, {}).get(name) != after.get(section, {}).get(name)
        for section, name in _QUALIFIED_MODEL_CHOICES
    )


class ExactServiceAdapter:
    def __init__(self, engine, handle, model_dir, *, drain_timeout=10.0):
        self.engine = engine
        self.handle = handle
        self.model_dir = model_dir
        self.drain_timeout = float(drain_timeout)
        self._condition = threading.Condition(threading.RLock())
        self._admissions = 0
        self._long_admissions = 0
        self._admitted_threads = Counter()
        self._transitioning = False
        self._control_thread = None
        self._last_vm = None
        self._attached = False
        self._failure = ''
        self._original = {}
        self._prewarmed_vm_id = None

    def _conflict(self, message):
        from pong_swap_engine import ConfigUpdateConflict
        return ConfigUpdateConflict(message)

    def status(self):
        with self._condition:
            mask_policy = os.environ.get('PONG_MASK_OVERLAP_POLICY', '').strip().lower()
            return {
                'transitioning': self._transitioning,
                'admittedCalls': self._admissions,
                'failure': self._failure,
                'restartRequired': bool(self._failure),
                'maskOverlapPolicy': mask_policy,
                'performanceQualifiedPolicy': mask_policy == 'guarded',
                'acceleration': self.handle.status(),
            }

    def _enter(self, *, long=False):
        tid = threading.get_ident()
        with self._condition:
            if (self._transitioning and tid != self._control_thread
                    and tid != getattr(self.engine, '_gpu_worker_ident', 0)
                    and not self._admitted_threads[tid]):
                raise self._conflict('Model/backend transition is in progress; retry shortly')
            self._admissions += 1
            self._admitted_threads[tid] += 1
            if long:
                self._long_admissions += 1

    def _leave(self, *, long=False):
        tid = threading.get_ident()
        with self._condition:
            self._admissions -= 1
            if long:
                self._long_admissions -= 1
            self._admitted_threads[tid] -= 1
            if not self._admitted_threads[tid]:
                del self._admitted_threads[tid]
            self._condition.notify_all()

    def _prewarm_on_owner(self, engine):
        vm = getattr(engine, '_vm', None)
        if vm is None or threading.get_ident() != getattr(engine, '_gpu_worker_ident', 0):
            return
        vm_id = id(vm)
        if self._prewarmed_vm_id == vm_id:
            return
        from pong_exact_runtime.vendor import (
            experiment_color_lut as color,
            experiment_identity_blend as blend,
            experiment_identity_delta_kernel as identity_delta,
            experiment_mask_overlap as overlap,
            experiment_u8_grid_sample as sampler,
        )
        blend.prewarm()
        identity_delta.prewarm()
        sampler.prewarm()
        color.prewarm()
        with engine._lock:
            if not getattr(vm, '_experiment_overlap_warmed', False):
                overlap.prewarm(vm, vm.parameters, adaptive=False)
                vm._experiment_overlap_warmed = True
        self._prewarmed_vm_id = vm_id

    def attach(self):
        if self._attached:
            raise RuntimeError('Exact service adapter is already attached')
        if not self.handle.installed or self.handle.gate.status()['started']:
            raise RuntimeError('Attach before accelerated engine warm-up')
        for name in ('_run_gpu_work', 'create_session', 'warm',
                     'update_config', 'health'):
            self._original[name] = getattr(self.engine, name)
        adapter = self

        def gpu_work(_engine, callback, *args, **kwargs):
            if threading.get_ident() == getattr(_engine, '_gpu_worker_ident', 0):
                return adapter._original['_run_gpu_work'](callback, *args, **kwargs)
            adapter._enter()
            try:
                return adapter._original['_run_gpu_work'](callback, *args, **kwargs)
            finally:
                adapter._leave()

        def create_session(_engine, *args, **kwargs):
            adapter._enter(long=True)
            try:
                # Match the qualified async-readback path. Explicit debug
                # diagnostics remain opt-in and retain the original behavior.
                kwargs.setdefault('diagnostics_enabled', False)
                return adapter._original['create_session'](*args, **kwargs)
            finally:
                adapter._leave(long=True)

        def warm(_engine, *args, **kwargs):
            adapter._enter(long=True)
            try:
                if not adapter.handle.gate.status()['started']:
                    adapter.handle.mark_started()
                result = adapter._original['warm'](*args, **kwargs)
                if getattr(_engine, '_vm', None) is not None:
                    adapter.handle.note_warm_binding(_engine)
                    adapter._last_vm = _engine._vm
                    adapter._prewarm_on_owner(_engine)
                return result
            finally:
                adapter._leave(long=True)

        def update_config(_engine, config, *args, **kwargs):
            return adapter.apply_settings(config, *args, **kwargs)

        def health(_engine, *args, **kwargs):
            result = adapter._original['health'](*args, **kwargs)
            result['exactAcceleration'] = adapter.status()
            return result

        for name, function in (
                ('_run_gpu_work', gpu_work), ('create_session', create_session),
                ('warm', warm), ('update_config', update_config),
                ('health', health)):
            setattr(self.engine, name, MethodType(function, self.engine))
        self._attached = True
        return self

    def _restore_admissions_after_fallback(self):
        # Health remains wrapped to expose why original fallback took over.
        for name in ('_run_gpu_work', 'create_session', 'warm', 'update_config'):
            setattr(self.engine, name, self._original[name])

    def apply_settings(self, config, *args, **kwargs):
        engine = self.engine
        original = self._original['update_config']
        if threading.get_ident() == getattr(engine, '_gpu_worker_ident', 0):
            # Original update_config dispatches self.update_config to owner.
            return original(config, *args, **kwargs)
        if not self.handle.installed:
            return original(config, *args, **kwargs)
        before = engine.config
        candidate = engine._normalized_config(config)
        candidate_token = model_binding_token(candidate, self.model_dir)
        lifecycle_changed = engine._model_lifecycle_changed(before, candidate)
        model_choice_changed = _model_choice_changed(before, candidate)
        if (not lifecycle_changed and not model_choice_changed
                and self.handle.binding_matches(candidate_token)):
            self._enter()
            try:
                return original(config, *args, **kwargs)
            finally:
                self._leave()

        # Do not interrupt an already playing producer. Engine's native
        # update_config will also reject it, but check before closing new work.
        if engine._active_session_count() > 0:
            raise self._conflict('Stop active sessions before changing model/backend')
        tid = threading.get_ident()
        precommit_vm = getattr(engine, '_vm', None)
        with self._condition:
            if self._transitioning:
                raise self._conflict('Another model/backend transition is in progress')
            if self._long_admissions:
                # A session registration or warm-up already in progress must
                # not be cut off. Short GPU submissions drain below.
                raise self._conflict('Existing model work is still finishing; retry')
            self._transitioning = True
            self._control_thread = tid
        committed = False
        try:
            if engine._active_session_count() > 0:
                raise self._conflict('A session was admitted before model transition')
            deadline = time.monotonic() + self.drain_timeout
            with self._condition:
                while self._admissions:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise self._conflict('Timed out draining admitted GPU work')
                    self._condition.wait(remaining)
            retired_vm = getattr(engine, '_vm', None) or self._last_vm
            if not self.handle.gate.status()['started']:
                self.handle.rollback_cold()
                self._restore_admissions_after_fallback()
                return original(config, *args, **kwargs)
            result = original(config, *args, **kwargs)
            committed = True
            # The original lifecycle change normally unloads. Explicit unload
            # also covers token fields it treats as non-lifecycle policy.
            engine.unload()
            if not engine.shutdown_gpu_worker(timeout=self.drain_timeout):
                raise RuntimeError('GPU worker did not stop after model change')
            self.handle.deactivate_after_unload(engine, retired_vm=retired_vm)
            self._restore_admissions_after_fallback()
            return result
        except BaseException as exc:
            # A failed post-commit fence is uncertain even when the model
            # binding token did not change (for example, detector profile).
            # Only a rejected precommit update with its original config and
            # VM still present may reopen admissions.
            safe_precommit = (
                not committed
                and isinstance(exc, type(self._conflict('')))
                and engine.config == before
                and getattr(engine, '_vm', None) is precommit_vm
            )
            if not safe_precommit:
                with self._condition:
                    self._failure = f'{type(exc).__name__}: {exc}'
                    self._control_thread = None
                raise
            with self._condition:
                self._transitioning = False
                self._control_thread = None
                self._condition.notify_all()
            raise
        finally:
            with self._condition:
                if not self._failure:
                    self._transitioning = False
                    self._control_thread = None
                    self._condition.notify_all()


def bootstrap_cold(engine, *, requested=None):
    """Unwired cold entry point; return ``(handle, adapter_or_none)``.

    A prior isolated-runner install owns its own wrappers and must not be
    stacked with these service admissions. Failed qualification leaves every
    original method intact except a read-only health status decoration.
    """
    from pong_exact_runtime import install as frozen

    prior = getattr(engine, '_pong_exact_bootstrap', None)
    if prior is not None:
        return prior
    existing = frozen._ACTIVE_HANDLE
    if existing is not None:
        if existing.installed and getattr(existing, '_engine_id', None) not in (None, id(engine)):
            raise RuntimeError('Frozen exact bundle belongs to a different engine')
        return existing, None
    if requested is None and 'PONG_EXACT_ACCELERATION' not in os.environ:
        requested = True
    os.environ.setdefault('PONG_MASK_OVERLAP_POLICY', 'guarded')
    handle = frozen.install_cold_for_engine(engine, requested=requested)
    if not handle.installed:
        original_health = engine.health

        def health(_engine, *args, **kwargs):
            result = original_health(*args, **kwargs)
            mask_policy = os.environ.get('PONG_MASK_OVERLAP_POLICY', '').strip().lower()
            result['exactAcceleration'] = {
                **handle.status(),
                'maskOverlapPolicy': mask_policy,
                'performanceQualifiedPolicy': mask_policy == 'guarded',
            }
            return result

        engine.health = MethodType(health, engine)
        result = (handle, None)
    else:
        try:
            import pong_swap_config as cfg
            adapter = ExactServiceAdapter(
                engine, handle, cfg.MODELS_DIR,
            ).attach()
        except BaseException:
            handle.rollback_cold()
            raise
        result = (handle, adapter)
    engine._pong_exact_bootstrap = result
    return result
