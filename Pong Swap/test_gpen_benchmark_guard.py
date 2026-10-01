"""CPU-only real child-process tests; no models or native GPU libraries."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).with_name('gpen_benchmark_guard.py')
spec = importlib.util.spec_from_file_location('guard_test_subject', SOURCE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def test_rejects_unbounded_limits(self):
        for value in (0, -1, float('nan'), float('inf'), 301):
            with self.subTest(value=value), self.assertRaises(ValueError):
                guard.bounded_seconds(value, 300)

    @unittest.skipUnless(os.name == 'nt', 'Windows Job Object contracts')
    def test_owned_children_are_contained_on_all_exit_paths(self):
        # All temporary directories belong to this test under its workspace.
        root = Path(__file__).resolve().parent / 'work'
        root.mkdir(exist_ok=True)
        for scenario in ('normal', 'timeout', 'headroom', 'telemetry', 'interrupt', 'parent_exit'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(dir=root) as directory:
                marker = Path(directory) / 'escaped.txt'
                descendant = f'import time; from pathlib import Path; time.sleep(1.2); Path({str(marker)!r}).write_text("escaped")'
                child = ('import subprocess,sys,time; sys.stdin.readline(); '
                         f'subprocess.Popen([sys.executable,"-I","-B","-c",{descendant!r}],'
                         ' creationflags=subprocess.CREATE_NO_WINDOW); '
                         + ('pass' if scenario == 'normal' else 'time.sleep(30)'))
                command = [sys.executable, '-I', '-B', '-c', child]
                calls = []
                def telemetry():
                    calls.append(True)
                    if scenario == 'timeout':
                        time.sleep(0.6)  # deadline must kill independently
                    if scenario == 'telemetry':
                        raise RuntimeError('telemetry lost')
                    if scenario == 'interrupt':
                        raise KeyboardInterrupt()
                    return {'freeMiB': 0 if scenario == 'headroom' else 10000, 'usedMiB': 100}
                with (Path(directory) / 'child.log').open('w') as log:
                    if scenario == 'parent_exit':
                        parent = (
                            'import importlib.util,os; '
                            f's=importlib.util.spec_from_file_location("g",{str(SOURCE)!r}); '
                            'g=importlib.util.module_from_spec(s); s.loader.exec_module(g); '
                            'deadline=g.HardDeadline(0.4); deadline.__enter__(); '
                            f'g.run_guarded_child({command!r},log=None,environment=os.environ.copy(),'
                            'token="test",timeout=5,minimum_free_mib=2048,'
                            'query_gpu=lambda:{"freeMiB":10000,"usedMiB":100})')
                        result = subprocess.run([sys.executable, '-I', '-B', '-c', parent],
                                                stdout=log, stderr=log, timeout=5,
                                                creationflags=subprocess.CREATE_NO_WINDOW)
                        self.assertEqual(result.returncode, 124)
                    else:
                        kwargs = dict(log=log, environment=os.environ.copy(), token='test',
                                      timeout=0.3 if scenario == 'timeout' else 5,
                                      minimum_free_mib=2048, query_gpu=telemetry)
                        if scenario == 'normal':
                            self.assertEqual(guard.run_guarded_child(command, **kwargs)['exitCode'], 0)
                        else:
                            expected = KeyboardInterrupt if scenario == 'interrupt' else (
                                TimeoutError if scenario == 'timeout' else RuntimeError)
                            with self.assertRaises(expected):
                                guard.run_guarded_child(command, **kwargs)
                time.sleep(1.3)
                self.assertFalse(marker.exists(), f'{scenario}: descendant outlived supervisor')


if __name__ == '__main__':
    unittest.main()
