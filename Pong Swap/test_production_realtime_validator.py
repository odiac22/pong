from __future__ import annotations

import ast
import unittest
from pathlib import Path


SOURCE_PATH = Path(__file__).with_name("validate_production_realtime.py")
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")


def extracted_function(name: str):
    tree = ast.parse(SOURCE, filename=str(SOURCE_PATH))
    node = next(
        item for item in tree.body
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == name
    )
    module = ast.Module(body=[node], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace: dict[str, object] = {}
    exec(compile(module, str(SOURCE_PATH), "exec"), namespace)
    return namespace[name]


class ProductionRealtimeValidatorTests(unittest.TestCase):
    def test_delivery_gate_checks_media_available_before_arrival(self) -> None:
        calculate = extracted_function("fragment_delivery_headroom")
        fps = 24.0
        timeline = [
            {"fragment": 1, "mediaEndSeconds": 1.0 / fps},
            {"fragment": 2, "mediaEndSeconds": 2.0 / fps},
        ]
        records = calculate(timeline, [(1, 10.0), (2, 10.120)], fps)
        self.assertAlmostEqual(records[1]["headroomBeforeArrivalSeconds"], -0.0783333333, places=6)
        self.assertLess(records[1]["headroomBeforeArrivalSeconds"], -(1.0 / fps))

    def test_transformation_proof_has_no_sparse_frame_sampling_escape(self) -> None:
        function_source = ast.get_source_segment(
            SOURCE,
            next(
                item for item in ast.parse(SOURCE).body
                if isinstance(item, ast.FunctionDef) and item.name == "verify_transformation"
            ),
        ) or ""
        self.assertNotIn("index %", function_source)
        self.assertIn("transformed_ratio >= 0.98", function_source)
        self.assertIn("maximum_untransformed_run <= 1", function_source)
        self.assertIn("tail_transformed_ratio >= 0.95", function_source)
        self.assertIn("maximum_tail_untransformed_run <= 1", function_source)
        self.assertIn(
            "identity_improved_samples / max(1, len(sample_records)) >= 0.98",
            function_source,
        )


if __name__ == "__main__":
    unittest.main()
