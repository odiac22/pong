import ast
from pathlib import Path
import unittest
from unittest.mock import Mock

from pong_swap_engine import PongSwapEngine


class ForegroundSourcePreparationTests(unittest.TestCase):
    def test_preparation_only_queues_network_negotiation(self):
        engine = PongSwapEngine.__new__(PongSwapEngine)
        engine._standby_sources = Mock()
        engine._standby_sources.warm.return_value = True
        engine._standby_sources.status.return_value = {"ready": 0, "opening": 1}
        result = engine.prepare_source("https://example.invalid/original.mp4?token=one")
        engine._standby_sources.warm.assert_called_once_with(
            "https://example.invalid/original.mp4?token=one"
        )
        self.assertEqual(result, {"queued": True, "sources": {"ready": 0, "opening": 1}})
        # No models, config, GPU lane, or frame/identity cache are initialized.
        self.assertFalse(hasattr(engine, "_models"))

    def test_full_pool_is_an_optional_miss_not_a_foreground_error(self):
        engine = PongSwapEngine.__new__(PongSwapEngine)
        engine._standby_sources = Mock()
        engine._standby_sources.warm.return_value = False
        engine._standby_sources.status.return_value = {"ready": 2, "opening": 0}
        self.assertFalse(engine.prepare_source("https://example.invalid/b.mp4")["queued"])

    def test_service_maps_emulator_alias_before_preparation(self):
        tree = ast.parse(Path(__file__).with_name("pong_swap_service.py").read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "prepare_source")
        node.decorator_list = []
        engine = Mock()
        engine.prepare_source.return_value = {"queued": True}
        scope = {"SourcePreparationRequest": object, "Any": object,
                 "ENGINE": engine, "_engine_source_url": lambda value: "mapped:" + value}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "route-test", "exec"), scope)
        payload = type("Request", (), {"sourceUrl": "http://10.0.2.2:8787/video-cache/stream?url=test"})()
        self.assertEqual(scope["prepare_source"](payload), {"ok": True, "queued": True})
        engine.prepare_source.assert_called_once_with("mapped:" + payload.sourceUrl)


if __name__ == "__main__":
    unittest.main()
