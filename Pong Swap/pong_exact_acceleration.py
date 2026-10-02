"""Cold, default-off qualification for future direct exact-acceleration hooks.

This module installs no hooks, changes no preset, and imports no GPU package
until explicitly requested. A qualified feature is only *eligible*: each typed
call site must still check its session configuration, tensor contract, model
binding, and stream, then call the original implementation on mismatch.

The source hashes are a frozen experimental baseline. Direct production hook
edits must be reviewed and these hashes deliberately refreshed before any
feature can qualify; source drift never silently enables acceleration.
"""

from dataclasses import dataclass
import builtins
import dis
import hashlib
from importlib import metadata
import inspect
import os
from pathlib import Path
import threading
import types
from typing import Callable


ENV_FLAG = 'PONG_EXACT_ACCELERATION'
QUALIFIED_SM = (8, 9)
RUNTIME_VERSIONS = {
    'torch': '2.11.0+cu128',
    'torchvision': '0.26.0+cu128',
    'onnxruntime-gpu': '1.26.0',
    'tensorrt': '10.16.1.11',
}
SOURCE_HASHES = {
    # Reviewed 2026-09-30: Approved 28 session/preview strength policy only.
    # Removing its import and four calls recovers ffdc49ff... exactly.
    # No inference kernels changed; frozen producer includes selection calls.
    # Reviewed 2026-10-01 (Claude, Baseline 1.7): process_frame short occlusion
    # bridge (pose carry-forward <=0.15 s for a locked face when detector and LK
    # both miss) + previous-pose bookkeeping. No inference kernels changed.
    'pong_swap_engine.py': '89b7043eb95ce0fc97485a4e7688cdec3ca90da874532bc457613c9f02f55422',
    'engine/Rope/rope/Models.py': '4b45f6c63c5a126fd30334edda46e242e5b148ff2014de7279bdb0a3ca337334',
    'engine/Rope/rope/VideoManager.py': 'aaf8646ceeb2bf7c97101af9b8879a63a8c52e36adbc18bd3a8642e76520fb6f',
    # Reviewed 2026-09-30: adds only the cold user-approved loader branch;
    # frame execution, graph capture, ownership and fallback are unchanged.
    'engine/Rope/rope/gpen_runtime.py': 'b19e543bcd8af84de39f9cda5cf98554932209a7543e4d406876f4de1d4b6675',
    'engine/Rope/rope/gpen_user_review.py': '3d4cef2e2a8e50b98c24eeaafd1d2ac3a58d598adf17eb4c039b2f4c5a936e5b',
}
MODEL_HASHES = {
    'inswapper_128.fp16.onnx': '0ad2aebf7388c66e638990365f378502ca7682bdb76da9af015c1afd53fc230f',
    'det_10g.onnx': '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
    'w600k_r50.onnx': '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
    'GPEN-BFR-1024.onnx': 'bcd31aa52110a2005efc96abbab4546d57e42482648f08715b552423d96b381b',
    'occluder.onnx': '79f5c2edf10b83458693d122dd51488b210fb80c059c5d56347a047710d44a78',
    'dfl_xseg.onnx': '0b57328efcb839d85973164b617ceee9dfe6cfcb2c82e8a033bba9f4f09b27e5',
    'ort_trt_cache/TensorrtExecutionProvider_TRTKernel_graph_torch_jit_16043652725959116708_0_0_fp16_sm89.engine':
        '471c54071f3976ea2c7b864047e40c0e635a1cf774ba70661214ee682f971d6d',
    'ort_trt_cache/TensorrtExecutionProvider_TRTKernel_graph_torch-jit-export_2446903033560239399_0_0_fp16_sm89.engine':
        'c82d0046bb26a37dcc0686cf2dc8d3a9c2fa1e6faf6ea9688fa5dd40c8fe2242',
    'ort_trt_cache/TensorrtExecutionProvider_TRTKernel_graph_torch-jit-export_13433965202042488077_0_0_fp16_sm89.engine':
        '9cf2e8b62960887983666e84cd1b3c8f51f64095a48f29e526b663858128da7b',
}

