import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import experiment_tiktok_acquisition_service as service


class ServiceTrialTests(unittest.TestCase):
    def app(self):
        events = {}
        return SimpleNamespace(router=SimpleNamespace(
            add_event_handler=lambda name, fn: events.setdefault(name, fn))), events

    def test_startup_requires_real_frozen_binding(self):
        app, events = self.app()
        engine = SimpleNamespace()
        state = service.install(engine, app)
        self.assertFalse(state['installed'])
        with self.assertRaisesRegex(RuntimeError, 'qualified frozen renderer'):
            events['startup']()

    def test_marks_experimental_health_without_replacing_quality_or_models(self):
        app, events = self.app()
        config = {'parameters': {'unchanged': True}}
        model = object()
        engine = SimpleNamespace(_pong_exact_bootstrap=(SimpleNamespace(installed=True),),
                                 health=lambda: {'ready': True, 'quality': config},
                                 config=config, model=model)
        calls = []
        handle = object()
        module = SimpleNamespace(install=lambda e, **kw: calls.append((e, kw)) or handle)
        with patch.dict(sys.modules, {'experiment_tiktok_acquisition': module}):
            state = service.install(engine, app, hair_precheck=True)
            events['startup']()
        self.assertTrue(state['installed'])
        self.assertIs(engine.config, config)
        self.assertIs(engine.model, model)
        self.assertIs(engine._tiktok_acquisition_trial, handle)
        self.assertEqual(calls, [(engine, {'qualified': True, 'hair_precheck': True})])
        self.assertEqual(engine.health()['acquisitionTrial'], {
            'installed': True, 'experimental': True,
            'scope': 'tiktok-face-size', 'hairPrecheck': True})


if __name__ == '__main__':
    unittest.main()
