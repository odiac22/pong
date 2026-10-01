"""CPU parity for one-cross-stride RetinaFace compaction."""

import unittest

import torch

from experiment_retinaface_postprocess import _compact_outputs


def old_compaction(scores, bboxes, kpss, threshold):
    return (
        torch.cat([s[s >= threshold] for s in scores]),
        torch.cat([b[s >= threshold] for s, b in zip(scores, bboxes)]),
        torch.cat([k[s >= threshold] for s, k in zip(scores, kpss)]),
    )


class RetinafaceCompactionTests(unittest.TestCase):
    def make_rows(self, seed, tied=False):
        generator = torch.Generator().manual_seed(seed)
        scores = []
        boxes = []
        landmarks = []
        for count in (128, 32, 8):
            value = torch.rand(count, generator=generator, dtype=torch.float32)
            if tied:
                value = torch.round(value * 4) / 4
            xy = torch.rand((count, 2), generator=generator) * 100
            size = torch.rand((count, 2), generator=generator) * 30 + 1
            box = torch.cat((xy, xy + size), dim=1)
            kps = torch.rand((count, 5, 2), generator=generator)
            scores.append(value)
            boxes.append(box)
            landmarks.append(kps)
        return scores, boxes, landmarks

    def assert_pipeline_equal(self, rows, threshold):
        scores, boxes, landmarks = rows
        old = old_compaction(scores, boxes, landmarks, threshold)
        new = _compact_outputs(scores, boxes, landmarks, threshold)
        for expected, actual in zip(old, new):
            self.assertTrue(torch.equal(expected.view(torch.int32), actual.view(torch.int32)))
        if old[0].numel() == 0:
            return
        old_order = torch.argsort(old[0], descending=True)
        new_order = torch.argsort(new[0], descending=True)
        self.assertTrue(torch.equal(old_order, new_order))
        old_sorted = tuple(t.index_select(0, old_order) for t in old)
        new_sorted = tuple(t.index_select(0, new_order) for t in new)
        for expected, actual in zip(old_sorted, new_sorted):
            self.assertTrue(torch.equal(expected.view(torch.int32), actual.view(torch.int32)))
        import torchvision

        old_keep = torchvision.ops.nms(old_sorted[1], old_sorted[0], 0.4)
        new_keep = torchvision.ops.nms(new_sorted[1], new_sorted[0], 0.4)
        self.assertTrue(torch.equal(old_keep, new_keep))

    def test_random_thresholds(self):
        for seed in range(12):
            rows = self.make_rows(seed)
            for threshold in (0.0, 0.25, 0.53, 0.9, 1.0):
                with self.subTest(seed=seed, threshold=threshold):
                    self.assert_pipeline_equal(rows, threshold)

    def test_tied_scores_keep_stride_and_anchor_order(self):
        rows = self.make_rows(91, tied=True)
        for threshold in (0.25, 0.5, 0.75):
            with self.subTest(threshold=threshold):
                self.assert_pipeline_equal(rows, threshold)

    def test_empty_and_all_selected(self):
        rows = self.make_rows(102)
        self.assert_pipeline_equal(rows, 2.0)
        self.assert_pipeline_equal(rows, -1.0)


if __name__ == "__main__":
    unittest.main()
