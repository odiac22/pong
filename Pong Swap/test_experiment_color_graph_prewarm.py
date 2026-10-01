"""CPU-only lifecycle contracts for the opt-in color graph prewarm."""

import unittest
from unittest import mock

from experiment_color_graph_prewarm import (
    ColorGraphSpec, eligible_config, prewarm, prewarm_on_owner,
)


class _Engine:
    def __init__(self, active=0):
        self.active = active
        self.config = {"parameters": {"ColorMatchSwitch": True},
                       "runtime": {"colorMatchCudaGraph": True}}
        self.calls = []

    def _active_session_count(self):
        return self.active

    def _run_gpu_work(self, fn, **kwargs):
        self.calls.append((fn, kwargs))
        return "queued"


class ColorGraphPrewarmTests(unittest.TestCase):
    def test_renderer_crop_size_range(self):
        for size in (128, 160, 161, 256, 512, 1024):
            self.assertEqual(ColorGraphSpec(size).size, size)
        for size in (0, 127, 2048):
            with self.assertRaises(ValueError):
                ColorGraphSpec(size)

    def test_color_graph_and_match_must_both_be_enabled(self):
        engine = _Engine()
        self.assertTrue(eligible_config(engine.config))
        engine.config["parameters"]["ColorMatchSwitch"] = False
        self.assertFalse(eligible_config(engine.config))
        engine.config["parameters"]["ColorMatchSwitch"] = True
        engine.config["runtime"]["colorMatchCudaGraph"] = False
        self.assertFalse(eligible_config(engine.config))

    def test_no_active_session_can_be_queued(self):
        engine = _Engine(active=1)
        with self.assertRaisesRegex(RuntimeError, "no active sessions"):
            prewarm(engine, (ColorGraphSpec(256),))
        self.assertEqual(engine.calls, [])

    def test_queued_once_on_gpu_owner_with_deduplicated_specs(self):
        engine = _Engine()
        spec = ColorGraphSpec(256)
        self.assertEqual(prewarm(engine, (spec, spec)), "queued")
        fn, args = engine.calls[0]
        self.assertIs(fn, prewarm_on_owner)
        self.assertIs(args["engine"], engine)
        self.assertEqual(args["specs"], (spec,))

    def test_owner_check_precedes_any_cuda_access(self):
        engine = _Engine()
        engine._gpu_worker_ident = -1
        with self.assertRaisesRegex(RuntimeError, "GPU owner"):
            prewarm_on_owner(engine, (ColorGraphSpec(256),))

    def test_empty_request_does_not_touch_gpu(self):
        engine = _Engine()
        self.assertEqual(prewarm(engine, ()), {"eligible": True, "keys": []})
        self.assertEqual(engine.calls, [])


if __name__ == "__main__":
    unittest.main()
