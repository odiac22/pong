"""rope_similarity_many must match the per-pair frame-scoped cosine; pinned upload falls back cleanly."""
import os, unittest
import numpy as np
from pong_three_x import rope_similarity, rope_similarity_many
from pong_identity_math import frame_identity_math


class BatchSimilarityTest(unittest.TestCase):
    def test_matches_per_pair_scores(self):
        rng = np.random.default_rng(7)
        refs = [rng.normal(size=512).astype(np.float32) for _ in range(40)]
        refs.append(refs[0] * 3)           # same direction, different norm
        refs.append(np.zeros(512, np.float32))  # invalid reference
        target = rng.normal(size=512).astype(np.float32)
        os.environ['PONG_FRAME_IDENTITY_MATH'] = '1'
        @frame_identity_math
        def inside():
            return [rope_similarity(r, target) for r in refs]
        expected = inside()
        got = rope_similarity_many(refs, target)
        for e, g in zip(expected, got):
            if not np.isfinite(e):
                self.assertFalse(np.isfinite(g))
            else:
                self.assertAlmostEqual(e, g, places=3)
        self.assertEqual(len(rope_similarity_many([], target)), 0)
        self.assertTrue(np.all(~np.isfinite(rope_similarity_many(refs[:2], np.zeros(512, np.float32)))))
        self.assertTrue(np.all(~np.isfinite(rope_similarity_many(refs[:2], np.ones(64, np.float32)))))


if __name__ == '__main__':
    unittest.main()
