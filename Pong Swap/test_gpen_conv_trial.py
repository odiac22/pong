import unittest
from benchmark_gpen_conv_islands import quality_pass


class GateTests(unittest.TestCase):
    def test_all_evidence_required(self):
        self.assertFalse(quality_pass([], [.1], .2))
        self.assertFalse(quality_pass([{'pass': True}], [], .2))

    def test_failure_cannot_be_averaged_away(self):
        self.assertFalse(quality_pass([{'pass': True}, {'pass': False}], [.01], .2))
        self.assertFalse(quality_pass([{'pass': True}], [.01, .21], .2))
        self.assertFalse(quality_pass([{'pass': True}], [float('nan')], .2))

    def test_complete_small_error_passes_only_diagnostic_gate(self):
        self.assertTrue(quality_pass([{'pass': True}], [0, .2], .2))


if __name__ == '__main__':
    unittest.main()
