"""CPU-only qualification and resource-lifetime tests; no GPU imports."""

import hashlib
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

import pong_exact_acceleration as exact


OFFSET = 100


def _baseline(self, value):
    return OFFSET + value


def _static(self, value):
    return OFFSET * 2 + value


def _static_needs_helper(self, value):
    return HELPER(value)


def _wrong_signature(self, value, extra):
    return value + extra


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


class ExactAccelerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / 'source'
        self.models = root / 'models'
        self.source.mkdir()
        self.models.mkdir()
        (self.source / 'core.py').write_bytes(b'original implementation')
        (self.models / 'model.onnx').write_bytes(b'fixed model')
        self.sources = {'core.py': digest(b'original implementation')}
        self.model_hashes = {'model.onnx': digest(b'fixed model')}
        self.requirements = {'sample': (('core.py',), ('model.onnx',)),
                             'source_only': (('core.py',), ())}

    def gate(self, **overrides):
        args = dict(model_dir=self.models, source_root=self.source,
                    requested=True,
                    capability_provider=lambda: (8, 9),
                    version_provider=lambda: dict(exact.RUNTIME_VERSIONS),
                    source_hashes=self.sources, model_hashes=self.model_hashes,
                    feature_requirements=self.requirements)
        args.update(overrides)
        return exact.ExactAcceleration(**args)

    def test_default_off_never_probes_hardware_or_files(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            gate = self.gate(requested=None,
                             capability_provider=lambda: 1 / 0)
            status = gate.qualify_cold()
        self.assertEqual(status['features']['sample'], 'not-requested')
        self.assertFalse(gate.can_use('sample'))

    def test_exact_manifest_qualifies_and_binding_mismatch_falls_back(self):
        gate = self.gate()
        self.assertEqual(gate.qualify_cold()['features']['sample'], 'qualified')
        self.assertTrue(gate.can_use('sample'))
        self.assertFalse(gate.can_use('sample', binding_ok=False))
        self.assertIsNone(gate.acquire('sample', 'bad', lambda: 1,
                                       lambda _v: None, lambda _v: None,
                                       binding_ok=False))
        self.assertEqual(gate.status()['resources'], [])

    def test_model_or_source_drift_only_disables_affected_features(self):
        (self.models / 'model.onnx').write_bytes(b'changed model')
        gate = self.gate()
        status = gate.qualify_cold()
        self.assertEqual(status['features']['sample'], 'model-mismatch:model.onnx')
        self.assertEqual(status['features']['source_only'], 'qualified')
        (self.source / 'core.py').write_bytes(b'changed source')
        gate = self.gate()
        self.assertEqual(gate.qualify_cold()['features']['sample'],
                         'source-mismatch:core.py')

    def test_hardware_and_runtime_drift_fall_back_without_throwing(self):
        gate = self.gate(capability_provider=lambda: (9, 0))
        self.assertEqual(gate.qualify_cold()['features']['sample'], 'unsupported-sm')
        gate = self.gate(version_provider=lambda: {'torch': 'wrong'})
        self.assertEqual(gate.qualify_cold()['features']['sample'],
                         'runtime-version-mismatch')
        gate = self.gate(capability_provider=lambda: 1 / 0)
        self.assertEqual(gate.qualify_cold()['features']['sample'],
                         'runtime-probe-failed')

    def test_lazy_rebind_fences_before_release_and_close(self):
        gate = self.gate()
        gate.qualify_cold()
        calls = []
        def acquire(binding):
            return gate.acquire('sample', binding,
                                lambda: calls.append(('create', binding)) or binding,
                                lambda value: calls.append(('fence', value)),
                                lambda value: calls.append(('release', value)))
        self.assertEqual(acquire('a'), 'a')
        self.assertEqual(acquire('a'), 'a')
        self.assertEqual(acquire('b'), 'b')
        self.assertEqual(calls, [('create', 'a'), ('fence', 'a'),
                                 ('release', 'a'), ('create', 'b')])
        self.assertTrue(gate.close())
        self.assertEqual(calls[-2:], [('fence', 'b'), ('release', 'b')])
        self.assertIsNone(acquire('c'))

    def test_failed_fence_keeps_strong_owner_and_cold_rollback_is_blocked(self):
        gate = self.gate()
        gate.qualify_cold()
        resource = object()
        self.assertIs(gate.acquire('sample', 'a', lambda: resource,
                                   lambda _v: (_ for _ in ()).throw(RuntimeError('busy')),
                                   lambda _v: self.fail('released unsafe resource')),
                      resource)
        self.assertFalse(gate.close())
        self.assertIn('sample', gate.status()['resources'])
        self.assertEqual(gate.status()['features']['sample'], 'resource-drain-failed')
        with self.assertRaises(RuntimeError):
            gate.disable_cold()

    def test_cold_rollback_and_started_state_are_irreversible(self):
        gate = self.gate()
        gate.qualify_cold()
        gate.disable_cold()
        self.assertFalse(gate.can_use('sample'))
        gate.start()
        with self.assertRaises(RuntimeError):
            gate.qualify_cold()
        with self.assertRaises(RuntimeError):
            gate.disable_cold()

    def test_frozen_manifest_hashes_are_well_formed(self):
        for value in (*exact.SOURCE_HASHES.values(), *exact.MODEL_HASHES.values()):
            self.assertEqual(len(value), 64)
            int(value, 16)

    def test_release_sources_match_reviewed_qualification(self):
        # Unit fixtures above intentionally exercise drift. A shipping tree
        # must also match the real reviewed manifest, or production silently
        # falls back to the slower baseline despite a green ready flag.
        root = Path(exact.__file__).resolve().parent
        for name, expected in exact.SOURCE_HASHES.items():
            with self.subTest(source=name):
                self.assertEqual(exact._file_sha256(root / name), expected,
                    'Review source changes, regenerate the frozen methods, '
                    'and requalify; never bypass the runtime hash gate.')

    def test_static_method_binding_uses_original_globals_and_cold_rolls_back(self):
        namespace = {'OFFSET': 3, '__builtins__': __builtins__}
        original = types.FunctionType(_baseline.__code__, namespace,
                                      _baseline.__name__, _baseline.__defaults__)
        owner = type('Owner', (), {'run': original})
        gate = self.gate()
        gate.qualify_cold()
        self.assertTrue(gate.install_static_methods([
            exact.StaticMethod('sample', owner, 'run', _static)]))
        self.assertEqual(owner().run(2), 8)
        self.assertEqual(gate.status()['staticMethods'], ['Owner.run'])
        gate.disable_cold()
        self.assertIs(owner.run, original)
        self.assertEqual(owner().run(2), 5)

    def test_static_binding_rejects_signature_or_unbound_global(self):
        namespace = {'OFFSET': 3, '__builtins__': __builtins__}
        original = types.FunctionType(_baseline.__code__, namespace,
                                      _baseline.__name__, _baseline.__defaults__)
        with self.assertRaises(ValueError):
            exact.bind_static_method(original, _wrong_signature)
        with self.assertRaises(ValueError):
            exact.bind_static_method(original, _static_needs_helper)

    def test_static_export_is_explicit_and_rolled_back(self):
        module = types.ModuleType('isolated_test_module')
        module.__dict__['__builtins__'] = __builtins__
        original = types.FunctionType(_baseline.__code__, module.__dict__,
                                      _baseline.__name__, _baseline.__defaults__)
        module.OFFSET = 3
        owner = type('Owner', (), {'run': original})
        gate = self.gate()
        gate.qualify_cold()
        self.assertTrue(gate.install_static_methods(
            [exact.StaticMethod('sample', owner, 'run', _static_needs_helper)],
            exports=[(module, 'HELPER', lambda value: value + 40)]))
        self.assertEqual(owner().run(2), 42)
        gate.disable_cold()
        self.assertFalse(hasattr(module, 'HELPER'))
        self.assertIs(owner.run, original)

    def test_static_install_fails_closed_on_source_change(self):
        owner = type('Owner', (), {'run': _baseline})
        gate = self.gate()
        gate.qualify_cold()
        (self.source / 'core.py').write_bytes(b'changed after qualification')
        self.assertFalse(gate.install_static_methods([
            exact.StaticMethod('sample', owner, 'run', _static)]))
        self.assertIs(owner.run, _baseline)


if __name__ == '__main__':
    unittest.main()
