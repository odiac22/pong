"""CPU-only checks for live/benchmark LK rendering-state parity."""

import ast
from pathlib import Path
import unittest

_BENCHMARK_PATH = Path(__file__).with_name("benchmark_realtime_corpus.py")
_BENCHMARK_TREE = ast.parse(_BENCHMARK_PATH.read_text(encoding="utf-8"))
_HELPER = next(
    node for node in _BENCHMARK_TREE.body
    if isinstance(node, ast.FunctionDef)
    and node.name == "_seed_tracking_render_contract"
)
_NAMESPACE = {}
exec(compile(
    ast.Module(body=[_HELPER], type_ignores=[]), str(_BENCHMARK_PATH), "exec",
), _NAMESPACE)
_seed_tracking_render_contract = _NAMESPACE["_seed_tracking_render_contract"]


class BenchmarkTrackingContractTests(unittest.TestCase):
    def test_live_flags_are_seeded_without_losing_generation(self):
        state = {"trackGeneration": 7}
        self.assertIs(
            _seed_tracking_render_contract(
                state,
                {
                    "temporalDetectorLkFusionEnabled": True,
                    "temporalDisableLkSmoothing": False,
                },
            ),
            state,
        )
        self.assertEqual(state, {
            "trackGeneration": 7,
            "sharedLandmarkEstimator": True,
            "disableLkSmoothing": False,
        })

    def test_reset_reseeds_both_flags_from_current_runtime(self):
        state = {"trackGeneration": 1, "sharedLandmarkEstimator": True,
                 "disableLkSmoothing": False, "oldTrack": object()}
        state.clear()
        state["trackGeneration"] = 2
        _seed_tracking_render_contract(state, {
            "temporalDetectorLkFusionEnabled": False,
            "temporalDisableLkSmoothing": True,
        })
        self.assertEqual(state, {
            "trackGeneration": 2,
            "sharedLandmarkEstimator": False,
            "disableLkSmoothing": True,
        })

    def test_benchmark_calls_seed_at_start_and_discontinuity(self):
        benchmark = next(
            node for node in _BENCHMARK_TREE.body
            if isinstance(node, ast.FunctionDef) and node.name == "benchmark_clip"
        )
        calls = [
            node for node in ast.walk(benchmark)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_seed_tracking_render_contract"
        ]
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