# A narrow missing plan disables its native feature, not unrelated exact
# pointwise paths. All features require the frozen library versions and SM.
FEATURE_REQUIREMENTS = {
    'native_swapper': (('Models.py', 'VideoManager.py'), ('inswapper_128.fp16.onnx', 'swapper-plan')),
    'native_detection': (('Models.py', 'pong_swap_engine.py'),
                         ('det_10g.onnx', 'w600k_r50.onnx', 'detector-plan', 'recognition-plan')),
    'mask_identity_overlap': (('VideoManager.py', 'Models.py'), ('occluder.onnx', 'dfl_xseg.onnx')),
    'swap_prefix_graph': (('VideoManager.py', 'Models.py'), ('inswapper_128.fp16.onnx', 'swapper-plan')),
    'restorer_graphs': (('VideoManager.py', 'gpen_runtime.py', 'gpen_user_review.py'), ('GPEN-BFR-1024.onnx',)),
    'mask_tail_graph': (('VideoManager.py',), ('occluder.onnx', 'dfl_xseg.onnx')),
    'input_warp_graph': (('VideoManager.py',), ()),
    'u8_grid_sample': (('VideoManager.py',), ()),
    'color_lut_lab': (('VideoManager.py',), ()),
    'confidence_twopass': (('VideoManager.py',), ()),
    'pasteback_matrix': (('VideoManager.py',), ()),
    'identity_delta': (('VideoManager.py',), ()),
    'pinned_frame_upload': (('pong_swap_engine.py',), ()),
    'async_readback': (('pong_swap_engine.py',), ()),
}
_MODEL_BY_ALIAS = {
    'swapper-plan': next(name for name in MODEL_HASHES if 'torch_jit_1604365' in name),
    'detector-plan': next(name for name in MODEL_HASHES if '2446903033560' in name),
    'recognition-plan': next(name for name in MODEL_HASHES if '1343396520204' in name),
}


