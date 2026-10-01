"""CPU-only contracts for the immutable-plan dual-context ceiling probe."""

import unittest
from unittest.mock import patch

import benchmark_gpen512_dual_context as probe


class DualContextProbeTests(unittest.TestCase):
    def test_jobs_are_deterministic_and_from_bounded_existing_capture_set(self):
        refs = probe.capture_refs()
        self.assertEqual(len(refs), 64)
        self.assertEqual(len(set(refs)), 36)
        self.assertEqual(refs[:3], [(name, 0) for name in probe.CAPTURE_NAMES])
        self.assertEqual(refs[36], refs[0])
        self.assertTrue(all(0 <= index < 12 for _, index in refs))

    def test_memory_guard_checks_identity_and_threshold_before_deserialization(self):
        manifest = {'gpu': 'NVIDIA GeForce RTX 4070'}
        self.assertEqual(probe.parse_free_mib('NVIDIA GeForce RTX 4070, 7000, 12288\n',
                                             expected_gpu=manifest['gpu']), (7000, 12288))
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            probe.parse_free_mib('Different GPU, 7000, 12288', expected_gpu=manifest['gpu'])
        with patch.object(probe.subprocess, 'run') as run:
            run.return_value.stdout = 'NVIDIA GeForce RTX 4070, 6000, 12288\n'
            with self.assertRaisesRegex(RuntimeError, 'before loading plan'):
                probe.require_gpu_headroom(manifest)
            run.return_value.stdout = 'NVIDIA GeForce RTX 4070, 7000, 12288\n'
            self.assertEqual(probe.require_gpu_headroom(manifest)['freeMiB'], 7000)

    def test_order_balanced_summary_reports_real_throughput_not_job_latency(self):
        rows = [
            {'mode': 'serial', 'gpuMakespanMs': 2000., 'hostMakespanMs': 2100.,
             'gpuJobLatencyMs': [30.] * 64},
            {'mode': 'parallel', 'gpuMakespanMs': 1500., 'hostMakespanMs': 1600.,
             'gpuJobLatencyMs': [40.] * 64},
            {'mode': 'parallel', 'gpuMakespanMs': 1500., 'hostMakespanMs': 1600.,
             'gpuJobLatencyMs': [40.] * 64},
            {'mode': 'serial', 'gpuMakespanMs': 2000., 'hostMakespanMs': 2100.,
             'gpuJobLatencyMs': [30.] * 64},
        ]
        summary = probe.summarize_rounds(rows)
        self.assertAlmostEqual(summary['serial']['gpuThroughputFps'], 32.)
        self.assertAlmostEqual(summary['parallel']['gpuThroughputFps'], 64. / 1.5)
        self.assertAlmostEqual(summary['parallelOverSerialGpuThroughput'], 4. / 3.)
        self.assertEqual(summary['parallel']['gpuJobLatencyP50Ms'], 40.)

    def test_verify_only_does_not_import_or_enter_gpu_run(self):
        fake_manifest = {'gpu': 'NVIDIA GeForce RTX 4070'}
        with patch.object(probe, 'verify_plan', return_value=(b'plan', fake_manifest)), \
             patch.object(probe, 'load_captures', return_value=(None, [{}] * 64)), \
             patch.object(probe, 'run_gpu', side_effect=AssertionError('GPU run')):
            self.assertEqual(probe.main(['--verify-only', '--output', 'never-written.json']), 0)


if __name__ == '__main__':
    unittest.main()
