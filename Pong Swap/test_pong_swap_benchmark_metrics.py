import unittest
from pong_swap_benchmark_metrics import throughput_consistency


class ConsistencyTests(unittest.TestCase):
    def ledger(self, values):
        return [{'milliseconds': value} for value in values]

    def test_constant_fast_frames_pass_both_targets(self):
        r=throughput_consistency(self.ledger([20]*180),30,45)
        self.assertTrue(r['targets']['40']['passed'])

    def test_fast_average_cannot_hide_a_slow_window(self):
        r=throughput_consistency(self.ledger([10]*150+[50]*30),30,45)
        self.assertFalse(r['targets']['30']['passed'])
        self.assertEqual(r['windowsByTimelineSeconds']['1']['minimumRenderWorkFps'],20)

    def test_encoder_overhead_still_fails_overall_gate(self):
        r=throughput_consistency(self.ledger([20]*180),30,29)
        self.assertTrue(r['targets']['40']['renderWindowsPassed'])
        self.assertFalse(r['targets']['30']['passed'])

    def test_short_or_invalid_evidence_cannot_pass(self):
        for values in ([],[20]*10,[float('nan')]*180,[0]*180):
            r=throughput_consistency(self.ledger(values),30,50)
            self.assertFalse(r['targets']['30']['passed'])

if __name__=='__main__':unittest.main()
