"""CPU-only contract tests for the isolated native swap-prefix capture."""

import ast
import inspect
from pathlib import Path
import sys
import textwrap
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / "engine" / "Rope"))

import experiment_swap_prefix_graph as experiment


class SwapPrefixGraphTests(unittest.TestCase):
    def test_mask_source_is_retained_and_eligible_branch_needs_no_swap_disabled(self):
        from rope.VideoManager import VideoManager
        from rope.Models import Models

        original = VideoManager.swap_core
        old_shutdown = VideoManager.shutdown_background_workers
        old_delete = Models.delete_models
        old_eligible = getattr(VideoManager, '_isolated_swap_prefix_eligible', None)
        old_prefix = getattr(VideoManager, '_isolated_swap_prefix_graph', None)
        had_source = hasattr(original, '_isolated_source')
        prior_source = getattr(original, '_isolated_source', None)
        source = textwrap.dedent(inspect.getsource(original))
        mask_launch = "    self._isolated_mask_overlap_launch(pipeline_input_face, parameters, temporal_context)"
        source = source.replace("    mark_stage('alignedCrop')",
                                "    mark_stage('alignedCrop')\n" + mask_launch)
        self.assertEqual(source.count(mask_launch), 1)
        original._isolated_source = source
        try:
            experiment.install()
            transformed = VideoManager.swap_core._isolated_source
            self.assertEqual(transformed.count(mask_launch), 1)
            self.assertIn("capture_error_mode='thread_local'",
                          inspect.getsource(experiment.install))
            self.assertIn("state.get('binding') != binding",
                          inspect.getsource(experiment.install))
            compile(transformed, "isolated-swap-prefix.py", "exec")

            tree = ast.parse(transformed)
            branches = [node for node in ast.walk(tree)
                        if isinstance(node, ast.If)
                        and isinstance(node.test, ast.Call)
                        and isinstance(node.test.func, ast.Attribute)
                        and node.test.func.attr == '_isolated_swap_prefix_eligible']
            self.assertEqual(len(branches), 1)
            branch = branches[0]
            self.assertNotIn('swap_disabled', [node.id for node in ast.walk(branch.test)
                                               if isinstance(node, ast.Name)])
            branch.orelse = [ast.Pass()]
            mini = ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[]))
            expected = object()
            stages = []

            class Fake:
                def _isolated_swap_prefix_eligible(self, *args):
                    return True

                def _isolated_swap_prefix_graph(self, *args):
                    return expected

            scope = {
                'self': Fake(), 'pipeline_input_face': object(), 'latent': object(),
                'parameters': {}, 'swap_size': 128, 'dim': 1,
                'pipeline_size': 128, 'hf_switch_on': False,
                'mark_stage': stages.append,
                # Deliberately no swap_disabled: assigned only in fallback.
            }
            exec(compile(mini, "isolated-eligible-branch.py", "exec"), scope)
            self.assertIs(scope['swap'], expected)
            self.assertEqual(stages, ['swapModel'])
        finally:
            VideoManager.swap_core = original
            VideoManager.shutdown_background_workers = old_shutdown
            Models.delete_models = old_delete
            if old_eligible is None:
                delattr(VideoManager, '_isolated_swap_prefix_eligible')
            else:
                VideoManager._isolated_swap_prefix_eligible = old_eligible
            if old_prefix is None:
                delattr(VideoManager, '_isolated_swap_prefix_graph')
            else:
                VideoManager._isolated_swap_prefix_graph = old_prefix
            if had_source:
                original._isolated_source = prior_source
            else:
                delattr(original, '_isolated_source')


if __name__ == '__main__':
    unittest.main()
