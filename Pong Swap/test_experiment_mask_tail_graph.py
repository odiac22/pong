"""CPU-only source and policy-boundary tests for the mask-tail graph."""

import ast
import inspect
from pathlib import Path
import sys
import textwrap
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine' / 'Rope'))

import experiment_mask_tail_graph as experiment


class MaskTailGraphTests(unittest.TestCase):
    def test_install_preserves_upstream_experimental_source_and_policy_calls(self):
        from rope.VideoManager import VideoManager

        original = VideoManager.swap_core
        old_shutdown = VideoManager.shutdown_background_workers
        old_eligible = getattr(VideoManager, '_isolated_mask_tail_eligible', None)
        old_graph = getattr(VideoManager, '_isolated_mask_tail_graph', None)
        had_source = hasattr(original, '_isolated_source')
        prior_source = getattr(original, '_isolated_source', None)
        source = textwrap.dedent(inspect.getsource(original))
        marker = "    mark_stage('alignedCrop')"
        upstream = "    self._isolated_mask_overlap_launch(pipeline_input_face, parameters, temporal_context)"
        self.assertEqual(source.count(marker), 1)
        source = source.replace(marker, marker + '\n' + upstream)
        original._isolated_source = source
        try:
            experiment.install()
            transformed = VideoManager.swap_core._isolated_source
            self.assertEqual(transformed.count(upstream), 1)
            self.assertEqual(transformed.count('self._temporal_mask_result('),
                             source.count('self._temporal_mask_result('))
            self.assertEqual(transformed.count("mark_stage('masks')"), 1)
            self.assertIn('capture_error_mode=\'thread_local\'',
                          inspect.getsource(experiment.install))
            compile(transformed, 'isolated-mask-tail.py', 'exec')
            branch = next(node for node in ast.walk(ast.parse(transformed))
                          if isinstance(node, ast.If)
                          and isinstance(node.test, ast.Call)
                          and isinstance(node.test.func, ast.Attribute)
                          and node.test.func.attr == '_isolated_mask_tail_eligible')
            self.assertTrue(any(isinstance(node, ast.Call)
                                and isinstance(node.func, ast.Attribute)
                                and node.func.attr == '_isolated_mask_tail_graph'
                                for node in ast.walk(branch.body[0])))
            self.assertTrue(any(isinstance(node, ast.Call)
                                and isinstance(node.func, ast.Attribute)
                                and node.func.attr == '_get_gaussian_blur'
                                for node in ast.walk(branch.orelse[0])))
        finally:
            VideoManager.swap_core = original
            VideoManager.shutdown_background_workers = old_shutdown
            for name, prior in (('_isolated_mask_tail_eligible', old_eligible),
                                ('_isolated_mask_tail_graph', old_graph)):
                if prior is None:
                    delattr(VideoManager, name)
                else:
                    setattr(VideoManager, name, prior)
            if had_source:
                original._isolated_source = prior_source
            else:
                delattr(original, '_isolated_source')


if __name__ == '__main__':
    unittest.main()
