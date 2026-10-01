"""CPU-only topology tests for the unqualified GPEN512 cast-island exporter."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
import uuid

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


SCRIPT = Path(__file__).with_name("build_gpen512_conv_islands.py")
SPEC = importlib.util.spec_from_file_location("build_gpen512_conv_islands", SCRIPT)
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


def fixture_model(*, fp16_input: bool = False, wrong_name: bool = False) -> onnx.ModelProto:
    dtype = TensorProto.FLOAT16 if fp16_input else TensorProto.FLOAT
    nodes = [
        helper.make_node("Conv", ["X", "W"], ["Y"],
                         name="wrong" if wrong_name else exporter.target_name(13)),
        helper.make_node("Pow", ["X", "two"], ["P"], name="sensitive_pow"),
        helper.make_node("ReduceSum", ["P"], ["S"], name="sensitive_sum", keepdims=0),
        helper.make_node("Add", ["S", "eps"], ["E"], name="sensitive_eps"),
        helper.make_node("Sqrt", ["E"], ["R"], name="sensitive_sqrt"),
        helper.make_node("Div", ["one", "R"], ["D"], name="sensitive_div"),
        helper.make_node("Add", ["Y", "D"], ["Z"], name="final_add"),
    ]
    initializers = [
        numpy_helper.from_array(np.ones((1, 1, 3, 3), dtype=np.float32), name="W"),
        numpy_helper.from_array(np.asarray(2.0, dtype=np.float32), name="two"),
        numpy_helper.from_array(np.asarray(1e-8, dtype=np.float32), name="eps"),
        numpy_helper.from_array(np.asarray(1.0, dtype=np.float32), name="one"),
    ]
    graph = helper.make_graph(nodes, "conv-island-fixture",
                              [helper.make_tensor_value_info("X", dtype, [1, 1, 4, 4])],
                              [helper.make_tensor_value_info("Z", TensorProto.FLOAT, [1, 1, 2, 2])],
                              initializer=initializers)
    return helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)])


class ConvIslandsTests(unittest.TestCase):
    def test_unnamed_operations_and_existing_casts_preserved(self) -> None:
        model = fixture_model()
        model.graph.node[1].name = ''
        model.graph.node[2].name = ''
        model.graph.node.extend([helper.make_node('Cast', ['one'], ['unused_cast'], name='existing_cast', to=TensorProto.DOUBLE)])
        candidate, topology = exporter.make_candidate(model, (13,))
        self.assertEqual(topology['castNodeCount'], 4)
        self.assertEqual(topology['insertedCastNodeCount'], 3)
        self.assertEqual(sum(not n.name for n in candidate.graph.node), 2)
        self.assertEqual(next(n for n in candidate.graph.node if n.name == 'existing_cast').attribute[0].i, TensorProto.DOUBLE)

    def test_selected_convolution_has_three_explicit_casts_and_fp32_outside(self) -> None:
        source = fixture_model()
        original_bytes = source.SerializeToString()
        candidate, topology = exporter.make_candidate(
            onnx.ModelProto.FromString(original_bytes), (13,))
        self.assertEqual(source.SerializeToString(), original_bytes)
        self.assertEqual(topology["castNodeCount"], 3)
        self.assertEqual(topology["sourceOutputShapes"][exporter.target_name(13)], [1, 1, 2, 2])
        casts = [node for node in candidate.graph.node if node.op_type == "Cast"]
        self.assertEqual([node.attribute[0].i for node in casts],
                         [TensorProto.FLOAT16, TensorProto.FLOAT16, TensorProto.FLOAT])
        conv = next(node for node in candidate.graph.node if node.name == exporter.target_name(13))
        self.assertTrue(all(value.endswith("_fp16") for value in (*conv.input, *conv.output)))
        self.assertEqual(candidate.graph.output[0].type.tensor_type.elem_type, TensorProto.FLOAT)
        self.assertEqual([node.op_type for node in candidate.graph.node if node.name.startswith("sensitive_")],
                         ["Pow", "ReduceSum", "Add", "Sqrt", "Div"])
        self.assertTrue(all(value.data_type == TensorProto.FLOAT for value in candidate.graph.initializer))
        eps = next(value for value in candidate.graph.initializer if value.name == "eps")
        self.assertEqual(float(numpy_helper.to_array(eps)), float(np.float32(1e-8)))
        onnx.checker.check_model(candidate)

    def test_invalid_selection_or_precision_rejected(self) -> None:
        for raw in ("", "-1", "14", "13,13", "13, 9", "1,", "abc"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                exporter.parse_layers(raw)
        with self.assertRaises(ValueError):
            exporter.make_candidate(fixture_model(wrong_name=True), (13,))
        with self.assertRaises((ValueError, onnx.shape_inference.InferenceError)):
            exporter.make_candidate(fixture_model(fp16_input=True), (13,))

    def test_output_path_is_new_explicit_e_candidate_directory(self) -> None:
        name = f"gpen512-conv-islands-test-{uuid.uuid4().hex}"
        path = exporter.OUTPUT_PARENT / name
        self.assertEqual(exporter.output_directory(str(path)), path.resolve())
        for unsafe in (str(exporter.OUTPUT_PARENT),
                       str(exporter.OUTPUT_PARENT / "not-a-candidate"),
                       str(SCRIPT.parent / name)):
            with self.subTest(path=unsafe), self.assertRaises(ValueError):
                exporter.output_directory(unsafe)

    def test_real_source_selection_names_are_exact_and_exclude_to_rgb(self) -> None:
        model = onnx.load(str(exporter.SOURCE), load_external_data=False)
        selected = {exporter.target_name(index) for index in range(exporter.LAYER_COUNT)}
        actual = {node.name for node in model.graph.node if node.name in selected}
        self.assertEqual(actual, selected)
        self.assertTrue(all("/to_rgb" not in name for name in selected))


if __name__ == "__main__":
    unittest.main()