def _file_sha256(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _default_versions():
    return {name: metadata.version(name) for name in RUNTIME_VERSIONS}


def _default_capability():
    import torch

    return tuple(torch.cuda.get_device_capability(0))


@dataclass
class _Resource:
    binding: object
    value: object
    fence: Callable[[], None]
    release: Callable[[], None]


@dataclass(frozen=True)
class StaticMethod:
    feature: str
    owner: type
    name: str
    candidate: Callable


def _global_reads(code):
    for instruction in dis.get_instructions(code):
        if instruction.opname in {'LOAD_GLOBAL', 'LOAD_NAME'}:
            yield instruction.argval
    for constant in code.co_consts:
        if isinstance(constant, types.CodeType):
            yield from _global_reads(constant)


def bind_static_method(original: Callable, candidate: Callable,
                       *, extra_global_names=()) -> Callable:
    """Bind reviewed static code to the original method's module namespace.

    No source inspection, compilation, or execution occurs here. Candidate
    helpers absent from the original namespace must be explicitly exported by
    the cold transaction; accidental static-module globals are rejected.
    """
    if not isinstance(original, types.FunctionType) or not isinstance(candidate, types.FunctionType):
        raise TypeError('Static method binding requires ordinary functions')
    if original.__closure__ or candidate.__closure__ or candidate.__code__.co_freevars:
        raise ValueError('Captured closure cells cannot be rebound safely')
    if inspect.signature(original) != inspect.signature(candidate):
        raise ValueError('Static accelerated signature/defaults changed')
    # An unchanged fallback branch may already contain a module lookup that
    # is only reached under an unsupported configuration. Do not mistake that
    # pre-existing lookup for a newly introduced helper dependency.
    allowed = (set(original.__globals__) | set(vars(builtins))
               | set(extra_global_names) | set(_global_reads(original.__code__)))
    missing = set(_global_reads(candidate.__code__)) - allowed
    if missing:
        raise ValueError(f'Static method has unbound globals: {sorted(missing)}')
    bound = types.FunctionType(candidate.__code__, original.__globals__,
                               original.__name__, original.__defaults__)
    bound.__kwdefaults__ = (dict(original.__kwdefaults__)
                            if original.__kwdefaults__ else None)
    bound.__annotations__ = dict(original.__annotations__)
    bound.__qualname__ = original.__qualname__
    bound.__module__ = original.__module__
    bound.__dict__.update(original.__dict__)
    if inspect.signature(bound) != inspect.signature(original):
        raise ValueError('Bound method signature differs from original')
    return bound


_MISSING = object()


class ExactAcceleration:
    """Per-engine gate and strong resource owner; construct before warm-up."""

    def __init__(self, model_dir: Path, *, source_root: Path | None = None,
                 requested: bool | None = None, capability_provider=None,
                 version_provider=None, source_hashes=None, model_hashes=None,
                 feature_requirements=None):
        self.model_dir = Path(model_dir)
        self.source_root = Path(source_root or Path(__file__).resolve().parent)
        raw = os.environ.get(ENV_FLAG, '') if requested is None else ('1' if requested else '')
        self.requested = raw == '1'
        self._request_reason = ('not-requested' if not raw else
                                'invalid-flag' if raw != '1' else 'requested')
        self._capability = capability_provider or _default_capability
        self._versions = version_provider or _default_versions
        self._source_hashes = dict(SOURCE_HASHES if source_hashes is None else source_hashes)
        self._model_hashes = dict(MODEL_HASHES if model_hashes is None else model_hashes)
        self._source_by_name = {Path(path).name: path for path in self._source_hashes}
        self._requirements = dict(FEATURE_REQUIREMENTS if feature_requirements is None
                                  else feature_requirements)
        self._lock = threading.RLock()
        self._qualified = False
        self._started = False
        self._closed = False
        self._features = {name: 'not-qualified' for name in self._requirements}
        self._resources: dict[str, _Resource] = {}
        self._faults: list[str] = []
        self._static_originals: list[tuple[type, str, object]] = []
        self._static_exports: list[tuple[types.ModuleType, str]] = []

    def qualify_cold(self) -> dict:
        """Read-only preflight. A failed requirement means original fallback."""
        with self._lock:
            if self._started or self._resources or self._static_originals:
                raise RuntimeError('Qualification must precede GPU work')
            if self._closed:
                return self.status()
            if not self.requested:
                self._features = {name: self._request_reason for name in self._requirements}
                self._qualified = True
                return self.status()
            try:
                capability = tuple(self._capability())
                versions = dict(self._versions())
            except Exception as exc:
                self._features = {name: 'runtime-probe-failed' for name in self._requirements}
                self._faults.append(f'runtime-probe: {type(exc).__name__}')
                self._qualified = True
                return self.status()
            if capability != QUALIFIED_SM or any(
                    versions.get(name) != expected
                    for name, expected in RUNTIME_VERSIONS.items()):
                reason = ('unsupported-sm' if capability != QUALIFIED_SM
                          else 'runtime-version-mismatch')
                self._features = {name: reason for name in self._requirements}
                self._qualified = True
                return self.status()
            sources = {
                key: _file_sha256(self.source_root / path) == digest
                for key, path, digest in ((Path(path).name, path, digest)
                                          for path, digest in self._source_hashes.items())
            }
            models = {
                key: _file_sha256(self.model_dir / path) == digest
                for key, path, digest in ((name, name, digest)
                                          for name, digest in self._model_hashes.items())
            }
            for alias, path in _MODEL_BY_ALIAS.items():
                models[alias] = models.get(path, False)
            self._features = {}
            for name, (source_names, model_names) in self._requirements.items():
                bad_source = next((key for key in source_names if not sources.get(key, False)), None)
                bad_model = next((key for key in model_names if not models.get(key, False)), None)
                self._features[name] = (
                    f'source-mismatch:{bad_source}' if bad_source else
                    f'model-mismatch:{bad_model}' if bad_model else 'qualified'
                )
            self._qualified = True
            return self.status()

    def can_use(self, feature: str, *, binding_ok: bool = True) -> bool:
        with self._lock:
            return (self._qualified and not self._closed and binding_ok
                    and self._features.get(feature) == 'qualified')

    def _check_feature_files(self, feature: str) -> str | None:
        """Revalidate a lazy/new binding so replaced files never get replayed."""
        source_names, model_names = self._requirements[feature]
        for name in source_names:
            path = self._source_by_name.get(name)
            if path is None or _file_sha256(self.source_root / path) != self._source_hashes[path]:
                return f'source-mismatch:{name}'
        for name in model_names:
            path = _MODEL_BY_ALIAS.get(name, name)
            expected = self._model_hashes.get(path)
            if expected is None or _file_sha256(self.model_dir / path) != expected:
                return f'model-mismatch:{name}'
        return None

    def start(self):
        """Freeze cold qualification once any frame work is admitted."""
        with self._lock:
            self._started = True

    def install_static_methods(self, methods, *, exports=()) -> bool:
        """Cold transactional assignments; no service/global writes on import.

        `exports` are explicit (module, name, value) triples for names used by
        the static methods. They may add names, never replace an existing
        global. A later cold rollback restores methods and removes added names.
        """
        with self._lock:
            if self._started or self._resources or self._closed or self._static_originals:
                raise RuntimeError('Static installation is cold and one-shot')
            methods = tuple(methods)
            exports = tuple(exports)
            if not methods or not self._qualified:
                return False
            if any(not self.can_use(item.feature) for item in methods):
                return False
            preview = {}
            for module, name, value in exports:
                if not isinstance(module, types.ModuleType) or not isinstance(name, str):
                    raise TypeError('Export must target a module global')
                old = module.__dict__.get(name, _MISSING)
                if old is not _MISSING and old is not value:
                    raise ValueError(f'Export would overwrite {module.__name__}.{name}')
                if name in preview.get(module, {}) and preview[module][name] is not value:
                    raise ValueError(f'Conflicting export {module.__name__}.{name}')
                preview.setdefault(module, {})[name] = value
            prepared = []
            for item in methods:
                if not isinstance(item, StaticMethod):
                    raise TypeError('Expected StaticMethod records')
                mismatch = self._check_feature_files(item.feature)
                if mismatch is not None:
                    self._features[item.feature] = mismatch
                    return False
                original = getattr(item.owner, item.name)
                available = next((names for module, names in preview.items()
                                  if module.__dict__ is original.__globals__), {})
                bound = bind_static_method(original, item.candidate,
                                           extra_global_names=available)
                prepared.append((item.owner, item.name, bound,
                                 item.owner.__dict__.get(item.name, _MISSING)))
            try:
                for module, name, value in exports:
                    if name not in module.__dict__:
                        module.__dict__[name] = value
                        self._static_exports.append((module, name))
                for owner, name, bound, prior in prepared:
                    setattr(owner, name, bound)
                    self._static_originals.append((owner, name, prior))
            except Exception:
                self._rollback_static_locked()
                raise
            return True

    def _rollback_static_locked(self):
        for owner, name, prior in reversed(self._static_originals):
            if prior is _MISSING:
                delattr(owner, name)
            else:
                setattr(owner, name, prior)
        self._static_originals.clear()
        for module, name in reversed(self._static_exports):
            del module.__dict__[name]
        self._static_exports.clear()

    def disable_cold(self):
        """Roll back before first frame; never toggle midstream."""
        with self._lock:
            if self._started or self._resources:
                raise RuntimeError('Cannot cold-rollback after resource/frame admission')
            self._rollback_static_locked()
            self.requested = False
            self._request_reason = 'cold-rollback'
            self._features = {name: 'cold-rollback' for name in self._requirements}
            self._qualified = True

    def acquire(self, feature: str, binding: object, factory: Callable[[], object],
                fence: Callable[[object], None], release: Callable[[object], None],
                *, binding_ok: bool = True):
        """Lazily own one binding; return None so the typed hook uses original."""
        with self._lock:
            if not self.can_use(feature):
                return None
            current = self._resources.get(feature)
            if not binding_ok:
                if current is not None:
                    self._drain_one(feature)
                return None
            if current is not None and current.binding == binding:
                return current.value
            if current is not None and not self._drain_one(feature):
                return None
            mismatch = self._check_feature_files(feature)
            if mismatch is not None:
                self._features[feature] = mismatch
                return None
            try:
                value = factory()
            except Exception as exc:
                self._features[feature] = 'resource-create-failed'
                self._faults.append(f'{feature}:create:{type(exc).__name__}')
                return None
            self._resources[feature] = _Resource(
                binding, value, lambda: fence(value), lambda: release(value))
            return value

    def _drain_one(self, feature: str) -> bool:
        record = self._resources.get(feature)
        if record is None:
            return True
        try:
            record.fence()
            record.release()
        except Exception as exc:
            # Keep a strong owner reference: releasing static graph buffers
            # after an incomplete submission is worse than a bounded leak.
            self._features[feature] = 'resource-drain-failed'
            self._faults.append(f'{feature}:drain:{type(exc).__name__}')
            return False
        del self._resources[feature]
        return True

    def drain(self, feature: str | None = None) -> bool:
        with self._lock:
            names = (feature,) if feature is not None else tuple(self._resources)
            results = [self._drain_one(name) for name in names]
            return all(results)

    def close(self) -> bool:
        with self._lock:
            drained = self.drain()
            if drained and not self._started:
                self._rollback_static_locked()
            self._closed = drained
            return drained

    def status(self) -> dict:
        with self._lock:
            return {
                'requested': self.requested, 'qualified': self._qualified,
                'started': self._started, 'closed': self._closed,
                'features': dict(self._features),
                'resources': sorted(self._resources),
                'staticMethods': [f'{owner.__name__}.{name}'
                                  for owner, name, _ in self._static_originals],
                'faults': list(self._faults),
                'fallback': all(value != 'qualified' for value in self._features.values()),
            }
