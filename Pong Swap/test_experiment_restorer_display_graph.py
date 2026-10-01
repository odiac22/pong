"""CPU-only ownership tests; graph arithmetic is verified by GPU parity runs."""

import gc
from pathlib import Path
import sys
import unittest
import weakref

sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine' / 'Rope'))

import experiment_restorer_display_graph as experiment


class _Event:
    def __init__(self):
        self.waits = 0

    def synchronize(self):
        self.waits += 1


class DisplayGraphOwnershipTests(unittest.TestCase):
    def test_context_collected_drains_only_its_cache(self):
        registry = experiment._GraphRegistry()
        first, second = {}, {}
        first_cache = registry.cache_for(first)
        second_cache = registry.cache_for(second)
        first_event, second_event = _Event(), _Event()
        first_cache['graph'] = {'done': first_event}
        second_cache['graph'] = {'done': second_event}
        first_owner = weakref.ref(first[experiment._OWNER_KEY])
        del first
        gc.collect()
        self.assertIsNone(first_owner())
        self.assertEqual(first_event.waits, 1)
        self.assertEqual(second_event.waits, 0)
        self.assertEqual(len(second_cache), 1)
        registry.drain_all()
        self.assertEqual(second_event.waits, 1)
        self.assertEqual(len(second_cache), 0)

    def test_install_is_idempotent_and_shutdown_drains(self):
        from rope import VideoManager as module

        original = module._stabilize_restorer_correction
        old_shutdown = module.VideoManager.shutdown_background_workers
        try:
            calls = []
            module.VideoManager.shutdown_background_workers = lambda self: calls.append('shutdown')
            registry = experiment.install()
            self.assertIs(experiment.install(), registry)
            event = _Event()
            context = {}
            registry.cache_for(context)['graph'] = {'done': event}
            module.VideoManager.shutdown_background_workers(object())
            self.assertEqual(calls, ['shutdown'])
            self.assertEqual(event.waits, 1)
            self.assertEqual(len(registry.cache_for(context)), 0)
        finally:
            module._stabilize_restorer_correction = original
            module.VideoManager.shutdown_background_workers = old_shutdown


if __name__ == '__main__':
    unittest.main()
