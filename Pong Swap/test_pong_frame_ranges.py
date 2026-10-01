import unittest
from pong_frame_ranges import append_transformed_range

class FrameRangeTests(unittest.TestCase):
    def test_contiguous_and_holes(self):
        ranges=[]
        for index in (0,1,4,5,8): append_transformed_range(ranges,index)
        self.assertEqual(ranges,[[0,1],[4,5],[8,8]])
    def test_duplicates_negative_and_bounded(self):
        ranges=[]
        for index in (-1,0,0,2,4,6): append_transformed_range(ranges,index,2)
        self.assertEqual(ranges,[[4,4],[6,6]])
