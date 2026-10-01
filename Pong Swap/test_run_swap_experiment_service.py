"""CPU-only checks for the disposable service's opt-in interface."""

import ast
from pathlib import Path
import subprocess
import sys
import unittest


SERVICE = Path(__file__).with_name('run_swap_experiment_service.py')


class SwapExperimentServiceTests(unittest.TestCase):
    def test_candidate_flags_are_exposed_without_starting_service(self):
        result = subprocess.run([sys.executable, str(SERVICE), '--help'],
                                capture_output=True, text=True, check=True)
        for flag in ('native-detection', 'confidence-twopass', 'lab-inverse',
                     'lab-transfer', 'pinned-frame-upload', 'async-readback',
                     'restorer-guard-graph', 'restorer-display-graph',
                     'pasteback-matrix'):
            self.assertIn('--' + flag, result.stdout)

    def test_async_diagnostics_and_fused_lab_are_opt_in(self):
        source = SERVICE.read_text(encoding='utf-8')
        compile(source, str(SERVICE), 'exec')
        tree = ast.parse(source)
        async_branch = next(node for node in ast.walk(tree)
                            if isinstance(node, ast.If)
                            and isinstance(node.test, ast.Attribute)
                            and node.test.attr == 'async_readback')
        self.assertTrue(any(isinstance(node, ast.Assign)
                            and any(isinstance(target, ast.Subscript)
                                    and isinstance(target.value, ast.Name)
                                    and target.value.id == 'kw'
                                    for target in node.targets)
                            and isinstance(node.value, ast.Constant)
                            and node.value.value is False
                            for node in ast.walk(async_branch)))
        self.assertIn('install(fuse_transfer=args.lab_transfer)', source)


if __name__ == '__main__':
    unittest.main()
